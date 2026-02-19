import { describe, expect, it } from "vitest";
import { gitcorpsAgentInstructions } from "../src/templates/agent";
import { gitcorpsRunnerScript } from "../src/templates/runner";
import { gitcorpsWorkflowYaml } from "../src/templates/workflow";

describe("workflow template", () => {
  it("uses Copilot CLI PAT execution with backend callbacks", () => {
    const yaml = gitcorpsWorkflowYaml();

    expect(yaml).toContain("npm install -g @github/copilot");
    expect(yaml).toContain("copilot --version");
    expect(yaml).toContain("node tools/gitcorps_runner.mjs");
    expect(yaml).toContain("Notify backend runStarted");
    expect(yaml).toContain("Notify backend runFinished");
    expect(yaml).toContain("GITCORPS_BOT_TOKEN");
    expect(yaml).toContain("Commit agent changes");
    expect(yaml).toContain("actions/upload-artifact@v4");
    expect(yaml).not.toContain("agent-task");
  });
});

describe("runner template", () => {
  it("invokes Copilot CLI loop and does not use direct provider HTTP calls", () => {
    const runner = gitcorpsRunnerScript();

    expect(runner).toContain("runCommand('copilot'");
    expect(runner).toContain("--allow-all");
    expect(runner).toContain("--no-ask-user");
    expect(runner).toContain("Missing GH_TOKEN/GITHUB_TOKEN");
    expect(runner).toContain("VISION.md is missing or empty.");
    expect(runner).toContain("STATUS.md is missing or empty.");
    expect(runner).not.toContain("agent-task");
    expect(runner).not.toContain("/responses");
    expect(runner).not.toContain("/chat/completions");
    expect(runner).not.toContain("/v1/messages");
  });
});

describe("custom agent template", () => {
  it("enforces vision, status, and test-first contract", () => {
    const agentMd = gitcorpsAgentInstructions();

    expect(agentMd).toContain("name: gitcorps");
    expect(agentMd).toContain("description:");
    expect(agentMd).toContain("Read `VISION.md`");
    expect(agentMd).toContain("`STATUS.md`");
    expect(agentMd).toContain("Prefer test-first development");
    expect(agentMd).toContain("Commit your changes");
  });
});
