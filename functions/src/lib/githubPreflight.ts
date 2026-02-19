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

export function computeRepoCreateHeuristic(
  input: RepoCreateHeuristicInput,
): RepoCreateHeuristic {
  if (!input.tokenPresent) {
    return "unlikely";
  }

  if (!input.viewerReachable || !input.orgReachable) {
    return "unlikely";
  }

  if (input.membership?.state && input.membership.state !== "active") {
    return "unlikely";
  }

  if (input.membership?.role === "admin") {
    return "likely";
  }

  if (input.orgSettings?.membersCanCreateRepositories === true) {
    return "likely";
  }

  if (
    input.orgSettings?.membersCanCreateRepositories === false &&
    input.membership?.role &&
    input.membership.role !== "admin"
  ) {
    return "unlikely";
  }

  return "unknown";
}
