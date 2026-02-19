import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function clearProjectEnv() {
  const keys = [
    "GITHUB_TOKEN",
    "GITHUB_ORG_NAME",
    "PUBLIC_SITE_DOMAIN",
    "PROJECT_SITE_TEMPLATE",
    "DEFAULT_LICENSE",
    "MIN_RUN_USD",
    "MAX_RUN_USD",
    "GLOBAL_MAX_CONCURRENT_RUNS",
    "GLOBAL_MAX_DAILY_SPEND_USD",
    "PER_PROJECT_MAX_DAILY_SPEND_USD",
    "LLM_PROVIDER_DEFAULT",
    "LLM_MODEL_DEFAULT",
    "AGENT_RUNTIME_DEFAULT",
    "BACKEND_BASE_URL",
    "RUN_TOKEN_TTL_MINUTES",
    "RUN_QUEUE_CHECK_LIMIT",
    "BUCKET_RUNTIME_MINUTES_PER_USD",
    "BUCKET_TOKENS_PER_USD",
  ] as const;

  for (const key of keys) {
    delete process.env[key];
  }
}

describe("env config", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    clearProjectEnv();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("reads direct uppercase env vars", async () => {
    process.env.GITHUB_ORG_NAME = "direct-org";
    process.env.MIN_RUN_USD = "3";

    const { getEnvConfig } = await import("../src/config/env");
    const config = getEnvConfig();

    expect(config.GITHUB_ORG_NAME).toBe("direct-org");
    expect(config.minRunCents).toBe(300);
  });

  it("reads lowercase env aliases", async () => {
    process.env.github_org_name = "legacy-org";
    process.env.github_token = "legacy-token";
    process.env.min_run_usd = "4";
    process.env.backend_base_url = "https://example.invalid";

    const { getEnvConfig } = await import("../src/config/env");
    const config = getEnvConfig();

    expect(config.GITHUB_ORG_NAME).toBe("legacy-org");
    expect(config.GITHUB_TOKEN).toBe("legacy-token");
    expect(config.minRunCents).toBe(400);
    expect(config.BACKEND_BASE_URL).toBe("https://example.invalid");
  });
});
