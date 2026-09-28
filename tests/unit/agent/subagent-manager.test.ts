import { describe, expect, it } from "vitest";
import { SubAgentManager } from "../../../src/core/agent/subagent/index.js";
import type { RoleToolsetBuilder } from "../../../src/core/agent/subagent/index.js";
import { roleDefinition } from "../../../src/core/agent/roles/index.js";
import type { ToolExecutor } from "../../../src/core/agent/types.js";
import { ScriptedLLM, StubTools, finalTurn, toolTurn } from "../helpers.js";

/**
 * A toolset builder that records which roles were asked for, and hands back a
 * stub executor. Doubles the *tool layer* boundary (a real registry lives in
 * the tools package); the `RoleToolsetBuilder` interface is the real one.
 */
class RecordingToolsetBuilder implements RoleToolsetBuilder {
  readonly built: string[] = [];
  constructor(private readonly tools: ToolExecutor) {}
  build(role: string) {
    this.built.push(role);
    return { tools: this.tools, permissions: [] };
  }
}

function manager(
  llm: ScriptedLLM,
  opts: {
    tools?: ToolExecutor;
    maxSubAgents?: number;
    verifier?: import("../../../src/core/agent/types.js").Verifier;
  } = {},
) {
  const builder = new RecordingToolsetBuilder(
    opts.tools ?? new StubTools({}),
  );
  return {
    builder,
    manager: new SubAgentManager({
      llm,
      toolsetBuilder: builder,
      ...(opts.verifier ? { verifier: opts.verifier } : {}),
      maxSubAgents: opts.maxSubAgents ?? 3,
      timeoutMs: 5_000,
    }),
  };
}

describe("SubAgentManager", () => {
  it("runs a sub-agent in an isolated context: role prompt + task only", async () => {
    const llm = new ScriptedLLM([finalTurn("researcher says hi")]);
    const { manager: m } = manager(llm);

    const result = await m.run({ role: "researcher", task: "find X" });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("researcher says hi");

    // The sub-agent's context must be its role prompt and the task — nothing
    // from a parent conversation. This is the whole reason to use a sub-agent.
    const first = llm.calls[0];
    expect(first?.messages).toHaveLength(2);
    expect(first?.messages[0]?.role).toBe("system");
    expect(first?.messages[0]?.content).toBe(roleDefinition("researcher").systemPrompt);
    expect(first?.messages[1]).toEqual({ role: "user", content: "find X" });
  });

  it("uses the role's own system prompt, not a generic one", async () => {
    const llm = new ScriptedLLM([finalTurn("ok")]);
    const { manager: m } = manager(llm);
    await m.run({ role: "reviewer", task: "review the change" });
    expect(llm.calls[0]?.messages[0]?.content).toBe(roleDefinition("reviewer").systemPrompt);
    expect(llm.calls[0]?.messages[0]?.content).toMatch(/read-only/i);
  });

  it("bounds the sub-agent by its role budget, not the parent's", async () => {
    // A model that never stops asking for tools must still terminate at the
    // role's maxIterations.
    const budget = roleDefinition("researcher").budget.maxIterations;
    const script = Array.from({ length: budget + 5 }, () => toolTurn("read_file", { path: "x" }));
    const llm = new ScriptedLLM(script);
    const tools = new StubTools({ read_file: { ok: true, observation: "contents" } });
    const { manager: m } = manager(llm, { tools });

    const result = await m.run({ role: "researcher", task: "loop forever" });

    expect(result.status).toBe("max_iterations");
    expect(result.iterations).toBe(budget);
  });

  it("enforces maxSubAgents across the run and refuses further delegation", async () => {
    const llm = new ScriptedLLM([finalTurn("a"), finalTurn("b"), finalTurn("c"), finalTurn("d")]);
    const { manager: m } = manager(llm, { maxSubAgents: 2 });

    expect(m.remaining()).toBe(2);
    await m.run({ role: "researcher", task: "one" });
    await m.run({ role: "researcher", task: "two" });
    expect(m.remaining()).toBe(0);

    const third = await m.run({ role: "researcher", task: "three" });
    expect(third.status).toBe("error");
    expect(third.error).toMatch(/budget exhausted/i);
    // The refused delegation must not have reached the model.
    expect(llm.calls).toHaveLength(2);
  });

  it("propagates a workspace mutation from the sub-agent to the result", async () => {
    const llm = new ScriptedLLM([toolTurn("write_file", { path: "a.txt" }), finalTurn("done")]);
    const tools = new StubTools({
      write_file: { ok: true, observation: "wrote", mutatedWorkspace: true },
    });
    const { manager: m } = manager(llm, { tools });

    const result = await m.run({ role: "coder", task: "write a file" });
    expect(result.mutatedWorkspace).toBe(true);
  });

  it("reports no mutation when the sub-agent only read", async () => {
    const llm = new ScriptedLLM([toolTurn("read_file", { path: "a" }), finalTurn("done")]);
    const tools = new StubTools({ read_file: { ok: true, observation: "contents" } });
    const { manager: m } = manager(llm, { tools });

    const result = await m.run({ role: "reviewer", task: "read a" });
    expect(result.mutatedWorkspace).toBe(false);
  });

  it("does not wire the verifier for a role with no verification budget", async () => {
    let verifyCalls = 0;
    const verifier = {
      name: "npm test",
      async verify() {
        verifyCalls++;
        return { kind: "pass" as const, observation: "exit 0" };
      },
    };
    // A coder mutates but has maxVerifications: 0, so the parent verifier must
    // not be invoked by the sub-agent.
    const llm = new ScriptedLLM([toolTurn("write_file", { path: "a" }), finalTurn("done")]);
    const tools = new StubTools({
      write_file: { ok: true, observation: "wrote", mutatedWorkspace: true },
    });
    const { manager: m } = manager(llm, { tools, verifier });

    await m.run({ role: "coder", task: "write" });
    expect(verifyCalls).toBe(0);
  });

  it("passes the signal through so a cancelled parent cancels the sub-agent", async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = new ScriptedLLM([finalTurn("never")]);
    const { manager: m } = manager(llm);
    const result = await m.run({ role: "researcher", task: "x" }, controller.signal);
    expect(result.status).toBe("aborted");
  });
});
