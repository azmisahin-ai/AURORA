import type { Logger } from "pino";
import type { Verifier, VerificationOutcome } from "../../core/agent/types.js";
import type { CommandValidator } from "../../security/CommandValidator.js";
import type { PermissionManager } from "../../security/PermissionManager.js";
import type { ExecutionProvider, ExecutionResult } from "./ExecutionProvider.js";
import { parseTestSummary, ranNoTests } from "./TestSummary.js";

export interface CommandVerifierOptions {
  /** Command to run as the external check, e.g. `"npm test"` or `"node --test"`. */
  command: string;
  execution: ExecutionProvider;
  commandValidator: CommandValidator;
  permissions: PermissionManager;
  cwd: string;
  timeoutMs: number;
  logger?: Logger;
}

/**
 * An external verification signal backed by a real command (ADR 001/006).
 *
 * This is the only place in Phase 4 that decides whether work is *actually*
 * correct, and it decides it from a process exit code — never from the model's
 * opinion. Three properties matter:
 *
 *  - It is the same gate as everything else: the command must pass
 *    `CommandValidator` and the run must hold `COMMAND_EXECUTION`. If not, the
 *    check is **skipped**, not passed. A skipped check is reported as skipped so
 *    the run cannot present unverified work as verified.
 *  - It runs `shell: false` via the execution provider, so the command string is
 *    not shell-interpreted.
 *  - Output is truncated (`maxOutputBytes`) so a noisy failing suite cannot
 *    blow the context budget.
 */
export class CommandVerifier implements Verifier {
  readonly name: string;
  private readonly opts: CommandVerifierOptions;

  constructor(opts: CommandVerifierOptions) {
    this.opts = opts;
    this.name = opts.command;
  }

  async verify(signal?: AbortSignal): Promise<VerificationOutcome> {
    const { commandValidator, permissions, execution, cwd, timeoutMs } = this.opts;

    if (!permissions.has("COMMAND_EXECUTION")) {
      this.opts.logger?.warn(
        { verifier: this.name },
        "verification skipped: COMMAND_EXECUTION not granted",
      );
      return {
        kind: "skipped",
        reason: "COMMAND_EXECUTION permission is not granted",
        observation:
          `Verification "${this.name}" was skipped: this run lacks COMMAND_EXECUTION. ` +
          `The result is therefore UNVERIFIED.`,
      };
    }

    const validation = commandValidator.tryValidate(this.name);
    if (!validation.ok) {
      this.opts.logger?.error(
        { verifier: this.name, reason: validation.error },
        "verification skipped: command rejected by validator",
      );
      return {
        kind: "skipped",
        reason: `command rejected: ${validation.error}`,
        observation:
          `Verification "${this.name}" was skipped: ${validation.error}. ` +
          `The result is therefore UNVERIFIED.`,
      };
    }

    const result = await execution.run({
      argv: validation.value.argv,
      cwd,
      timeoutMs,
      maxOutputBytes: 16 * 1024,
      ...(signal ? { signal } : {}),
    });

    const observation = formatVerdict(validation.value.argv, result);

    if (result.timedOut) {
      return { kind: "fail", observation, evidence: result };
    }
    if (result.exitCode !== 0) {
      return { kind: "fail", observation, evidence: result };
    }
    // Exit 0 is not sufficient: `node --test` exits 0 when no test files match,
    // so a vacuous run would otherwise be reported as a pass (ADR 006).
    if (ranNoTests(parseTestSummary(`${result.stdout}\n${result.stderr}`))) {
      return {
        kind: "fail",
        observation: `${observation}\nverification ran no tests — treated as failure`,
        evidence: result,
      };
    }
    return { kind: "pass", observation };
  }
}

function formatVerdict(argv: string[], result: ExecutionResult): string {
  const parts = [`$ ${argv.join(" ")}  (external verification)`];
  if (result.timedOut) parts.push(`(timed out after ${result.durationMs} ms)`);
  parts.push(`exit code: ${result.exitCode}`);
  // stderr first: for a failing test run it carries the assertion and stack.
  if (result.stderr) parts.push(`--- stderr ---\n${result.stderr.trimEnd()}`);
  if (result.stdout) parts.push(`--- stdout ---\n${result.stdout.trimEnd()}`);
  if (result.truncated) parts.push("(output truncated)");
  return parts.join("\n");
}
