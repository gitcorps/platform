"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.amountToCents = amountToCents;
exports.resolveProjectIdForPayment = resolveProjectIdForPayment;
exports.creditProjectWalletFromPayment = creditProjectWalletFromPayment;
const firestore_1 = require("firebase-admin/firestore");
const firestore_2 = require("./firestore");
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
    const checkoutSessionId = typeof paymentData.checkout_session === "string"
        ? paymentData.checkout_session
        : typeof paymentData.checkoutSessionId === "string"
            ? paymentData.checkoutSessionId
            : null;
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