"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGithubClient = getGithubClient;
const env_1 = require("../config/env");
let cachedOctokit = null;
const importEsm = new Function("modulePath", "return import(modulePath)");
async function getGithubClient() {
    if (cachedOctokit) {
        return cachedOctokit;
    }
    const config = (0, env_1.getEnvConfig)();
    if (!config.GITHUB_TOKEN) {
        throw new Error("GITHUB_TOKEN is required to manage project repositories.");
    }
    const octokitModule = (await importEsm("@octokit/rest"));
    const { Octokit } = octokitModule;
    cachedOctokit = new Octokit({
        auth: config.GITHUB_TOKEN,
    });
    return cachedOctokit;
}
//# sourceMappingURL=client.js.map