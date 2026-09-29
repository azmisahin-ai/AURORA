import { describe, it, expect } from "vitest";
import { EventBus } from "../../../src/events/EventBus.js";
import type { AuroraEvent } from "../../../src/events/types.js";

/**
 * Unit: the event bus is the ordering and buffering primitive the live UI rests
 * on, so its guarantees are tested directly rather than only through a run.
 */
describe("EventBus", () => {
  it("assigns contiguous, strictly increasing sequences starting at 1", () => {
    const bus = new EventBus();
    const a = bus.emit({ type: "run.created" });
    const b = bus.emit({ type: "run.started" });
    const c = bus.emit({ type: "tool.completed" });
    expect([a.sequence, b.sequence, c.sequence]).toEqual([1, 2, 3]);
    expect(bus.lastSequence).toBe(3);
  });

  it("fills id, timestamp, source and payload defaults", () => {
    const bus = new EventBus({ now: () => new Date("2026-09-29T00:00:00.000Z") });
    const event = bus.emit({ type: "agent.started" });
    expect(event.id).toMatch(/^evt-1-[0-9a-f]{8}$/);
    expect(event.timestamp).toBe("2026-09-29T00:00:00.000Z");
    expect(event.source).toBe("aurora");
    expect(event.payload).toBeNull();
    expect(event.taskId).toBe("");
    expect(event.runId).toBe("");
  });

  it("delivers each event to every subscriber in order", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribe((e) => seen.push(e.sequence));
    bus.subscribe((e) => seen.push(e.sequence));
    bus.emit({ type: "a" });
    bus.emit({ type: "b" });
    // Two subscribers × two events = four deliveries, ordered per subscriber
    // (the bus is synchronous, so the interleaving is deterministic).
    expect(seen).toEqual([1, 1, 2, 2]);
  });

  it("does not let a throwing subscriber break emit or other subscribers", () => {
    const bus = new EventBus();
    const good: AuroraEvent[] = [];
    bus.subscribe(() => {
      throw new Error("bad subscriber");
    });
    bus.subscribe((e) => good.push(e));
    expect(() => bus.emit({ type: "run.completed" })).not.toThrow();
    expect(good).toHaveLength(1);
  });

  it("replays retained events after `after` on subscribe, then goes live", () => {
    const bus = new EventBus();
    bus.emit({ type: "a" });
    bus.emit({ type: "b" });
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(`${e.sequence}:${e.type}`), 1);
    expect(seen).toEqual(["2:b"]);
    bus.emit({ type: "c" });
    expect(seen).toEqual(["2:b", "3:c"]);
  });

  it("replays the whole ring for a fresh subscriber (after = 0)", () => {
    // A client that connects *after* a run finished sends `after=0`; it must
    // still receive the run's history, or the timeline renders empty.
    const bus = new EventBus();
    bus.emit({ type: "run.created" });
    bus.emit({ type: "run.completed" });
    const seen: number[] = [];
    bus.subscribe((e) => seen.push(e.sequence));
    expect(seen).toEqual([1, 2]);
  });

  it("drops old events from the replay ring but keeps live delivery", () => {
    const bus = new EventBus({ maxRetained: 2 });
    const live: number[] = [];
    bus.subscribe((e) => live.push(e.sequence));
    bus.emit({ type: "1" });
    bus.emit({ type: "2" });
    bus.emit({ type: "3" });
    expect(bus.replay().map((e) => e.sequence)).toEqual([2, 3]);
    expect(bus.droppedCount).toBe(1);
    // Live subscribers saw all three; only the replay buffer is bounded.
    expect(live).toEqual([1, 2, 3]);
  });

  it("filters replay by runId", () => {
    const bus = new EventBus();
    bus.emit({ type: "a", runId: "run-1" });
    bus.emit({ type: "b", runId: "run-2" });
    bus.emit({ type: "c", runId: "run-1" });
    expect(bus.replay(0, "run-1").map((e) => e.type)).toEqual(["a", "c"]);
  });

  it("stops delivery after unsubscribe", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const off = bus.subscribe((e) => seen.push(e.sequence));
    bus.emit({ type: "a" });
    off();
    bus.emit({ type: "b" });
    expect(seen).toEqual([1]);
    expect(bus.subscriberCount()).toBe(0);
  });
});
