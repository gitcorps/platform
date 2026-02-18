export type RunStartGateReason = "ok" | "already_running" | "insufficient_balance" | "global_concurrency" | "global_daily_cap" | "project_daily_cap";
export interface RunStartConstraints {
    hasCurrentRun: boolean;
    balanceCents: number;
    minRunCents: number;
    globalActiveRuns: number;
    globalMaxConcurrentRuns: number;
    globalDailySpendCents: number;
    globalMaxDailySpendCents: number;
    projectDailySpendCents: number;
    projectMaxDailySpendCents: number;
    maxRunCents: number;
}
export interface BudgetBuckets {
    budgetCents: number;
    runtimeMinutes: number;
    tokenBudget: number;
}
export declare function computeRunBudgetCents(balanceCents: number, maxRunCents: number): number;
export declare function evaluateRunStartGate(constraints: RunStartConstraints): RunStartGateReason;
export declare function computeBudgetBuckets(budgetCents: number, runtimeMinutesPerUsd: number, tokensPerUsd: number): BudgetBuckets;
export declare function computeChargedCents(spentCents: number | undefined, budgetCents: number): number;
