/**
 * Search abstraction. AURORA must work with no search credentials at all, so
 * `SearchProvider` is optional by design: when no provider is configured,
 * `NoopSearchProvider` is used and research falls back to fetching known URLs.
 */

export interface SearchQuery {
  query: string;
  maxResults?: number;
  signal?: AbortSignal;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchProvider {
  readonly name: string;
  /** False when the provider cannot serve requests (e.g. no API key). */
  readonly available: boolean;
  search(query: SearchQuery): Promise<SearchResult[]>;
}
