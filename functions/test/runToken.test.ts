import { describe, expect, it } from "vitest";
import { hashRunToken, issueRunToken, secureTokenEquals } from "../src/lib/runToken";

describe("runToken", () => {
  it("issues token and hash with expiry", () => {
    const issued = issueRunToken(5);
    expect(issued.token).toHaveLength(64);
    expect(issued.tokenHash).toHaveLength(64);
    expect(issued.expiresAt.toMillis()).toBeGreaterThan(Date.now());
    expect(hashRunToken(issued.token)).toBe(issued.tokenHash);
  });

  it("compares token hashes securely", () => {
    expect(secureTokenEquals("abcd", "abcd")).toBe(true);
    expect(secureTokenEquals("abcd", "abce")).toBe(false);
    expect(secureTokenEquals("abcd", "abcde")).toBe(false);
  });
});
