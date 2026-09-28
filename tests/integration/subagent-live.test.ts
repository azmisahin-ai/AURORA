import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../src/core/agent/AgentRuntime.js";
import { loadConfig } from "../../src/config/Config.js";
import { silentLogger } from "../../src/observability/Logger.js";

/**
 * Live sub-agent integration test (Phase 5 acceptance).
 *
 * SKIPS when Ollama is unreachable — never reported as a pass. When it runs, a
 * real model orchestrates a real `delegate` call, which stands up a real
 * `SubAgentManager`, which runs a real role-scoped `AgentLoop` that writes a
 * real file with the real `write_file` tool.
 *
 * The assertions are on the file on disk and on the delegation appearing in the
 * trajectory — not on either model's prose. A model claiming it delegated is
 * not evidence that it did (ADR 001).
 *
 * Env switches mirror the other live tests.
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
      `sub-agent integration test skipped, NOT passed.\n`,
  );
}

describe.skipIf(!shouldRun)("AgentRuntime ↔ live Ollama ↔ sub-agents", () => {
  let workspace: string;
  let warm = false;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "aurora-live-subagent-"));
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "ok" }], stream: false }),
      signal: AbortSignal.timeout(WARMUP_MS),
    });
    warm = res.ok;
  }, WARMUP_MS + 10_000);

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("delegates to a coder sub-agent that writes a file which exists on disk", async () => {
    expect(warm, `warmup request to ${MODEL} failed`).toBe(true);

    const config = loadConfig({
      ...process.env,
      AURORA_LLM_PROVIDER: "ollama",
      AURORA_MODEL: MODEL,
      OLLAMA_BASE_URL: OLLAMA_URL,
      AURORA_WORKSPACE: workspace,
      AURORA_TIMEOUT_MS: String(RUN_TIMEOUT_MS),
      AURORA_MAX_ITERATIONS: "10",
      AURORA_MAX_SUB_AGENTS: "2",
    });
    const runtime = new AgentRuntime({ config, logger: silentLogger });

    const result = await runtime.createLoop().run(
      "Delegate to the coder sub-agent: create a file named delegated.txt whose " +
        "contents are exactly aurora-phase5-ok. Use the delegate tool.",
    );

    // Evidence 1: the parent actually invoked `delegate`.
    const delegated = result.trajectory.some((t) => t.toolCall?.name === "delegate");
    expect(delegated, "parent never called delegate").toBe(true);

    // Evidence 2: the file the *sub-agent* wrote exists on disk.
    const onDisk = await readFile(join(workspace, "delegated.txt"), "utf8");
    expect(onDisk.trim()).toBe("aurora-phase5-ok");
  }, RUN_TIMEOUT_MS + 60_000);
});
