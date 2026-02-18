import { promises as fs } from "node:fs";
import type { RunPlan } from "./types.js";

export interface TestResult {
  executed: boolean;
  success: boolean;
}

export function buildStatusAppendix(
  runPlan: RunPlan,
  runtimeId: string,
  testBefore: TestResult,
  testAfter: TestResult,
): string {
  const now = new Date().toISOString();
  return [
    "",
    `## Run ${now}`,
    "",
    "### Runtime",
    `- Agent runtime: ${runtimeId}`,
    "",
    "### Attempted",
    `- ${runPlan.attempted}`,
    "",
    "### Changed",
    `- ${runPlan.changed}`,
    "",
    "### Works",
    `- ${runPlan.works}`,
    "",
    "### Broken",
    `- ${runPlan.broken}`,
    "",
    "### Test-First Workflow Attempt",
    `- Pre-change tests: ${
      testBefore.executed ? (testBefore.success ? "passed" : "failed") : "not run"
    }`,
    `- Post-change tests: ${
      testAfter.executed ? (testAfter.success ? "passed" : "failed") : "not run"
    }`,
    "",
    "### Next Milestone",
    `- ${runPlan.nextMilestone}`,
    "",
  ].join("\n");
}

export async function appendStatus(statusPath: string, appendix: string): Promise<void> {
  let current = "";
  try {
    current = await fs.readFile(statusPath, "utf8");
  } catch {
    current = "# STATUS\n";
  }

  await fs.writeFile(statusPath, current + appendix, "utf8");
}

export async function writeSummary(summaryPath: string, runPlan: RunPlan, runtimeId: string): Promise<void> {
  const summary = [
    "# Run Summary",
    "",
    `- Runtime: ${runtimeId}`,
    `- Attempted: ${runPlan.attempted}`,
    `- Changed: ${runPlan.changed}`,
    `- Works: ${runPlan.works}`,
    `- Broken: ${runPlan.broken}`,
    `- Next milestone: ${runPlan.nextMilestone}`,
    "",
    "## Notes",
    runPlan.summary,
    "",
  ].join("\n");

  await fs.writeFile(summaryPath, summary, "utf8");
}
