export interface HttpResponse {
    status: number;
    body: string;
}
export declare function post(url: string, body: string, headers: Record<string, string>): Promise<HttpResponse>;
