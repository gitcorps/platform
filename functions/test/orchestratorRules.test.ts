import { describe, expect, it } from "vitest";
import {
  computeBudgetBuckets,
  computeChargedCents,
  computeRunBudgetCents,
  evaluateRunStartGate,
  type RunStartConstraints,
} from "../src/lib/orchestratorRules";

const baseConstraints: RunStartConstraints = {
  hasCurrentRun: false,
  balanceCents: 5000,
  minRunCents: 200,
  globalActiveRuns: 1,
  globalMaxConcurrentRuns: 10,
  globalDailySpendCents: 0,
  globalMaxDailySpendCents: 100000,
  projectDailySpendCents: 0,
  projectMaxDailySpendCents: 10000,
  maxRunCents: 2500,
};

describe("orchestratorRules", () => {
  it("limits run budget by max run cents", () => {
    expect(computeRunBudgetCents(1000, 2500)).toBe(1000);
    expect(computeRunBudgetCents(3000, 2500)).toBe(2500);
  });

  it("blocks run when project already has active run", () => {
    expect(evaluateRunStartGate({ ...baseConstraints, hasCurrentRun: true })).toBe("already_running");
  });

  it("blocks run below minimum balance", () => {
    expect(evaluateRunStartGate({ ...baseConstraints, balanceCents: 100, minRunCents: 200 })).toBe(
      "insufficient_balance",
    );
  });

  it("blocks run on global concurrency", () => {
    expect(
      evaluateRunStartGate({
        ...baseConstraints,
        globalActiveRuns: 10,
        globalMaxConcurrentRuns: 10,
      }),
    ).toBe("global_concurrency");
  });

  it("blocks run on global daily cap", () => {
    expect(
      evaluateRunStartGate({
        ...baseConstraints,
        globalDailySpendCents: 99000,
        globalMaxDailySpendCents: 100000,
      }),
    ).toBe("global_daily_cap");
  });

  it("blocks run on project daily cap", () => {
    expect(
      evaluateRunStartGate({
        ...baseConstraints,
        projectDailySpendCents: 9000,
        projectMaxDailySpendCents: 10000,
      }),
    ).toBe("project_daily_cap");
  });

  it("computes runtime and token buckets from budget", () => {
    expect(computeBudgetBuckets(1250, 6, 30000)).toEqual({
      budgetCents: 1250,
      runtimeMinutes: 75,
      tokenBudget: 375000,
    });
  });

  it("caps charged cents at budget", () => {
    expect(computeChargedCents(500, 1000)).toBe(500);
    expect(computeChargedCents(1500, 1000)).toBe(1000);
    expect(computeChargedCents(undefined, 1000)).toBe(1000);
  });
});
