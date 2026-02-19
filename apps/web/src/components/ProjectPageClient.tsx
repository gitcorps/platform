"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type DocumentData,
} from "firebase/firestore";
import { Disclaimer } from "./Disclaimer";
import { createFundingCheckoutSession, waitForCheckoutUrl } from "../lib/api";
import {
  getFirebaseAuth,
  getFirebaseDb,
  isFirebaseConfigured,
  signInWithGoogle,
} from "../lib/firebase";

interface ProjectData {
  id: string;
  slug: string;
  name: string;
  manifestoMd: string;
  balanceCents: number;
  status: string;
  repoUrl?: string;
  repoFullName?: string;
}

interface RunData {
  id: string;
  status: string;
  budgetCents: number;
  spentCents?: number;
  summaryMd?: string;
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
}

function formatTimestamp(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "-";
  }

  const maybeSeconds = (value as { seconds?: number }).seconds;
  if (typeof maybeSeconds === "number") {
    return new Date(maybeSeconds * 1000).toLocaleString();
  }

  return "-";
}

function mapRun(docData: DocumentData, id: string): RunData {
  return {
    id,
    status: String(docData.status || "queued"),
    budgetCents: Number(docData.budgetCents || 0),
    spentCents: typeof docData.spentCents === "number" ? docData.spentCents : undefined,
    summaryMd: typeof docData.summaryMd === "string" ? docData.summaryMd : undefined,
    createdAt: formatTimestamp(docData.createdAt),
    startedAt: formatTimestamp(docData.startedAt),
    endedAt: formatTimestamp(docData.endedAt),
  };
}

export function ProjectPageClient({ slug }: { slug: string }) {
  const [project, setProject] = useState<ProjectData | null>(null);
  const [runs, setRuns] = useState<RunData[]>([]);
  const [fundingUsd, setFundingUsd] = useState(15);
  const [fundingLoading, setFundingLoading] = useState(false);
  const [fundingError, setFundingError] = useState<string | null>(null);
  const firebaseConfigured = isFirebaseConfigured();

  function getDbOrThrow() {
    if (!firebaseConfigured) {
      throw new Error("Firebase config is missing. Set NEXT_PUBLIC_FIREBASE_* values.");
    }

    return getFirebaseDb();
  }

  useEffect(() => {
    if (!firebaseConfigured) {
      return;
    }

    const db = getFirebaseDb();
    const projectsQuery = query(collection(db, "projects"), where("slug", "==", slug), limit(1));
    const unsubscribe = onSnapshot(projectsQuery, (snapshot) => {
      const first = snapshot.docs[0];
      if (!first) {
        setProject(null);
        return;
      }

      const data = first.data();
      setProject({
        id: first.id,
        slug: String(data.slug || ""),
        name: String(data.name || "Untitled"),
        manifestoMd: String(data.manifestoMd || ""),
        balanceCents: Number(data.balanceCents || 0),
        status: String(data.status || "active"),
        repoUrl: typeof data.repoUrl === "string" ? data.repoUrl : undefined,
        repoFullName: typeof data.repoFullName === "string" ? data.repoFullName : undefined,
      });
    });

    return unsubscribe;
  }, [slug, firebaseConfigured]);

  useEffect(() => {
    if (!project?.id) {
      return;
    }

    if (!firebaseConfigured) {
      return;
    }

    const db = getFirebaseDb();
    const runsQuery = query(
      collection(db, "projects", project.id, "runs"),
      orderBy("createdAt", "desc"),
      limit(20),
    );

    const unsubscribe = onSnapshot(runsQuery, (snapshot) => {
      const items = snapshot.docs.map((runDoc) => mapRun(runDoc.data(), runDoc.id));
      setRuns(items);
    });

    return unsubscribe;
  }, [project?.id, firebaseConfigured]);

  const latestRun = useMemo(() => runs[0], [runs]);

  async function ensureSignedIn() {
    const auth = getFirebaseAuth();
    if (auth.currentUser) {
      return;
    }
    await signInWithGoogle();
  }

  async function handleFund() {
    if (!project) {
      return;
    }

    setFundingError(null);
    setFundingLoading(true);

    try {
      await ensureSignedIn();
      const db = getDbOrThrow();

      const amountCents = Math.round(fundingUsd * 100);
      const successUrl = `${window.location.origin}/p/${project.slug}?checkout=success`;
      const cancelUrl = `${window.location.origin}/p/${project.slug}?checkout=cancel`;

      const checkout = await createFundingCheckoutSession({
        projectId: project.id,
        amountCents,
        successUrl,
        cancelUrl,
      });

      const url = await waitForCheckoutUrl(db, checkout.sessionDocumentPath);
      window.location.assign(url);
    } catch (error) {
      setFundingError(error instanceof Error ? error.message : String(error));
      setFundingLoading(false);
    }
  }

  if (!firebaseConfigured) {
    return <p className="muted">Firebase config is missing.</p>;
  }

  if (!project) {
    return <p className="muted">Project not found.</p>;
  }

  return (
    <section>
      <h1>{project.name}</h1>

      <div className="metrics">
        <div className="metric">
          <div className="muted">Wallet Balance</div>
          <strong>${(project.balanceCents / 100).toFixed(2)}</strong>
        </div>
        <div className="metric">
          <div className="muted">Project Status</div>
          <strong>{project.status}</strong>
        </div>
        <div className="metric">
          <div className="muted">Repository</div>
          {project.repoUrl ? (
            <a href={project.repoUrl} target="_blank" rel="noreferrer">
              {project.repoFullName || "Open GitHub"}
            </a>
          ) : (
            <span>-</span>
          )}
        </div>
      </div>

      <h2>Manifesto</h2>
      <article className="project-card">
        <ReactMarkdown>{project.manifestoMd}</ReactMarkdown>
      </article>

      <h2>Fund Project</h2>
      <Disclaimer />
      <div className="form-grid">
        <label>
          Amount (USD)
          <input
            type="number"
            min={1}
            step={1}
            value={fundingUsd}
            onChange={(event) => {
              setFundingUsd(Number(event.target.value));
            }}
          />
        </label>
        <button className="button-primary" type="button" disabled={fundingLoading} onClick={handleFund}>
          {fundingLoading ? "Redirecting..." : "Fund with Stripe"}
        </button>
        {fundingError ? <p className="muted">Funding error: {fundingError}</p> : null}
      </div>

      <h2>Latest Run</h2>
      {latestRun ? (
        <article className="run-item">
          <p>
            <strong>Status:</strong> {latestRun.status}
          </p>
          <p>
            <strong>Started:</strong> {latestRun.startedAt}
          </p>
          <p>
            <strong>Ended:</strong> {latestRun.endedAt}
          </p>
          <pre>{latestRun.summaryMd || "No summary yet."}</pre>
        </article>
      ) : (
        <p className="muted">No runs yet.</p>
      )}

      <h2>Run History</h2>
      <div className="run-list">
        {runs.map((run) => (
          <article className="run-item" key={run.id}>
            <p>
              <strong>{run.status}</strong> | budget ${(run.budgetCents / 100).toFixed(2)} | spent $
              {((run.spentCents ?? 0) / 100).toFixed(2)}
            </p>
            <p>
              Created: {run.createdAt} | Ended: {run.endedAt}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
