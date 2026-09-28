import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PathValidator } from "../../security/PathValidator.js";
import type {
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeMetadata,
  KnowledgeQuery,
  KnowledgeSearchHit,
  KnowledgeStore,
  KnowledgeWriteInput,
} from "./types.js";

const KIND_DIR: Record<KnowledgeKind, string> = {
  topic: "topics",
  source: "sources",
  research: "research",
};
const DIR_KIND: Record<string, KnowledgeKind> = {
  topics: "topic",
  sources: "source",
  research: "research",
};

/**
 * Filesystem-backed knowledge store: `<root>/<dir>/<slug>.md` plus a
 * `<slug>.meta.json` sidecar (ADR 002).
 *
 * Search is keyword-based with a small, explicit scoring function rather than a
 * full-text index. That is honest about what it is: exact-term matching. The
 * store is behind an interface so SQLite FTS5 can replace it without touching
 * callers.
 */
export class FileKnowledgeStore implements KnowledgeStore {
  private readonly root: string;
  private readonly paths: PathValidator;

  constructor(root: string) {
    this.root = resolve(root);
    this.paths = new PathValidator([this.root]);
  }

  get rootDir(): string {
    return this.root;
  }

  async write(input: KnowledgeWriteInput): Promise<KnowledgeEntry> {
    const slug = normalizeSlug(input.slug);
    const metadata: KnowledgeMetadata = {
      slug,
      kind: input.kind,
      title: input.title,
      retrievedAt: input.retrievedAt ?? new Date().toISOString(),
      provider: input.provider ?? "agent",
      verified: input.verified ?? false,
      tags: input.tags ?? [],
      ...(input.topic !== undefined ? { topic: input.topic } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };

    const dir = this.dirFor(input.kind);
    const mdPath = this.paths.resolve(join(dir, `${slug}.md`));
    const metaPath = this.paths.resolve(join(dir, `${slug}.meta.json`));

    await mkdir(resolve(this.root, dir), { recursive: true });
    await writeFile(mdPath, input.content, "utf8");
    await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    return {
      metadata,
      content: input.content,
      path: join(dir, `${slug}.md`),
    };
  }

  async read(kind: KnowledgeKind, slug: string): Promise<KnowledgeEntry | null> {
    const safeSlug = normalizeSlug(slug);
    const dir = this.dirFor(kind);
    const mdPath = this.paths.resolve(join(dir, `${safeSlug}.md`));
    try {
      const [content, metadata] = await Promise.all([
        readFile(mdPath, "utf8"),
        this.readMetadata(dir, safeSlug),
      ]);
      return { metadata, content, path: join(dir, `${safeSlug}.md`) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async list(filter?: { kind?: KnowledgeKind; topic?: string }): Promise<KnowledgeMetadata[]> {
    const kinds = filter?.kind ? [filter.kind] : (["topic", "source", "research"] as const);
    const out: KnowledgeMetadata[] = [];
    for (const kind of kinds) {
      const dir = this.dirFor(kind);
      const absolute = resolve(this.root, dir);
      let names: string[];
      try {
        names = await readdir(absolute);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      for (const name of names) {
        if (!name.endsWith(".meta.json")) continue;
        const slug = name.slice(0, -".meta.json".length);
        const metadata = await this.readMetadata(dir, slug);
        if (filter?.topic !== undefined && metadata.topic !== filter.topic) continue;
        out.push(metadata);
      }
    }
    return out.sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt));
  }

  async search(query: KnowledgeQuery): Promise<KnowledgeSearchHit[]> {
    const terms = tokenize(query.text);
    if (terms.length === 0) return [];
    const limit = query.limit ?? 10;

    const kinds = query.kind ? [query.kind] : (["topic", "source", "research"] as const);
    const hits: KnowledgeSearchHit[] = [];

    for (const kind of kinds) {
      const dir = this.dirFor(kind);
      const absolute = resolve(this.root, dir);
      let names: string[];
      try {
        names = await readdir(absolute);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }

      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        const slug = name.slice(0, -".md".length);
        const metadata = await this.readMetadata(dir, slug);
        if (query.topic !== undefined && metadata.topic !== query.topic) continue;

        const content = await readFile(resolve(absolute, name), "utf8");
        const scored = scoreEntry(metadata, content, terms);
        if (scored.score > 0) {
          hits.push({
            entry: { metadata, content, path: join(dir, name) },
            score: scored.score,
            matchedTerms: scored.matchedTerms,
          });
        }
      }
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private dirFor(kind: KnowledgeKind): string {
    return KIND_DIR[kind];
  }

  private async readMetadata(dir: string, slug: string): Promise<KnowledgeMetadata> {
    const metaPath = this.paths.resolve(join(dir, `${slug}.meta.json`));
    try {
      const raw = await readFile(metaPath, "utf8");
      const parsed = JSON.parse(raw) as KnowledgeMetadata;
      // Defend against hand-edited sidecars: fill required fields.
      return {
        slug: parsed.slug ?? slug,
        kind: parsed.kind ?? DIR_KIND[dir] ?? "topic",
        title: parsed.title ?? slug,
        retrievedAt: parsed.retrievedAt ?? new Date(0).toISOString(),
        provider: parsed.provider ?? "unknown",
        verified: parsed.verified ?? false,
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        ...(parsed.topic !== undefined ? { topic: parsed.topic } : {}),
        ...(parsed.source !== undefined ? { source: parsed.source } : {}),
        ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      };
    } catch {
      // A missing or corrupt sidecar must not hide the content; mark it unknown.
      return {
        slug,
        kind: DIR_KIND[dir] ?? "topic",
        title: slug,
        retrievedAt: new Date(0).toISOString(),
        provider: "unknown",
        verified: false,
        tags: [],
      };
    }
  }
}

/** Lowercase, hyphenated, filesystem-safe. Rejects empty results. */
export function normalizeSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 128);
  if (slug.length === 0) {
    throw new Error(`Invalid knowledge slug: ${JSON.stringify(raw)}`);
  }
  return slug;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "for", "on",
  "with", "as", "by", "at", "be", "it", "that", "this", "from", "how", "what",
]);

function tokenize(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
  )];
}

/**
 * Score by where a term appears, not merely whether it does: a title hit is
 * worth far more than a body hit, and an exact phrase match more than scattered
 * terms. Provenance fields count because they are what a research task searches
 * for ("which entries came from docs.ollama.com?").
 */
function scoreEntry(
  metadata: KnowledgeMetadata,
  content: string,
  terms: string[],
): { score: number; matchedTerms: string[] } {
  const title = metadata.title.toLowerCase();
  const slug = metadata.slug.toLowerCase();
  const tags = metadata.tags.map((t) => t.toLowerCase());
  const provenance = [metadata.source ?? "", metadata.topic ?? "", metadata.provider].join(" ").toLowerCase();
  const body = content.toLowerCase();

  let score = 0;
  const matchedTerms: string[] = [];

  for (const term of terms) {
    let termScore = 0;
    if (title.includes(term)) termScore += 6;
    if (slug.includes(term)) termScore += 4;
    if (tags.some((t) => t.includes(term))) termScore += 4;
    if (provenance.includes(term)) termScore += 3;
    const occurrences = countOccurrences(body, term);
    if (occurrences > 0) termScore += 1 + Math.min(occurrences, 5) * 0.4;
    if (termScore > 0) {
      matchedTerms.push(term);
      score += termScore;
    }
  }

  // Reward entries that match more of the query, not just one rare term.
  score *= 1 + (matchedTerms.length - 1) * 0.15;

  // Verified entries are preferred, all else equal.
  if (metadata.verified) score *= 1.1;

  return { score: Math.round(score * 100) / 100, matchedTerms };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < 100) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
