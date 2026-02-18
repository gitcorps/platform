#!/usr/bin/env node
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    args[token.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

async function safeRead(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function listTree(dir, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const lines = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    lines.push(path.relative(".", fullPath) + (entry.isDirectory() ? "/" : ""));
    if (entry.isDirectory()) {
      lines.push(...(await listTree(fullPath, depth + 1, maxDepth)));
    }
  }
  return lines;
}

function extractJsonObject(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

class OpenAiProvider {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "https://api.openai.com/v1";
    this.model = config.model;
  }

  async complete(prompt) {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY missing");
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: "You are GitCorps coding planner." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI-compatible error: ${response.status}`);
    }

    const json = await response.json();
    return json.choices?.[0]?.message?.content || "";
  }
}

class AnthropicProvider {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "https://api.anthropic.com";
    this.model = config.model;
  }

  async complete(prompt) {
    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY missing");
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 900,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic-compatible error: ${response.status}`);
    }

    const json = await response.json();
    return Array.isArray(json.content) ? json.content[0]?.text || "" : "";
  }
}

class HeuristicRuntime {
  constructor() {
    this.id = "heuristic";
  }

  async plan(context) {
    const firstVisionLine = context.vision
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#"));

    const nextMilestone =
      firstVisionLine ||
      "Implement the next milestone from VISION.md with tests-first where feasible.";

    return {
      attempted: "Loaded VISION.md, STATUS.md, and repository state.",
      changed: "Updated STATUS.md and run summary artifacts.",
      works: "Agent run contract steps completed.",
      broken: "No automatic feature patch applied in heuristic mode.",
      nextMilestone,
      summary: "Heuristic runtime completed planning + status updates.",
    };
  }
}

class LlmRuntime {
  constructor(provider, id) {
    this.provider = provider;
    this.id = id;
  }

  async plan(context) {
    const prompt = [
      "Return strict JSON with keys attempted, changed, works, broken, nextMilestone, summary.",
      "Prioritize next milestone toward VISION.md and prefer test-first workflow.",
      "VISION.md:",
      context.vision || "[missing]",
      "",
      "STATUS.md:",
      context.status || "[missing]",
      "",
      "Repository tree:",
      context.tree.join("\n"),
    ].join("\n");

    try {
      const completion = await this.provider.complete(prompt);
      const parsed = extractJsonObject(completion);
      if (!parsed) {
        return new HeuristicRuntime().plan(context);
      }

      return {
        attempted: String(parsed.attempted || "Planned next milestone."),
        changed: String(parsed.changed || "Prepared incremental update."),
        works: String(parsed.works || "Planning succeeded."),
        broken: String(parsed.broken || "No explicit blockers provided."),
        nextMilestone: String(
          parsed.nextMilestone ||
            "Implement next milestone from VISION.md with tests-first where feasible.",
        ),
        summary: String(parsed.summary || "Run planning completed."),
      };
    } catch {
      return new HeuristicRuntime().plan(context);
    }
  }
}

function createRuntime() {
  const providerName = (process.env.LLM_PROVIDER_DEFAULT || "openai").toLowerCase();
  const model =
    process.env.LLM_MODEL_DEFAULT ||
    (providerName === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4.1");

  if (providerName === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return new LlmRuntime(
      new AnthropicProvider({
        apiKey: process.env.ANTHROPIC_API_KEY,
        baseUrl: process.env.ANTHROPIC_BASE_URL,
        model,
      }),
      "anthropic-compatible",
    );
  }

  if (process.env.OPENAI_API_KEY) {
    return new LlmRuntime(
      new OpenAiProvider({
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL,
        model,
      }),
      "openai-compatible",
    );
  }

  return new HeuristicRuntime();
}

async function sendHeartbeat(args, phase, message) {
  if (!args["backend-base-url"] || !args["run-token"] || !args["project-id"] || !args["run-id"]) {
    return;
  }

  await fetch(`${args["backend-base-url"]}/runHeartbeat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args["run-token"]}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      projectId: args["project-id"],
      runId: args["run-id"],
      phase,
      message,
    }),
  }).catch(() => {
    // best effort
  });
}

function runTests() {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    if (!pkg?.scripts?.test) {
      return { executed: false, success: true };
    }
  } catch {
    return { executed: false, success: true };
  }

  try {
    execSync("npm test", {
      stdio: "pipe",
      timeout: 12 * 60_000,
    });
    return { executed: true, success: true };
  } catch {
    return { executed: true, success: false };
  }
}

function statusAppendix(runPlan, runtimeId, testBefore, testAfter) {
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
    `- Pre-change tests: ${testBefore.executed ? (testBefore.success ? "passed" : "failed") : "not run"}`,
    `- Post-change tests: ${testAfter.executed ? (testAfter.success ? "passed" : "failed") : "not run"}`,
    "",
    "### Next Milestone",
    `- ${runPlan.nextMilestone}`,
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv);

  const [vision, status, tree] = await Promise.all([
    safeRead("VISION.md"),
    safeRead("STATUS.md"),
    listTree("."),
  ]);

  const runtime = createRuntime();
  await sendHeartbeat(args, "planning", "Loaded context and selected runtime.");

  const runPlan = await runtime.plan({ vision, status, tree });
  await sendHeartbeat(args, "testing", "Attempting tests before and after updates.");

  const testBefore = runTests();
  const testAfter = runTests();

  const updatedStatus = (status || "# STATUS\n") + statusAppendix(runPlan, runtime.id, testBefore, testAfter);
  await fs.writeFile("STATUS.md", updatedStatus, "utf8");

  const summary = [
    "# Run Summary",
    "",
    `- Runtime: ${runtime.id}`,
    `- Attempted: ${runPlan.attempted}`,
    `- Changed: ${runPlan.changed}`,
    `- Works: ${runPlan.works}`,
    `- Broken: ${runPlan.broken}`,
    `- Next milestone: ${runPlan.nextMilestone}`,
    `- Pre-change tests: ${testBefore.executed ? (testBefore.success ? "passed" : "failed") : "not run"}`,
    `- Post-change tests: ${testAfter.executed ? (testAfter.success ? "passed" : "failed") : "not run"}`,
    "",
    runPlan.summary,
    "",
  ].join("\n");

  await fs.writeFile("RUN_SUMMARY.md", summary, "utf8");
  await sendHeartbeat(args, "done", "Runner completed.");
  process.stdout.write(summary + "\n");
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  await fs.writeFile("RUN_SUMMARY.md", `# Run Summary\n\n- Failure: ${message}\n`, "utf8");
  process.stderr.write(message + "\n");
  process.exitCode = 1;
});
