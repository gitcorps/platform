import { getEnvConfig } from "../config/env";

interface GithubClient {
  users: {
    getAuthenticated(): Promise<{
      data: {
        login: string;
        id: number;
        type: string;
      };
      headers: Record<string, string | number | string[] | undefined>;
    }>;
  };
  orgs: {
    get(input: { org: string }): Promise<{
      data: {
        login?: string;
        members_can_create_repositories?: boolean;
        default_repository_permission?: string;
      };
    }>;
    getMembershipForAuthenticatedUser(input: { org: string }): Promise<{
      data: {
        state?: string;
        role?: string;
      };
    }>;
  };
  repos: {
    getContent(input: { owner: string; repo: string; path: string }): Promise<{
      data:
        | Array<unknown>
        | {
            sha?: string;
            content?: string;
            encoding?: string;
            type?: string;
          };
    }>;
    createInOrg(input: {
      org: string;
      name: string;
      description: string;
      private: boolean;
      has_issues: boolean;
      has_projects: boolean;
      has_wiki: boolean;
      auto_init: boolean;
      license_template: string;
    }): Promise<{ data: { name: string; html_url: string } }>;
    delete(input: { owner: string; repo: string }): Promise<unknown>;
    createOrUpdateFileContents(input: {
      owner: string;
      repo: string;
      path: string;
      message: string;
      content: string;
      branch: string;
      sha?: string;
    }): Promise<unknown>;
  };
  actions: {
    createWorkflowDispatch(input: {
      owner: string;
      repo: string;
      workflow_id: string;
      ref: string;
      inputs: Record<string, string>;
    }): Promise<unknown>;
  };
}

let cachedOctokit: GithubClient | null = null;
const importEsm = new Function("modulePath", "return import(modulePath)") as (
  modulePath: string,
) => Promise<unknown>;

export async function getGithubClient(): Promise<GithubClient> {
  if (cachedOctokit) {
    return cachedOctokit;
  }

  const config = getEnvConfig();
  if (!config.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is required to manage project repositories.");
  }

  const octokitModule = (await importEsm("@octokit/rest")) as { Octokit: new (config: {
    auth: string;
  }) => unknown };
  const { Octokit } = octokitModule;
  cachedOctokit = new Octokit({
    auth: config.GITHUB_TOKEN,
  }) as unknown as GithubClient;

  return cachedOctokit;
}
