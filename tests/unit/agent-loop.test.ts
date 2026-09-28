import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../src/core/agent/AgentLoop.js";
import type { AgentLoopDeps } from "../../src/core/agent/types.js";
import { Planner } from "../../src/core/planner/Planner.js";
import { LLMError } from "../../src/providers/llm/LLMProvider.js";
import { ScriptedLLM, StubTools, ThrowingLLM, finalTurn, toolTurn } from "./helpers.js";

const limits = { maxIterations: 5, maxToolCalls: 5, timeoutMs: 2_000 };

function makeLoop(llm: AgentLoopDeps["llm"], tools?: AgentLoopDeps["tools"]) {
  return new AgentLoop({
    llm,
    planner: new Planner(),
    ...(tools ? { tools } : {}),
    limits,
  });
}

describe("AgentLoop", () => {
  it("returns the model's final answer in one iteration", async () => {
    const loop = makeLoop(new ScriptedLLM([finalTurn("merhaba")]));
    const result = await loop.run("Merhaba de");
    expect(result.status).toBe("completed");
    expect(result.output).toBe("merhaba");
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(0);
  });

  it("feeds the system prompt and the user task to the provider", async () => {
    const llm = new ScriptedLLM([finalTurn("ok")]);
    await makeLoop(llm).run("görev");
    const first = llm.calls[0];
    expect(first?.messages[0]?.role).toBe("system");
    expect(first?.messages[0]?.content).toMatch(/UNTRUSTED DATA/);
    expect(first?.messages[1]).toEqual({ role: "user", content: "görev" });
  });

  it("executes a tool then uses the observation to finish", async () => {
    const llm = new ScriptedLLM([
      toolTurn("echo_tool", { value: "hi" }),
      finalTurn("done"),
    ]);
    const tools = new StubTools({
      echo_tool: { ok: true, observation: "hi" },
    });
    const result = await makeLoop(llm, tools).run("do it");

    expect(result.status).toBe("completed");
    expect(result.toolCalls).toBe(1);
    expect(tools.executed).toHaveLength(1);
    expect(tools.executed[0]?.name).toBe("echo_tool");

    // The tool result must be appended as a tool-role message.
    const secondCall = llm.calls[1];
    const last = secondCall?.messages.at(-1);
    expect(last?.role).toBe("tool");
    expect(last?.content).toBe("hi");
    expect(last?.toolName).toBe("echo_tool");
  });

  it("stops at maxIterations when the model keeps calling tools", async () => {
    const script = Array.from({ length: 10 }, () => toolTurn("loop_tool"));
    const tools = new StubTools({ loop_tool: { ok: true, observation: "again" } });
    const loop = new AgentLoop({
      llm: new ScriptedLLM(script),
      planner: new Planner(),
      tools,
      limits: { maxIterations: 3, maxToolCalls: 100, timeoutMs: 2_000 },
    });

    const result = await loop.run("loop forever");
    expect(result.status).toBe("max_iterations");
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toBe(3);
  });

  it("stops at maxToolCalls even when iterations remain", async () => {
    const script = Array.from({ length: 10 }, () => toolTurn("t"));
    const tools = new StubTools({ t: { ok: true, observation: "x" } });
    const loop = new AgentLoop({
      llm: new ScriptedLLM(script),
      planner: new Planner(),
      tools,
      limits: { maxIterations: 100, maxToolCalls: 2, timeoutMs: 2_000 },
    });

    const result = await loop.run("many tools");
    expect(result.status).toBe("max_tool_calls");
    expect(result.toolCalls).toBe(2);
    // Two executed, and the third attempt exits before executing.
    expect(tools.executed).toHaveLength(2);
  });

  it("reports an unknown tool back to the model instead of crashing", async () => {
    const llm = new ScriptedLLM([toolTurn("ghost"), finalTurn("recovered")]);
    const tools = new StubTools({});
    const result = await makeLoop(llm, tools).run("call ghost");
    expect(result.status).toBe("completed");
    const secondCall = llm.calls[1];
    const last = secondCall?.messages.at(-1);
    expect(last?.content).toMatch(/Unknown tool "ghost"/);
  });

  it("marks a fatal tool failure as an error result", async () => {
    const tools: ConstructorParameters<typeof AgentLoop>[0]["tools"] = {
      has: () => true,
      execute: async () => ({ ok: false, observation: "boom", fatal: true }),
    };
    const loop = makeLoop(new ScriptedLLM([toolTurn("bad")]), tools);
    const result = await loop.run("fail");
    expect(result.status).toBe("error");
    expect(result.error).toBe("boom");
  });

  it("returns timeout when the provider is too slow", async () => {
    const slow: ConstructorParameters<typeof AgentLoop>[0]["llm"] = {
      name: "slow",
      model: "slow",
      chat: (_input) =>
        new Promise((_resolve, reject) => {
          const t = setTimeout(() => reject(new Error("unreachable")), 5_000);
          _input.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new LLMError("aborted", { provider: "slow" }));
          });
        }),
    };
    const loop = new AgentLoop({
      llm: slow,
      planner: new Planner(),
      limits: { maxIterations: 5, maxToolCalls: 5, timeoutMs: 50 },
    });
    const result = await loop.run("slow");
    expect(result.status).toBe("timeout");
  });

  it("returns error when the provider throws a non-abort failure", async () => {
    const loop = makeLoop(
      new ThrowingLLM(new LLMError("connection refused", { provider: "x" })),
    );
    const result = await loop.run("anything");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/connection refused/);
  });

  it("records a trajectory entry per iteration", async () => {
    const llm = new ScriptedLLM([toolTurn("t"), finalTurn("end")]);
    const tools = new StubTools({ t: { ok: true, observation: "obs" } });
    const result = await makeLoop(llm, tools).run("trace me");
    expect(result.trajectory).toHaveLength(2);
    expect(result.trajectory[0]?.toolCall?.name).toBe("t");
    expect(result.trajectory[1]?.step.kind).toBe("final");
  });
});
