"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.issueRunToken = issueRunToken;
exports.hashRunToken = hashRunToken;
exports.secureTokenEquals = secureTokenEquals;
const node_crypto_1 = require("node:crypto");
const firestore_1 = require("firebase-admin/firestore");
function issueRunToken(ttlMinutes) {
    const token = (0, node_crypto_1.randomBytes)(32).toString("hex");
    return {
        token,
        tokenHash: hashRunToken(token),
        expiresAt: firestore_1.Timestamp.fromDate(new Date(Date.now() + ttlMinutes * 60_000)),
    };
}
function hashRunToken(token) {
    return (0, node_crypto_1.createHash)("sha256").update(token).digest("hex");
}
function secureTokenEquals(a, b) {
    const aBuffer = Buffer.from(a);
    const bBuffer = Buffer.from(b);
    if (aBuffer.length !== bBuffer.length) {
        return false;
    }
    return (0, node_crypto_1.timingSafeEqual)(aBuffer, bBuffer);
}
//# sourceMappingURL=runToken.js.map