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
 * One readable label for a trajectory step. `step` is an object
 * (`{ kind, rationale, ... }`), so interpolating it directly into a template
 * renders "[object Object]"; this flattens it to `kind · rationale`, including
 * the tool name when there is one. Pure, so it is unit-tested without a DOM.
 */
export function formatStep(step, fallback = "step") {
  if (typeof step === "string" && step !== "") return step;
  if (!step || typeof step !== "object") return fallback;
  const kind = typeof step.kind === "string" && step.kind !== "" ? step.kind : fallback;
  const tool = typeof step.toolName === "string" && step.toolName !== "" ? ` ${step.toolName}` : "";
  const rationale = typeof step.rationale === "string" && step.rationale !== "" ? step.rationale : "";
  return rationale ? `${kind}${tool} · ${rationale}` : `${kind}${tool}`;
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

/**
 * A CSS-class-safe token for an event type's family, mirroring `statusClass`:
 * the type is data from the stream, so it is mapped through an allowlist before
 * it can reach a class attribute.
 */
export function eventClass(type) {
  const value = typeof type === "string" ? type : "";
  if (value.startsWith("agent.")) return "ev-agent";
  if (value.startsWith("model.")) return "ev-model";
  if (value.startsWith("tool.")) return "ev-tool";
  if (value.startsWith("approval.")) return "ev-approval";
  if (value.startsWith("verification.")) return "ev-verify";
  if (value.startsWith("repair.")) return "ev-repair";
  if (value.startsWith("run.")) return "ev-run";
  if (value.startsWith("task.")) return "ev-task";
  if (value === "file.modified") return "ev-file";
  return "ev-other";
}

/**
 * One-line summary of an event payload, for a dense timeline. Kept pure and
 * defensive: payloads are `unknown` by contract, so a missing or exotic field
 * degrades to an empty string rather than throwing in the render loop.
 */
export function summarizeEvent(event) {
  const payload = event && typeof event.payload === "object" && event.payload !== null ? event.payload : {};
  const type = typeof event?.type === "string" ? event.type : "";
  if (type.startsWith("model.requested")) {
    const model = typeof payload.model === "string" ? payload.model : "?";
    const tools = Array.isArray(payload.tools) ? payload.tools.length : 0;
    return `${model}${tools ? ` · ${tools} tool(s)` : ""}`;
  }
  if (type.startsWith("model.response")) {
    const calls = Array.isArray(payload.toolCalls) ? payload.toolCalls.join(", ") : "";
    return calls ? `tool calls: ${calls}` : `${payload.contentChars ?? 0} chars`;
  }
  if (type.startsWith("model.failed") || type === "agent.failed") {
    return typeof payload.error === "string" ? payload.error : "";
  }
  if (type.startsWith("tool.") || type.startsWith("approval.")) {
    const tool = typeof payload.tool === "string" ? payload.tool : "";
    const summary = typeof payload.summary === "string" ? payload.summary : "";
    return summary || tool;
  }
  if (type.startsWith("verification.")) {
    const verifier = typeof payload.verifier === "string" ? payload.verifier : "";
    return verifier;
  }
  if (type === "file.modified") {
    return typeof payload.tool === "string" ? payload.tool : "";
  }
  if (typeof payload.task === "string") return truncate(payload.task, 60);
  return "";
}
