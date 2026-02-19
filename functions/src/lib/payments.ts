import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getDb } from "./firestore";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function amountToCents(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 1 && Number.isInteger(value)) {
      return value;
    }
    return Math.round(value * 100);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return amountToCents(parsed);
    }
  }

  return 0;
}

export function extractPaymentIntentIdFromCheckoutSession(
  sessionData: Record<string, unknown>,
): string | null {
  const directCandidates = [
    sessionData.payment_intent,
    sessionData.paymentIntent,
    sessionData.payment_intent_id,
    sessionData.paymentIntentId,
  ];

  for (const candidate of directCandidates) {
    const stringValue = readString(candidate);
    if (stringValue) {
      return stringValue;
    }
  }

  const nested = sessionData.payment_intent;
  if (nested && typeof nested === "object") {
    const id = readString((nested as Record<string, unknown>).id);
    if (id) {
      return id;
    }
  }

  return null;
}

export function extractCheckoutSessionIdFromPayment(
  paymentData: Record<string, unknown>,
): string | null {
  const directCandidates = [
    paymentData.checkout_session,
    paymentData.checkoutSessionId,
    paymentData.checkout_session_id,
    paymentData.checkoutSession,
    paymentData.session_id,
    paymentData.sessionId,
  ];

  for (const candidate of directCandidates) {
    const stringValue = readString(candidate);
    if (stringValue) {
      return stringValue;
    }
  }

  const nestedCheckout = paymentData.checkout_session;
  if (nestedCheckout && typeof nestedCheckout === "object") {
    const id = readString((nestedCheckout as Record<string, unknown>).id);
    if (id) {
      return id;
    }
  }

  return null;
}

export function extractPaymentStatus(paymentData: Record<string, unknown>): string {
  const statusCandidates = [
    paymentData.status,
    paymentData.payment_status,
    paymentData.paymentStatus,
  ];

  for (const candidate of statusCandidates) {
    const status = readString(candidate);
    if (status) {
      return status;
    }
  }

  return "";
}

export async function resolveProjectIdForPayment(
  uid: string,
  paymentIntentId: string,
  paymentData: Record<string, unknown>,
): Promise<string | null> {
  const metadata = paymentData.metadata as Record<string, unknown> | undefined;

  if (metadata && typeof metadata.projectId === "string" && metadata.projectId.length > 0) {
    return metadata.projectId;
  }

  const mappingByPaymentIntent = await getDb()
    .collection("paymentIntentProjects")
    .doc(paymentIntentId)
    .get();

  if (mappingByPaymentIntent.exists) {
    const mappedProjectId = mappingByPaymentIntent.get("projectId");
    if (typeof mappedProjectId === "string" && mappedProjectId.length > 0) {
      return mappedProjectId;
    }
  }

  const checkoutSessionId = extractCheckoutSessionIdFromPayment(paymentData);

  if (checkoutSessionId) {
    const sessionMapping = await getDb().collection("checkoutSessionProjects").doc(checkoutSessionId).get();
    if (sessionMapping.exists) {
      const mappedProjectId = sessionMapping.get("projectId");
      if (typeof mappedProjectId === "string" && mappedProjectId.length > 0) {
        return mappedProjectId;
      }
    }

    const sessionDoc = await getDb()
      .collection("customers")
      .doc(uid)
      .collection("checkout_sessions")
      .doc(checkoutSessionId)
      .get();
    if (sessionDoc.exists) {
      const sessionMeta = sessionDoc.get("metadata");
      const projectId = sessionMeta?.projectId;
      if (typeof projectId === "string" && projectId.length > 0) {
        return projectId;
      }
    }
  }

  return null;
}

export interface CreditProjectInput {
  projectId: string;
  paymentIntentId: string;
  uid: string | null;
  amountCents: number;
}

export async function creditProjectWalletFromPayment(input: CreditProjectInput): Promise<boolean> {
  const db = getDb();
  const projectRef = db.collection("projects").doc(input.projectId);
  const fundingEventRef = projectRef.collection("fundingEvents").doc(input.paymentIntentId);

  return db.runTransaction(async (tx) => {
    const [projectSnap, fundingEventSnap] = await Promise.all([
      tx.get(projectRef),
      tx.get(fundingEventRef),
    ]);

    if (!projectSnap.exists) {
      throw new Error(`Project ${input.projectId} not found`);
    }

    if (fundingEventSnap.exists) {
      return false;
    }

    tx.update(projectRef, {
      balanceCents: FieldValue.increment(input.amountCents),
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.set(fundingEventRef, {
      uid: input.uid,
      amountCents: input.amountCents,
      stripePaymentIntentId: input.paymentIntentId,
      createdAt: FieldValue.serverTimestamp(),
    });

    tx.set(db.collection("fundingEventsLedger").doc(input.paymentIntentId), {
      projectId: input.projectId,
      uid: input.uid,
      amountCents: input.amountCents,
      createdAt: Timestamp.now(),
    });

    return true;
  });
}
