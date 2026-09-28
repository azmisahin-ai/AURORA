/**
 * Knowledge memory types. Provenance is mandatory on every entry: retrieval can
 * surface stale or wrong content, so callers must be able to see where an entry
 * came from and whether it was verified (ADR 002, docs/research/rag.md §3).
 */

export type KnowledgeKind = "topic" | "source" | "research";

export interface KnowledgeMetadata {
  slug: string;
  kind: KnowledgeKind;
  title: string;
  /** Topic this entry belongs to (topic and research entries). */
  topic?: string;
  /** Origin URL for fetched content. */
  source?: string;
  /** ISO-8601 timestamp of when the content was obtained. */
  retrievedAt: string;
  /** Which mechanism produced it, e.g. "web-fetch", "agent", "manual". */
  provider: string;
  /**
   * True only when the content was checked against its primary source. Anything
   * unverified stays false and is surfaced as such to the agent.
   */
  verified: boolean;
  tags: string[];
  /** Free-form caveats, e.g. the DOĞRULANACAK marker. */
  notes?: string;
}

export interface KnowledgeEntry {
  metadata: KnowledgeMetadata;
  /** Markdown body. */
  content: string;
  /** Path relative to the knowledge root, for display and provenance. */
  path: string;
}

export interface KnowledgeWriteInput {
  kind: KnowledgeKind;
  slug: string;
  title: string;
  content: string;
  topic?: string;
  source?: string;
  provider?: string;
  verified?: boolean;
  tags?: string[];
  notes?: string;
  retrievedAt?: string;
}

export interface KnowledgeQuery {
  text: string;
  kind?: KnowledgeKind;
  topic?: string;
  limit?: number;
}

export interface KnowledgeSearchHit {
  entry: KnowledgeEntry;
  score: number;
  matchedTerms: string[];
}

export interface KnowledgeStore {
  write(input: KnowledgeWriteInput): Promise<KnowledgeEntry>;
  read(kind: KnowledgeKind, slug: string): Promise<KnowledgeEntry | null>;
  search(query: KnowledgeQuery): Promise<KnowledgeSearchHit[]>;
  list(filter?: { kind?: KnowledgeKind; topic?: string }): Promise<KnowledgeMetadata[]>;
}
