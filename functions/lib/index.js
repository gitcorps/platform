"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.githubPreflight = exports.maybeStartRunCallable = exports.retryPendingStripePayments = exports.recoverStaleRuns = exports.processRunQueue = exports.runFinished = exports.runHeartbeat = exports.runStarted = exports.onStripePaymentSucceeded = exports.onPaymentIntentProjectMapped = exports.onCheckoutSessionUpdated = exports.createFundingCheckoutSession = exports.createProject = void 0;
const node_buffer_1 = require("node:buffer");
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const node_crypto_1 = require("node:crypto");
const https_1 = require("firebase-functions/v2/https");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firestore_2 = require("firebase-functions/v2/firestore");
const zod_1 = require("zod");
const env_1 = require("./config/env");
const client_1 = require("./github/client");
const repo_1 = require("./github/repo");
const firestore_3 = require("./lib/firestore");
const githubPreflight_1 = require("./lib/githubPreflight");
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
async function upsertPendingStripePayment(input) {
    await (0, firestore_3.getDb)()
        .collection("pendingStripePayments")
        .doc(input.paymentIntentId)
        .set({
        uid: input.uid,
        paymentIntentId: input.paymentIntentId,
        paymentData: input.paymentData,
        reason: input.reason,
        attemptCount: firestore_1.FieldValue.increment(1),
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
}
async function clearPendingStripePayment(paymentIntentId) {
    await (0, firestore_3.getDb)().collection("pendingStripePayments").doc(paymentIntentId).delete().catch(() => {
        // best effort
    });
}
async function processSucceededStripePayment(input) {
    const projectId = await (0, payments_1.resolveProjectIdForPayment)(input.uid, input.paymentIntentId, input.paymentData);
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
    const amountCents = (0, payments_1.amountToCents)(input.paymentData.amount_received ??
        input.paymentData.amount ??
        input.paymentData.amount_total ??
        input.paymentData.amount_capturable);
    if (amountCents <= 0) {
        await upsertPendingStripePayment({
            uid: input.uid,
            paymentIntentId: input.paymentIntentId,
            paymentData: input.paymentData,
            reason: "invalid_amount",
        });
        firebase_functions_1.logger.error("Stripe payment had invalid amount", {
            paymentIntentId: input.paymentIntentId,
            rawAmount: input.paymentData.amount_received ??
                input.paymentData.amount ??
                input.paymentData.amount_total,
        });
        return "invalid_amount";
    }
    const credited = await (0, payments_1.creditProjectWalletFromPayment)({
        projectId: resolvedProjectId,
        paymentIntentId: input.paymentIntentId,
        uid: input.uid || null,
        amountCents,
    });
    async function tryStartRunFromFunding(source) {
        try {
            const runResult = await (0, orchestrator_1.maybeStartRun)(resolvedProjectId);
            firebase_functions_1.logger.info("maybeStartRun evaluated after funding event", {
                projectId: resolvedProjectId,
                paymentIntentId: input.paymentIntentId,
                source,
                runResult,
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            firebase_functions_1.logger.error("maybeStartRun threw after funding event; enqueueing fallback", {
                projectId: resolvedProjectId,
                paymentIntentId: input.paymentIntentId,
                source,
                error: message,
            });
            await (0, orchestrator_1.enqueueProjectForLater)(resolvedProjectId, "post_funding_start_failed");
        }
    }
    if (!credited) {
        await clearPendingStripePayment(input.paymentIntentId);
        firebase_functions_1.logger.info("Payment was already applied (idempotent)", {
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
async function processPendingStripePaymentIfPresent(paymentIntentId, fallbackUid) {
    const pendingSnap = await (0, firestore_3.getDb)().collection("pendingStripePayments").doc(paymentIntentId).get();
    if (!pendingSnap.exists) {
        return;
    }
    const pendingData = pendingSnap.data();
    const pendingUid = typeof pendingData.uid === "string" ? pendingData.uid : fallbackUid;
    const pendingPaymentData = pendingData.paymentData && typeof pendingData.paymentData === "object"
        ? pendingData.paymentData
        : null;
    if (!pendingUid || !pendingPaymentData) {
        firebase_functions_1.logger.error("Pending stripe payment record missing required fields", {
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
    const afterData = (after.data() || {});
    const paymentIntentId = (0, payments_1.extractPaymentIntentIdFromCheckoutSession)(afterData);
    if (!paymentIntentId) {
        return;
    }
    const beforeData = (before?.exists ? before.data() : {});
    const beforePaymentIntentId = (0, payments_1.extractPaymentIntentIdFromCheckoutSession)(beforeData);
    if (beforePaymentIntentId === paymentIntentId) {
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
    await processPendingStripePaymentIfPresent(paymentIntentId, event.params.uid);
});
exports.onPaymentIntentProjectMapped = (0, firestore_2.onDocumentWritten)({
    region,
    document: "paymentIntentProjects/{paymentIntentId}",
}, async (event) => {
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
    const fallbackUid = typeof after.get("uid") === "string" && String(after.get("uid")).length > 0
        ? String(after.get("uid"))
        : "";
    await processPendingStripePaymentIfPresent(paymentIntentId, fallbackUid);
});
exports.onStripePaymentSucceeded = (0, firestore_2.onDocumentWritten)({
    region,
    document: "customers/{uid}/payments/{paymentIntentId}",
}, async (event) => {
    const after = event.data?.after;
    const before = event.data?.before;
    if (!after?.exists) {
        return;
    }
    const uid = String(event.params.uid || "");
    const paymentIntentId = String(event.params.paymentIntentId || "");
    const paymentData = (after.data() || {});
    const beforeData = (before?.exists ? before.data() : {});
    const status = (0, payments_1.extractPaymentStatus)(paymentData).toLowerCase();
    const beforeStatus = (0, payments_1.extractPaymentStatus)(beforeData).toLowerCase();
    const succeededStatuses = new Set(["succeeded", "paid"]);
    if (!succeededStatuses.has(status)) {
        firebase_functions_1.logger.info("Ignoring non-succeeded payment event", { paymentIntentId, status });
        return;
    }
    if (succeededStatuses.has(beforeStatus)) {
        firebase_functions_1.logger.info("Ignoring duplicate succeeded payment transition", {
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
    firebase_functions_1.logger.info("Processed succeeded Stripe payment", {
        paymentIntentId,
        uid,
        status,
        result,
    });
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
exports.retryPendingStripePayments = (0, scheduler_1.onSchedule)({
    region,
    schedule: "every 5 minutes",
    timeoutSeconds: 540,
}, async () => {
    const pendingSnapshot = await (0, firestore_3.getDb)().collection("pendingStripePayments").limit(50).get();
    if (pendingSnapshot.empty) {
        return;
    }
    const outcomeCounts = {
        credited: 0,
        already_credited: 0,
        pending_mapping: 0,
        invalid_amount: 0,
    };
    for (const doc of pendingSnapshot.docs) {
        const data = doc.data();
        const uid = typeof data.uid === "string" ? data.uid : "";
        const paymentData = data.paymentData && typeof data.paymentData === "object"
            ? data.paymentData
            : null;
        if (!uid || !paymentData) {
            firebase_functions_1.logger.error("Skipping malformed pendingStripePayments document", {
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
        }
        catch (error) {
            firebase_functions_1.logger.error("retryPendingStripePayments failed for payment", {
                paymentIntentId: doc.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    firebase_functions_1.logger.info("retryPendingStripePayments completed", {
        scanned: pendingSnapshot.size,
        outcomes: outcomeCounts,
    });
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
exports.githubPreflight = (0, https_1.onCall)({
    region,
    memory: "256MiB",
}, async (request) => {
    assertAuth(request);
    const payload = zod_1.z
        .object({
        writeProbe: zod_1.z.boolean().optional(),
    })
        .parse(request.data ?? {});
    const writeProbeRequested = payload.writeProbe === true;
    const config = (0, env_1.getEnvConfig)();
    const org = config.GITHUB_ORG_NAME;
    const tokenPresent = Boolean(config.GITHUB_TOKEN);
    const result = {
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
    const octokit = await (0, client_1.getGithubClient)();
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
    }
    catch (error) {
        const err = error;
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
    }
    catch (error) {
        const err = error;
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
    }
    catch (error) {
        const err = error;
        result.errors.push({
            step: "membership",
            status: err.status,
            message: err.message || "Could not resolve org membership for authenticated user.",
        });
    }
    result.repoCreateHeuristic = (0, githubPreflight_1.computeRepoCreateHeuristic)({
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
        const probeRepoName = `gitcorps-preflight-${Date.now()}-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
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
                content: node_buffer_1.Buffer.from("ok\n", "utf8").toString("base64"),
                branch: "main",
            });
            result.writeProbeDetails.contentsWriteOk = true;
            result.checks.push("write_probe_contents_ok");
            await octokit.repos.createOrUpdateFileContents({
                owner: org,
                repo: probeRepoName,
                path: ".github/workflows/preflight-check.yml",
                message: "chore(preflight): verify workflow write",
                content: node_buffer_1.Buffer.from("name: preflight-check\non: workflow_dispatch\njobs: {}\n", "utf8").toString("base64"),
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
        }
        catch (error) {
            const err = error;
            result.writeProbeSucceeded = false;
            result.ok = false;
            result.errors.push({
                step: result.writeProbeDetails.repoCreated && !result.writeProbeDetails.contentsWriteOk
                    ? "writeProbeContents"
                    : result.writeProbeDetails.repoCreated &&
                        result.writeProbeDetails.contentsWriteOk &&
                        !result.writeProbeDetails.workflowWriteOk
                        ? "writeProbeWorkflow"
                        : result.writeProbeDetails.repoCreated ? "writeProbeDelete" : "writeProbeCreate",
                status: err.status,
                message: err.message ||
                    "Write probe failed while creating or deleting temporary repository.",
            });
        }
    }
    return result;
});
//# sourceMappingURL=index.js.map