import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../../src/core/agent/AgentLoop.js";
import { Planner } from "../../../src/core/planner/Planner.js";
import { EventBus } from "../../../src/events/index.js";
import { ScriptedLLM, StubTools, ThrowingLLM, finalTurn, toolTurn } from "../helpers.js";

const limits = { maxIterations: 5, maxToolCalls: 5, timeoutMs: 2_000 };

/**
 * Unit: the loop emits a run's observable story onto the bus. These assertions
 * are the contract the SSE stream and the UI timeline rely on — if the loop
 * stops emitting an event, the live view silently loses that step, which is why
 * the sequence is checked rather than merely the presence of events.
 */
describe("AgentLoop events", () => {
  it("emits agent/model/tool lifecycle events in order for a tool run", async () => {
    const bus = new EventBus({ now: () => new Date("2026-09-29T00:00:00.000Z") });
    const loop = new AgentLoop({
      llm: new ScriptedLLM([toolTurn("echo_tool", { value: "hi" }), finalTurn("done")]),
      planner: new Planner(),
      tools: new StubTools({ echo_tool: { ok: true, observation: "hi" } }),
      limits,
      events: bus,
      runId: "run-1",
      taskId: "task-1",
      modelName: "test-model",
    });

    const result = await loop.run("do it");
    expect(result.status).toBe("completed");

    const types = bus.replay().map((e) => e.type);
    expect(types).toEqual([
      "agent.started",
      "model.requested",
      "model.response",
      "tool.requested",
      "tool.completed",
      "model.requested",
      "model.response",
      "agent.completed",
    ]);

    for (const event of bus.replay()) {
      expect(event.runId).toBe("run-1");
      expect(event.taskId).toBe("task-1");
    }

    const requested = bus.replay().find((e) => e.type === "model.requested");
    expect((requested?.payload as { model: string }).model).toBe("test-model");
  });

  it("emits file.modified when a tool reports a workspace mutation", async () => {
    const bus = new EventBus();
    const loop = new AgentLoop({
      llm: new ScriptedLLM([toolTurn("write_tool", {}), finalTurn("ok")]),
      planner: new Planner(),
      tools: new StubTools({ write_tool: { ok: true, observation: "wrote", mutatedWorkspace: true } }),
      limits,
      events: bus,
    });
    await loop.run("write");
    expect(bus.replay().map((e) => e.type)).toContain("file.modified");
  });

  it("emits agent.failed with the error when the model call fails", async () => {
    const bus = new EventBus();
    const loop = new AgentLoop({
      llm: new ThrowingLLM(new Error("provider down")),
      planner: new Planner(),
      limits,
      events: bus,
    });
    const result = await loop.run("boom");
    expect(result.status).toBe("error");
    const failed = bus.replay().find((e) => e.type === "agent.failed");
    expect(failed).toBeDefined();
    expect((failed?.payload as { error: string }).error).toContain("provider down");
  });

  it("emits agent.failed when the iteration budget is exhausted", async () => {
    const bus = new EventBus();
    const loop = new AgentLoop({
      llm: new ScriptedLLM([toolTurn("echo_tool", {}), toolTurn("echo_tool", {})]),
      planner: new Planner(),
      tools: new StubTools({ echo_tool: { ok: true, observation: "hi" } }),
      limits: { maxIterations: 2, maxToolCalls: 5, timeoutMs: 2_000 },
      events: bus,
    });
    const result = await loop.run("loop");
    expect(result.status).toBe("max_iterations");
    const failed = bus.replay().find((e) => e.type === "agent.failed");
    expect((failed?.payload as { status: string }).status).toBe("max_iterations");
  });

  it("works with no bus wired (null-object default)", async () => {
    const loop = new AgentLoop({
      llm: new ScriptedLLM([finalTurn("ok")]),
      planner: new Planner(),
      limits,
    });
    await expect(loop.run("hi")).resolves.toMatchObject({ status: "completed" });
  });
});
