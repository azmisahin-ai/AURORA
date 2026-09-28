/**
 * Fetch abstraction. Tools depend on this, not on a concrete HTTP client, so a
 * cached, sandboxed, or proxy-backed fetcher can be swapped in later (ADR 003).
 */

export interface FetchRequest {
  url: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

export interface FetchResult {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: string;
  /** True when the body was cut to respect `maxBytes`. */
  truncated: boolean;
}

export interface Fetcher {
  readonly name: string;
  fetch(request: FetchRequest): Promise<FetchResult>;
}
