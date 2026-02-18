"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.maybeStartRunCallable = exports.recoverStaleRuns = exports.processRunQueue = exports.runFinished = exports.runHeartbeat = exports.runStarted = exports.onStripePaymentSucceeded = exports.onCheckoutSessionUpdated = exports.createFundingCheckoutSession = exports.createProject = void 0;
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const https_1 = require("firebase-functions/v2/https");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firestore_2 = require("firebase-functions/v2/firestore");
const zod_1 = require("zod");
const env_1 = require("./config/env");
const repo_1 = require("./github/repo");
const firestore_3 = require("./lib/firestore");
const orchestrator_1 = require("./lib/orchestrator");
const orchestratorRules_1 = require("./lib/orchestratorRules");
const payments_1 = require("./lib/payments");
const runAuth_1 = require("./lib/runAuth");
const urlSecurity_1 = require("./lib/urlSecurity");
const license_1 = require("./templates/license");
const runner_1 = require("./templates/runner");
const status_1 = require("./templates/status");
const workflow_1 = require("./templates/workflow");
const region = "us-central1";
const createProjectSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).max(120),
    slug: zod_1.z
        .string()
        .min(3)
        .max(80)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    manifestoMd: zod_1.z.string().min(20).max(200_000),
});
const createFundingCheckoutSchema = zod_1.z.object({
    projectId: zod_1.z.string().min(3),
    amountCents: zod_1.z.number().int().min(50).max(500_000),
    successUrl: zod_1.z.string().url(),
    cancelUrl: zod_1.z.string().url(),
});
function assertAuth(request) {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError("unauthenticated", "Authentication is required.");
    }
    return request.auth.uid;
}
async function ensureUserDocument(uid, displayName) {
    const userRef = (0, firestore_3.getDb)().collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (userSnap.exists) {
        return;
    }
    await userRef.set({
        createdAt: firestore_1.FieldValue.serverTimestamp(),
        displayName: displayName || "GitCorps User",
    });
}
exports.createProject = (0, https_1.onCall)({
    region,
    memory: "512MiB",
}, async (request) => {
    const uid = assertAuth(request);
    const payload = createProjectSchema.parse(request.data);
    const db = (0, firestore_3.getDb)();
    const displayName = request.auth?.token && typeof request.auth.token.name === "string"
        ? request.auth.token.name
        : undefined;
    await ensureUserDocument(uid, displayName ?? null);
    const config = (0, env_1.getEnvConfig)();
    const statusTemplate = (0, status_1.initialStatusTemplate)(payload.name);
    const workflowYaml = (0, workflow_1.gitcorpsWorkflowYaml)();
    const runnerScript = (0, runner_1.gitcorpsRunnerScript)();
    const projectRef = db.collection("projects").doc();
    const slugRef = db.collection("projectSlugs").doc(payload.slug);
    await db.runTransaction(async (tx) => {
        const slugSnap = await tx.get(slugRef);
        if (slugSnap.exists) {
            throw new https_1.HttpsError("already-exists", "Project slug already exists.");
        }
        tx.set(slugRef, {
            projectId: projectRef.id,
            createdByUid: uid,
            status: "reserved",
            createdAt: firestore_1.FieldValue.serverTimestamp(),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    const siteUrl = config.PROJECT_SITE_TEMPLATE?.includes("{slug}")
        ? `https://${config.PROJECT_SITE_TEMPLATE.replace("{slug}", payload.slug)}`
        : undefined;
    let repoInfo = null;
    try {
        repoInfo = await (0, repo_1.createProjectRepoAndSeed)({
            org: config.GITHUB_ORG_NAME,
            slug: payload.slug,
            name: payload.name,
            manifestoMd: payload.manifestoMd,
            statusTemplate,
            workflowYaml,
            runnerScript,
            licenseText: config.DEFAULT_LICENSE === "MIT" ? license_1.mitLicenseText : license_1.mitLicenseText,
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
            createdAt: firestore_1.FieldValue.serverTimestamp(),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        await slugRef.set({
            projectId: projectRef.id,
            repoFullName: repoInfo.repoFullName,
            status: "active",
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
        return {
            projectId: projectRef.id,
            repoUrl: repoInfo.repoUrl,
            repoFullName: repoInfo.repoFullName,
        };
    }
    catch (error) {
        if (repoInfo) {
            await slugRef.set({
                projectId: projectRef.id,
                repoFullName: repoInfo.repoFullName,
                status: "orphaned_repo",
                error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            }, { merge: true });
        }
        else {
            await slugRef.delete().catch(() => {
                // Best-effort cleanup.
            });
        }
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        firebase_functions_1.logger.error("createProject failed", {
            uid,
            slug: payload.slug,
            error: error instanceof Error ? error.message : String(error),
        });
        throw new https_1.HttpsError("internal", "Failed to create project. Check GitHub/org configuration and try again.");
    }
});
exports.createFundingCheckoutSession = (0, https_1.onCall)({
    region,
    memory: "256MiB",
}, async (request) => {
    const uid = assertAuth(request);
    const payload = createFundingCheckoutSchema.parse(request.data);
    const config = (0, env_1.getEnvConfig)();
    if (!(0, urlSecurity_1.isAllowedReturnUrl)(payload.successUrl, config.PUBLIC_SITE_DOMAIN)) {
        throw new https_1.HttpsError("invalid-argument", "Invalid successUrl host.");
    }
    if (!(0, urlSecurity_1.isAllowedReturnUrl)(payload.cancelUrl, config.PUBLIC_SITE_DOMAIN)) {
        throw new https_1.HttpsError("invalid-argument", "Invalid cancelUrl host.");
    }
    const projectSnap = await (0, firestore_3.getDb)().collection("projects").doc(payload.projectId).get();
    if (!projectSnap.exists) {
        throw new https_1.HttpsError("not-found", "Project not found.");
    }
    const projectName = String(projectSnap.get("name") || "GitCorps Project");
    const sessionRef = (0, firestore_3.getDb)()
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
        createdAt: firestore_1.FieldValue.serverTimestamp(),
    });
    await (0, firestore_3.getDb)()
        .collection("checkoutSessionProjects")
        .doc(sessionRef.id)
        .set({
        uid,
        projectId: payload.projectId,
        amountCents: payload.amountCents,
        createdAt: firestore_1.FieldValue.serverTimestamp(),
    });
    return {
        sessionDocumentPath: sessionRef.path,
        sessionId: sessionRef.id,
    };
});
exports.onCheckoutSessionUpdated = (0, firestore_2.onDocumentWritten)({
    region,
    document: "customers/{uid}/checkout_sessions/{sessionId}",
}, async (event) => {
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
    const mapping = await (0, firestore_3.getDb)()
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
    await (0, firestore_3.getDb)()
        .collection("paymentIntentProjects")
        .doc(paymentIntentId)
        .set({
        projectId,
        sessionId: event.params.sessionId,
        uid: event.params.uid,
        createdAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
});
exports.onStripePaymentSucceeded = (0, firestore_2.onDocumentCreated)({
    region,
    document: "customers/{uid}/payments/{paymentIntentId}",
}, async (event) => {
    const uid = String(event.params.uid || "");
    const paymentIntentId = String(event.params.paymentIntentId || "");
    const paymentData = event.data?.data() || {};
    const status = String(paymentData.status || "succeeded");
    if (status !== "succeeded") {
        firebase_functions_1.logger.info("Ignoring non-succeeded payment event", { paymentIntentId, status });
        return;
    }
    const projectId = await (0, payments_1.resolveProjectIdForPayment)(uid, paymentIntentId, paymentData);
    if (!projectId) {
        firebase_functions_1.logger.error("Unable to map Stripe payment to project", { uid, paymentIntentId });
        return;
    }
    const amountCents = (0, payments_1.amountToCents)(paymentData.amount_received ?? paymentData.amount ?? paymentData.amount_total);
    if (amountCents <= 0) {
        firebase_functions_1.logger.error("Stripe payment had invalid amount", {
            paymentIntentId,
            rawAmount: paymentData.amount_received ?? paymentData.amount,
        });
        return;
    }
    const credited = await (0, payments_1.creditProjectWalletFromPayment)({
        projectId,
        paymentIntentId,
        uid: uid || null,
        amountCents,
    });
    if (!credited) {
        firebase_functions_1.logger.info("Payment was already applied (idempotent)", { paymentIntentId, projectId });
        return;
    }
    await (0, orchestrator_1.maybeStartRun)(projectId);
});
function methodNotAllowed(res) {
    res.status(405).json({ error: "Method not allowed" });
}
exports.runStarted = (0, https_1.onRequest)({ region }, async (req, res) => {
    if (req.method !== "POST") {
        methodNotAllowed(res);
        return;
    }
    const auth = await (0, runAuth_1.validateRunTokenFromRequest)(req);
    if (!auth.ok) {
        res.status(auth.status).json({ error: auth.message });
        return;
    }
    const { projectId, runId } = auth.payload;
    const runRef = (0, firestore_3.getDb)().collection("projects").doc(projectId).collection("runs").doc(runId);
    await runRef.set({
        status: "running",
        startedAt: firestore_1.FieldValue.serverTimestamp(),
        heartbeatAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
    res.status(200).json({ ok: true });
});
exports.runHeartbeat = (0, https_1.onRequest)({ region }, async (req, res) => {
    if (req.method !== "POST") {
        methodNotAllowed(res);
        return;
    }
    const auth = await (0, runAuth_1.validateRunTokenFromRequest)(req);
    if (!auth.ok) {
        res.status(auth.status).json({ error: auth.message });
        return;
    }
    const { projectId, runId } = auth.payload;
    const body = (req.body || {});
    const runRef = (0, firestore_3.getDb)().collection("projects").doc(projectId).collection("runs").doc(runId);
    await runRef.set({
        heartbeatAt: firestore_1.FieldValue.serverTimestamp(),
        heartbeatPhase: typeof body.phase === "string" ? body.phase : null,
        heartbeatMessage: typeof body.message === "string" ? body.message.slice(0, 500) : null,
    }, { merge: true });
    res.status(200).json({ ok: true });
});
const runFinishedSchema = zod_1.z.object({
    projectId: zod_1.z.string().min(3),
    runId: zod_1.z.string().min(3),
    status: zod_1.z.enum(["succeeded", "failed", "out_of_funds"]),
    summaryMd: zod_1.z.string().min(1).max(100_000),
    spentCents: zod_1.z.number().int().min(0).optional(),
});
exports.runFinished = (0, https_1.onRequest)({ region }, async (req, res) => {
    if (req.method !== "POST") {
        methodNotAllowed(res);
        return;
    }
    const auth = await (0, runAuth_1.validateRunTokenFromRequest)(req);
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
    const db = (0, firestore_3.getDb)();
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
        const chargedCents = (0, orchestratorRules_1.computeChargedCents)(spentCents, budgetCents);
        const currentBalance = Number(projectSnap.get("balanceCents") ?? 0);
        tx.update(runRef, {
            status,
            spentCents: chargedCents,
            chargedCents,
            endedAt: firestore_1.FieldValue.serverTimestamp(),
            heartbeatAt: firestore_1.FieldValue.serverTimestamp(),
            summaryMd,
            runTokenHash: firestore_1.FieldValue.delete(),
            runTokenExpiresAt: firestore_1.FieldValue.delete(),
        });
        if (projectSnap.get("currentRunId") === runId) {
            tx.update(projectRef, {
                currentRunId: null,
                balanceCents: Math.max(0, currentBalance - chargedCents),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
        }
        tx.delete(db.collection("activeRuns").doc(projectId));
    });
    await (0, orchestrator_1.maybeStartRun)(projectId).catch((error) => {
        firebase_functions_1.logger.error("Auto-continue maybeStartRun failed", {
            projectId,
            error: error instanceof Error ? error.message : String(error),
        });
    });
    res.status(200).json({ ok: true });
});
exports.processRunQueue = (0, scheduler_1.onSchedule)({
    region,
    schedule: "every 1 minutes",
    timeoutSeconds: 540,
}, async () => {
    const config = (0, env_1.getEnvConfig)();
    await (0, orchestrator_1.processRunQueueBatch)(config.RUN_QUEUE_CHECK_LIMIT);
});
exports.recoverStaleRuns = (0, scheduler_1.onSchedule)({
    region,
    schedule: "every 5 minutes",
    timeoutSeconds: 540,
}, async () => {
    await (0, orchestrator_1.recoverStaleQueuedRuns)();
    await (0, orchestrator_1.recoverStaleRunningRuns)();
});
exports.maybeStartRunCallable = (0, https_1.onCall)({
    region,
    memory: "256MiB",
}, async (request) => {
    assertAuth(request);
    const schema = zod_1.z.object({ projectId: zod_1.z.string().min(3) });
    const payload = schema.parse(request.data);
    const result = await (0, orchestrator_1.maybeStartRun)(payload.projectId);
    return {
        ...result,
        defaults: {
            githubOrgName: (0, env_1.getEnvConfig)().GITHUB_ORG_NAME || "gitcorps",
        },
    };
});
//# sourceMappingURL=index.js.map