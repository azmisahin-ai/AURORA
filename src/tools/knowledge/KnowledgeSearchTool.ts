import { z } from "zod/v4";
import { defineTool } from "../types.js";
import type { KnowledgeStore } from "../../core/knowledge/KnowledgeStore.js";
import { wrapUntrusted } from "../../security/UntrustedData.js";

/**
 * Search long-term knowledge. Results are local files the agent itself wrote, so
 * they are lower risk than web content — but they may quote web content, so the
 * result body is still wrapped as untrusted data. Provenance is printed for
 * every hit, because retrieval can surface stale or wrong entries.
 */
export function knowledgeSearchTool(store: KnowledgeStore) {
  return defineTool({
    name: "knowledge_search",
    description:
      "Search long-term knowledge (topics, sources, research notes) by keyword. " +
      "Returns matching entries with their provenance (source URL, retrieval date, verified flag).",
    inputSchema: z.object({
      query: z.string().min(1).describe("Keywords to search for"),
      kind: z.enum(["topic", "source", "research"]).optional().describe("Restrict to one kind"),
      topic: z.string().optional().describe("Restrict to one topic"),
      limit: z.number().int().positive().max(20).optional().describe("Max results (default 10)"),
    }),
    requiredPermissions: ["READ_ONLY"] as const,
    async execute(input) {
      const hits = await store.search({
        text: input.query,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.topic !== undefined ? { topic: input.topic } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });

      if (hits.length === 0) {
        return {
          ok: true,
          output: `No knowledge entries matched "${input.query}".`,
        };
      }

      const blocks = hits.map((hit) => {
        const m = hit.entry.metadata;
        const provenance = [
          `kind=${m.kind}`,
          `slug=${m.slug}`,
          `title=${m.title}`,
          m.source ? `source=${m.source}` : undefined,
          `retrievedAt=${m.retrievedAt}`,
          `verified=${m.verified}`,
          m.topic ? `topic=${m.topic}` : undefined,
          `score=${hit.score}`,
        ]
          .filter(Boolean)
          .join(" | ");
        const body = hit.entry.content.length > 4_000
          ? `${hit.entry.content.slice(0, 4_000)}\n[entry truncated for context]`
          : hit.entry.content;
        return `### ${m.title}\n${provenance}\n\n${body}`;
      });

      const wrapped = wrapUntrusted(blocks.join("\n\n"), {
        origin: `knowledge_search "${input.query}" (${hits.length} hits)`,
      });
      return { ok: true, output: wrapped.text };
    },
  });
}
