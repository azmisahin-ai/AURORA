import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../../src/core/agent/AgentLoop.js";
import { Planner } from "../../../src/core/planner/Planner.js";
import { EventBus } from "../../../src/events/index.js";
import { ScriptedLLM, StubTools, finalTurn, toolTurn } from "../helpers.js";

const limits = { maxIterations: 5, maxToolCalls: 5, timeoutMs: 2_000 };

/**
 * Unit: a run whose required mutation was refused must not be reported as
 * `completed` (ADR 010). This is the NOT_VERIFIED != COMPLETED rule applied to
 * permission, not verification: the model claiming it is done does not make the
 * blocked change exist.
 */
describe("AgentLoop denial semantics", () => {
  it("reports `denied`, not `completed`, when a mutation is refused", async () => {
    const bus = new EventBus();
    const loop = new AgentLoop({
      llm: new ScriptedLLM([toolTurn("write_tool", {}), finalTurn("I wrote the file")]),
      planner: new Planner(),
      tools: new StubTools({
        write_tool: {
          ok: false,
          denied: true,
          observation: 'User denied permission to run "write_tool".',
        },
      }),
      limits,
      events: bus,
    });

    const result = await loop.run("write a file");
    expect(result.status).toBe("denied");
    expect(result.error).toContain("denied");
    // The terminal event reflects the honest status, not a green completion.
    const terminal = bus.replay().filter((e) => e.type.startsWith("agent.")).at(-1);
    expect(terminal?.type).toBe("agent.failed");
    expect((terminal?.payload as { status: string }).status).toBe("denied");
  });

  it("recovers to `completed` when a later mutation is approved", async () => {
    // A stub returns one result per name, so a sequence-aware executor is used
    // to deny the first attempt and approve the second.
    let calls = 0;
    const tools = {
      has: () => true,
      execute: async () => {
        calls++;
        return calls === 1
          ? { ok: false, denied: true, observation: "denied" }
          : { ok: true, observation: "wrote", mutatedWorkspace: true };
      },
    };
    const loop = new AgentLoop({
      llm: new ScriptedLLM([
        toolTurn("write_tool", {}),
        toolTurn("write_tool", {}),
        finalTurn("done"),
      ]),
      planner: new Planner(),
      tools: tools as never,
      limits,
    });

    const result = await loop.run("write a file");
    expect(result.status).toBe("completed");
    expect(result.mutatedWorkspace).toBe(true);
  });

  it("does not flag a read-only run as denied", async () => {
    const loop = new AgentLoop({
      llm: new ScriptedLLM([toolTurn("read_tool", {}), finalTurn("read it")]),
      planner: new Planner(),
      tools: new StubTools({ read_tool: { ok: true, observation: "contents" } }),
      limits,
    });
    const result = await loop.run("read a file");
    expect(result.status).toBe("completed");
  });
});
