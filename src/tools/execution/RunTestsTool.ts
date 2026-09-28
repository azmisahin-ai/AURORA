import { z } from "zod/v4";
import { defineTool } from "../types.js";
import { parseTestSummary, ranNoTests, type TestCounts } from "../../providers/execution/TestSummary.js";

/**
 * Runs the project's configured test command and reports a structured verdict.
 *
 * This is the agent-facing counterpart to `CommandVerifier`: same command, same
 * gate, but callable *by the model* so it can check its own work mid-task. The
 * verifier is what the loop trusts; this tool is how the model investigates.
 *
 * The verdict (pass/fail) comes from the process **exit code** — an external
 * signal. The pass/fail counters are parsed from runner output on a best-effort
 * basis and are labelled as such, because output formats differ between runners
 * and a wrong count must never be mistaken for the verdict.
 */

export type { TestCounts };

/**
 * Extracts pass/fail counts from common runner output (Node's `node --test`
 * summary, Vitest/Jest summary lines). Best-effort by design: it returns
 * `undefined` rather than a guess when nothing matches.
 */
export { parseTestSummary } from "../../providers/execution/TestSummary.js";

export interface RunTestsToolOptions {
  /** Test command from configuration, e.g. `"npm test"` or `"node --test"`. */
  command: string;
  /** Default timeout for a test run; the model may raise it per call. */
  defaultTimeoutMs?: number;
}

export function runTestsTool(opts: RunTestsToolOptions) {
  return defineTool({
    name: "run_tests",
    description:
      `Run the project's test suite ("${opts.command}") in the workspace and report whether it passed. ` +
      `Use this to check your own work before finishing. The verdict is the command's exit code.`,
    inputSchema: z.object({
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe("Override the test-run timeout in milliseconds"),
    }),
    requiredPermissions: ["COMMAND_EXECUTION"] as const,
    async execute(input, ctx) {
      const validation = ctx.commandValidator.tryValidate(opts.command);
      if (!validation.ok) {
        ctx.logger.warn(
          { command: opts.command, reason: validation.error },
          "test command rejected",
        );
        return { ok: false, output: `Test command rejected: ${validation.error}` };
      }

      const result = await ctx.execution.run({
        argv: validation.value.argv,
        cwd: ctx.workspace,
        timeoutMs: input.timeoutMs ?? opts.defaultTimeoutMs ?? 300_000,
        maxOutputBytes: 32 * 1024,
        signal: ctx.signal,
      });

      const passed = !result.timedOut && result.exitCode === 0;
      const counts = parseTestSummary(`${result.stdout}\n${result.stderr}`);
      const empty = ranNoTests(counts);

      const parts = [`$ ${validation.value.argv.join(" ")}`];
      if (result.timedOut) parts.push(`(timed out after ${result.durationMs} ms)`);
      parts.push(`exit code: ${result.exitCode}`);
      if (empty) {
        // Node's `node --test` exits 0 on zero test files. Report that as a
        // failure: "exit 0" here means nothing was verified.
        parts.push(
          "no tests were found or run (exit code 0 is vacuous, not a pass)",
        );
      } else {
        parts.push(
          counts
            ? `summary: ${counts.pass} passed, ${counts.fail} failed` +
                (counts.total !== undefined ? ` of ${counts.total}` : "")
            : "summary: could not be parsed from runner output (not an error)",
        );
      }
      if (result.stderr) parts.push(`--- stderr ---\n${result.stderr.trimEnd()}`);
      if (result.stdout) parts.push(`--- stdout ---\n${result.stdout.trimEnd()}`);
      if (result.truncated) parts.push("(output truncated)");

      return { ok: passed && !empty, output: parts.join("\n") };
    },
  });
}
