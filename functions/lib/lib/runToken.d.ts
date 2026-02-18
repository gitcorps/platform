import { Timestamp } from "firebase-admin/firestore";
export interface IssuedRunToken {
    token: string;
    tokenHash: string;
    expiresAt: Timestamp;
}
export declare function issueRunToken(ttlMinutes: number): IssuedRunToken;
export declare function hashRunToken(token: string): string;
export declare function secureTokenEquals(a: string, b: string): boolean;
