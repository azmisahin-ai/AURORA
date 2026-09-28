import { Agent, fetch as undiciFetch, buildConnector } from "undici";
import type { LookupFunction } from "node:net";
import type { UrlValidator } from "../../security/UrlValidator.js";
import { UrlValidationError } from "../../security/UrlValidator.js";
import type { FetchRequest, FetchResult, Fetcher } from "./Fetcher.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class FetchError extends Error {
  readonly url: string;
  readonly status?: number;
  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = "FetchError";
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Direct HTTP fetcher with SSRF containment.
 *
 * Redirects are followed **manually** so every hop is re-validated: a public URL
 * that 302s to `http://169.254.169.254/` must be rejected, and only checking the
 * first URL would miss it.
 *
 * DNS-rebinding hardening: the hostname is resolved once by `UrlValidator`, and
 * the connection is then *pinned* to those addresses via a custom undici
 * connector. Without pinning, the socket lookup would resolve the name a second
 * time and could reach an address that was never validated.
 */
export class DirectFetcher implements Fetcher {
  readonly name = "direct-fetch";

  constructor(
    private readonly urlValidator: UrlValidator,
    private readonly opts: {
      userAgent?: string;
      allowPrivate?: boolean;
      /** Pin the connection to the validated address. Off only in tests. */
      pinConnections?: boolean;
    } = {},
  ) {}

  async fetch(request: FetchRequest): Promise<FetchResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (request.signal) {
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let current = request.url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const validated = await this.urlValidator.validate(current);
        const response = await this.requestOnce(
          validated.url.toString(),
          validated.addresses,
          request.headers,
          controller.signal,
        );

        if (isRedirect(response.status)) {
          const location = response.headers.get("location");
          if (!location) {
            throw new FetchError(
              `Redirect (${response.status}) without a Location header`,
              current,
              response.status,
            );
          }
          // Re-validate on the next loop iteration; never trust the target.
          current = new URL(location, validated.url).toString();
          continue;
        }

        const body = await readCapped(response, maxBytes, controller.signal);
        return {
          url: validated.url.toString(),
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          body: body.text,
          truncated: body.truncated,
        };
      }
      throw new FetchError(`Too many redirects (limit ${MAX_REDIRECTS})`, request.url);
    } finally {
      clearTimeout(timer);
      if (request.signal) request.signal.removeEventListener("abort", onExternalAbort);
    }
  }

  private async requestOnce(
    url: string,
    addresses: string[],
    headers: Record<string, string> | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const dispatcher =
      this.opts.pinConnections === false ? undefined : this.pinnedDispatcher(addresses);

    try {
      return (await undiciFetch(url, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": this.opts.userAgent ?? "AURORA/0.1 (+https://localhost)",
          accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
          ...(headers ?? {}),
        },
        signal,
        ...(dispatcher ? { dispatcher } : {}),
      })) as unknown as Response;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new FetchError(`Request to ${url} failed: ${message}`, url);
    } finally {
      // A dispatcher owns sockets; without closing it the process would hang.
      if (dispatcher) void dispatcher.close().catch(() => {});
    }
  }

  /** A one-shot dispatcher whose DNS answers are the already-validated ones. */
  private pinnedDispatcher(addresses: string[]) {
    const pinned = addresses.slice();
    const connector = buildConnector({
      // undici calls this instead of the system resolver; the signature matches
      // net.connect's lookup contract (callback form).
      lookup: ((_hostname: string, options: unknown, callback: unknown) => {
        const cb = (typeof options === "function" ? options : callback) as (
          err: Error | null,
          address: string | { address: string; family: number }[],
          family?: number,
        ) => void;
        const wantsAll =
          typeof options === "object" && options !== null && "all" in options
            ? Boolean((options as { all?: boolean }).all)
            : false;
        const results = pinned.map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        }));
        if (wantsAll) cb(null, results);
        else cb(null, results[0]!.address, results[0]!.family);
      }) as unknown as LookupFunction,
    });
    return new Agent({ connect: connector, pipelining: 1 });
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Read the body, stopping at `maxBytes` so a huge response cannot exhaust memory. */
async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: "", truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const remaining = maxBytes - total;
        if (value.byteLength >= remaining) {
          chunks.push(value.subarray(0, remaining));
          total = maxBytes;
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), truncated };
}

export { UrlValidationError };
