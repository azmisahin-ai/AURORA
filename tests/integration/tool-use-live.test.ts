import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../src/core/agent/AgentRuntime.js";
import { loadConfig } from "../../src/config/Config.js";
import { silentLogger } from "../../src/observability/Logger.js";

/**
 * Live tool-use integration test (Phase 2 acceptance).
 *
 * SKIPS when Ollama is unreachable — never reported as a pass. When it runs, a
 * real model drives the real AgentLoop, which offers real tool definitions,
 * receives a real tool call, and executes real filesystem tools. The assertion
 * is on the file that exists on disk, not on the model's prose: the model's own
 * claim of success is not evidence (ADR 001).
 *
 * Env switches mirror ollama-live.test.ts:
 *   AURORA_TEST_OLLAMA=0|1, AURORA_MODEL, OLLAMA_BASE_URL,
 *   AURORA_TEST_OLLAMA_WARMUP_MS, AURORA_TEST_OLLAMA_TIMEOUT_MS
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
      `tool-use integration test skipped, NOT passed.\n`,
  );
}

describe.skipIf(!shouldRun)("AgentLoop ↔ live Ollama ↔ real tools", () => {
  let workspace: string;
  let warm = false;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "aurora-live-tools-"));
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
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("writes a file through the tool system and the file exists on disk", async () => {
    expect(warm, `warmup request to ${MODEL} failed`).toBe(true);

    const config = loadConfig({
      ...process.env,
      AURORA_LLM_PROVIDER: "ollama",
      AURORA_MODEL: MODEL,
      OLLAMA_BASE_URL: OLLAMA_URL,
      AURORA_WORKSPACE: workspace,
      AURORA_TIMEOUT_MS: String(RUN_TIMEOUT_MS),
      AURORA_MAX_ITERATIONS: "12",
    });
    const runtime = new AgentRuntime({ config, logger: silentLogger });

    const result = await runtime
      .createLoop()
      .run(
        "Use the write_file tool to create a file named proof.txt containing " +
          "exactly the text: aurora-phase2-ok. Do not do anything else.",
      );

    // The model is free to narrate; the evidence is the file.
    expect(result.toolCalls).toBeGreaterThan(0);
    const onDisk = await readFile(join(workspace, "proof.txt"), "utf8");
    expect(onDisk.trim()).toBe("aurora-phase2-ok");
  }, RUN_TIMEOUT_MS + 60_000);
});
