import type { Command } from "commander";
import { loadConfig } from "../../config/Config.js";
import { FileKnowledgeStore } from "../../core/knowledge/FileKnowledgeStore.js";

export function registerKnowledgeCommand(program: Command): void {
  const knowledge = program
    .command("knowledge")
    .description("Inspect the long-term knowledge store");

  knowledge
    .command("list")
    .description("List knowledge entries with their provenance")
    .option("--kind <kind>", "topic | source | research")
    .option("--topic <topic>", "filter by topic")
    .action(async (options: { kind?: string; topic?: string }) => {
      const config = loadConfig();
      const store = new FileKnowledgeStore(config.knowledgeDir);
      const entries = await store.list({
        ...(options.kind ? { kind: options.kind as "topic" | "source" | "research" } : {}),
        ...(options.topic ? { topic: options.topic } : {}),
      });
      if (entries.length === 0) {
        process.stdout.write(`No knowledge entries in ${config.knowledgeDir}.\n`);
        return;
      }
      for (const entry of entries) {
        const verified = entry.verified ? "verified" : "UNVERIFIED";
        const source = entry.source ? ` <- ${entry.source}` : "";
        process.stdout.write(
          `${entry.kind.padEnd(8)} ${entry.slug.padEnd(32)} [${verified}] ${entry.retrievedAt}${source}\n`,
        );
      }
    });

  knowledge
    .command("search")
    .description("Search knowledge by keyword")
    .argument("<query>", "search terms")
    .option("--kind <kind>", "topic | source | research")
    .option("--topic <topic>", "filter by topic")
    .option("--limit <n>", "max results", "10")
    .action(async (query: string, options: { kind?: string; topic?: string; limit?: string }) => {
      const config = loadConfig();
      const store = new FileKnowledgeStore(config.knowledgeDir);
      const hits = await store.search({
        text: query,
        ...(options.kind ? { kind: options.kind as "topic" | "source" | "research" } : {}),
        ...(options.topic ? { topic: options.topic } : {}),
        ...(options.limit ? { limit: Number(options.limit) } : {}),
      });
      if (hits.length === 0) {
        process.stdout.write(`No knowledge entries matched "${query}".\n`);
        return;
      }
      for (const hit of hits) {
        const m = hit.entry.metadata;
        process.stdout.write(
          `${m.kind}/${m.slug} (score ${hit.score})${m.source ? ` <- ${m.source}` : ""}\n`,
        );
      }
    });

  knowledge
    .command("show")
    .description("Print one knowledge entry and its metadata")
    .argument("<kind>", "topic | source | research")
    .argument("<slug>", "entry slug")
    .action(async (kind: string, slug: string) => {
      const config = loadConfig();
      const store = new FileKnowledgeStore(config.knowledgeDir);
      const entry = await store.read(kind as "topic" | "source" | "research", slug);
      if (!entry) {
        process.stderr.write(`aurora: no ${kind} entry named "${slug}".\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${JSON.stringify(entry.metadata, null, 2)}\n\n${entry.content}\n`);
    });
}
