import { describe, expect, it } from "vitest";
import {
  amountToCents,
  extractCheckoutSessionIdFromPayment,
  extractPaymentIntentIdFromCheckoutSession,
  extractPaymentStatus,
} from "../src/lib/payments";

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

  it("extracts payment intent id from checkout session variants", () => {
    expect(extractPaymentIntentIdFromCheckoutSession({ payment_intent: "pi_123" })).toBe("pi_123");
    expect(extractPaymentIntentIdFromCheckoutSession({ paymentIntentId: "pi_456" })).toBe("pi_456");
    expect(extractPaymentIntentIdFromCheckoutSession({ payment_intent: { id: "pi_789" } })).toBe(
      "pi_789",
    );
  });

  it("extracts checkout session id from payment variants", () => {
    expect(extractCheckoutSessionIdFromPayment({ checkout_session: "cs_123" })).toBe("cs_123");
    expect(extractCheckoutSessionIdFromPayment({ checkoutSessionId: "cs_456" })).toBe("cs_456");
    expect(extractCheckoutSessionIdFromPayment({ checkout_session: { id: "cs_789" } })).toBe(
      "cs_789",
    );
  });

  it("extracts status from multiple fields", () => {
    expect(extractPaymentStatus({ status: "succeeded" })).toBe("succeeded");
    expect(extractPaymentStatus({ payment_status: "paid" })).toBe("paid");
    expect(extractPaymentStatus({ paymentStatus: "processing" })).toBe("processing");
    expect(extractPaymentStatus({})).toBe("");
  });
});
