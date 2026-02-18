import { Octokit } from "@octokit/rest";
import { getEnvConfig } from "../config/env";

let cachedOctokit: Octokit | null = null;

export function getGithubClient(): Octokit {
  if (cachedOctokit) {
    return cachedOctokit;
  }

  const config = getEnvConfig();
  if (!config.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is required to manage project repositories.");
  }

  cachedOctokit = new Octokit({
    auth: config.GITHUB_TOKEN,
  });

  return cachedOctokit;
}
