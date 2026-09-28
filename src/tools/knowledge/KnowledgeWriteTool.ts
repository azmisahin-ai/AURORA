import { z } from "zod/v4";
import { defineTool } from "../types.js";
import type { KnowledgeStore } from "../../core/knowledge/KnowledgeStore.js";

/**
 * Persist a research finding with provenance. Kept as a factory because the
 * tool needs the store, which is constructed from config at runtime.
 */
export function knowledgeWriteTool(store: KnowledgeStore) {
  return defineTool({
    name: "knowledge_write",
    description:
      "Save a research finding or technical note to long-term knowledge with provenance. " +
      "Always set source to the URL the content came from and verified=true only if you " +
      "confirmed it against the primary source.",
    inputSchema: z.object({
      kind: z
        .enum(["topic", "source", "research"])
        .describe("topic = synthesized note, source = raw fetched page, research = dated report"),
      slug: z.string().min(1).describe("Short kebab-case identifier, e.g. ollama-api-chat"),
      title: z.string().min(1).describe("Human-readable title"),
      content: z.string().min(1).describe("Markdown body"),
      topic: z.string().optional().describe("Topic this belongs to"),
      source: z.string().optional().describe("Origin URL, if the content came from the web"),
      verified: z.boolean().optional().describe("True only if checked against the primary source"),
      tags: z.array(z.string()).optional().describe("Free-form tags"),
      notes: z.string().optional().describe("Caveats, e.g. an unverified claim marker"),
    }),
    requiredPermissions: ["WORKSPACE_WRITE"] as const,
    async execute(input) {
      const entry = await store.write({
        kind: input.kind,
        slug: input.slug,
        title: input.title,
        content: input.content,
        provider: "agent",
        ...(input.topic !== undefined ? { topic: input.topic } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.verified !== undefined ? { verified: input.verified } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
      return {
        ok: true,
        output:
          `Saved ${entry.metadata.kind} "${entry.metadata.slug}" to ${entry.path} ` +
          `(verified=${entry.metadata.verified}, retrievedAt=${entry.metadata.retrievedAt})`,
      };
    },
  });
}
