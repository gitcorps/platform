export interface PreflightMembership {
    state?: string;
    role?: string;
}
export interface PreflightOrgSettings {
    membersCanCreateRepositories?: boolean;
    defaultRepositoryPermission?: string;
}
export interface RepoCreateHeuristicInput {
    tokenPresent: boolean;
    viewerReachable: boolean;
    orgReachable: boolean;
    membership?: PreflightMembership;
    orgSettings?: PreflightOrgSettings;
}
export type RepoCreateHeuristic = "likely" | "unknown" | "unlikely";
export declare function computeRepoCreateHeuristic(input: RepoCreateHeuristicInput): RepoCreateHeuristic;
