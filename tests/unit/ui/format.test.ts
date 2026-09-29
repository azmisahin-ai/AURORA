import { describe, it, expect } from "vitest";
import {
  eventClass,
  formatAge,
  formatDuration,
  formatStep,
  formatTime,
  statusClass,
  summarizeEvent,
  summarizeTrajectory,
  truncate,
  TASK_STATUSES,
} from "../../../ui/lib/format.js";

/** Pure formatting rules — Node imports the UI module directly, no DOM. */

describe("format", () => {
  it("formats a timestamp and degrades gracefully", () => {
    expect(formatTime("2026-09-28T00:00:00.000Z")).not.toBe("—");
    expect(formatTime("")).toBe("—");
    expect(formatTime(undefined)).toBe("—");
    // An unparseable value is shown as-is rather than becoming "Invalid Date".
    expect(formatTime("not-a-date")).toBe("not-a-date");
  });

  it("formats age relative to a fixed now", () => {
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    expect(formatAge("2026-09-28T11:59:30.000Z", now)).toBe("30s ago");
    expect(formatAge("2026-09-28T11:30:00.000Z", now)).toBe("30m ago");
    expect(formatAge("2026-09-28T06:00:00.000Z", now)).toBe("6h ago");
    expect(formatAge("2026-09-26T12:00:00.000Z", now)).toBe("2d ago");
    expect(formatAge("", now)).toBe("—");
  });

  it("truncates with an ellipsis and never exceeds the bound", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
    expect(truncate(null, 4)).toBe("");
  });

  it("maps statuses through an allowlist", () => {
    for (const status of TASK_STATUSES) expect(statusClass(status)).not.toBe("status-unknown");
    expect(statusClass("nonsense")).toBe("status-unknown");
    expect(statusClass(undefined)).toBe("status-unknown");
    expect(statusClass("</style>")).toBe("status-unknown");
  });

  it("formats durations", () => {
    expect(formatDuration("2026-09-28T00:00:00.000Z", "2026-09-28T00:00:00.500Z")).toBe("500ms");
    expect(formatDuration("2026-09-28T00:00:00.000Z", "2026-09-28T00:00:05.000Z")).toBe("5.0s");
    expect(formatDuration("2026-09-28T00:00:00.000Z", "2026-09-28T00:02:00.000Z")).toBe("2m");
    expect(formatDuration("2026-09-28T00:00:05.000Z", "2026-09-28T00:00:00.000Z")).toBe("—");
  });

  it("summarizes a trajectory defensively", () => {
    const summary = summarizeTrajectory([
      { toolCall: { name: "a" }, verification: { kind: "pass" } },
      { toolCall: { name: "b" } },
      {},
    ]);
    expect(summary).toEqual({ steps: 3, toolCalls: 2, verifications: 1 });
    expect(summarizeTrajectory(undefined)).toEqual({ steps: 0, toolCalls: 0, verifications: 0 });
    expect(summarizeTrajectory("nope")).toEqual({ steps: 0, toolCalls: 0, verifications: 0 });
  });

  it("renders a trajectory step as text, never [object Object]", () => {
    // The bug this guards: `step` is an object, and `${entry.step}` rendered it
    // as "[object Object]" in the trajectory summary.
    expect(formatStep({ kind: "final", rationale: "no tool call" })).toBe("final · no tool call");
    expect(formatStep({ kind: "tool", toolName: "web_fetch", rationale: "fetch" })).toBe(
      "tool web_fetch · fetch",
    );
    expect(formatStep({ kind: "reason" })).toBe("reason");
    expect(formatStep("plain step")).toBe("plain step");
    expect(formatStep(undefined)).toBe("step");
    expect(formatStep(null)).toBe("step");
    expect(formatStep({ kind: "final" })).not.toContain("[object");
  });

  it("maps event types to CSS-safe families through an allowlist", () => {
    expect(eventClass("tool.completed")).toBe("ev-tool");
    expect(eventClass("model.requested")).toBe("ev-model");
    expect(eventClass("agent.failed")).toBe("ev-agent");
    expect(eventClass("verification.passed")).toBe("ev-verify");
    expect(eventClass("file.modified")).toBe("ev-file");
    // A hostile value never reaches a class attribute as-is.
    expect(eventClass('<img src=x onerror=alert(1)>')).toBe("ev-other");
    expect(eventClass(undefined)).toBe("ev-other");
  });

  it("summarises event payloads defensively", () => {
    expect(
      summarizeEvent({ type: "model.requested", payload: { model: "llama3.2", tools: ["a", "b"] } }),
    ).toBe("llama3.2 · 2 tool(s)");
    expect(
      summarizeEvent({ type: "model.response", payload: { toolCalls: ["web_fetch"] } }),
    ).toBe("tool calls: web_fetch");
    expect(summarizeEvent({ type: "tool.completed", payload: { tool: "read_file" } })).toBe(
      "read_file",
    );
    // Malformed payloads must not throw in the render loop.
    expect(summarizeEvent({ type: "tool.completed", payload: null })).toBe("");
    expect(summarizeEvent({ type: "model.failed", payload: { error: "boom" } })).toBe("boom");
    expect(summarizeEvent(null)).toBe("");
  });
});
