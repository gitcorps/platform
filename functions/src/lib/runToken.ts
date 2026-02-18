import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";

export interface IssuedRunToken {
  token: string;
  tokenHash: string;
  expiresAt: Timestamp;
}

export function issueRunToken(ttlMinutes: number): IssuedRunToken {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashRunToken(token),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + ttlMinutes * 60_000)),
  };
}

export function hashRunToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function secureTokenEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return timingSafeEqual(aBuffer, bBuffer);
}
