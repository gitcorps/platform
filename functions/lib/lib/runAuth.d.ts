interface HttpRequestLike {
    get(headerName: string): string | undefined;
    body?: unknown;
}
export interface RunAuthPayload {
    projectId: string;
    runId: string;
}
export declare function validateRunTokenFromRequest(request: HttpRequestLike): Promise<{
    ok: true;
    payload: RunAuthPayload;
} | {
    ok: false;
    status: number;
    message: string;
}>;
export {};
