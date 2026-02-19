import { Buffer } from "node:buffer";
import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { randomUUID } from "node:crypto";
import {
  HttpsError,
  onCall,
  onRequest,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { z } from "zod";
import { getEnvConfig } from "./config/env";
import { getGithubClient } from "./github/client";
import { createProjectRepoAndSeed } from "./github/repo";
import { getDb } from "./lib/firestore";
import { computeRepoCreateHeuristic } from "./lib/githubPreflight";
import {
  enqueueProjectForLater,
  maybeStartRun,
  processRunQueueBatch,
  recoverStaleQueuedRuns,
  recoverStaleRunningRuns,
} from "./lib/orchestrator";
import { computeChargedCents } from "./lib/orchestratorRules";
import {
  amountToCents,
  creditProjectWalletFromPayment,
  extractPaymentIntentIdFromCheckoutSession,
  extractPaymentStatus,
  resolveProjectIdForPayment,
} from "./lib/payments";
import { validateRunTokenFromRequest } from "./lib/runAuth";
import { isAllowedReturnUrl } from "./lib/urlSecurity";
import { mitLicenseText } from "./templates/license";
import { gitcorpsRunnerScript } from "./templates/runner";
import { initialStatusTemplate } from "./templates/status";
import { gitcorpsWorkflowYaml } from "./templates/workflow";

const region = "us-central1";

const createProjectSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z
    .string()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  manifestoMd: z.string().min(20).max(200_000),
});

const createFundingCheckoutSchema = z.object({
  projectId: z.string().min(3),
  amountCents: z.number().int().min(50).max(500_000),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

function assertAuth<T>(request: CallableRequest<T>) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }

  return request.auth.uid;
}

async function ensureUserDocument(uid: string, displayName: string | null): Promise<void> {
  const userRef = getDb().collection("users").doc(uid);
  const userSnap = await userRef.get();

  if (userSnap.exists) {
    return;
  }

  await userRef.set({
    createdAt: FieldValue.serverTimestamp(),
    displayName: displayName || "GitCorps User",
  });
}

interface PendingStripePaymentRecord {
  uid: string;
  paymentIntentId: string;
  paymentData: Record<string, unknown>;
}

async function upsertPendingStripePayment(input: {
  uid: string;
  paymentIntentId: string;
  paymentData: Record<string, unknown>;
  reason: string;
}): Promise<void> {
  await getDb()
    .collection("pendingStripePayments")
    .doc(input.paymentIntentId)
    .set(
      {
        uid: input.uid,
        paymentIntentId: input.paymentIntentId,
        paymentData: input.paymentData,
        reason: input.reason,
        attemptCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

async function clearPendingStripePayment(paymentIntentId: string): Promise<void> {
  await getDb().collection("pendingStripePayments").doc(paymentIntentId).delete().catch(() => {
    // best effort
  });
}

async function processSucceededStripePayment(
  input: PendingStripePaymentRecord,
): Promise<"credited" | "already_credited" | "pending_mapping" | "invalid_amount"> {
  const projectId = await resolveProjectIdForPayment(
    input.uid,
    input.paymentIntentId,
    input.paymentData,
  );

  if (!projectId) {
    await upsertPendingStripePayment({
      uid: input.uid,
      paymentIntentId: input.paymentIntentId,
      paymentData: input.paymentData,
      reason: "project_mapping_missing",
    });
    return "pending_mapping";
  }
  const resolvedProjectId = projectId;

  const amountCents = amountToCents(
    input.paymentData.amount_received ??
      input.paymentData.amount ??
      input.paymentData.amount_total ??
      input.paymentData.amount_capturable,
  );

  if (amountCents <= 0) {
    await upsertPendingStripePayment({
      uid: input.uid,
      paymentIntentId: input.paymentIntentId,
      paymentData: input.paymentData,
      reason: "invalid_amount",
    });

    logger.error("Stripe payment had invalid amount", {
      paymentIntentId: input.paymentIntentId,
      rawAmount:
        input.paymentData.amount_received ??
        input.paymentData.amount ??
        input.paymentData.amount_total,
    });
    return "invalid_amount";
  }

  const credited = await creditProjectWalletFromPayment({
    projectId: resolvedProjectId,
    paymentIntentId: input.paymentIntentId,
    uid: input.uid || null,
    amountCents,
  });

  async function tryStartRunFromFunding(source: "credited" | "already_credited"): Promise<void> {
    try {
      const runResult = await maybeStartRun(resolvedProjectId);
      logger.info("maybeStartRun evaluated after funding event", {
        projectId: resolvedProjectId,
        paymentIntentId: input.paymentIntentId,
        source,
        runResult,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("maybeStartRun threw after funding event; enqueueing fallback", {
        projectId: resolvedProjectId,
        paymentIntentId: input.paymentIntentId,
        source,
        error: message,
      });
      await enqueueProjectForLater(resolvedProjectId, "post_funding_start_failed");
    }
  }

  if (!credited) {
    await clearPendingStripePayment(input.paymentIntentId);
    logger.info("Payment was already applied (idempotent)", {
      paymentIntentId: input.paymentIntentId,
      projectId: resolvedProjectId,
    });
    await tryStartRunFromFunding("already_credited");
    return "already_credited";
  }

  await clearPendingStripePayment(input.paymentIntentId);
  await tryStartRunFromFunding("credited");
  return "credited";
}

async function processPendingStripePaymentIfPresent(
  paymentIntentId: string,
  fallbackUid: string,
): Promise<void> {
  const pendingSnap = await getDb().collection("pendingStripePayments").doc(paymentIntentId).get();
  if (!pendingSnap.exists) {
    return;
  }

  const pendingData = pendingSnap.data() as Record<string, unknown>;
  const pendingUid = typeof pendingData.uid === "string" ? pendingData.uid : fallbackUid;
  const pendingPaymentData =
    pendingData.paymentData && typeof pendingData.paymentData === "object"
      ? (pendingData.paymentData as Record<string, unknown>)
      : null;

  if (!pendingUid || !pendingPaymentData) {
    logger.error("Pending stripe payment record missing required fields", {
      paymentIntentId,
      pendingUidType: typeof pendingData.uid,
      pendingPaymentDataType: typeof pendingData.paymentData,
    });
    return;
  }

  await processSucceededStripePayment({
    uid: pendingUid,
    paymentIntentId,
    paymentData: pendingPaymentData,
  });
}

export const createProject = onCall(
  {
    region,
    memory: "512MiB",
  },
  async (request) => {
    const uid = assertAuth(request);
    const payload = createProjectSchema.parse(request.data);
    const db = getDb();
    const displayName =
      request.auth?.token && typeof request.auth.token.name === "string"
        ? request.auth.token.name
        : undefined;

    await ensureUserDocument(uid, displayName ?? null);

    const config = getEnvConfig();
    const statusTemplate = initialStatusTemplate(payload.name);
    const workflowYaml = gitcorpsWorkflowYaml();
    const runnerScript = gitcorpsRunnerScript();
    const projectRef = db.collection("projects").doc();
    const slugRef = db.collection("projectSlugs").doc(payload.slug);

    await db.runTransaction(async (tx) => {
      const slugSnap = await tx.get(slugRef);
      if (slugSnap.exists) {
        throw new HttpsError("already-exists", "Project slug already exists.");
      }

      tx.set(slugRef, {
        projectId: projectRef.id,
        createdByUid: uid,
        status: "reserved",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    const siteUrl = config.PROJECT_SITE_TEMPLATE?.includes("{slug}")
      ? `https://${config.PROJECT_SITE_TEMPLATE.replace("{slug}", payload.slug)}`
      : undefined;

    let repoInfo: { repoUrl: string; repoFullName: string } | null = null;

    try {
      repoInfo = await createProjectRepoAndSeed({
        org: config.GITHUB_ORG_NAME,
        slug: payload.slug,
        name: payload.name,
        manifestoMd: payload.manifestoMd,
        statusTemplate,
        workflowYaml,
        runnerScript,
        licenseText: config.DEFAULT_LICENSE === "MIT" ? mitLicenseText : mitLicenseText,
      });

      await projectRef.set({
        slug: payload.slug,
        name: payload.name,
        manifestoMd: payload.manifestoMd,
        repoFullName: repoInfo.repoFullName,
        repoUrl: repoInfo.repoUrl,
        siteUrl,
        createdByUid: uid,
        balanceCents: 0,
        currentRunId: null,
        status: "active",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      await slugRef.set(
        {
          projectId: projectRef.id,
          repoFullName: repoInfo.repoFullName,
          status: "active",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return {
        projectId: projectRef.id,
        repoUrl: repoInfo.repoUrl,
        repoFullName: repoInfo.repoFullName,
      };
    } catch (error) {
      if (repoInfo) {
        await slugRef.set(
          {
            projectId: projectRef.id,
            repoFullName: repoInfo.repoFullName,
            status: "orphaned_repo",
            error:
              error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      } else {
        await slugRef.delete().catch(() => {
          // Best-effort cleanup.
        });
      }

      if (error instanceof HttpsError) {
        throw error;
      }

      logger.error("createProject failed", {
        uid,
        slug: payload.slug,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new HttpsError(
        "internal",
        "Failed to create project. Check GitHub/org configuration and try again.",
      );
    }
  },
);

export const createFundingCheckoutSession = onCall(
  {
    region,
    memory: "256MiB",
  },
  async (request) => {
    const uid = assertAuth(request);
    const payload = createFundingCheckoutSchema.parse(request.data);
    const config = getEnvConfig();

    if (!isAllowedReturnUrl(payload.successUrl, config.PUBLIC_SITE_DOMAIN)) {
      throw new HttpsError("invalid-argument", "Invalid successUrl host.");
    }

    if (!isAllowedReturnUrl(payload.cancelUrl, config.PUBLIC_SITE_DOMAIN)) {
      throw new HttpsError("invalid-argument", "Invalid cancelUrl host.");
    }

    const projectSnap = await getDb().collection("projects").doc(payload.projectId).get();
    if (!projectSnap.exists) {
      throw new HttpsError("not-found", "Project not found.");
    }

    const projectName = String(projectSnap.get("name") || "GitCorps Project");

    const sessionRef = getDb()
      .collection("customers")
      .doc(uid)
      .collection("checkout_sessions")
      .doc();

    await sessionRef.set({
      mode: "payment",
      success_url: payload.successUrl,
      cancel_url: payload.cancelUrl,
      client_reference_id: payload.projectId,
      metadata: {
        projectId: payload.projectId,
      },
      payment_intent_data: {
        metadata: {
          projectId: payload.projectId,
        },
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: payload.amountCents,
            product_data: {
              name: `Fund ${projectName}`,
              description: "GitCorps project wallet contribution",
            },
          },
        },
      ],
      allow_promotion_codes: true,
      createdAt: FieldValue.serverTimestamp(),
    });

    await getDb()
      .collection("checkoutSessionProjects")
      .doc(sessionRef.id)
      .set({
        uid,
        projectId: payload.projectId,
        amountCents: payload.amountCents,
        createdAt: FieldValue.serverTimestamp(),
      });

    return {
      sessionDocumentPath: sessionRef.path,
      sessionId: sessionRef.id,
    };
  },
);

export const onCheckoutSessionUpdated = onDocumentWritten(
  {
    region,
    document: "customers/{uid}/checkout_sessions/{sessionId}",
  },
  async (event) => {
    const after = event.data?.after;
    const before = event.data?.before;

    if (!after?.exists) {
      return;
    }

    const afterData = (after.data() || {}) as Record<string, unknown>;
    const paymentIntentId = extractPaymentIntentIdFromCheckoutSession(afterData);
    if (!paymentIntentId) {
      return;
    }

    const beforeData = (before?.exists ? before.data() : {}) as Record<string, unknown>;
    const beforePaymentIntentId = extractPaymentIntentIdFromCheckoutSession(beforeData);
    if (beforePaymentIntentId === paymentIntentId) {
      return;
    }

    const mapping = await getDb()
      .collection("checkoutSessionProjects")
      .doc(event.params.sessionId)
      .get();

    if (!mapping.exists) {
      return;
    }

    const projectId = mapping.get("projectId");
    if (typeof projectId !== "string") {
      return;
    }

    await getDb()
      .collection("paymentIntentProjects")
      .doc(paymentIntentId)
      .set(
        {
          projectId,
          sessionId: event.params.sessionId,
          uid: event.params.uid,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

    await processPendingStripePaymentIfPresent(paymentIntentId, event.params.uid);
  },
);

export const onPaymentIntentProjectMapped = onDocumentWritten(
  {
    region,
    document: "paymentIntentProjects/{paymentIntentId}",
  },
  async (event) => {
    const after = event.data?.after;
    const before = event.data?.before;

    if (!after?.exists) {
      return;
    }

    const paymentIntentId = String(event.params.paymentIntentId || "");
    if (!paymentIntentId) {
      return;
    }

    const afterProjectId = after.get("projectId");
    if (typeof afterProjectId !== "string" || afterProjectId.length === 0) {
      return;
    }

    const beforeProjectId = before?.exists ? before.get("projectId") : undefined;
    if (beforeProjectId === afterProjectId) {
      return;
    }

    const fallbackUid =
      typeof after.get("uid") === "string" && String(after.get("uid")).length > 0
        ? String(after.get("uid"))
        : "";

    await processPendingStripePaymentIfPresent(paymentIntentId, fallbackUid);
  },
);

export const onStripePaymentSucceeded = onDocumentWritten(
  {
    region,
    document: "customers/{uid}/payments/{paymentIntentId}",
  },
  async (event) => {
    const after = event.data?.after;
    const before = event.data?.before;
    if (!after?.exists) {
      return;
    }

    const uid = String(event.params.uid || "");
    const paymentIntentId = String(event.params.paymentIntentId || "");
    const paymentData = (after.data() || {}) as Record<string, unknown>;
    const beforeData = (before?.exists ? before.data() : {}) as Record<string, unknown>;

    const status = extractPaymentStatus(paymentData).toLowerCase();
    const beforeStatus = extractPaymentStatus(beforeData).toLowerCase();
    const succeededStatuses = new Set(["succeeded", "paid"]);

    if (!succeededStatuses.has(status)) {
      logger.info("Ignoring non-succeeded payment event", { paymentIntentId, status });
      return;
    }

    if (succeededStatuses.has(beforeStatus)) {
      logger.info("Ignoring duplicate succeeded payment transition", {
        paymentIntentId,
        status,
        beforeStatus,
      });
      return;
    }

    const result = await processSucceededStripePayment({
      uid,
      paymentIntentId,
      paymentData,
    });

    logger.info("Processed succeeded Stripe payment", {
      paymentIntentId,
      uid,
      status,
      result,
    });
  },
);

function methodNotAllowed(res: { status(code: number): { json(payload: unknown): void } }) {
  res.status(405).json({ error: "Method not allowed" });
}

export const runStarted = onRequest({ region }, async (req, res) => {
  if (req.method !== "POST") {
    methodNotAllowed(res);
    return;
  }

  const auth = await validateRunTokenFromRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.message });
    return;
  }

  const { projectId, runId } = auth.payload;
  const runRef = getDb().collection("projects").doc(projectId).collection("runs").doc(runId);

  await runRef.set(
    {
      status: "running",
      startedAt: FieldValue.serverTimestamp(),
      heartbeatAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  res.status(200).json({ ok: true });
});

export const runHeartbeat = onRequest({ region }, async (req, res) => {
  if (req.method !== "POST") {
    methodNotAllowed(res);
    return;
  }

  const auth = await validateRunTokenFromRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.message });
    return;
  }

  const { projectId, runId } = auth.payload;
  const body = (req.body || {}) as { phase?: string; message?: string };
  const runRef = getDb().collection("projects").doc(projectId).collection("runs").doc(runId);

  await runRef.set(
    {
      heartbeatAt: FieldValue.serverTimestamp(),
      heartbeatPhase: typeof body.phase === "string" ? body.phase : null,
      heartbeatMessage: typeof body.message === "string" ? body.message.slice(0, 500) : null,
    },
    { merge: true },
  );

  res.status(200).json({ ok: true });
});

const runFinishedSchema = z.object({
  projectId: z.string().min(3),
  runId: z.string().min(3),
  status: z.enum(["succeeded", "failed", "out_of_funds"]),
  summaryMd: z.string().min(1).max(100_000),
  spentCents: z.number().int().min(0).optional(),
});

export const runFinished = onRequest({ region }, async (req, res) => {
  if (req.method !== "POST") {
    methodNotAllowed(res);
    return;
  }

  const auth = await validateRunTokenFromRequest(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.message });
    return;
  }

  const payload = runFinishedSchema.safeParse(req.body);
  if (!payload.success) {
    res.status(400).json({ error: "Invalid request payload", details: payload.error.issues });
    return;
  }

  const { projectId, runId, status, summaryMd, spentCents } = payload.data;
  const db = getDb();
  const projectRef = db.collection("projects").doc(projectId);
  const runRef = projectRef.collection("runs").doc(runId);

  await db.runTransaction(async (tx) => {
    const [projectSnap, runSnap] = await Promise.all([tx.get(projectRef), tx.get(runRef)]);
    if (!projectSnap.exists || !runSnap.exists) {
      throw new Error("Project or run not found");
    }

    const runData = runSnap.data() || {};
    if (runData.endedAt) {
      return;
    }

    const budgetCents = typeof runData.budgetCents === "number" ? runData.budgetCents : 0;
    const chargedCents = computeChargedCents(spentCents, budgetCents);
    const currentBalance = Number(projectSnap.get("balanceCents") ?? 0);

    tx.update(runRef, {
      status,
      spentCents: chargedCents,
      chargedCents,
      endedAt: FieldValue.serverTimestamp(),
      heartbeatAt: FieldValue.serverTimestamp(),
      summaryMd,
      runTokenHash: FieldValue.delete(),
      runTokenExpiresAt: FieldValue.delete(),
    });

    if (projectSnap.get("currentRunId") === runId) {
      tx.update(projectRef, {
        currentRunId: null,
        balanceCents: Math.max(0, currentBalance - chargedCents),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    tx.delete(db.collection("activeRuns").doc(projectId));
  });

  await maybeStartRun(projectId).catch((error) => {
    logger.error("Auto-continue maybeStartRun failed", {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  res.status(200).json({ ok: true });
});

export const processRunQueue = onSchedule(
  {
    region,
    schedule: "every 1 minutes",
    timeoutSeconds: 540,
  },
  async () => {
    const config = getEnvConfig();
    await processRunQueueBatch(config.RUN_QUEUE_CHECK_LIMIT);
  },
);

export const recoverStaleRuns = onSchedule(
  {
    region,
    schedule: "every 5 minutes",
    timeoutSeconds: 540,
  },
  async () => {
    await recoverStaleQueuedRuns();
    await recoverStaleRunningRuns();
  },
);

export const retryPendingStripePayments = onSchedule(
  {
    region,
    schedule: "every 5 minutes",
    timeoutSeconds: 540,
  },
  async () => {
    const pendingSnapshot = await getDb().collection("pendingStripePayments").limit(50).get();
    if (pendingSnapshot.empty) {
      return;
    }

    const outcomeCounts: Record<string, number> = {
      credited: 0,
      already_credited: 0,
      pending_mapping: 0,
      invalid_amount: 0,
    };

    for (const doc of pendingSnapshot.docs) {
      const data = doc.data() as Record<string, unknown>;
      const uid = typeof data.uid === "string" ? data.uid : "";
      const paymentData =
        data.paymentData && typeof data.paymentData === "object"
          ? (data.paymentData as Record<string, unknown>)
          : null;

      if (!uid || !paymentData) {
        logger.error("Skipping malformed pendingStripePayments document", {
          paymentIntentId: doc.id,
          uidType: typeof data.uid,
          paymentDataType: typeof data.paymentData,
        });
        continue;
      }

      try {
        const outcome = await processSucceededStripePayment({
          uid,
          paymentIntentId: doc.id,
          paymentData,
        });
        outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
      } catch (error) {
        logger.error("retryPendingStripePayments failed for payment", {
          paymentIntentId: doc.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("retryPendingStripePayments completed", {
      scanned: pendingSnapshot.size,
      outcomes: outcomeCounts,
    });
  },
);

export const maybeStartRunCallable = onCall(
  {
    region,
    memory: "256MiB",
  },
  async (request) => {
    assertAuth(request);

    const schema = z.object({ projectId: z.string().min(3) });
    const payload = schema.parse(request.data);

    const result = await maybeStartRun(payload.projectId);
    return {
      ...result,
      defaults: {
        githubOrgName: getEnvConfig().GITHUB_ORG_NAME || "gitcorps",
      },
    };
  },
);

export const githubPreflight = onCall(
  {
    region,
    memory: "256MiB",
  },
  async (request) => {
    assertAuth(request);
    const payload = z
      .object({
        writeProbe: z.boolean().optional(),
      })
      .parse(request.data ?? {});
    const writeProbeRequested = payload.writeProbe === true;

    const config = getEnvConfig();
    const org = config.GITHUB_ORG_NAME;
    const tokenPresent = Boolean(config.GITHUB_TOKEN);

    const result: {
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
    } = {
      ok: true,
      org,
      tokenPresent,
      orgReachable: false,
      writeProbeRequested,
      checks: [],
      repoCreateHeuristic: "unknown",
      errors: [],
    };

    if (!tokenPresent) {
      result.ok = false;
      result.errors.push({
        step: "token",
        message: "GITHUB_TOKEN is not configured.",
      });
      result.repoCreateHeuristic = "unlikely";
      return result;
    }

    const octokit = await getGithubClient();
    let viewerReachable = false;

    try {
      const viewerResp = await octokit.users.getAuthenticated();
      viewerReachable = true;
      result.viewer = viewerResp.data;

      const scopesHeader = viewerResp.headers["x-oauth-scopes"];
      const acceptedHeader = viewerResp.headers["x-accepted-oauth-scopes"];
      result.oauthScopes = scopesHeader ? String(scopesHeader) : null;
      result.acceptedOauthScopes = acceptedHeader ? String(acceptedHeader) : null;
      result.checks.push("viewer_ok");
    } catch (error) {
      const err = error as { status?: number; message?: string };
      result.ok = false;
      result.errors.push({
        step: "viewer",
        status: err.status,
        message: err.message || "Failed to read authenticated viewer.",
      });
    }

    try {
      const orgResp = await octokit.orgs.get({ org });
      result.orgReachable = true;
      result.orgSettings = {
        membersCanCreateRepositories: orgResp.data.members_can_create_repositories,
        defaultRepositoryPermission: orgResp.data.default_repository_permission,
      };
      result.checks.push("org_ok");
    } catch (error) {
      const err = error as { status?: number; message?: string };
      result.ok = false;
      result.errors.push({
        step: "org",
        status: err.status,
        message: err.message || "Failed to access organization.",
      });
    }

    try {
      const membershipResp = await octokit.orgs.getMembershipForAuthenticatedUser({ org });
      result.membership = {
        state: membershipResp.data.state,
        role: membershipResp.data.role,
      };
      result.checks.push("membership_ok");
    } catch (error) {
      const err = error as { status?: number; message?: string };
      result.errors.push({
        step: "membership",
        status: err.status,
        message: err.message || "Could not resolve org membership for authenticated user.",
      });
    }

    result.repoCreateHeuristic = computeRepoCreateHeuristic({
      tokenPresent,
      viewerReachable,
      orgReachable: result.orgReachable,
      membership: result.membership,
      orgSettings: result.orgSettings,
    });

    if (result.repoCreateHeuristic === "unlikely") {
      result.ok = false;
    }

    if (writeProbeRequested) {
      const probeRepoName = `gitcorps-preflight-${Date.now()}-${randomUUID().slice(0, 8)}`;
      result.writeProbeRepoName = probeRepoName;
      result.writeProbeDetails = {
        repoCreated: false,
        contentsWriteOk: false,
        workflowWriteOk: false,
        repoDeleted: false,
      };

      try {
        const createResp = await octokit.repos.createInOrg({
          org,
          name: probeRepoName,
          description: "Temporary GitCorps preflight repo. Safe to delete.",
          private: false,
          has_issues: false,
          has_projects: false,
          has_wiki: false,
          auto_init: false,
          license_template: "mit",
        });

        result.writeProbeDetails.repoCreated = true;
        result.writeProbeRepoUrl = createResp.data.html_url;
        result.checks.push("write_probe_create_ok");

        await octokit.repos.createOrUpdateFileContents({
          owner: org,
          repo: probeRepoName,
          path: ".gitcorps-preflight.txt",
          message: "chore(preflight): verify contents write",
          content: Buffer.from("ok\n", "utf8").toString("base64"),
          branch: "main",
        });
        result.writeProbeDetails.contentsWriteOk = true;
        result.checks.push("write_probe_contents_ok");

        await octokit.repos.createOrUpdateFileContents({
          owner: org,
          repo: probeRepoName,
          path: ".github/workflows/preflight-check.yml",
          message: "chore(preflight): verify workflow write",
          content: Buffer.from("name: preflight-check\non: workflow_dispatch\njobs: {}\n", "utf8").toString("base64"),
          branch: "main",
        });
        result.writeProbeDetails.workflowWriteOk = true;
        result.checks.push("write_probe_workflow_ok");

        await octokit.repos.delete({
          owner: org,
          repo: probeRepoName,
        });
        result.writeProbeDetails.repoDeleted = true;
        result.writeProbeSucceeded = true;
        result.checks.push("write_probe_delete_ok");
      } catch (error) {
        const err = error as { status?: number; message?: string };
        result.writeProbeSucceeded = false;
        result.ok = false;
        result.errors.push({
          step:
            result.writeProbeDetails.repoCreated && !result.writeProbeDetails.contentsWriteOk
              ? "writeProbeContents"
              : result.writeProbeDetails.repoCreated &&
                  result.writeProbeDetails.contentsWriteOk &&
                  !result.writeProbeDetails.workflowWriteOk
                ? "writeProbeWorkflow"
                : result.writeProbeDetails.repoCreated ? "writeProbeDelete" : "writeProbeCreate",
          status: err.status,
          message:
            err.message ||
            "Write probe failed while creating or deleting temporary repository.",
        });
      }
    }

    return result;
  },
);
