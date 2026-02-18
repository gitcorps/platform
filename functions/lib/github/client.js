"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGithubClient = getGithubClient;
const rest_1 = require("@octokit/rest");
const env_1 = require("../config/env");
let cachedOctokit = null;
function getGithubClient() {
    if (cachedOctokit) {
        return cachedOctokit;
    }
    const config = (0, env_1.getEnvConfig)();
    if (!config.GITHUB_TOKEN) {
        throw new Error("GITHUB_TOKEN is required to manage project repositories.");
    }
    cachedOctokit = new rest_1.Octokit({
        auth: config.GITHUB_TOKEN,
    });
    return cachedOctokit;
}
//# sourceMappingURL=client.js.map