import { describe, expect, it } from "vitest";
import { buildStatusAppendix } from "../src/lib/status.js";

describe("buildStatusAppendix", () => {
  it("renders required status sections", () => {
    const appendix = buildStatusAppendix(
      {
        attempted: "Do A",
        changed: "Changed B",
        works: "Works C",
        broken: "Broken D",
        nextMilestone: "Next E",
        summary: "Summary F",
      },
      "heuristic",
      { executed: true, success: true },
      { executed: true, success: false },
    );

    expect(appendix).toContain("### Attempted");
    expect(appendix).toContain("### Changed");
    expect(appendix).toContain("### Works");
    expect(appendix).toContain("### Broken");
    expect(appendix).toContain("### Next Milestone");
    expect(appendix).toContain("Pre-change tests: passed");
    expect(appendix).toContain("Post-change tests: failed");
  });
});
