"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueProjectForLater = enqueueProjectForLater;
exports.maybeStartRun = maybeStartRun;
exports.processRunQueueBatch = processRunQueueBatch;
exports.recoverStaleQueuedRuns = recoverStaleQueuedRuns;
exports.recoverStaleRunningRuns = recoverStaleRunningRuns;
const firestore_1 = require("firebase-admin/firestore");
const firebase_functions_1 = require("firebase-functions");
const env_1 = require("../config/env");
const repo_1 = require("../github/repo");
const agent_1 = require("../templates/agent");
const runner_1 = require("../templates/runner");
const workflow_1 = require("../templates/workflow");
const orchestratorRules_1 = require("./orchestratorRules");
const firestore_2 = require("./firestore");
const runToken_1 = require("./runToken");
function isFailedPreconditionError(error) {
    const candidate = error;
    if (candidate?.code === 9 || candidate?.code === "failed-precondition") {
        return true;
    }
    const message = typeof candidate?.message === "string" ? candidate.message : "";
    return message.includes("FAILED_PRECONDITION") || message.includes("failed-precondition");
}
function serializeError(error) {
    const candidate = error;
    return {
        code: candidate?.code,
        message: typeof candidate?.message === "string" ? candidate.message : String(error),
    };
}
function throwIndexHintIfNeeded(operation, error) {
    if (isFailedPreconditionError(error)) {
        const details = serializeError(error);
        firebase_functions_1.logger.error("Firestore FAILED_PRECONDITION in orchestrator.", {
            operation,
            ...details,
            hint: "Deploy firestore indexes (collection-group indexes for runs.status and runs.endedAt).",
        });
        throw new Error(`Firestore FAILED_PRECONDITION during ${operation}. Missing Firestore indexes. Deploy firestore.indexes.json. Original: ${details.message}`);
    }
    throw error instanceof Error ? error : new Error(String(error));
}
function utcDayStart(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
async function getActiveRunCount() {
    const snap = await (0, firestore_2.getDb)().collection("activeRuns").get();
    return snap.size;
}
async function getGlobalDailyChargedCents(now = new Date()) {
    const start = firestore_1.Timestamp.fromDate(utcDayStart(now));
    try {
        const snap = await (0, firestore_2.getDb)().collectionGroup("runs").where("endedAt", ">=", start).get();
        return snap.docs.reduce((sum, doc) => {
            const charged = doc.get("chargedCents");
            return sum + (typeof charged === "number" ? charged : 0);
        }, 0);
    }
    catch (error) {
        throwIndexHintIfNeeded("getGlobalDailyChargedCents", error);
    }
}
async function getProjectDailyChargedCents(projectId, now = new Date()) {
    const start = firestore_1.Timestamp.fromDate(utcDayStart(now));
    try {
        const runs = await (0, firestore_2.getDb)()
            .collection("projects")
            .doc(projectId)
            .collection("runs")
            .where("endedAt", ">=", start)
            .get();
        return runs.docs.reduce((sum, doc) => {
            const charged = doc.get("chargedCents");
            return sum + (typeof charged === "number" ? charged : 0);
        }, 0);
    }
    catch (error) {
        throwIndexHintIfNeeded("getProjectDailyChargedCents", error);
    }
}
async function enqueueProjectForLater(projectId, reason) {
    const queueRef = (0, firestore_2.getDb)().collection("runQueue").doc(projectId);
    await (0, firestore_2.getDb)().runTransaction(async (tx) => {
        const queueSnap = await tx.get(queueRef);
        if (!queueSnap.exists) {
            tx.set(queueRef, {
                projectId,
                reason,
                enqueuedAt: firestore_1.FieldValue.serverTimestamp(),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            return;
        }
        tx.update(queueRef, {
            reason,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
}
async function clearQueueEntry(projectId) {
    await (0, firestore_2.getDb)().collection("runQueue").doc(projectId).delete().catch(() => {
        // best effort only
    });
}
async function maybeStartRun(projectId) {
    const config = (0, env_1.getEnvConfig)();
    const db = (0, firestore_2.getDb)();
    const projectRef = db.collection("projects").doc(projectId);
    const projectSnap = await projectRef.get();
    if (!projectSnap.exists) {
        return { state: "missing_project" };
    }
    const projectData = projectSnap.data() ?? {};
    const currentRunId = typeof projectData.currentRunId === "string" ? projectData.currentRunId : null;
    const balanceCents = typeof projectData.balanceCents === "number" ? projectData.balanceCents : 0;
    const projectStatus = String(projectData.status ?? "active");
    if (projectStatus !== "active") {
        return {
            state: "skipped",
            message: `Project status '${projectStatus}' is not runnable`,
        };
    }
    const [globalActiveRuns, globalDailySpendCents, projectDailySpendCents] = await Promise.all([
        getActiveRunCount(),
        getGlobalDailyChargedCents(),
        getProjectDailyChargedCents(projectId),
    ]);
    const gateReason = (0, orchestratorRules_1.evaluateRunStartGate)({
        hasCurrentRun: Boolean(currentRunId),
        balanceCents,
        minRunCents: config.minRunCents,
        globalActiveRuns,
        globalMaxConcurrentRuns: config.GLOBAL_MAX_CONCURRENT_RUNS,
        globalDailySpendCents,
        globalMaxDailySpendCents: config.globalMaxDailySpendCents,
        projectDailySpendCents,
        projectMaxDailySpendCents: config.perProjectMaxDailySpendCents,
        maxRunCents: config.maxRunCents,
    });
    if (gateReason !== "ok") {
        if (gateReason === "global_concurrency" ||
            gateReason === "global_daily_cap" ||
            gateReason === "project_daily_cap") {
            await enqueueProjectForLater(projectId, gateReason);
            return {
                state: "queue_enqueued",
                gateReason,
            };
        }
        return {
            state: "skipped",
            gateReason,
        };
    }
    const runRef = projectRef.collection("runs").doc();
    const issuedToken = (0, runToken_1.issueRunToken)(config.RUN_TOKEN_TTL_MINUTES);
    let runBudgetCents = (0, orchestratorRules_1.computeRunBudgetCents)(balanceCents, config.maxRunCents);
    const lockCreated = await db.runTransaction(async (tx) => {
        const freshProjectSnap = await tx.get(projectRef);
        if (!freshProjectSnap.exists) {
            return false;
        }
        const freshCurrentRunId = freshProjectSnap.get("currentRunId");
        const freshBalanceCents = Number(freshProjectSnap.get("balanceCents") ?? 0);
        if (freshCurrentRunId || freshBalanceCents < config.minRunCents) {
            return false;
        }
        runBudgetCents = (0, orchestratorRules_1.computeRunBudgetCents)(freshBalanceCents, config.maxRunCents);
        const budgetBuckets = (0, orchestratorRules_1.computeBudgetBuckets)(runBudgetCents, config.BUCKET_RUNTIME_MINUTES_PER_USD, config.BUCKET_TOKENS_PER_USD);
        tx.set(runRef, {
            status: "queued",
            budgetCents: runBudgetCents,
            budgetRuntimeMinutes: budgetBuckets.runtimeMinutes,
            budgetTokenLimit: budgetBuckets.tokenBudget,
            agentRuntime: config.AGENT_RUNTIME_DEFAULT,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
            heartbeatAt: firestore_1.FieldValue.serverTimestamp(),
            runTokenHash: issuedToken.tokenHash,
            runTokenExpiresAt: issuedToken.expiresAt,
        });
        tx.update(projectRef, {
            currentRunId: runRef.id,
            status: "active",
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        tx.set(db.collection("activeRuns").doc(projectId), {
            projectId,
            runId: runRef.id,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
        });
        tx.delete(db.collection("runQueue").doc(projectId));
        return true;
    });
    if (!lockCreated) {
        return {
            state: "skipped",
            gateReason: "already_running",
        };
    }
    if (!config.BACKEND_BASE_URL) {
        const message = "BACKEND_BASE_URL is required to dispatch workflow runs.";
        firebase_functions_1.logger.error(message);
        await markRunDispatchFailure(projectId, runRef.id, message);
        return {
            state: "dispatch_failed",
            runId: runRef.id,
            message,
        };
    }
    try {
        const repoFullName = String(projectData.repoFullName || "");
        if (!repoFullName) {
            throw new Error("project repoFullName is missing");
        }
        await (0, repo_1.syncProjectAutomationFiles)({
            repoFullName,
            workflowYaml: (0, workflow_1.gitcorpsWorkflowYaml)(),
            runnerScript: (0, runner_1.gitcorpsRunnerScript)(),
            agentInstructions: (0, agent_1.gitcorpsAgentInstructions)(),
        });
        await (0, repo_1.dispatchWorkflow)({
            repoFullName,
            workflowFile: "gitcorps-agent.yml",
            inputs: {
                projectId,
                runId: runRef.id,
                budgetCents: String(runBudgetCents),
                runToken: issuedToken.token,
                backendBaseUrl: config.BACKEND_BASE_URL,
                agentRuntime: config.AGENT_RUNTIME_DEFAULT,
            },
        });
        await clearQueueEntry(projectId);
        return {
            state: "started",
            runId: runRef.id,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        firebase_functions_1.logger.error("Failed to dispatch workflow", { projectId, runId: runRef.id, message });
        await markRunDispatchFailure(projectId, runRef.id, message);
        return {
            state: "dispatch_failed",
            runId: runRef.id,
            message,
        };
    }
}
async function markRunDispatchFailure(projectId, runId, reason) {
    const db = (0, firestore_2.getDb)();
    const projectRef = db.collection("projects").doc(projectId);
    const runRef = projectRef.collection("runs").doc(runId);
    await db.runTransaction(async (tx) => {
        const projectSnap = await tx.get(projectRef);
        const runSnap = await tx.get(runRef);
        if (!runSnap.exists) {
            return;
        }
        tx.update(runRef, {
            status: "failed",
            endedAt: firestore_1.FieldValue.serverTimestamp(),
            summaryMd: `Dispatch failed before run start: ${reason}`,
            chargedCents: 0,
        });
        if (projectSnap.exists && projectSnap.get("currentRunId") === runId) {
            tx.update(projectRef, {
                currentRunId: null,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
        }
        tx.delete(db.collection("activeRuns").doc(projectId));
    });
    await enqueueProjectForLater(projectId, "dispatch_failed");
}
async function processRunQueueBatch(limit) {
    let queueSnap;
    try {
        queueSnap = await (0, firestore_2.getDb)()
            .collection("runQueue")
            .orderBy("enqueuedAt", "asc")
            .limit(limit)
            .get();
    }
    catch (error) {
        throwIndexHintIfNeeded("processRunQueueBatch.queryQueue", error);
    }
    for (const doc of queueSnap.docs) {
        const projectId = String(doc.get("projectId") || doc.id);
        let result;
        try {
            result = await maybeStartRun(projectId);
        }
        catch (error) {
            firebase_functions_1.logger.error("maybeStartRun failed during queue processing", {
                projectId,
                ...serializeError(error),
            });
            continue;
        }
        if (result.state === "queue_enqueued" && result.gateReason === "global_concurrency") {
            break;
        }
    }
}
async function recoverStaleQueuedRuns(staleMinutes = 15) {
    const cutoff = firestore_1.Timestamp.fromDate(new Date(Date.now() - staleMinutes * 60_000));
    let staleRuns;
    try {
        staleRuns = await (0, firestore_2.getDb)().collectionGroup("runs").where("status", "==", "queued").get();
    }
    catch (error) {
        throwIndexHintIfNeeded("recoverStaleQueuedRuns.queryRunsByStatus", error);
    }
    for (const runDoc of staleRuns.docs) {
        const createdAt = runDoc.get("createdAt");
        if (!createdAt || createdAt.toMillis() > cutoff.toMillis()) {
            continue;
        }
        const runPath = runDoc.ref.path.split("/");
        const projectId = runPath[1];
        const runId = runPath[3];
        if (!projectId || !runId) {
            continue;
        }
        const db = (0, firestore_2.getDb)();
        const projectRef = db.collection("projects").doc(projectId);
        const projectSnap = await projectRef.get();
        if (!projectSnap.exists || projectSnap.get("currentRunId") !== runId) {
            continue;
        }
        await db.runTransaction(async (tx) => {
            const freshProject = await tx.get(projectRef);
            const freshRun = await tx.get(runDoc.ref);
            if (!freshProject.exists || !freshRun.exists) {
                return;
            }
            if (freshRun.get("status") !== "queued") {
                return;
            }
            tx.update(runDoc.ref, {
                status: "failed",
                endedAt: firestore_1.FieldValue.serverTimestamp(),
                summaryMd: "Run did not start within the stale window. Marked failed and re-queued automatically.",
                chargedCents: 0,
            });
            if (freshProject.get("currentRunId") === runId) {
                tx.update(projectRef, {
                    currentRunId: null,
                    updatedAt: firestore_1.FieldValue.serverTimestamp(),
                });
            }
            tx.delete(db.collection("activeRuns").doc(projectId));
        });
        await enqueueProjectForLater(projectId, "stale_queued_run");
    }
}
async function recoverStaleRunningRuns(staleMinutes = 90) {
    const cutoff = firestore_1.Timestamp.fromDate(new Date(Date.now() - staleMinutes * 60_000));
    let staleRuns;
    try {
        staleRuns = await (0, firestore_2.getDb)().collectionGroup("runs").where("status", "==", "running").get();
    }
    catch (error) {
        throwIndexHintIfNeeded("recoverStaleRunningRuns.queryRunsByStatus", error);
    }
    for (const runDoc of staleRuns.docs) {
        const heartbeatAt = runDoc.get("heartbeatAt");
        if (!heartbeatAt || heartbeatAt.toMillis() > cutoff.toMillis()) {
            continue;
        }
        const runPath = runDoc.ref.path.split("/");
        const projectId = runPath[1];
        const runId = runPath[3];
        if (!projectId || !runId) {
            continue;
        }
        const db = (0, firestore_2.getDb)();
        const projectRef = db.collection("projects").doc(projectId);
        await db.runTransaction(async (tx) => {
            const [freshProject, freshRun] = await Promise.all([tx.get(projectRef), tx.get(runDoc.ref)]);
            if (!freshProject.exists || !freshRun.exists) {
                return;
            }
            if (freshRun.get("status") !== "running") {
                return;
            }
            const budgetCents = Number(freshRun.get("budgetCents") ?? 0);
            const currentBalance = Number(freshProject.get("balanceCents") ?? 0);
            const shouldClearCurrent = freshProject.get("currentRunId") === runId;
            tx.update(runDoc.ref, {
                status: "failed",
                endedAt: firestore_1.FieldValue.serverTimestamp(),
                spentCents: budgetCents,
                chargedCents: budgetCents,
                summaryMd: "Run heartbeat became stale and was auto-terminated. Charged full run budget to avoid unmetered compute.",
            });
            if (shouldClearCurrent) {
                tx.update(projectRef, {
                    currentRunId: null,
                    balanceCents: Math.max(0, currentBalance - budgetCents),
                    updatedAt: firestore_1.FieldValue.serverTimestamp(),
                });
            }
            tx.delete(db.collection("activeRuns").doc(projectId));
        });
        await enqueueProjectForLater(projectId, "stale_running_run");
    }
}
//# sourceMappingURL=orchestrator.js.map