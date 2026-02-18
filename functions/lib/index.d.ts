export declare const createProject: import("firebase-functions/v2/https").CallableFunction<any, Promise<{
    projectId: string;
    repoUrl: string;
    repoFullName: string;
}>, unknown>;
export declare const createFundingCheckoutSession: import("firebase-functions/v2/https").CallableFunction<any, Promise<{
    sessionDocumentPath: string;
    sessionId: string;
}>, unknown>;
export declare const onCheckoutSessionUpdated: import("firebase-functions").CloudFunction<import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions").Change<import("firebase-functions/v2/firestore").DocumentSnapshot> | undefined, {
    uid: string;
    sessionId: string;
}>>;
export declare const onStripePaymentSucceeded: import("firebase-functions").CloudFunction<import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").QueryDocumentSnapshot | undefined, {
    uid: string;
    paymentIntentId: string;
}>>;
export declare const runStarted: import("firebase-functions/v2/https").HttpsFunction;
export declare const runHeartbeat: import("firebase-functions/v2/https").HttpsFunction;
export declare const runFinished: import("firebase-functions/v2/https").HttpsFunction;
export declare const processRunQueue: import("firebase-functions/v2/scheduler").ScheduleFunction;
export declare const recoverStaleRuns: import("firebase-functions/v2/scheduler").ScheduleFunction;
export declare const maybeStartRunCallable: import("firebase-functions/v2/https").CallableFunction<any, Promise<{
    defaults: {
        githubOrgName: string;
    };
    state: "started" | "skipped" | "missing_project" | "dispatch_failed" | "queue_enqueued" | "error";
    runId?: string;
    gateReason?: import("./lib/orchestratorRules").RunStartGateReason;
    message?: string;
}>, unknown>;
