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
    sessionId: string;
    uid: string;
}>>;
export declare const onPaymentIntentProjectMapped: import("firebase-functions").CloudFunction<import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions").Change<import("firebase-functions/v2/firestore").DocumentSnapshot> | undefined, {
    paymentIntentId: string;
}>>;
export declare const onStripePaymentSucceeded: import("firebase-functions").CloudFunction<import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions").Change<import("firebase-functions/v2/firestore").DocumentSnapshot> | undefined, {
    paymentIntentId: string;
    uid: string;
}>>;
export declare const runStarted: import("firebase-functions/v2/https").HttpsFunction;
export declare const runHeartbeat: import("firebase-functions/v2/https").HttpsFunction;
export declare const runFinished: import("firebase-functions/v2/https").HttpsFunction;
export declare const processRunQueue: import("firebase-functions/v2/scheduler").ScheduleFunction;
export declare const recoverStaleRuns: import("firebase-functions/v2/scheduler").ScheduleFunction;
export declare const retryPendingStripePayments: import("firebase-functions/v2/scheduler").ScheduleFunction;
export declare const maybeStartRunCallable: import("firebase-functions/v2/https").CallableFunction<any, Promise<{
    defaults: {
        githubOrgName: string;
    };
    state: "started" | "skipped" | "missing_project" | "dispatch_failed" | "queue_enqueued" | "error";
    runId?: string;
    gateReason?: import("./lib/orchestratorRules").RunStartGateReason;
    message?: string;
}>, unknown>;
export declare const githubPreflight: import("firebase-functions/v2/https").CallableFunction<any, Promise<{
    ok: boolean;
    org: string;
    tokenPresent: boolean;
    viewer?: {
        login: string;
        id: number;
        type: string;
    };
    oauthScopes?: string | null;
    acceptedOauthScopes?: string | null;
    orgReachable: boolean;
    orgSettings?: {
        membersCanCreateRepositories?: boolean;
        defaultRepositoryPermission?: string;
    };
    membership?: {
        state?: string;
        role?: string;
    };
    writeProbeRequested: boolean;
    writeProbeSucceeded?: boolean;
    writeProbeRepoName?: string;
    writeProbeRepoUrl?: string;
    writeProbeDetails?: {
        repoCreated: boolean;
        contentsWriteOk: boolean;
        workflowWriteOk: boolean;
        repoDeleted: boolean;
    };
    checks: string[];
    repoCreateHeuristic: "likely" | "unknown" | "unlikely";
    errors: Array<{
        step: string;
        status?: number;
        message: string;
    }>;
}>, unknown>;
