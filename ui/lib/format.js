/**
 * Formatting and status mapping — pure functions, no DOM (ADR 012 §1).
 *
 * These are the rules the panels share, kept here so they are unit-testable by
 * Node without a browser and without jsdom.
 */

/** Shorten a timestamp to a stable, readable local form; never throws. */
export function formatTime(iso) {
  if (typeof iso !== "string" || iso === "") return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

/** A compact "3m ago" style age, for list density. */
export function formatAge(iso, now = Date.now()) {
  if (typeof iso !== "string" || iso === "") return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Truncate to `max` characters, with an explicit ellipsis. */
export function truncate(text, max = 160) {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * A CSS-class-safe token for a status. The status is data from the API; mapping
 * it through an allowlist means a hostile value cannot inject class names (and
 * `class` is an attribute sink we avoid reaching with raw data).
 */
const STATUS_CLASSES = {
  running: "status-running",
  queued: "status-queued",
  waiting: "status-waiting",
  completed: "status-completed",
  failed: "status-failed",
  cancelled: "status-cancelled",
};

export function statusClass(status) {
  return STATUS_CLASSES[status] ?? "status-unknown";
}

/** The set of statuses a filter dropdown should offer, in display order. */
export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
];

export const KNOWLEDGE_KINDS = ["topic", "source", "research"];

/** Human-readable duration between two ISO timestamps, or "—". */
export function formatDuration(startIso, endIso) {
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * Count the trajectory's steps for a compact summary. Returns plain numbers, so
 * the caller decides how to render them.
 */
export function summarizeTrajectory(trajectory) {
  const entries = Array.isArray(trajectory) ? trajectory : [];
  let toolCalls = 0;
  let verifications = 0;
  for (const entry of entries) {
    if (entry && entry.toolCall) toolCalls++;
    if (entry && entry.verification) verifications++;
  }
  return { steps: entries.length, toolCalls, verifications };
}
