"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncProjectAutomationFiles = syncProjectAutomationFiles;
exports.createProjectRepoAndSeed = createProjectRepoAndSeed;
exports.deleteRepoByFullName = deleteRepoByFullName;
exports.dispatchWorkflow = dispatchWorkflow;
const node_buffer_1 = require("node:buffer");
const client_1 = require("./client");
async function upsertFile(owner, repo, file) {
    const octokit = await (0, client_1.getGithubClient)();
    let sha;
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
                const decoded = encoding === "base64"
                    ? node_buffer_1.Buffer.from(normalized, "base64").toString("utf8")
                    : rawContent;
                if (decoded === file.content) {
                    return;
                }
            }
        }
    }
    catch {
        sha = undefined;
    }
    try {
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
    catch (error) {
        const err = error;
        if (err.status === 422 && (err.message || "").toLowerCase().includes("content")) {
            return;
        }
        const status = typeof err.status === "number" ? ` [status=${err.status}]` : "";
        const message = err.message || "Unknown GitHub API error";
        throw new Error(`Failed to upsert '${file.path}'${status}: ${message}`);
    }
}
async function syncProjectAutomationFiles(input) {
    const [owner, repo] = input.repoFullName.split("/");
    if (!owner || !repo) {
        throw new Error(`Invalid repoFullName: ${input.repoFullName}`);
    }
    const files = [
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
        {
            path: ".github/agents/gitcorps.agent.md",
            content: input.agentInstructions,
            message: "chore: sync gitcorps custom agent",
        },
    ];
    for (const file of files) {
        await upsertFile(owner, repo, file);
    }
}
async function createProjectRepoAndSeed(input) {
    const octokit = await (0, client_1.getGithubClient)();
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
            path: ".github/agents/gitcorps.agent.md",
            content: input.agentInstructions,
            message: "docs: add gitcorps custom agent instructions",
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
async function deleteRepoByFullName(repoFullName) {
    const octokit = await (0, client_1.getGithubClient)();
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) {
        throw new Error(`Invalid repoFullName: ${repoFullName}`);
    }
    try {
        await octokit.repos.delete({ owner, repo });
    }
    catch (error) {
        const err = error;
        if (err.status === 404) {
            return;
        }
        const status = typeof err.status === "number" ? ` [status=${err.status}]` : "";
        throw new Error(`Failed to delete repository '${repoFullName}'${status}: ${err.message || "unknown error"}`);
    }
}
async function dispatchWorkflow(input) {
    const octokit = await (0, client_1.getGithubClient)();
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