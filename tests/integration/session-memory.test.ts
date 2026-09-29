import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../src/core/agent/AgentRuntime.js";
import { loadConfig } from "../../src/config/Config.js";
import { silentLogger } from "../../src/observability/Logger.js";
import { ScriptedLLM, finalTurn, toolTurn } from "../unit/helpers.js";
import { StubTools } from "../unit/helpers.js";

/**
 * Phase 7 acceptance: work done in one run is visible to the next (Session
 * memory tier), and the recall block is bounded and untrusted-wrapped.
 *
 * The "restart" is real: each runtime is a fresh object on the same directory,
 * and only the filesystem carries state between them. The LLM is scripted at
 * the network boundary; everything else — runtime, store, builder, loop — is
 * the real implementation.
 */

let sessionDir: string;

beforeEach(async () => {
  sessionDir = await mkdtemp(join(tmpdir(), "aurora-session-memory-"));
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

function runtime(llm: ScriptedLLM, tools?: StubTools) {
  const config = loadConfig({ AURORA_SESSION_DIR: sessionDir } as NodeJS.ProcessEnv);
  return new AgentRuntime({
    config,
    llm,
    ...(tools ? { tools } : {}),
    logger: silentLogger,
  });
}

describe("session memory across runs", () => {
  it("persists a completed run and recalls it in the next", async () => {
    const first = runtime(new ScriptedLLM([finalTurn("ollama runs on port 11434")]), new StubTools({}));
    const result = await first.runTask("where does ollama listen");
    expect(result.status).toBe("completed");

    // A second runtime, fresh on disk: only the file carries state.
    const secondLlm = new ScriptedLLM([finalTurn("ok")]);
    const second = runtime(secondLlm, new StubTools({}));
    const recall = await second.recall();
    expect(recall).toBeDefined();
    expect(recall).toMatch(/where does ollama listen/);
    expect(recall).toMatch(/ollama runs on port 11434/);
    expect(recall).toMatch(/UNTRUSTED DATA/);
  });

  it("injects the recall into the provider call of the next run", async () => {
    await runtime(new ScriptedLLM([finalTurn("earlier work")]), new StubTools({})).runTask(
      "earlier task",
    );

    const llm = new ScriptedLLM([finalTurn("done")]);
    await runtime(llm, new StubTools({})).runTask("new task");

    const messages = llm.calls[0]!.messages;
    const recall = messages.find(
      (m) => m.role === "user" && m.content.includes("Summary of earlier sessions"),
    );
    expect(recall).toBeDefined();
    // The task is still the last user message, not displaced by recall.
    expect(messages.at(-1)).toEqual({ role: "user", content: "new task" });
  });

  it("records the tools a run used", async () => {
    const llm = new ScriptedLLM([toolTurn("read_file", { path: "a" }), finalTurn("done")]);
    const tools = new StubTools({ read_file: { ok: true, observation: "contents" } });
    await runtime(llm, tools).runTask("read a");

    const records = await runtime(new ScriptedLLM([finalTurn("x")]), new StubTools({})).sessions.list();
    expect(records[0]?.toolsUsed).toEqual(["read_file"]);
  });

  it("produces no recall when disabled, even with stored sessions", async () => {
    await runtime(new ScriptedLLM([finalTurn("earlier")]), new StubTools({})).runTask("t1");

    const config = loadConfig({
      AURORA_SESSION_DIR: sessionDir,
      AURORA_RECALL_SESSIONS: "0",
    } as NodeJS.ProcessEnv);
    const disabled = new AgentRuntime({ config, llm: new ScriptedLLM([finalTurn("x")]), logger: silentLogger });
    expect(await disabled.recall()).toBeUndefined();
  });

  it("leaves the output intact when a session save fails", async () => {
    // A file where the session directory should be makes writes fail.
    const config = loadConfig({ AURORA_SESSION_DIR: sessionDir } as NodeJS.ProcessEnv);
    const rt = new AgentRuntime({
      config,
      llm: new ScriptedLLM([finalTurn("the answer")]),
      logger: silentLogger,
      sessionStore: {
        save: async () => {
          throw new Error("disk full");
        },
        get: async () => undefined,
        list: async () => [],
        recent: async () => [],
      },
    });
    const result = await rt.runTask("t");
    expect(result.status).toBe("completed");
    expect(result.output).toBe("the answer");
  });
});
