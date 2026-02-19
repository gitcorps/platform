"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeRepoCreateHeuristic = computeRepoCreateHeuristic;
function computeRepoCreateHeuristic(input) {
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
    if (input.orgSettings?.membersCanCreateRepositories === false &&
        input.membership?.role &&
        input.membership.role !== "admin") {
        return "unlikely";
    }
    return "unknown";
}
//# sourceMappingURL=githubPreflight.js.map