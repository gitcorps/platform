import type { AgentRuntime, LlmProvider, RunPlan, RunnerContext } from "../lib/types.js";
import { HeuristicRuntime } from "./heuristicRuntime.js";

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class LlmRuntime implements AgentRuntime {
  public readonly id: string;
  private readonly provider: LlmProvider;

  constructor(provider: LlmProvider) {
    this.provider = provider;
    this.id = `llm:${provider.id}`;
  }

  async plan(context: RunnerContext): Promise<RunPlan> {
    const prompt = [
      "You are GitCorps autonomous coding planner.",
      "Return strict JSON with keys: attempted, changed, works, broken, nextMilestone, summary.",
      "Prefer test-first workflow where feasible.",
      "", 
      "VISION.md:",
      context.vision || "[missing]",
      "",
      "STATUS.md:",
      context.status || "[missing]",
      "",
      "Tree:",
      context.tree.join("\\n"),
    ].join("\\n");

    try {
      const completion = await this.provider.complete(prompt);
      const json = extractJsonObject(completion);
      if (!json) {
        return new HeuristicRuntime().plan(context);
      }

      return {
        attempted: String(json.attempted ?? "Planned next milestone."),
        changed: String(json.changed ?? "Prepared milestone update."),
        works: String(json.works ?? "Planning completed."),
        broken: String(json.broken ?? "No blockers recorded."),
        nextMilestone: String(
          json.nextMilestone ??
            "Implement the next milestone from VISION.md with tests first where feasible.",
        ),
        summary: String(json.summary ?? "Run planning complete."),
      };
    } catch {
      return new HeuristicRuntime().plan(context);
    }
  }
}
