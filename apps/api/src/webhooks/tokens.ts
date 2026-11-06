export const WEBHOOK_HTTP = Symbol("WEBHOOK_HTTP");
export const URL_RESOLVER = Symbol("URL_RESOLVER");

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Sends one webhook request. Resolves with the status for any response; rejects on network errors and timeouts. */
export interface WebhookHttp {
  post(request: WebhookRequest): Promise<{ status: number }>;
}
