import { Buffer } from "node:buffer";
import { getGithubClient } from "./client";

interface SeedFile {
  path: string;
  content: string;
  message: string;
}

export interface CreateRepoInput {
  org: string;
  slug: string;
  name: string;
  manifestoMd: string;
  statusTemplate: string;
  workflowYaml: string;
  runnerScript: string;
  licenseText: string;
}

export interface CreatedRepo {
  repoFullName: string;
  repoUrl: string;
}

async function upsertFile(
  owner: string,
  repo: string,
  file: SeedFile,
): Promise<void> {
  const octokit = getGithubClient();
  let sha: string | undefined;

  try {
    const existing = await octokit.repos.getContent({
      owner,
      repo,
      path: file.path,
    });

    if (!Array.isArray(existing.data) && "sha" in existing.data) {
      sha = existing.data.sha;
    }
  } catch {
    sha = undefined;
  }

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: file.path,
    message: file.message,
    content: Buffer.from(file.content, "utf8").toString("base64"),
    branch: "main",
    sha,
  });
}

export async function createProjectRepoAndSeed(input: CreateRepoInput): Promise<CreatedRepo> {
  const octokit = getGithubClient();

  const createResult = await octokit.repos.createInOrg({
    org: input.org,
    name: input.slug,
    description: `GitCorps project: ${input.name}`,
    private: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    auto_init: true,
    license_template: "mit",
  });

  const repoName = createResult.data.name;
  const repoFullName = `${input.org}/${repoName}`;

  const files: SeedFile[] = [
    {
      path: "VISION.md",
      content: input.manifestoMd,
      message: "docs: add project vision",
    },
    {
      path: "STATUS.md",
      content: input.statusTemplate,
      message: "docs: add initial status",
    },
    {
      path: ".github/workflows/gitcorps-agent.yml",
      content: input.workflowYaml,
      message: "ci: add gitcorps agent workflow",
    },
    {
      path: "tools/gitcorps_runner.mjs",
      content: input.runnerScript,
      message: "feat: add gitcorps runner entrypoint",
    },
    {
      path: "LICENSE",
      content: input.licenseText,
      message: "chore: set default license",
    },
  ];

  for (const file of files) {
    await upsertFile(input.org, repoName, file);
  }

  return {
    repoFullName,
    repoUrl: createResult.data.html_url,
  };
}

export interface DispatchWorkflowInput {
  repoFullName: string;
  workflowFile: string;
  inputs: Record<string, string>;
}

export async function dispatchWorkflow(input: DispatchWorkflowInput): Promise<void> {
  const octokit = getGithubClient();
  const [owner, repo] = input.repoFullName.split("/");

  if (!owner || !repo) {
    throw new Error(`Invalid repoFullName: ${input.repoFullName}`);
  }

  await octokit.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: input.workflowFile,
    ref: "main",
    inputs: input.inputs,
  });
}
