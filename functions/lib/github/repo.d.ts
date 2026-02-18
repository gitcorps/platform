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
export declare function createProjectRepoAndSeed(input: CreateRepoInput): Promise<CreatedRepo>;
export interface DispatchWorkflowInput {
    repoFullName: string;
    workflowFile: string;
    inputs: Record<string, string>;
}
export declare function dispatchWorkflow(input: DispatchWorkflowInput): Promise<void>;
