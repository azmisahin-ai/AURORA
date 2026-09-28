import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../../src/core/agent/AgentLoop.js";
import type { AgentLoopDeps } from "../../../src/core/agent/types.js";
import type { ToolCall } from "../../../src/providers/llm/LLMProvider.js";
import { Planner } from "../../../src/core/planner/Planner.js";
import { ScriptedLLM, StubTools, finalTurn, toolTurn } from "../helpers.js";

/**
 * A scripted external verifier. Like `ScriptedLLM`, this doubles a *boundary*
 * (a real process the loop cannot run in a unit test), not an internal
 * function. The `Verifier` interface it implements is the real one.
 */
class ScriptedVerifier {
  readonly name = "npm test";
  calls = 0;
  constructor(private readonly outcomes: Array<"pass" | "fail" | "skipped">) {}
  async verify() {
    const kind = this.outcomes[this.calls] ?? "pass";
    this.calls++;
    if (kind === "pass") return { kind, observation: "exit 0" } as const;
    if (kind === "skipped") {
      return { kind, observation: "skipped: not permitted", reason: "not permitted" } as const;
    }
    return {
      kind,
      observation: "AssertionError: 2 !== 3",
      evidence: { exitCode: 1, stdout: "", stderr: "AssertionError: 2 !== 3", timedOut: false },
    } as const;
  }
}

/** Stub reporting a workspace mutation for successful `edit` calls. */
class MutatingStubTools extends StubTools {
  async execute(call: ToolCall) {
    const result = await super.execute(call);
    // Mirrors what the real ToolRegistry does: the flag is set only on success.
    return call.name === "edit" && result.ok ? { ...result, mutatedWorkspace: true } : result;
  }
}

function makeLoop(
  llm: AgentLoopDeps["llm"],
  opts: {
    tools?: AgentLoopDeps["tools"];
    verifier?: AgentLoopDeps["verifier"];
    maxVerifications?: number;
  } = {},
) {
  return new AgentLoop({
    llm,
    planner: new Planner(),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.verifier ? { verifier: opts.verifier } : {}),
    limits: {
      maxIterations: 8,
      maxToolCalls: 8,
      timeoutMs: 5_000,
      ...(opts.maxVerifications !== undefined
        ? { maxVerifications: opts.maxVerifications }
        : {}),
    },
  });
}

describe("AgentLoop verification gate", () => {
  it("accepts completion without verifying when no verifier is configured", async () => {
    const loop = makeLoop(new ScriptedLLM([finalTurn("done")]));
    const result = await loop.run("task");
    expect(result.status).toBe("completed");
    expect(result.verifications).toBeUndefined();
  });

  it("never verifies a run that changed nothing", async () => {
    // A pure research task: the model answers, no mutating tool ran. A code
    // test here would be meaningless, so the verifier must not be called.
    const verifier = new ScriptedVerifier(["fail"]);
    const loop = makeLoop(new ScriptedLLM([finalTurn("answer")]), {
      verifier,
      maxVerifications: 3,
    });
    const result = await loop.run("research only");
    expect(result.status).toBe("completed");
    expect(verifier.calls).toBe(0);
    expect(result.verifications).toBeUndefined();
  });

  it("verifies a mutating run and accepts when the check passes", async () => {
    const verifier = new ScriptedVerifier(["pass"]);
    const tools = new MutatingStubTools({ edit: { ok: true, observation: "saved" } });
    const llm = new ScriptedLLM([toolTurn("edit", {}), finalTurn("finished")]);
    const result = await makeLoop(llm, { tools, verifier, maxVerifications: 3 }).run("fix it");

    expect(result.status).toBe("completed");
    expect(verifier.calls).toBe(1);
    expect(result.verifications).toBe(1);
    expect(result.lastVerification?.kind).toBe("pass");
  });

  it("rejects completion, feeds the classified failure back, then accepts on repair", async () => {
    const verifier = new ScriptedVerifier(["fail", "pass"]);
    const tools = new MutatingStubTools({ edit: { ok: true, observation: "saved" } });
    const llm = new ScriptedLLM([
      toolTurn("edit", {}),
      finalTurn("first attempt"),
      finalTurn("second attempt"),
    ]);
    const result = await makeLoop(llm, { tools, verifier, maxVerifications: 3 }).run("fix it");

    expect(result.status).toBe("completed");
    expect(verifier.calls).toBe(2);

    // The third LLM call must carry a tool message describing the failure and
    // its classification — that is how the model learns *why* to repair.
    const feedback = llm.calls[2]?.messages.at(-1);
    expect(feedback?.role).toBe("tool");
    expect(feedback?.content).toMatch(/EXTERNAL VERIFICATION FAILED/);
    expect(feedback?.content).toMatch(/failure class: CODE/);
  });

  it("escalates with max_verifications when the check keeps failing", async () => {
    const verifier = new ScriptedVerifier(["fail", "fail", "fail"]);
    const tools = new MutatingStubTools({ edit: { ok: true, observation: "saved" } });
    const llm = new ScriptedLLM([
      toolTurn("edit", {}),
      finalTurn("a"),
      finalTurn("b"),
      finalTurn("c"),
    ]);
    const result = await makeLoop(llm, { tools, verifier, maxVerifications: 2 }).run("fix it");

    expect(result.status).toBe("max_verifications");
    // Bounded: exactly maxVerifications attempts, never unbounded retrying.
    expect(verifier.calls).toBe(2);
    expect(result.error).toMatch(/budget exhausted/i);
  });

  it("does not report a skipped check as a pass", async () => {
    const verifier = new ScriptedVerifier(["skipped"]);
    const tools = new MutatingStubTools({ edit: { ok: true, observation: "saved" } });
    const llm = new ScriptedLLM([toolTurn("edit", {}), finalTurn("done")]);
    const result = await makeLoop(llm, { tools, verifier, maxVerifications: 3 }).run("fix it");

    expect(result.status).toBe("completed");
    expect(result.lastVerification?.kind).toBe("skipped");
  });

  it("treats maxVerifications=0 as verification disabled", async () => {
    const verifier = new ScriptedVerifier(["fail"]);
    const tools = new MutatingStubTools({ edit: { ok: true, observation: "saved" } });
    const llm = new ScriptedLLM([toolTurn("edit", {}), finalTurn("done")]);
    const result = await makeLoop(llm, { tools, verifier, maxVerifications: 0 }).run("fix it");
    expect(result.status).toBe("completed");
    expect(verifier.calls).toBe(0);
  });

  it("records the verification in the trajectory", async () => {
    const verifier = new ScriptedVerifier(["pass"]);
    const tools = new MutatingStubTools({ edit: { ok: true, observation: "saved" } });
    const llm = new ScriptedLLM([toolTurn("edit", {}), finalTurn("done")]);
    const result = await makeLoop(llm, { tools, verifier, maxVerifications: 3 }).run("fix it");
    expect(result.trajectory.at(-1)?.verification?.kind).toBe("pass");
  });

  it("a non-mutating tool does not trigger verification", async () => {
    const verifier = new ScriptedVerifier(["fail"]);
    const tools = new StubTools({ read: { ok: true, observation: "contents" } });
    const llm = new ScriptedLLM([toolTurn("read", {}), finalTurn("done")]);
    const result = await makeLoop(llm, { tools, verifier, maxVerifications: 3 }).run("read it");
    expect(result.status).toBe("completed");
    expect(verifier.calls).toBe(0);
  });

  it("a failed mutating tool does not count as a mutation", async () => {
    const verifier = new ScriptedVerifier(["fail"]);
    const tools = new MutatingStubTools({ edit: { ok: false, observation: "write failed" } });
    const llm = new ScriptedLLM([toolTurn("edit", {}), finalTurn("done")]);
    const result = await makeLoop(llm, { tools, verifier, maxVerifications: 3 }).run("fix it");
    expect(result.status).toBe("completed");
    expect(verifier.calls).toBe(0);
  });
});
