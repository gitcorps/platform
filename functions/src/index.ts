import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import {
  HttpsError,
  onCall,
  onRequest,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { z } from "zod";
import { getEnvConfig } from "./config/env";
import { createProjectRepoAndSeed } from "./github/repo";
import { getDb } from "./lib/firestore";
import {
  maybeStartRun,
  processRunQueueBatch,
  recoverStaleQueuedRuns,
  recoverStaleRunningRuns,
} from "./lib/orchestrator";
import { computeChargedCents } from "./lib/orchestratorRules";
import {
  amountToCents,
  creditProjectWalletFromPayment,
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

    const afterData = after.data() || {};
    const paymentIntentId = afterData.payment_intent;
    if (typeof paymentIntentId !== "string" || paymentIntentId.length === 0) {
      return;
    }

    const beforePaymentIntent = before?.exists ? before.data()?.payment_intent : undefined;
    if (beforePaymentIntent === paymentIntentId) {
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
  },
);

export const onStripePaymentSucceeded = onDocumentCreated(
  {
    region,
    document: "customers/{uid}/payments/{paymentIntentId}",
  },
  async (event) => {
    const uid = String(event.params.uid || "");
    const paymentIntentId = String(event.params.paymentIntentId || "");
    const paymentData = event.data?.data() || {};

    const status = String(paymentData.status || "succeeded");
    if (status !== "succeeded") {
      logger.info("Ignoring non-succeeded payment event", { paymentIntentId, status });
      return;
    }

    const projectId = await resolveProjectIdForPayment(
      uid,
      paymentIntentId,
      paymentData as Record<string, unknown>,
    );

    if (!projectId) {
      logger.error("Unable to map Stripe payment to project", { uid, paymentIntentId });
      return;
    }

    const amountCents = amountToCents(
      paymentData.amount_received ?? paymentData.amount ?? paymentData.amount_total,
    );

    if (amountCents <= 0) {
      logger.error("Stripe payment had invalid amount", {
        paymentIntentId,
        rawAmount: paymentData.amount_received ?? paymentData.amount,
      });
      return;
    }

    const credited = await creditProjectWalletFromPayment({
      projectId,
      paymentIntentId,
      uid: uid || null,
      amountCents,
    });

    if (!credited) {
      logger.info("Payment was already applied (idempotent)", { paymentIntentId, projectId });
      return;
    }

    await maybeStartRun(projectId);
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
