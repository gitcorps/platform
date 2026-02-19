import { describe, expect, it } from "vitest";
import { computeRepoCreateHeuristic } from "../src/lib/githubPreflight";

describe("computeRepoCreateHeuristic", () => {
  it("is unlikely when token is missing", () => {
    expect(
      computeRepoCreateHeuristic({
        tokenPresent: false,
        viewerReachable: true,
        orgReachable: true,
      }),
    ).toBe("unlikely");
  });

  it("is likely for org admin", () => {
    expect(
      computeRepoCreateHeuristic({
        tokenPresent: true,
        viewerReachable: true,
        orgReachable: true,
        membership: { state: "active", role: "admin" },
      }),
    ).toBe("likely");
  });

  it("is likely for active member when org allows member repo creation", () => {
    expect(
      computeRepoCreateHeuristic({
        tokenPresent: true,
        viewerReachable: true,
        orgReachable: true,
        membership: { state: "active", role: "member" },
        orgSettings: { membersCanCreateRepositories: true },
      }),
    ).toBe("likely");
  });

  it("is unlikely for active non-admin when org disallows member repo creation", () => {
    expect(
      computeRepoCreateHeuristic({
        tokenPresent: true,
        viewerReachable: true,
        orgReachable: true,
        membership: { state: "active", role: "member" },
        orgSettings: { membersCanCreateRepositories: false },
      }),
    ).toBe("unlikely");
  });

  it("is unknown when checks pass but permissions cannot be inferred", () => {
    expect(
      computeRepoCreateHeuristic({
        tokenPresent: true,
        viewerReachable: true,
        orgReachable: true,
      }),
    ).toBe("unknown");
  });
});
