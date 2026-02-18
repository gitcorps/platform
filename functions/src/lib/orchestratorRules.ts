export type RunStartGateReason =
  | "ok"
  | "already_running"
  | "insufficient_balance"
  | "global_concurrency"
  | "global_daily_cap"
  | "project_daily_cap";

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

export function computeRunBudgetCents(balanceCents: number, maxRunCents: number): number {
  return Math.max(0, Math.min(balanceCents, maxRunCents));
}

export function evaluateRunStartGate(constraints: RunStartConstraints): RunStartGateReason {
  if (constraints.hasCurrentRun) {
    return "already_running";
  }

  if (constraints.balanceCents < constraints.minRunCents) {
    return "insufficient_balance";
  }

  if (constraints.globalActiveRuns >= constraints.globalMaxConcurrentRuns) {
    return "global_concurrency";
  }

  const proposedBudgetCents = computeRunBudgetCents(constraints.balanceCents, constraints.maxRunCents);

  if (
    constraints.globalDailySpendCents + proposedBudgetCents >
    constraints.globalMaxDailySpendCents
  ) {
    return "global_daily_cap";
  }

  if (
    constraints.projectDailySpendCents + proposedBudgetCents >
    constraints.projectMaxDailySpendCents
  ) {
    return "project_daily_cap";
  }

  return "ok";
}

export function computeBudgetBuckets(
  budgetCents: number,
  runtimeMinutesPerUsd: number,
  tokensPerUsd: number,
): BudgetBuckets {
  const budgetUsd = budgetCents / 100;
  return {
    budgetCents,
    runtimeMinutes: Math.max(1, Math.floor(budgetUsd * runtimeMinutesPerUsd)),
    tokenBudget: Math.max(1, Math.floor(budgetUsd * tokensPerUsd)),
  };
}

export function computeChargedCents(spentCents: number | undefined, budgetCents: number): number {
  if (spentCents === undefined) {
    return budgetCents;
  }

  if (spentCents < 0) {
    return 0;
  }

  return Math.min(spentCents, budgetCents);
}
