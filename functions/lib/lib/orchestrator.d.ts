import { type RunStartGateReason } from "./orchestratorRules";
export interface MaybeStartRunResult {
    state: "started" | "skipped" | "missing_project" | "dispatch_failed" | "queue_enqueued" | "error";
    runId?: string;
    gateReason?: RunStartGateReason;
    message?: string;
}
export declare function enqueueProjectForLater(projectId: string, reason: string): Promise<void>;
export declare function maybeStartRun(projectId: string): Promise<MaybeStartRunResult>;
export declare function processRunQueueBatch(limit: number): Promise<void>;
export declare function recoverStaleQueuedRuns(staleMinutes?: number): Promise<void>;
export declare function recoverStaleRunningRuns(staleMinutes?: number): Promise<void>;
