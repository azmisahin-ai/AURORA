import { randomBytes } from "node:crypto";
import type { AuroraEvent, EventInput, EventListener } from "./types.js";

export interface EventBusOptions {
  /** Events retained for replay (`GET /runs/:id/events`). Defaults to 5_000. */
  maxRetained?: number;
  /** Clock, injectable so tests are deterministic. */
  now?: () => Date;
}

/**
 * The in-process event bus (M0, CAP-004).
 *
 * Design constraints, all load-bearing:
 *
 *  - **Ordering is a counter, not a clock.** `sequence` is assigned under the
 *    same synchronous step that appends the event, so a subscriber can never
 *    observe a gap or an out-of-order pair. Wall-clock timestamps are recorded
 *    for humans but never used to order.
 *
 *  - **A slow subscriber cannot break a run.** Listener callbacks run
 *    synchronously (so ordering holds) but every one is wrapped: a throwing
 *    listener is logged and skipped. The bus never propagates a subscriber's
 *    exception into the agent loop.
 *
 *  - **Bounded memory.** Only the last `maxRetained` events are kept for
 *    replay. A long run emits thousands of events; retaining them all is a
 *    leak. Live subscribers still see each event exactly once, in order.
 *
 * The bus deliberately does *not* persist to disk: the event stream is
 * observability, and a crash loses what was in flight — the durable record is
 * the task store (ADR 008), not the event log. Stated, not implied.
 */
export class EventBus {
  private readonly maxRetained: number;
  private readonly now: () => Date;
  private readonly buffer: AuroraEvent[] = [];
  private readonly listeners = new Set<EventListener>();
  private seq = 0;
  private dropped = 0;

  constructor(opts: EventBusOptions = {}) {
    this.maxRetained = opts.maxRetained ?? 5_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** Highest sequence assigned so far. */
  get lastSequence(): number {
    return this.seq;
  }

  /** How many old events were evicted from the replay buffer. */
  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * Record an event. Returns the fully-populated event so a caller can log it.
   * Synchronous by design: sequence assignment and append are one step.
   */
  emit(input: EventInput): AuroraEvent {
    this.seq += 1;
    const event: AuroraEvent = {
      id: `evt-${this.seq}-${randomBytes(4).toString("hex")}`,
      type: input.type,
      taskId: input.taskId ?? "",
      runId: input.runId ?? "",
      timestamp: this.now().toISOString(),
      sequence: this.seq,
      source: input.source ?? "aurora",
      payload: input.payload ?? null,
    };

    this.buffer.push(event);
    if (this.buffer.length > this.maxRetained) {
      this.buffer.shift();
      this.dropped += 1;
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A subscriber's failure is the subscriber's problem. Swallowing it
        // here is what keeps a broken UI connection from aborting an agent run.
      }
    }
    return event;
  }

  /**
   * Subscribe to new events. Immediately replays retained events with
   * `sequence > after` (in order), so a client that reconnects does not miss
   * the gap. Returns an unsubscribe function.
   *
   * `after` is the last sequence the client already holds, so `after = 0` — a
   * fresh client — replays the whole ring. Treating `0` as "skip history"
   * instead would leave a client that connects after a run finished with an
   * empty timeline, which is the one case catch-up exists to serve.
   */
  subscribe(listener: EventListener, after = 0): () => void {
    for (const event of this.buffer) {
      if (event.sequence > after) {
        try {
          listener(event);
        } catch {
          /* see emit */
        }
      }
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Retained events with `sequence > after`, oldest first. */
  replay(after = 0, runId?: string): AuroraEvent[] {
    return this.buffer.filter(
      (e) => e.sequence > after && (runId === undefined || e.runId === runId),
    );
  }

  /** Number of live subscribers. Used by tests and `/health` diagnostics. */
  subscriberCount(): number {
    return this.listeners.size;
  }
}
