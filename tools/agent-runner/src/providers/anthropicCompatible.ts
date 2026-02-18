import { z } from "zod";
import type { LlmProvider } from "../lib/types.js";

const responseSchema = z.object({
  content: z
    .array(
      z.object({
        text: z.string().optional(),
      }),
    )
    .default([]),
});

export interface AnthropicCompatibleConfig {
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

export class AnthropicCompatibleProvider implements LlmProvider {
  public readonly id = "anthropic-compatible";
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: AnthropicCompatibleConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
  }

  async complete(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not configured.");
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
      throw new Error(`Anthropic-compatible request failed: ${response.status}`);
    }

    const json = responseSchema.parse(await response.json());
    return json.content[0]?.text ?? "";
  }
}
