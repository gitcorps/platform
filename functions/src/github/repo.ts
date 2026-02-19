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
  const octokit = await getGithubClient();
  let sha: string | undefined;

  try {
    const existing = await octokit.repos.getContent({
      owner,
      repo,
      path: file.path,
    });

    if (!Array.isArray(existing.data) && "sha" in existing.data) {
      sha = existing.data.sha;
      const rawContent = existing.data.content;
      const encoding = existing.data.encoding;

      if (typeof rawContent === "string" && rawContent.length > 0) {
        const normalized = rawContent.replace(/\n/g, "");
        const decoded =
          encoding === "base64"
            ? Buffer.from(normalized, "base64").toString("utf8")
            : rawContent;

        if (decoded === file.content) {
          return;
        }
      }
    }
  } catch {
    sha = undefined;
  }

  try {
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: file.path,
      message: file.message,
      content: Buffer.from(file.content, "utf8").toString("base64"),
      branch: "main",
      sha,
    });
  } catch (error) {
    const err = error as { status?: number; message?: string };
    if (err.status === 422 && (err.message || "").toLowerCase().includes("content")) {
      return;
    }
    const status = typeof err.status === "number" ? ` [status=${err.status}]` : "";
    const message = err.message || "Unknown GitHub API error";
    throw new Error(`Failed to upsert '${file.path}'${status}: ${message}`);
  }
}

export async function syncProjectAutomationFiles(input: {
  repoFullName: string;
  workflowYaml: string;
  runnerScript: string;
}): Promise<void> {
  const [owner, repo] = input.repoFullName.split("/");

  if (!owner || !repo) {
    throw new Error(`Invalid repoFullName: ${input.repoFullName}`);
  }

  const files: SeedFile[] = [
    {
      path: ".github/workflows/gitcorps-agent.yml",
      content: input.workflowYaml,
      message: "ci: sync gitcorps agent workflow",
    },
    {
      path: "tools/gitcorps_runner.mjs",
      content: input.runnerScript,
      message: "chore: sync gitcorps runner",
    },
  ];

  for (const file of files) {
    await upsertFile(owner, repo, file);
  }
}

export async function createProjectRepoAndSeed(input: CreateRepoInput): Promise<CreatedRepo> {
  const octokit = await getGithubClient();

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
  const octokit = await getGithubClient();
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
