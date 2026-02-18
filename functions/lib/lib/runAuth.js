"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateRunTokenFromRequest = validateRunTokenFromRequest;
const firestore_1 = require("./firestore");
const runToken_1 = require("./runToken");
async function validateRunTokenFromRequest(request) {
    const bearer = request.get("authorization")?.replace(/^Bearer\s+/i, "");
    const body = typeof request.body === "object" && request.body ? request.body : {};
    const tokenCandidate = typeof bearer === "string" && bearer.length > 0 ? bearer : body.runToken;
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    const runId = typeof body.runId === "string" ? body.runId : "";
    if (typeof tokenCandidate !== "string" || tokenCandidate.length === 0 || !projectId || !runId) {
        return { ok: false, status: 400, message: "Missing run token, projectId, or runId" };
    }
    const runRef = (0, firestore_1.getDb)().collection("projects").doc(projectId).collection("runs").doc(runId);
    const runSnap = await runRef.get();
    if (!runSnap.exists) {
        return { ok: false, status: 404, message: "Run not found" };
    }
    const data = runSnap.data() ?? {};
    const storedHash = typeof data.runTokenHash === "string" ? data.runTokenHash : "";
    const expiresAt = data.runTokenExpiresAt;
    if (!storedHash || !expiresAt) {
        return { ok: false, status: 401, message: "Run token is not configured" };
    }
    if (expiresAt.toMillis() <= Date.now()) {
        return { ok: false, status: 401, message: "Run token expired" };
    }
    const providedHash = (0, runToken_1.hashRunToken)(tokenCandidate);
    if (!(0, runToken_1.secureTokenEquals)(storedHash, providedHash)) {
        return { ok: false, status: 401, message: "Invalid run token" };
    }
    return { ok: true, payload: { projectId, runId } };
}
//# sourceMappingURL=runAuth.js.map