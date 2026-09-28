import { beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../src/core/agent/AgentRuntime.js";
import { loadConfig } from "../../src/config/Config.js";
import { createLogger } from "../../src/observability/Logger.js";

/**
 * Live end-to-end Phase 3 acceptance: a real model researches a real web page
 * and persists the finding to the knowledge store, which is then verified on
 * disk and retrieved by search.
 *
 * Skips (never "passes") when either Ollama or network egress is missing.
 *
 * Env switches:
 *   AURORA_TEST_OLLAMA=0 / =1     force skip / force run
 *   AURORA_TEST_NETWORK=0 / =1    force skip / force run
 *   AURORA_MODEL                  model to use (no model is hard-coded)
 */

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.AURORA_MODEL ?? "llama3.2";
const WARMUP_MS = Number(process.env.AURORA_TEST_OLLAMA_WARMUP_MS ?? 300_000);
const RUN_TIMEOUT_MS = Number(process.env.AURORA_TEST_OLLAMA_TIMEOUT_MS ?? 300_000);

async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL.replace(/\/+$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function networkReachable(): Promise<boolean> {
  try {
    const res = await fetch("https://example.com/", {
      method: "HEAD",
      signal: AbortSignal.timeout(8_000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

const ollamaForced = process.env.AURORA_TEST_OLLAMA;
const netForced = process.env.AURORA_TEST_NETWORK;

const hasOllama = ollamaForced === "0" ? false : ollamaForced === "1" ? true : await ollamaReachable();
const hasNet = netForced === "0" ? false : netForced === "1" ? true : await networkReachable();
const shouldRun = hasOllama && hasNet;

if (!shouldRun) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n[integration] SKIP: live research E2E skipped (ollama=${hasOllama}, network=${hasNet}) — ` +
      "skipped, NOT passed.\n",
  );
}

describe.skipIf(!shouldRun)("agent ↔ live web ↔ knowledge store", () => {
  beforeAll(async () => {
    // Warm the model so the timed run is not paying cold-load cost.
    await fetch(`${OLLAMA_URL.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        options: { num_predict: 1 },
      }),
      signal: AbortSignal.timeout(WARMUP_MS),
    }).catch(() => undefined);
  }, WARMUP_MS + 10_000);

  it(
    "fetches a real page and saves the finding to knowledge with provenance",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "aurora-e2e-ws-"));
      const knowledgeDir = await mkdtemp(join(tmpdir(), "aurora-e2e-kb-"));

      try {
        const config = loadConfig({
          ...process.env,
          AURORA_LLM_PROVIDER: "ollama",
          AURORA_MODEL: MODEL,
          AURORA_WORKSPACE: workspace,
          AURORA_KNOWLEDGE_DIR: knowledgeDir,
          AURORA_LOG_LEVEL: "silent",
          AURORA_MAX_ITERATIONS: "10",
          AURORA_MAX_TOOL_CALLS: "12",
          // CPU-only inference is slow (tens of seconds per generation), so the
          // default 120s agent budget is too tight for a multi-step run.
          AURORA_TIMEOUT_MS: String(RUN_TIMEOUT_MS),
        } as NodeJS.ProcessEnv);

        const runtime = new AgentRuntime({ config, logger: createLogger("silent") });
        const loop = runtime.createLoop();

        const task =
          "Use web_fetch to read https://example.com/ and then use knowledge_write " +
          "to save what the page says. For the knowledge_write call use kind \"topic\", " +
          "slug \"example-domain\", title \"Example Domain\", topic \"web\", " +
          "source \"https://example.com/\", and verified true. Then reply with a one-line summary.";

        const result = await loop.run(task);

        // The run must complete through the real loop.
        expect(result.status, `status=${result.status} error=${result.error ?? ""}`).toBe(
          "completed",
        );

        // The decisive assertion is on disk, not on the model's prose: a run
        // that only claims success must fail this test.
        const topicsDir = join(knowledgeDir, "topics");
        const files = await readdir(topicsDir).catch(() => [] as string[]);
        const mdFiles = files.filter((f) => f.endsWith(".md"));
        expect(mdFiles.length, `knowledge files: ${files.join(", ")}`).toBeGreaterThan(0);

        const slug = mdFiles[0]!.replace(/\.md$/, "");
        const content = await readFile(join(topicsDir, mdFiles[0]!), "utf8");
        expect(content.length).toBeGreaterThan(0);

        const meta = JSON.parse(
          await readFile(join(topicsDir, `${slug}.meta.json`), "utf8"),
        ) as Record<string, unknown>;
        expect(meta.kind).toBe("topic");
        expect(meta.retrievedAt).toBeTruthy();
        expect(typeof meta.verified).toBe("boolean");

        // And it is retrievable through the real store.
        const { FileKnowledgeStore } = await import(
          "../../src/core/knowledge/FileKnowledgeStore.js"
        );
        const hits = await new FileKnowledgeStore(knowledgeDir).search({
          text: "example domain",
        });
        expect(hits.length).toBeGreaterThan(0);
      } finally {
        await rm(workspace, { recursive: true, force: true });
        await rm(knowledgeDir, { recursive: true, force: true });
      }
    },
    RUN_TIMEOUT_MS,
  );
});
