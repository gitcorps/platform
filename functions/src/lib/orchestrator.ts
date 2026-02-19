import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { getEnvConfig } from "../config/env";
import { dispatchWorkflow, syncProjectAutomationFiles } from "../github/repo";
import { gitcorpsRunnerScript } from "../templates/runner";
import { gitcorpsWorkflowYaml } from "../templates/workflow";
import {
  computeBudgetBuckets,
  computeRunBudgetCents,
  evaluateRunStartGate,
  type RunStartGateReason,
} from "./orchestratorRules";
import { getDb } from "./firestore";
import { issueRunToken } from "./runToken";

export interface MaybeStartRunResult {
  state:
    | "started"
    | "skipped"
    | "missing_project"
    | "dispatch_failed"
    | "queue_enqueued"
    | "error";
  runId?: string;
  gateReason?: RunStartGateReason;
  message?: string;
}

type FirestoreLikeError = {
  code?: unknown;
  message?: unknown;
};

function isFailedPreconditionError(error: unknown): boolean {
  const candidate = error as FirestoreLikeError;
  if (candidate?.code === 9 || candidate?.code === "failed-precondition") {
    return true;
  }

  const message = typeof candidate?.message === "string" ? candidate.message : "";
  return message.includes("FAILED_PRECONDITION") || message.includes("failed-precondition");
}

function serializeError(error: unknown): { code?: unknown; message: string } {
  const candidate = error as FirestoreLikeError;
  return {
    code: candidate?.code,
    message: typeof candidate?.message === "string" ? candidate.message : String(error),
  };
}

function throwIndexHintIfNeeded(operation: string, error: unknown): never {
  if (isFailedPreconditionError(error)) {
    const details = serializeError(error);
    logger.error("Firestore FAILED_PRECONDITION in orchestrator.", {
      operation,
      ...details,
      hint: "Deploy firestore indexes (collection-group indexes for runs.status and runs.endedAt).",
    });
    throw new Error(
      `Firestore FAILED_PRECONDITION during ${operation}. Missing Firestore indexes. Deploy firestore.indexes.json. Original: ${details.message}`,
    );
  }
  throw error instanceof Error ? error : new Error(String(error));
}

function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function getActiveRunCount(): Promise<number> {
  const snap = await getDb().collection("activeRuns").get();
  return snap.size;
}

async function getGlobalDailyChargedCents(now = new Date()): Promise<number> {
  const start = Timestamp.fromDate(utcDayStart(now));
  try {
    const snap = await getDb().collectionGroup("runs").where("endedAt", ">=", start).get();
    return snap.docs.reduce((sum, doc) => {
      const charged = doc.get("chargedCents");
      return sum + (typeof charged === "number" ? charged : 0);
    }, 0);
  } catch (error) {
    throwIndexHintIfNeeded("getGlobalDailyChargedCents", error);
  }
}

async function getProjectDailyChargedCents(projectId: string, now = new Date()): Promise<number> {
  const start = Timestamp.fromDate(utcDayStart(now));
  try {
    const runs = await getDb()
      .collection("projects")
      .doc(projectId)
      .collection("runs")
      .where("endedAt", ">=", start)
      .get();
    return runs.docs.reduce((sum, doc) => {
      const charged = doc.get("chargedCents");
      return sum + (typeof charged === "number" ? charged : 0);
    }, 0);
  } catch (error) {
    throwIndexHintIfNeeded("getProjectDailyChargedCents", error);
  }
}

export async function enqueueProjectForLater(
  projectId: string,
  reason: string,
): Promise<void> {
  const queueRef = getDb().collection("runQueue").doc(projectId);

  await getDb().runTransaction(async (tx) => {
    const queueSnap = await tx.get(queueRef);
    if (!queueSnap.exists) {
      tx.set(queueRef, {
        projectId,
        reason,
        enqueuedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    tx.update(queueRef, {
      reason,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

async function clearQueueEntry(projectId: string): Promise<void> {
  await getDb().collection("runQueue").doc(projectId).delete().catch(() => {
    // best effort only
  });
}

export async function maybeStartRun(projectId: string): Promise<MaybeStartRunResult> {
  const config = getEnvConfig();
  const db = getDb();
  const projectRef = db.collection("projects").doc(projectId);
  const projectSnap = await projectRef.get();

  if (!projectSnap.exists) {
    return { state: "missing_project" };
  }

  const projectData = projectSnap.data() ?? {};
  const currentRunId =
    typeof projectData.currentRunId === "string" ? projectData.currentRunId : null;
  const balanceCents =
    typeof projectData.balanceCents === "number" ? projectData.balanceCents : 0;
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

  const gateReason = evaluateRunStartGate({
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
    if (
      gateReason === "global_concurrency" ||
      gateReason === "global_daily_cap" ||
      gateReason === "project_daily_cap"
    ) {
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
  const issuedToken = issueRunToken(config.RUN_TOKEN_TTL_MINUTES);
  let runBudgetCents = computeRunBudgetCents(balanceCents, config.maxRunCents);

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

    runBudgetCents = computeRunBudgetCents(freshBalanceCents, config.maxRunCents);
    const budgetBuckets = computeBudgetBuckets(
      runBudgetCents,
      config.BUCKET_RUNTIME_MINUTES_PER_USD,
      config.BUCKET_TOKENS_PER_USD,
    );

    tx.set(runRef, {
      status: "queued",
      budgetCents: runBudgetCents,
      budgetRuntimeMinutes: budgetBuckets.runtimeMinutes,
      budgetTokenLimit: budgetBuckets.tokenBudget,
      agentRuntime: config.AGENT_RUNTIME_DEFAULT,
      createdAt: FieldValue.serverTimestamp(),
      heartbeatAt: FieldValue.serverTimestamp(),
      runTokenHash: issuedToken.tokenHash,
      runTokenExpiresAt: issuedToken.expiresAt,
    });

    tx.update(projectRef, {
      currentRunId: runRef.id,
      status: "active",
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.set(db.collection("activeRuns").doc(projectId), {
      projectId,
      runId: runRef.id,
      createdAt: FieldValue.serverTimestamp(),
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
    logger.error(message);
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

    await syncProjectAutomationFiles({
      repoFullName,
      workflowYaml: gitcorpsWorkflowYaml(),
      runnerScript: gitcorpsRunnerScript(),
    });

    await dispatchWorkflow({
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to dispatch workflow", { projectId, runId: runRef.id, message });
    await markRunDispatchFailure(projectId, runRef.id, message);
    return {
      state: "dispatch_failed",
      runId: runRef.id,
      message,
    };
  }
}

async function markRunDispatchFailure(
  projectId: string,
  runId: string,
  reason: string,
): Promise<void> {
  const db = getDb();
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
      endedAt: FieldValue.serverTimestamp(),
      summaryMd: `Dispatch failed before run start: ${reason}`,
      chargedCents: 0,
    });

    if (projectSnap.exists && projectSnap.get("currentRunId") === runId) {
      tx.update(projectRef, {
        currentRunId: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    tx.delete(db.collection("activeRuns").doc(projectId));
  });

  await enqueueProjectForLater(projectId, "dispatch_failed");
}

export async function processRunQueueBatch(limit: number): Promise<void> {
  let queueSnap;
  try {
    queueSnap = await getDb()
      .collection("runQueue")
      .orderBy("enqueuedAt", "asc")
      .limit(limit)
      .get();
  } catch (error) {
    throwIndexHintIfNeeded("processRunQueueBatch.queryQueue", error);
  }

  for (const doc of queueSnap.docs) {
    const projectId = String(doc.get("projectId") || doc.id);
    let result: MaybeStartRunResult;
    try {
      result = await maybeStartRun(projectId);
    } catch (error) {
      logger.error("maybeStartRun failed during queue processing", {
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

export async function recoverStaleQueuedRuns(staleMinutes = 15): Promise<void> {
  const cutoff = Timestamp.fromDate(new Date(Date.now() - staleMinutes * 60_000));
  let staleRuns;
  try {
    staleRuns = await getDb().collectionGroup("runs").where("status", "==", "queued").get();
  } catch (error) {
    throwIndexHintIfNeeded("recoverStaleQueuedRuns.queryRunsByStatus", error);
  }

  for (const runDoc of staleRuns.docs) {
    const createdAt = runDoc.get("createdAt") as Timestamp | undefined;
    if (!createdAt || createdAt.toMillis() > cutoff.toMillis()) {
      continue;
    }

    const runPath = runDoc.ref.path.split("/");
    const projectId = runPath[1];
    const runId = runPath[3];

    if (!projectId || !runId) {
      continue;
    }

    const db = getDb();
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
        endedAt: FieldValue.serverTimestamp(),
        summaryMd:
          "Run did not start within the stale window. Marked failed and re-queued automatically.",
        chargedCents: 0,
      });

      if (freshProject.get("currentRunId") === runId) {
        tx.update(projectRef, {
          currentRunId: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      tx.delete(db.collection("activeRuns").doc(projectId));
    });

    await enqueueProjectForLater(projectId, "stale_queued_run");
  }
}

export async function recoverStaleRunningRuns(staleMinutes = 90): Promise<void> {
  const cutoff = Timestamp.fromDate(new Date(Date.now() - staleMinutes * 60_000));
  let staleRuns;
  try {
    staleRuns = await getDb().collectionGroup("runs").where("status", "==", "running").get();
  } catch (error) {
    throwIndexHintIfNeeded("recoverStaleRunningRuns.queryRunsByStatus", error);
  }

  for (const runDoc of staleRuns.docs) {
    const heartbeatAt = runDoc.get("heartbeatAt") as Timestamp | undefined;
    if (!heartbeatAt || heartbeatAt.toMillis() > cutoff.toMillis()) {
      continue;
    }

    const runPath = runDoc.ref.path.split("/");
    const projectId = runPath[1];
    const runId = runPath[3];

    if (!projectId || !runId) {
      continue;
    }

    const db = getDb();
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
        endedAt: FieldValue.serverTimestamp(),
        spentCents: budgetCents,
        chargedCents: budgetCents,
        summaryMd:
          "Run heartbeat became stale and was auto-terminated. Charged full run budget to avoid unmetered compute.",
      });

      if (shouldClearCurrent) {
        tx.update(projectRef, {
          currentRunId: null,
          balanceCents: Math.max(0, currentBalance - budgetCents),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      tx.delete(db.collection("activeRuns").doc(projectId));
    });

    await enqueueProjectForLater(projectId, "stale_running_run");
  }
}
