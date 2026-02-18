"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProjectRepoAndSeed = createProjectRepoAndSeed;
exports.dispatchWorkflow = dispatchWorkflow;
const node_buffer_1 = require("node:buffer");
const client_1 = require("./client");
async function upsertFile(owner, repo, file) {
    const octokit = (0, client_1.getGithubClient)();
    let sha;
    try {
        const existing = await octokit.repos.getContent({
            owner,
            repo,
            path: file.path,
        });
        if (!Array.isArray(existing.data) && "sha" in existing.data) {
            sha = existing.data.sha;
        }
    }
    catch {
        sha = undefined;
    }
    await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: file.path,
        message: file.message,
        content: node_buffer_1.Buffer.from(file.content, "utf8").toString("base64"),
        branch: "main",
        sha,
    });
}
async function createProjectRepoAndSeed(input) {
    const octokit = (0, client_1.getGithubClient)();
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
    const files = [
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
async function dispatchWorkflow(input) {
    const octokit = (0, client_1.getGithubClient)();
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
//# sourceMappingURL=repo.js.map