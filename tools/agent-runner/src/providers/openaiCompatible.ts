import { z } from "zod";
import type { LlmProvider } from "../lib/types.js";

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().optional(),
        }),
      }),
    )
    .default([]),
});

export interface OpenAiCompatibleConfig {
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  public readonly id = "openai-compatible";
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: OpenAiCompatibleConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
  }

  async complete(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is not configured.");
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
          {
            role: "system",
            content: "You are a concise autonomous coding planner.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI-compatible request failed: ${response.status}`);
    }

    const json = responseSchema.parse(await response.json());
    return json.choices[0]?.message.content ?? "";
  }
}
