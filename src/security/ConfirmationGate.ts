/**
 * Confirmation gate for state-changing operations (Phase 8, ADR 010).
 *
 * ADR 004 already says "state-changing operations require user confirmation
 * where practical". Phase 8 makes the "where practical" concrete: the registry
 * asks a `ConfirmationGate` before running a tool that can change the workspace
 * or the machine, and the answer — yes, no, or nobody to ask — is a decision
 * with three distinct meanings, not a boolean.
 *
 * The three outcomes are the whole design. Collapsing "denied" and "no one to
 * ask" into `false` would make an unattended run silently indistinguishable
 * from a rejected one. A non-interactive CI run must *proceed* under its
 * configured policy; a user who answers "no" must *stop* it.
 */

export interface ConfirmationRequest {
  tool: string;
  /** One-line, human-readable summary of what the call will do. */
  summary: string;
  /** The tool's validated arguments, for a UI to display. */
  arguments?: unknown;
}

export type ConfirmationOutcome = "approved" | "denied" | "unavailable";

export interface ConfirmationGate {
  /** A stable name, for audit logs. */
  readonly name: string;
  request(req: ConfirmationRequest): Promise<ConfirmationOutcome>;
}

/**
 * Approves everything without asking. The default for non-interactive runs:
 * an agent that must run unattended should not deadlock on a prompt, and the
 * guard rails that actually constrain it are permissions, validators, and the
 * allowlist — not this gate.
 */
export class AllowAllGate implements ConfirmationGate {
  readonly name = "allow-all";
  async request(): Promise<ConfirmationOutcome> {
    return "approved";
  }
}

/** Denies everything it is asked about. The conservative default. */
export class DenyAllGate implements ConfirmationGate {
  readonly name = "deny-all";
  async request(): Promise<ConfirmationOutcome> {
    return "denied";
  }
}

export interface PromptGateOptions {
  /**
   * Answers a question and returns the user's reply, or `undefined` when there
   * is no interactive input (EOF / closed stdin). Injected so the gate is
   * testable without a terminal.
   */
  ask: (question: string) => Promise<string | undefined>;
}

/**
 * Asks the user. Reads from a supplied `ask` function so the CLI can wire
 * `readline` and a test can wire a script. Any answer other than an explicit
 * yes is a no: this is an approval prompt, so the safe default wins.
 */
export class PromptGate implements ConfirmationGate {
  readonly name = "prompt";
  constructor(private readonly opts: PromptGateOptions) {}

  async request(req: ConfirmationRequest): Promise<ConfirmationOutcome> {
    const answer = await this.opts.ask(
      `allow ${req.tool}? ${req.summary} [y/N] `,
    );
    if (answer === undefined) return "unavailable";
    return /^y(es)?$/i.test(answer.trim()) ? "approved" : "denied";
  }
}
