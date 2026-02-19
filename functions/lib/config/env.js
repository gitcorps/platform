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
function readConfigValue(key) {
    const direct = process.env[key];
    if (typeof direct === "string" && direct.length > 0) {
        return direct;
    }
    // Accept lowercase env aliases (e.g. from manual Cloud Run env setup).
    const lowerAlias = process.env[key.toLowerCase()];
    if (typeof lowerAlias === "string" && lowerAlias.length > 0) {
        return lowerAlias;
    }
    return undefined;
}
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
    const resolvedEnv = {
        ...process.env,
        GITHUB_TOKEN: readConfigValue("GITHUB_TOKEN"),
        GITHUB_ORG_NAME: readConfigValue("GITHUB_ORG_NAME"),
        PUBLIC_SITE_DOMAIN: readConfigValue("PUBLIC_SITE_DOMAIN"),
        PROJECT_SITE_TEMPLATE: readConfigValue("PROJECT_SITE_TEMPLATE"),
        DEFAULT_LICENSE: readConfigValue("DEFAULT_LICENSE"),
        MIN_RUN_USD: readConfigValue("MIN_RUN_USD"),
        MAX_RUN_USD: readConfigValue("MAX_RUN_USD"),
        GLOBAL_MAX_CONCURRENT_RUNS: readConfigValue("GLOBAL_MAX_CONCURRENT_RUNS"),
        GLOBAL_MAX_DAILY_SPEND_USD: readConfigValue("GLOBAL_MAX_DAILY_SPEND_USD"),
        PER_PROJECT_MAX_DAILY_SPEND_USD: readConfigValue("PER_PROJECT_MAX_DAILY_SPEND_USD"),
        LLM_PROVIDER_DEFAULT: readConfigValue("LLM_PROVIDER_DEFAULT"),
        LLM_MODEL_DEFAULT: readConfigValue("LLM_MODEL_DEFAULT"),
        AGENT_RUNTIME_DEFAULT: readConfigValue("AGENT_RUNTIME_DEFAULT"),
        BACKEND_BASE_URL: readConfigValue("BACKEND_BASE_URL"),
        RUN_TOKEN_TTL_MINUTES: readConfigValue("RUN_TOKEN_TTL_MINUTES"),
        RUN_QUEUE_CHECK_LIMIT: readConfigValue("RUN_QUEUE_CHECK_LIMIT"),
        BUCKET_RUNTIME_MINUTES_PER_USD: readConfigValue("BUCKET_RUNTIME_MINUTES_PER_USD"),
        BUCKET_TOKENS_PER_USD: readConfigValue("BUCKET_TOKENS_PER_USD"),
    };
    const parsed = envSchema.parse(resolvedEnv);
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