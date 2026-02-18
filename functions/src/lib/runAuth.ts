import { Timestamp } from "firebase-admin/firestore";
import { getDb } from "./firestore";
import { hashRunToken, secureTokenEquals } from "./runToken";

interface HttpRequestLike {
  get(headerName: string): string | undefined;
  body?: unknown;
}

export interface RunAuthPayload {
  projectId: string;
  runId: string;
}

export async function validateRunTokenFromRequest(
  request: HttpRequestLike,
): Promise<{ ok: true; payload: RunAuthPayload } | { ok: false; status: number; message: string }> {
  const bearer = request.get("authorization")?.replace(/^Bearer\s+/i, "");
  const body: Record<string, unknown> =
    typeof request.body === "object" && request.body ? (request.body as Record<string, unknown>) : {};

  const tokenCandidate = typeof bearer === "string" && bearer.length > 0 ? bearer : body.runToken;
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const runId = typeof body.runId === "string" ? body.runId : "";

  if (typeof tokenCandidate !== "string" || tokenCandidate.length === 0 || !projectId || !runId) {
    return { ok: false, status: 400, message: "Missing run token, projectId, or runId" };
  }

  const runRef = getDb().collection("projects").doc(projectId).collection("runs").doc(runId);
  const runSnap = await runRef.get();

  if (!runSnap.exists) {
    return { ok: false, status: 404, message: "Run not found" };
  }

  const data = runSnap.data() ?? {};
  const storedHash = typeof data.runTokenHash === "string" ? data.runTokenHash : "";
  const expiresAt = data.runTokenExpiresAt as Timestamp | undefined;

  if (!storedHash || !expiresAt) {
    return { ok: false, status: 401, message: "Run token is not configured" };
  }

  if (expiresAt.toMillis() <= Date.now()) {
    return { ok: false, status: 401, message: "Run token expired" };
  }

  const providedHash = hashRunToken(tokenCandidate);
  if (!secureTokenEquals(storedHash, providedHash)) {
    return { ok: false, status: 401, message: "Invalid run token" };
  }

  return { ok: true, payload: { projectId, runId } };
}
