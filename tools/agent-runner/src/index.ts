#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendStatus, buildStatusAppendix, writeSummary, type TestResult } from "./lib/status.js";
import { loadRunnerContext } from "./lib/context.js";
import { createRuntimeFromEnv } from "./lib/runtimeFactory.js";

interface CliArgs {
  [key: string]: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

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

async function sendHeartbeat(args: CliArgs, phase: string, message: string): Promise<void> {
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
    // best-effort heartbeat
  });
}

function hasTestScript(): boolean {
  try {
    const pkgRaw = readFileSync("package.json", "utf8");
    const pkg = JSON.parse(pkgRaw) as { scripts?: { test?: string } };
    return typeof pkg.scripts?.test === "string" && pkg.scripts.test.length > 0;
  } catch {
    return false;
  }
}

function runTestsIfAvailable(): TestResult {
  if (!hasTestScript()) {
    return {
      executed: false,
      success: true,
    };
  }

  try {
    execSync("npm test", {
      stdio: "pipe",
      timeout: 12 * 60_000,
    });

    return {
      executed: true,
      success: true,
    };
  } catch {
    return {
      executed: true,
      success: false,
    };
  }
}

async function main() {
  const args = parseArgs(process.argv);

  await sendHeartbeat(args, "loading", "Reading vision, status, and repository state.");

  const context = await loadRunnerContext();
  const runtime = createRuntimeFromEnv(process.env);

  await sendHeartbeat(args, "planning", `Planning with runtime ${runtime.id}.`);
  const plan = await runtime.plan(context);

  await sendHeartbeat(args, "testing", "Attempting test-first workflow.");
  const testBefore = runTestsIfAvailable();
  const testAfter = runTestsIfAvailable();

  const appendix = buildStatusAppendix(plan, runtime.id, testBefore, testAfter);
  await appendStatus("STATUS.md", appendix);
  await writeSummary("RUN_SUMMARY.md", plan, runtime.id);

  await sendHeartbeat(args, "complete", "Run complete.");
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await writeSummary(
    "RUN_SUMMARY.md",
    {
      attempted: "Runner startup",
      changed: "No changes due to runtime failure.",
      works: "N/A",
      broken: message,
      nextMilestone: "Fix runtime issue and rerun.",
      summary: "Runner terminated early.",
    },
    "error",
  );

  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
