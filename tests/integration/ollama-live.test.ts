import { beforeAll, describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/core/agent/AgentRuntime.js";
import { loadConfig } from "../../src/config/Config.js";
import { silentLogger } from "../../src/observability/Logger.js";

/**
 * Live Ollama integration test.
 *
 * If Ollama is not running this test SKIPS — it is never reported as a pass.
 * When Ollama IS running, the full AgentLoop path runs against the real model.
 *
 * Env switches:
 *   AURORA_TEST_OLLAMA=0        force-skip
 *   AURORA_TEST_OLLAMA=1        force-run (fails rather than skips if unreachable)
 *   AURORA_MODEL                model to use (default: llama3.2)
 *   OLLAMA_BASE_URL             default: http://127.0.0.1:11434
 *   AURORA_TEST_OLLAMA_WARMUP_MS   budget for the first (cold) request
 *   AURORA_TEST_OLLAMA_TIMEOUT_MS  per-run agent timeout
 *
 * On CPU-only hosts the first request pays the model load cost (tens of seconds
 * to minutes for a multi-GB model). We therefore warm the model up in beforeAll
 * and only time the already-loaded run, so the assertion measures the agent loop
 * rather than disk/VRAM warmup.
 */

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.AURORA_MODEL ?? "llama3.2";
const WARMUP_MS = Number(process.env.AURORA_TEST_OLLAMA_WARMUP_MS ?? 300_000);
const RUN_TIMEOUT_MS = Number(process.env.AURORA_TEST_OLLAMA_TIMEOUT_MS ?? 180_000);

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
      `integration test skipped, NOT passed.\n`,
  );
}

describe.skipIf(!shouldRun)("AgentLoop ↔ live Ollama", () => {
  let warm = false;

  beforeAll(async () => {
    // Load the model into memory before the timed assertion. This request is
    // intentionally not asserted on; it only removes cold-start cost.
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

  it("answers a simple prompt through the real agent loop", async () => {
    expect(warm, `warmup request to ${MODEL} failed`).toBe(true);

    const config = loadConfig({
      ...process.env,
      AURORA_LLM_PROVIDER: "ollama",
      AURORA_MODEL: MODEL,
      OLLAMA_BASE_URL: OLLAMA_URL,
      AURORA_TIMEOUT_MS: String(RUN_TIMEOUT_MS),
    });
    const runtime = new AgentRuntime({ config, logger: silentLogger });

    const loop = runtime.createLoop();
    const result = await loop.run("Reply with exactly the word: merhaba");

    expect(result.status).toBe("completed");
    expect(result.output.trim().length).toBeGreaterThan(0);
  }, RUN_TIMEOUT_MS + 30_000);
});
