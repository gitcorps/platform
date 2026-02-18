import { describe, expect, it } from "vitest";
import { amountToCents } from "../src/lib/payments";

describe("amountToCents", () => {
  it("handles integer cent values", () => {
    expect(amountToCents(500)).toBe(500);
  });

  it("handles usd decimal values", () => {
    expect(amountToCents(12.34)).toBe(1234);
    expect(amountToCents("8.5")).toBe(850);
  });

  it("returns 0 for invalid values", () => {
    expect(amountToCents(undefined)).toBe(0);
    expect(amountToCents("not-number")).toBe(0);
  });
});
