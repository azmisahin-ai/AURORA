import type { AuroraEvent } from "./types.js";

/** Values that may be emitted as an event payload. */
export type EmitPayload = unknown;

/**
 * The narrow port the agent loop, tool registry and verifier depend on.
 *
 * Kept minimal (`emit` only) so those modules never gain access to subscription
 * or replay — they produce events, they do not consume them. The concrete
 * `EventBus` satisfies it. A no-op implementation is used where a bus is not
 * wired, so call sites never branch on "is there a bus".
 */
export interface EventEmitterPort {
  emit(input: import("./types.js").EventInput): AuroraEvent;
}

/** Forwards to a bus when present, does nothing when absent. */
export class NullEventBus implements EventEmitterPort {
  emit(input: import("./types.js").EventInput): AuroraEvent {
    return {
      id: "evt-null",
      type: input.type,
      taskId: input.taskId ?? "",
      runId: input.runId ?? "",
      timestamp: new Date().toISOString(),
      sequence: 0,
      source: input.source ?? "null",
      payload: input.payload ?? null,
    };
  }
}

export const NULL_EVENT_BUS: EventEmitterPort = new NullEventBus();
