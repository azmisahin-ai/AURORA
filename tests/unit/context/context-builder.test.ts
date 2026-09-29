import { describe, expect, it } from "vitest";
import { ContextBuilder } from "../../../src/core/context/ContextBuilder.js";
import { HeuristicTokenEstimator } from "../../../src/core/context/TokenEstimator.js";
import type { ChatMessage } from "../../../src/providers/llm/LLMProvider.js";

const est = new HeuristicTokenEstimator();

/** A transcript with a protected head and `n` tool-using turns. */
function transcript(n: number, observationChars = 400): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "the task" },
  ];
  for (let i = 0; i < n; i++) {
    messages.push({
      role: "assistant",
      content: `turn ${i}`,
      toolCalls: [{ id: `c${i}`, name: "read_file", arguments: { path: `f${i}` } }],
    });
    messages.push({ role: "tool", content: `obs ${i} `.repeat(observationChars / 10) });
  }
  return messages;
}

describe("ContextBuilder", () => {
  it("returns the transcript untouched when it fits", () => {
    const builder = new ContextBuilder({ budget: 10_000, estimator: est });
    const messages = transcript(2, 40);
    const plan = builder.build(messages);
    expect(plan.overBudget).toBe(false);
    expect(plan.messages).toEqual(messages);
    expect(plan.actions).toEqual([{ kind: "none" }]);
  });

  it("truncates a single oversized observation before eliding turns", () => {
    const builder = new ContextBuilder({
      budget: 1_000,
      estimator: est,
      maxObservationTokens: 100,
    });
    const messages = transcript(2, 4_000);
    const plan = builder.build(messages);
    expect(plan.actions.some((a) => a.kind === "truncate-observation")).toBe(true);
    // A truncated observation keeps a marker; the original had none.
    const toolMsgs = plan.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.some((m) => m.content.includes("omitted to fit"))).toBe(true);
  });

  it("preserves the system prompt and the task when eliding", () => {
    const builder = new ContextBuilder({ budget: 300, estimator: est });
    const messages = transcript(20, 400);
    const plan = builder.build(messages);
    expect(plan.messages[0]).toEqual({ role: "system", content: "system prompt" });
    expect(plan.messages[1]).toEqual({ role: "user", content: "the task" });
  });

  it("elides old middle turns while keeping the newest turn", () => {
    const builder = new ContextBuilder({ budget: 400, estimator: est });
    const messages = transcript(20, 400);
    const plan = builder.build(messages);
    expect(plan.actions.some((a) => a.kind === "elide-turns")).toBe(true);
    const elided = plan.actions.find((a) => a.kind === "elide-turns");
    expect(elided?.elidedMessages).toBeGreaterThan(0);
    // The last message of the newest turn survives.
    expect(plan.messages.at(-1)).toEqual(messages.at(-1));
  });

  it("does not split a tool turn from its result", () => {
    const builder = new ContextBuilder({ budget: 250, estimator: est, maxObservationTokens: 60 });
    const messages = transcript(12, 400);
    const plan = builder.build(messages);
    // Every remaining assistant tool-call must be immediately followed by its
    // tool result — orphaning either is rejected by providers.
    for (let i = 0; i < plan.messages.length; i++) {
      const message = plan.messages[i]!;
      if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
        expect(plan.messages[i + 1]?.role).toBe("tool");
      }
    }
  });

  it("inserts the omission notice after the protected head, not into the system prompt", () => {
    const builder = new ContextBuilder({ budget: 300, estimator: est });
    const plan = builder.build(transcript(20, 400));
    const noticeIndex = plan.messages.findIndex(
      (m) => m.role === "system" && m.content.includes("omitted to stay within"),
    );
    expect(noticeIndex).toBeGreaterThan(0);
    expect(plan.messages[noticeIndex]?.content).not.toContain("system prompt");
  });

  it("protects the whole leading system/user run, including session recall", () => {
    const builder = new ContextBuilder({ budget: 300, estimator: est });
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "recall block" },
      { role: "user", content: "the task" },
      ...transcript(20, 400).slice(2),
    ];
    const plan = builder.build(messages);
    expect(plan.messages.slice(0, 3)).toEqual(messages.slice(0, 3));
  });

  it("reports overBudget instead of dropping the task when nothing else fits", () => {
    const builder = new ContextBuilder({ budget: 50, estimator: est });
    const plan = builder.build(transcript(5, 400));
    expect(plan.overBudget).toBe(true);
    // The answer is still returned; the caller decides how to report it.
    expect(plan.messages.length).toBeGreaterThan(0);
  });

  it("rejects a non-positive budget at construction", () => {
    expect(() => new ContextBuilder({ budget: 0 })).toThrow(/positive/);
    expect(() => new ContextBuilder({ budget: Number.NaN })).toThrow(/positive/);
  });

  it("reserves reply tokens, compacting earlier", () => {
    const plain = new ContextBuilder({ budget: 1_000, estimator: est });
    const reserved = new ContextBuilder({ budget: 1_000, estimator: est, reserveForReply: 900 });
    const messages = transcript(4, 400);
    const plainPlan = plain.build(messages);
    const reservedPlan = reserved.build(messages);
    expect(plainPlan.overBudget).toBe(false);
    // Reserving 900 of 1000 leaves only 100 for the prompt, which the transcript
    // cannot fit; the builder says so rather than pretending it did.
    expect(reservedPlan.overBudget).toBe(true);
    expect(reservedPlan.finalTokens).toBeLessThan(plainPlan.finalTokens);
  });
});
