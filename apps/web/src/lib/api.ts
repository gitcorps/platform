"use client";

import { httpsCallable } from "firebase/functions";
import {
  doc,
  onSnapshot,
  query,
  where,
  collection,
  getDocs,
  limit,
  type Firestore,
} from "firebase/firestore";
import { getFirebaseFunctions } from "./firebase";

export interface CreateProjectInput {
  name: string;
  slug: string;
  manifestoMd: string;
}

export interface CreateProjectResult {
  projectId: string;
  repoUrl: string;
  repoFullName: string;
}

export interface CreateCheckoutInput {
  projectId: string;
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateCheckoutResult {
  sessionDocumentPath: string;
  sessionId: string;
}

export interface GithubPreflightResult {
  ok: boolean;
  org: string;
  tokenPresent: boolean;
  viewer?: { login: string; id: number; type: string };
  oauthScopes?: string | null;
  acceptedOauthScopes?: string | null;
  orgReachable: boolean;
  orgSettings?: {
    membersCanCreateRepositories?: boolean;
    defaultRepositoryPermission?: string;
  };
  membership?: { state?: string; role?: string };
  writeProbeRequested: boolean;
  writeProbeSucceeded?: boolean;
  writeProbeRepoName?: string;
  writeProbeRepoUrl?: string;
  writeProbeDetails?: {
    repoCreated: boolean;
    contentsWriteOk: boolean;
    workflowWriteOk: boolean;
    repoDeleted: boolean;
  };
  checks: string[];
  repoCreateHeuristic: "likely" | "unknown" | "unlikely";
  errors: Array<{ step: string; status?: number; message: string }>;
}

export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  const callable = httpsCallable<CreateProjectInput, CreateProjectResult>(
    getFirebaseFunctions(),
    "createProject",
  );
  const result = await callable(input);
  return result.data;
}

export async function createFundingCheckoutSession(
  input: CreateCheckoutInput,
): Promise<CreateCheckoutResult> {
  const callable = httpsCallable<CreateCheckoutInput, CreateCheckoutResult>(
    getFirebaseFunctions(),
    "createFundingCheckoutSession",
  );
  const result = await callable(input);
  return result.data;
}

export async function runGithubPreflight(
  writeProbe = false,
): Promise<GithubPreflightResult> {
  const callable = httpsCallable<{ writeProbe?: boolean }, GithubPreflightResult>(
    getFirebaseFunctions(),
    "githubPreflight",
  );
  const result = await callable({ writeProbe });
  return result.data;
}

export async function waitForCheckoutUrl(
  db: Firestore,
  sessionDocumentPath: string,
  timeoutMs = 60_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for Stripe checkout session URL"));
    }, timeoutMs);

    const unsubscribe = onSnapshot(
      doc(db, sessionDocumentPath),
      (snap) => {
        const data = snap.data();
        if (!data) {
          return;
        }

        if (typeof data.error?.message === "string") {
          clearTimeout(timeout);
          unsubscribe();
          reject(new Error(data.error.message));
          return;
        }

        if (typeof data.url === "string" && data.url.length > 0) {
          clearTimeout(timeout);
          unsubscribe();
          resolve(data.url);
        }
      },
      (error) => {
        clearTimeout(timeout);
        unsubscribe();
        reject(error);
      },
    );
  });
}

export async function isSlugAvailable(db: Firestore, slug: string): Promise<boolean> {
  const snap = await getDocs(query(collection(db, "projects"), where("slug", "==", slug), limit(1)));
  return snap.empty;
}
