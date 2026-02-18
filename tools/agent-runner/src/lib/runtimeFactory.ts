import type { AgentRuntime } from "./types.js";
import { AnthropicCompatibleProvider } from "../providers/anthropicCompatible.js";
import { OpenAiCompatibleProvider } from "../providers/openaiCompatible.js";
import { HeuristicRuntime } from "../runtimes/heuristicRuntime.js";
import { LlmRuntime } from "../runtimes/llmRuntime.js";

export type RuntimeFactoryEnv = Record<string, string | undefined>;

export function createRuntimeFromEnv(env: RuntimeFactoryEnv = process.env): AgentRuntime {
  const provider = (env.LLM_PROVIDER_DEFAULT || "openai").toLowerCase();
  const model =
    env.LLM_MODEL_DEFAULT ||
    (provider === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4.1");

  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) {
      return new HeuristicRuntime();
    }

    return new LlmRuntime(
      new AnthropicCompatibleProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: env.ANTHROPIC_BASE_URL,
        model,
      }),
    );
  }

  if (!env.OPENAI_API_KEY) {
    return new HeuristicRuntime();
  }

  return new LlmRuntime(
    new OpenAiCompatibleProvider({
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL,
      model,
    }),
  );
}
