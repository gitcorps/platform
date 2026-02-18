"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEnvConfig = getEnvConfig;
exports.usdToCents = usdToCents;
const zod_1 = require("zod");
const DEFAULTS = {
    githubOrgName: "gitcorps",
    publicSiteDomain: "gitcorps.com",
    projectSiteTemplate: "{slug}.gitcorps.com",
    defaultLicense: "MIT",
    llmProvider: "openai",
    llmModel: "gpt-4.1",
};
const numberFromEnv = (defaultValue) => zod_1.z
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
const envSchema = zod_1.z.object({
    GITHUB_TOKEN: zod_1.z.string().optional(),
    GITHUB_ORG_NAME: zod_1.z.string().default(DEFAULTS.githubOrgName),
    PUBLIC_SITE_DOMAIN: zod_1.z.string().default(DEFAULTS.publicSiteDomain),
    PROJECT_SITE_TEMPLATE: zod_1.z.string().default(DEFAULTS.projectSiteTemplate),
    DEFAULT_LICENSE: zod_1.z.string().default(DEFAULTS.defaultLicense),
    MIN_RUN_USD: numberFromEnv(2),
    MAX_RUN_USD: numberFromEnv(10),
    GLOBAL_MAX_CONCURRENT_RUNS: numberFromEnv(10),
    GLOBAL_MAX_DAILY_SPEND_USD: numberFromEnv(500),
    PER_PROJECT_MAX_DAILY_SPEND_USD: numberFromEnv(100),
    LLM_PROVIDER_DEFAULT: zod_1.z.string().default(DEFAULTS.llmProvider),
    LLM_MODEL_DEFAULT: zod_1.z.string().default(DEFAULTS.llmModel),
    AGENT_RUNTIME_DEFAULT: zod_1.z.string().default("node_builtin"),
    BACKEND_BASE_URL: zod_1.z.string().optional(),
    RUN_TOKEN_TTL_MINUTES: numberFromEnv(120),
    RUN_QUEUE_CHECK_LIMIT: numberFromEnv(25),
    BUCKET_RUNTIME_MINUTES_PER_USD: numberFromEnv(5),
    BUCKET_TOKENS_PER_USD: numberFromEnv(75000),
});
let cachedConfig = null;
function getEnvConfig() {
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
function usdToCents(amountUsd) {
    return Math.round(amountUsd * 100);
}
//# sourceMappingURL=env.js.map