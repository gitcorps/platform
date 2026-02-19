"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.amountToCents = amountToCents;
exports.extractPaymentIntentIdFromCheckoutSession = extractPaymentIntentIdFromCheckoutSession;
exports.extractCheckoutSessionIdFromPayment = extractCheckoutSessionIdFromPayment;
exports.extractPaymentStatus = extractPaymentStatus;
exports.resolveProjectIdForPayment = resolveProjectIdForPayment;
exports.creditProjectWalletFromPayment = creditProjectWalletFromPayment;
const firestore_1 = require("firebase-admin/firestore");
const firestore_2 = require("./firestore");
function readString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
function amountToCents(value) {
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
function extractPaymentIntentIdFromCheckoutSession(sessionData) {
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
        const id = readString(nested.id);
        if (id) {
            return id;
        }
    }
    return null;
}
function extractCheckoutSessionIdFromPayment(paymentData) {
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
        const id = readString(nestedCheckout.id);
        if (id) {
            return id;
        }
    }
    return null;
}
function extractPaymentStatus(paymentData) {
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
async function resolveProjectIdForPayment(uid, paymentIntentId, paymentData) {
    const metadata = paymentData.metadata;
    if (metadata && typeof metadata.projectId === "string" && metadata.projectId.length > 0) {
        return metadata.projectId;
    }
    const mappingByPaymentIntent = await (0, firestore_2.getDb)()
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
        const sessionMapping = await (0, firestore_2.getDb)().collection("checkoutSessionProjects").doc(checkoutSessionId).get();
        if (sessionMapping.exists) {
            const mappedProjectId = sessionMapping.get("projectId");
            if (typeof mappedProjectId === "string" && mappedProjectId.length > 0) {
                return mappedProjectId;
            }
        }
        const sessionDoc = await (0, firestore_2.getDb)()
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
async function creditProjectWalletFromPayment(input) {
    const db = (0, firestore_2.getDb)();
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
            balanceCents: firestore_1.FieldValue.increment(input.amountCents),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        tx.set(fundingEventRef, {
            uid: input.uid,
            amountCents: input.amountCents,
            stripePaymentIntentId: input.paymentIntentId,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
        });
        tx.set(db.collection("fundingEventsLedger").doc(input.paymentIntentId), {
            projectId: input.projectId,
            uid: input.uid,
            amountCents: input.amountCents,
            createdAt: firestore_1.Timestamp.now(),
        });
        return true;
    });
}
//# sourceMappingURL=payments.js.map