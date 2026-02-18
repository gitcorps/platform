import { describe, expect, it } from "vitest";
import { createRuntimeFromEnv } from "../src/lib/runtimeFactory.js";

describe("createRuntimeFromEnv", () => {
  it("falls back to heuristic when openai key is missing", () => {
    const runtime = createRuntimeFromEnv({
      LLM_PROVIDER_DEFAULT: "openai",
      LLM_MODEL_DEFAULT: "gpt-4.1",
    });

    expect(runtime.id).toBe("heuristic");
  });

  it("falls back to heuristic when anthropic key is missing", () => {
    const runtime = createRuntimeFromEnv({
      LLM_PROVIDER_DEFAULT: "anthropic",
      LLM_MODEL_DEFAULT: "claude-3-5-sonnet-latest",
    });

    expect(runtime.id).toBe("heuristic");
  });

  it("builds llm runtime when openai-compatible key exists", () => {
    const runtime = createRuntimeFromEnv({
      LLM_PROVIDER_DEFAULT: "openai",
      LLM_MODEL_DEFAULT: "gpt-4.1",
      OPENAI_API_KEY: "test-key",
    });

    expect(runtime.id).toBe("llm:openai-compatible");
  });

  it("builds llm runtime when anthropic-compatible key exists", () => {
    const runtime = createRuntimeFromEnv({
      LLM_PROVIDER_DEFAULT: "anthropic",
      LLM_MODEL_DEFAULT: "claude-3-5-sonnet-latest",
      ANTHROPIC_API_KEY: "test-key",
    });

    expect(runtime.id).toBe("llm:anthropic-compatible");
  });
});
