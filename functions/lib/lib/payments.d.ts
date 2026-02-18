export declare function amountToCents(value: unknown): number;
export declare function resolveProjectIdForPayment(uid: string, paymentIntentId: string, paymentData: Record<string, unknown>): Promise<string | null>;
export interface CreditProjectInput {
    projectId: string;
    paymentIntentId: string;
    uid: string | null;
    amountCents: number;
}
export declare function creditProjectWalletFromPayment(input: CreditProjectInput): Promise<boolean>;
