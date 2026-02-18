import { describe, expect, it } from "vitest";
import { isAllowedReturnUrl } from "../src/lib/urlSecurity";

describe("isAllowedReturnUrl", () => {
  const domain = "gitcorps.com";

  it("allows https public domain and subdomains", () => {
    expect(isAllowedReturnUrl("https://gitcorps.com/p/a", domain)).toBe(true);
    expect(isAllowedReturnUrl("https://app.gitcorps.com/p/a", domain)).toBe(true);
  });

  it("allows localhost for local development", () => {
    expect(isAllowedReturnUrl("http://localhost:3000/p/a", domain)).toBe(true);
    expect(isAllowedReturnUrl("https://127.0.0.1:5001/x", domain)).toBe(true);
  });

  it("blocks unrelated domains and invalid urls", () => {
    expect(isAllowedReturnUrl("https://evil.example/p", domain)).toBe(false);
    expect(isAllowedReturnUrl("notaurl", domain)).toBe(false);
  });

  it("blocks non-https for non-local domains", () => {
    expect(isAllowedReturnUrl("http://gitcorps.com/p", domain)).toBe(false);
  });
});
