import { describe, expect, it } from "vitest";
import { HeuristicTokenEstimator } from "../../../src/core/context/TokenEstimator.js";

/**
 * The estimator is a heuristic and is tested as one: the assertions pin the
 * *contract* (monotonic, conservative, counts tool arguments) rather than an
 * exact token count, which no character-based estimator can promise.
 */
describe("HeuristicTokenEstimator", () => {
  const est = new HeuristicTokenEstimator();

  it("returns 0 for empty text", () => {
    expect(est.estimateText("")).toBe(0);
  });

  it("rounds up so it never under-counts a partial token", () => {
    expect(est.estimateText("abcde")).toBe(2); // 5 chars / 4 → ceil
  });

  it("grows monotonically with text length", () => {
    const short = est.estimateText("hello");
    const long = est.estimateText("hello world this is longer");
    expect(long).toBeGreaterThan(short);
  });

  it("adds per-message overhead so messages are never free", () => {
    const empty = est.estimateMessage({ role: "user", content: "" });
    expect(empty).toBeGreaterThan(0);
  });

  it("counts tool-call arguments, not just content", () => {
    const without = est.estimateMessage({ role: "assistant", content: "ok" });
    const withCall = est.estimateMessage({
      role: "assistant",
      content: "ok",
      toolCalls: [
        { id: "1", name: "write_file", arguments: { path: "a", content: "x".repeat(400) } },
      ],
    });
    expect(withCall).toBeGreaterThan(without);
  });

  it("sums messages", () => {
    const messages = [
      { role: "user" as const, content: "aaaa" },
      { role: "assistant" as const, content: "bbbb" },
    ];
    const total = est.estimateMessages(messages);
    expect(total).toBe(est.estimateMessage(messages[0]!) + est.estimateMessage(messages[1]!));
  });

  it("over-counts rather than under-counts a long ASCII string", () => {
    const text = "x".repeat(4000);
    // 4000/4 = 1000 minimum; the contract is "at least this many".
    expect(est.estimateText(text)).toBeGreaterThanOrEqual(1000);
  });
});
