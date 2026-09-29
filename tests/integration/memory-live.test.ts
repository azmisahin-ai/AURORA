import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../src/core/agent/AgentRuntime.js";
import { loadConfig } from "../../src/config/Config.js";
import { silentLogger } from "../../src/observability/Logger.js";

/**
 * Live memory integration test (Phase 7 acceptance).
 *
 * SKIPS when Ollama is unreachable — never reported as a pass. When it runs, a
 * real model completes a real task through the real loop; the session record
 * written to disk and the recall block read back by a *second* runtime are the
 * evidence. Nothing about the model's prose is asserted.
 */

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.AURORA_MODEL ?? "llama3.2";
const WARMUP_MS = Number(process.env.AURORA_TEST_OLLAMA_WARMUP_MS ?? 300_000);
const RUN_TIMEOUT_MS = Number(process.env.AURORA_TEST_OLLAMA_TIMEOUT_MS ?? 240_000);
const base = OLLAMA_URL.replace(/\/+$/, "");

async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const force = process.env.AURORA_TEST_OLLAMA;
const reachable = force === "0" ? false : await ollamaReachable();
const shouldRun = force === "1" ? true : reachable;

if (!shouldRun) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n[integration] SKIP: Ollama NOT reachable at ${OLLAMA_URL} — ` +
      `memory integration test skipped, NOT passed.\n`,
  );
}

describe.skipIf(!shouldRun)("AgentRuntime ↔ live Ollama ↔ session memory", () => {
  let sessionDir: string;
  let warm = false;

  beforeAll(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "aurora-live-memory-"));
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "ok" }],
        stream: false,
      }),
      signal: AbortSignal.timeout(WARMUP_MS),
    });
    warm = res.ok;
  }, WARMUP_MS + 10_000);

  afterAll(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  function runtime() {
    const config = loadConfig({
      AURORA_SESSION_DIR: sessionDir,
      AURORA_MODEL: MODEL,
      OLLAMA_BASE_URL: base,
    } as NodeJS.ProcessEnv);
    return new AgentRuntime({ config, logger: silentLogger });
  }

  it("persists a real run and recalls it from a fresh runtime", async () => {
    expect(warm, "model warmup failed").toBe(true);

    const first = runtime();
    const result = await first.runTask(
      "Remember this sentence exactly: the aurora test marker is PLUTO-77. Reply with just: stored",
      { signal: AbortSignal.timeout(RUN_TIMEOUT_MS) },
    );
    expect(result.status).toBe("completed");

    // The session record on disk is the evidence, not the model's claim.
    const stored = await first.sessions.recent(5);
    expect(stored.length).toBeGreaterThanOrEqual(1);
    expect(stored[0]?.task).toMatch(/PLUTO-77/);

    // A second runtime reads only from the filesystem.
    const recall = await runtime().recall();
    expect(recall).toBeDefined();
    expect(recall).toMatch(/UNTRUSTED DATA/);
    expect(recall).toMatch(/PLUTO-77/);
  }, RUN_TIMEOUT_MS + 10_000);
});
