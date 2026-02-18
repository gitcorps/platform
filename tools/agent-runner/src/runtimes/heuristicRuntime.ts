import type { AgentRuntime, RunnerContext, RunPlan } from "../lib/types.js";

export class HeuristicRuntime implements AgentRuntime {
  public readonly id = "heuristic";

  async plan(context: RunnerContext): Promise<RunPlan> {
    const nextLine = context.vision
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#"));

    const nextMilestone =
      nextLine ?? "Implement the first practical milestone from VISION.md with tests first.";

    return {
      attempted: "Parsed VISION.md + STATUS.md and selected the next milestone.",
      changed: "No automated code generation in heuristic mode; only status artifacts updated.",
      works: "Run planning and documentation update completed.",
      broken: "No feature code was generated in this run mode.",
      nextMilestone,
      summary: "Heuristic runtime completed planning and status reporting.",
    };
  }
}
