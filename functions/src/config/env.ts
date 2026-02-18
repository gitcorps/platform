import { z } from "zod";

const DEFAULTS = {
  githubOrgName: "gitcorps",
  publicSiteDomain: "gitcorps.com",
  projectSiteTemplate: "{slug}.gitcorps.com",
  defaultLicense: "MIT",
  llmProvider: "openai",
  llmModel: "gpt-4.1",
};

const numberFromEnv = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (!value || value.trim().length === 0) {
        return defaultValue;
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Expected numeric env var, got '${value}'`);
      }
      return parsed;
    });

const envSchema = z.object({
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_ORG_NAME: z.string().default(DEFAULTS.githubOrgName),
  PUBLIC_SITE_DOMAIN: z.string().default(DEFAULTS.publicSiteDomain),
  PROJECT_SITE_TEMPLATE: z.string().default(DEFAULTS.projectSiteTemplate),
  DEFAULT_LICENSE: z.string().default(DEFAULTS.defaultLicense),
  MIN_RUN_USD: numberFromEnv(2),
  MAX_RUN_USD: numberFromEnv(10),
  GLOBAL_MAX_CONCURRENT_RUNS: numberFromEnv(10),
  GLOBAL_MAX_DAILY_SPEND_USD: numberFromEnv(500),
  PER_PROJECT_MAX_DAILY_SPEND_USD: numberFromEnv(100),
  LLM_PROVIDER_DEFAULT: z.string().default(DEFAULTS.llmProvider),
  LLM_MODEL_DEFAULT: z.string().default(DEFAULTS.llmModel),
  AGENT_RUNTIME_DEFAULT: z.string().default("node_builtin"),
  BACKEND_BASE_URL: z.string().optional(),
  RUN_TOKEN_TTL_MINUTES: numberFromEnv(120),
  RUN_QUEUE_CHECK_LIMIT: numberFromEnv(25),
  BUCKET_RUNTIME_MINUTES_PER_USD: numberFromEnv(5),
  BUCKET_TOKENS_PER_USD: numberFromEnv(75000),
});

export type EnvConfig = z.infer<typeof envSchema> & {
  minRunCents: number;
  maxRunCents: number;
  globalMaxDailySpendCents: number;
  perProjectMaxDailySpendCents: number;
};

let cachedConfig: EnvConfig | null = null;

export function getEnvConfig(): EnvConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const parsed = envSchema.parse(process.env);

  cachedConfig = {
    ...parsed,
    minRunCents: usdToCents(parsed.MIN_RUN_USD),
    maxRunCents: usdToCents(parsed.MAX_RUN_USD),
    globalMaxDailySpendCents: usdToCents(parsed.GLOBAL_MAX_DAILY_SPEND_USD),
    perProjectMaxDailySpendCents: usdToCents(parsed.PER_PROJECT_MAX_DAILY_SPEND_USD),
  };

  return cachedConfig;
}

export function usdToCents(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}
