import { describe, expect, it } from "vitest";
import { parseTestSummary, runTestsTool } from "../../../src/tools/execution/RunTestsTool.js";
import type { ExecutionResult } from "../../../src/providers/execution/ExecutionProvider.js";
import { CommandValidator } from "../../../src/security/CommandValidator.js";
import { silentLogger } from "../../../src/observability/Logger.js";

/* ── parseTestSummary: real runner output, not invented strings ───────────── */

describe("parseTestSummary", () => {
  it("parses Node's node:test summary", () => {
    // Captured from a real `node --test` run.
    const output = [
      "✔ this passes (0.6ms)",
      "✖ this fails (0.7ms)",
      "ℹ tests 2",
      "ℹ suites 0",
      "ℹ pass 1",
      "ℹ fail 1",
    ].join("\n");
    expect(parseTestSummary(output)).toEqual({ pass: 1, fail: 1, total: 2 });
  });

  it("parses Vitest/Jest 'failed | passed (n)' summary", () => {
    const output = "Test Files  1 failed | 2 passed (3)\n     Tests  1 failed | 4 passed (5)";
    expect(parseTestSummary(output)).toEqual({ pass: 4, fail: 1, total: 5 });
  });

  it("returns undefined rather than guessing on unrecognised output", () => {
    expect(parseTestSummary("all good")).toBeUndefined();
  });
});

/* ── run_tests: verdict from the exit code, not the parsed counts ─────────── */

function makeResult(over: Partial<ExecutionResult>): ExecutionResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 5,
    timedOut: false,
    truncated: false,
    ...over,
  };
}

function ctxWith(result: ExecutionResult) {
  return {
    workspace: "/tmp",
    pathValidator: {} as never,
    commandValidator: new CommandValidator({ allowed: ["node"] }),
    execution: { name: "stub", run: async () => result },
    logger: silentLogger,
    signal: new AbortController().signal,
  };
}

const tool = runTestsTool({ command: "node --test", defaultTimeoutMs: 1000 });

describe("run_tests tool", () => {
  it("reports ok=true on exit code 0", async () => {
    const out = await tool.execute({}, ctxWith(makeResult({ exitCode: 0 })));
    expect(out.ok).toBe(true);
  });

  it("reports ok=false on a non-zero exit code", async () => {
    const out = await tool.execute(
      {},
      ctxWith(makeResult({ exitCode: 1, stderr: "ℹ fail 1\n1 !== 2" })),
    );
    expect(out.ok).toBe(false);
    expect(out.output).toMatch(/1 failed/);
  });

  it("treats a timeout as failure regardless of exit code", async () => {
    const out = await tool.execute({}, ctxWith(makeResult({ exitCode: null, timedOut: true })));
    expect(out.ok).toBe(false);
    expect(out.output).toMatch(/timed out/);
  });

  it("reports a vacuous run (exit 0, zero tests) as failure", async () => {
    // Node's `node --test` exits 0 when no test files match; exit 0 alone is
    // therefore not a pass.
    const out = await tool.execute(
      {},
      ctxWith(makeResult({ exitCode: 0, stdout: "ℹ tests 0\nℹ pass 0\nℹ fail 0" })),
    );
    expect(out.ok).toBe(false);
    expect(out.output).toMatch(/no tests were found or run/);
  });

  it("does not mistake an unparseable summary for zero tests", async () => {
    const out = await tool.execute({}, ctxWith(makeResult({ exitCode: 0, stdout: "weird output" })));
    expect(out.ok).toBe(true);
    expect(out.output).toMatch(/could not be parsed/);
  });

  it("rejects a test command that fails validation", async () => {
    const bad = runTestsTool({ command: "rm -rf /" });
    const out = await bad.execute({}, ctxWith(makeResult({ exitCode: 0 })));
    expect(out.ok).toBe(false);
    expect(out.output).toMatch(/rejected/i);
  });
});
