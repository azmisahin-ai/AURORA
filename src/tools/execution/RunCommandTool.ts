import { z } from "zod/v4";
import { defineTool } from "../types.js";

/**
 * Runs an allowlisted command inside the workspace.
 *
 * The command string is validated and tokenised by CommandValidator, then
 * executed with `shell: false`, so shell metacharacters are impossible rather
 * than merely discouraged. The validator's allowlist is the policy; this tool
 * adds no further judgement.
 */
export const runCommandTool = defineTool({
  name: "run_command",
  description:
    "Run a single allowlisted command in the workspace (no shell syntax, no pipes or redirects). Returns exit code, stdout and stderr. Example: run_command {\"command\": \"npm test\"}.",
  inputSchema: z.object({
    command: z
      .string()
      .min(1)
      .describe('Command and arguments, e.g. "npm test" or "ls -la src"'),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe("Override the default command timeout in milliseconds"),
  }),
  requiredPermissions: ["COMMAND_EXECUTION"] as const,
  async execute(input, ctx) {
    const validation = ctx.commandValidator.tryValidate(input.command);
    if (!validation.ok) {
      ctx.logger.warn({ command: input.command, reason: validation.error }, "command rejected");
      return { ok: false, output: `Command rejected: ${validation.error}` };
    }

    const result = await ctx.execution.run({
      argv: validation.value.argv,
      cwd: ctx.workspace,
      timeoutMs: input.timeoutMs ?? 120_000,
      signal: ctx.signal,
    });

    return {
      ok: result.exitCode === 0,
      output: formatExecution(validation.value.argv, result),
    };
  },
});

function formatExecution(
  argv: string[],
  result: Awaited<ReturnType<import("../../providers/execution/ExecutionProvider.js").ExecutionProvider["run"]>>,
): string {
  const parts = [`$ ${argv.join(" ")}`];
  if (result.timedOut) parts.push(`(timed out after ${result.durationMs} ms)`);
  parts.push(`exit code: ${result.exitCode}`);
  if (result.stdout) parts.push(`--- stdout ---\n${result.stdout.trimEnd()}`);
  if (result.stderr) parts.push(`--- stderr ---\n${result.stderr.trimEnd()}`);
  if (result.truncated) parts.push("(output truncated)");
  return parts.join("\n");
}
