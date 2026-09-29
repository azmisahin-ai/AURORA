/**
 * The event model for a run (M0, CAP-004).
 *
 * An event is the unit of *visibility*: every meaningful thing the runtime does
 * — a model call, a tool call, a command, an approval, a verification, a repair
 * — produces one. The UI, the audit trail and the timeline are all projections
 * of the same stream, so there is exactly one place where "what happened" is
 * recorded.
 */

export interface AuroraEvent {
  /** Stable, unique id (`evt-<sequence>-<random>`). */
  id: string;
  /** Dotted type, e.g. `tool.completed`, `verification.failed`. */
  type: string;
  /** Empty string when the event is not tied to a durable task. */
  taskId: string;
  /** Empty string when the event is not tied to a run. */
  runId: string;
  /** ISO-8601. */
  timestamp: string;
  /** Monotonic, gap-free, 1-based. The ordering guarantee for clients. */
  sequence: number;
  /** Emitting subsystem, e.g. "tool-registry", "agent-loop". */
  source: string;
  /** Type-specific body. Never contains an unredacted secret. */
  payload: unknown;
}

/** What a caller supplies to `emit`; the bus fills in id/time/sequence. */
export interface EventInput {
  type: string;
  taskId?: string;
  runId?: string;
  source?: string;
  payload?: unknown;
}

export type EventListener = (event: AuroraEvent) => void;

/** Canonical event type names, for callers that want a symbol. */
export const EVENT_TYPES = [
  "run.created",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "task.created",
  "task.started",
  "task.completed",
  "task.failed",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "model.requested",
  "model.response",
  "model.failed",
  "tool.requested",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.approved",
  "approval.denied",
  "approval.unavailable",
  "verification.started",
  "verification.passed",
  "verification.failed",
  "verification.skipped",
  "repair.started",
  "repair.completed",
  "file.modified",
] as const;

export type EventType = (typeof EVENT_TYPES)[number] | (string & {});
