export interface HttpResponse {
    status: number;
    body: string;
}
export declare function post(url: string, body: string, headers: Record<string, string>): Promise<HttpResponse>;
/** GET counterpart to post(), for the approval-status poll (no body). */
export declare function get(url: string, headers: Record<string, string>): Promise<HttpResponse>;
