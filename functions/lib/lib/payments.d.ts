export declare function amountToCents(value: unknown): number;
export declare function extractPaymentIntentIdFromCheckoutSession(sessionData: Record<string, unknown>): string | null;
export declare function extractCheckoutSessionIdFromPayment(paymentData: Record<string, unknown>): string | null;
export declare function extractPaymentStatus(paymentData: Record<string, unknown>): string;
export declare function resolveProjectIdForPayment(uid: string, paymentIntentId: string, paymentData: Record<string, unknown>): Promise<string | null>;
export interface CreditProjectInput {
    projectId: string;
    paymentIntentId: string;
    uid: string | null;
    amountCents: number;
}
export declare function creditProjectWalletFromPayment(input: CreditProjectInput): Promise<boolean>;
