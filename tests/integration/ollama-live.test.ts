import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/core/agent/AgentRuntime.js";
import { loadConfig } from "../../src/config/Config.js";
import { silentLogger } from "../../src/observability/Logger.js";

/**
 * Live Ollama integration test.
 *
 * If Ollama is not running this test SKIPS — it is never reported as a pass.
 * When Ollama IS running, the full AgentLoop path runs against the real model.
 *
 * Set AURORA_TEST_OLLAMA=1 to force-run (it will fail rather than skip if the
 * server is unreachable), or AURORA_TEST_OLLAMA=0 to force-skip.
 */

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const MODEL = process.env.AURORA_MODEL ?? "llama3.2";

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

const force = process.env.AURORA_TEST_OLLAMA;
const reachable = force === "0" ? false : await ollamaReachable();
const shouldRun = force === "1" ? true : reachable;

const reason = reachable
  ? `Ollama reachable at ${OLLAMA_URL}`
  : `Ollama NOT reachable at ${OLLAMA_URL} — integration test skipped (not passed)`;

// Vitest prints this in the run output so a skip is visible, not silent.
if (!shouldRun) {
  // eslint-disable-next-line no-console
  console.warn(`\n[integration] SKIP: ${reason}\n`);
}

describe.skipIf(!shouldRun)("AgentLoop ↔ live Ollama", () => {
  it("answers a simple prompt through the real agent loop", async () => {
    const config = loadConfig({
      ...process.env,
      AURORA_LLM_PROVIDER: "ollama",
      AURORA_MODEL: MODEL,
      OLLAMA_BASE_URL: OLLAMA_URL,
      AURORA_TIMEOUT_MS: "120000",
    });
    const runtime = new AgentRuntime({ config, logger: silentLogger });

    const loop = runtime.createLoop();
    const result = await loop.run("Reply with exactly the word: merhaba");

    expect(result.status).toBe("completed");
    expect(result.output.trim().length).toBeGreaterThan(0);
  }, 130_000);
});
