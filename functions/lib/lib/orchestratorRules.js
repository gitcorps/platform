"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeRunBudgetCents = computeRunBudgetCents;
exports.evaluateRunStartGate = evaluateRunStartGate;
exports.computeBudgetBuckets = computeBudgetBuckets;
exports.computeChargedCents = computeChargedCents;
function computeRunBudgetCents(balanceCents, maxRunCents) {
    return Math.max(0, Math.min(balanceCents, maxRunCents));
}
function evaluateRunStartGate(constraints) {
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
    if (constraints.globalDailySpendCents + proposedBudgetCents >
        constraints.globalMaxDailySpendCents) {
        return "global_daily_cap";
    }
    if (constraints.projectDailySpendCents + proposedBudgetCents >
        constraints.projectMaxDailySpendCents) {
        return "project_daily_cap";
    }
    return "ok";
}
function computeBudgetBuckets(budgetCents, runtimeMinutesPerUsd, tokensPerUsd) {
    const budgetUsd = budgetCents / 100;
    return {
        budgetCents,
        runtimeMinutes: Math.max(1, Math.floor(budgetUsd * runtimeMinutesPerUsd)),
        tokenBudget: Math.max(1, Math.floor(budgetUsd * tokensPerUsd)),
    };
}
function computeChargedCents(spentCents, budgetCents) {
    if (spentCents === undefined) {
        return budgetCents;
    }
    if (spentCents < 0) {
        return 0;
    }
    return Math.min(spentCents, budgetCents);
}
//# sourceMappingURL=orchestratorRules.js.map