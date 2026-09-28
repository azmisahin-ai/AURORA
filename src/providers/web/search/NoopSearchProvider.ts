import type { Logger } from "pino";
import type { SearchProvider, SearchQuery, SearchResult } from "./SearchProvider.js";

/**
 * A provider that never returns results, used when no search backend is
 * configured. It exists so the absence of a search API is a *degraded mode*
 * rather than an error: the agent can still fetch URLs it knows about.
 */
export class NoopSearchProvider implements SearchProvider {
  readonly name = "noop";
  readonly available = false;

  constructor(private readonly logger?: Logger) {}

  async search(query: SearchQuery): Promise<SearchResult[]> {
    this.logger?.info(
      { query: query.query },
      "no search provider configured; returning no results (fetch known URLs directly)",
    );
    return [];
  }
}
