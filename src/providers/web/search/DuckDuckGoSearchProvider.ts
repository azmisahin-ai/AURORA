import { load } from "cheerio";
import type { Logger } from "pino";
import type { SearchProvider, SearchQuery, SearchResult } from "./SearchProvider.js";

const DEFAULT_BASE_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 10;
const UA = "Mozilla/5.0 (compatible; AURORA/0.1; +https://localhost)";

/**
 * A keyless web search backend, backed by DuckDuckGo's HTML endpoint.
 *
 * Motivation: AURORA's research path is only as useful as its ability to *find*
 * sources, and every API-key provider (Brave, Tavily) makes the default install
 * a no-op. This provider needs no credential, so `research` works out of the box
 * while the keyed providers remain a drop-in behind the same `SearchProvider`
 * interface.
 *
 * This is scraped HTML, not an API, and is treated as such:
 *  - Results are returned as `SearchResult` data and, upstream, wrapped as
 *    UNTRUSTED DATA — the same trust boundary as any other web content.
 *  - A parse that yields nothing is an empty result list, not an error: the
 *    endpoint's markup is not ours to depend on, and `web_search` already
 *    degrades gracefully to "fetch known URLs".
 *
 * `fetchImpl` is injectable so the parser is testable without the network.
 */
export class DuckDuckGoSearchProvider implements SearchProvider {
  readonly name = "duckduckgo-html";
  readonly available = true;

  constructor(
    private readonly opts: {
      fetchImpl?: typeof fetch;
      baseUrl?: string;
      timeoutMs?: number;
      logger?: Logger;
    } = {},
  ) {}

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const baseUrl = this.opts.baseUrl ?? DEFAULT_BASE_URL;
    const maxResults = query.maxResults ?? DEFAULT_MAX_RESULTS;
    const doFetch = this.opts.fetchImpl ?? fetch;

    const url = new URL(baseUrl);
    url.searchParams.set("q", query.query);

    // Bound the request with the caller's signal plus our own timeout, so a
    // hung search cannot outlive the run that asked for it.
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = query.signal ? AbortSignal.any([query.signal, timeout]) : timeout;

    const response = await doFetch(url.toString(), {
      method: "GET",
      headers: { "user-agent": UA, accept: "text/html" },
      signal,
    });

    if (!response.ok) {
      this.opts.logger?.warn(
        { status: response.status, provider: this.name },
        "search provider returned a non-OK status; treating as no results",
      );
      return [];
    }

    const html = await response.text();
    return parseDuckDuckGoResults(html, maxResults);
  }
}

/**
 * Extract results from DuckDuckGo's HTML. Pure, so it is unit-tested against a
 * saved fragment rather than a live request.
 *
 * Result anchors point at a redirect (`/l/?uddg=<encoded target>`), so the real
 * URL is unwrapped; a direct href is used as-is.
 */
export function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const $ = load(html);
  const results: SearchResult[] = [];

  $("a.result__a").each((_index, element) => {
    if (results.length >= maxResults) return false;
    const node = $(element);
    const title = node.text().trim();
    const href = node.attr("href") ?? "";
    const url = unwrapDuckDuckGoUrl(href);
    if (title === "" || url === "") return;

    const container = node.closest(".result, .web-result");
    const snippet = container.find(".result__snippet").first().text().trim();

    results.push({ title, url, ...(snippet !== "" ? { snippet } : {}) });
  });

  return results;
}

/**
 * Turn a result href into an absolute target URL. DuckDuckGo wraps results as
 * `/l/?uddg=<url-encoded target>`; reverse that. Falls back to resolving the href
 * against duckduckgo.com when it is a relative path.
 */
export function unwrapDuckDuckGoUrl(href: string): string {
  if (href === "") return "";
  let parsed: URL;
  try {
    parsed = new URL(href, "https://duckduckgo.com");
  } catch {
    return "";
  }

  const target = parsed.searchParams.get("uddg");
  if (target !== null && target !== "") return target;

  // Some layouts leave a relative link; only http(s) links are useful to a
  // fetcher, so anything else is dropped rather than handed back.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  return parsed.toString();
}
