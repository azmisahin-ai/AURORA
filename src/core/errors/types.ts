/**
 * Failure classification for the verification/repair loop.
 *
 * The classifier is deliberately dependency-free: it inspects *evidence* (a
 * non-zero exit, stderr text, a thrown error) and returns a category plus a
 * recovery action. It does not retry, repair, or call a model — deciding what
 * to do is the loop's job, and keeping that decision out of the classifier is
 * what makes both testable.
 */

export type ErrorCategory =
  | "TRANSIENT" // a retry may simply succeed
  | "CONFIGURATION" // setup is wrong: missing command/module/file
  | "AUTHENTICATION" // credentials missing, invalid, or rejected
  | "NETWORK" // the network itself failed
  | "CODE" // the code under change is wrong
  | "VALIDATION" // the input/arguments are wrong
  | "PERMISSION" // a filesystem/capability permission was refused
  | "UNKNOWN"; // no signal we recognise

export type RecoveryAction =
  | "retry" // retry immediately
  | "backoff_retry" // retry after a delay
  | "inspect_and_fix" // read the output, change the workspace, re-run
  | "fix_input" // correct the arguments/input and retry
  | "request_permission" // needs a broader grant; cannot self-resolve
  | "report_to_user" // environment/credential issue the agent must not guess at
  | "stop"; // unrecognised; do not guess

/**
 * Minimal structural view of an execution result. `ExecutionResult` from the
 * execution provider satisfies this without core importing that provider, which
 * keeps the `core → providers` dependency direction intact (ADR 001).
 */
export interface ExecutionFailure {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Minimal structural view of an error. `LLMError` (which carries `retryable`
 * and `status`) and Node's `SystemError` (which carries `code`) both satisfy it.
 */
export interface ClassifiableError {
  name?: string;
  message: string;
  retryable?: boolean;
  status?: number;
  code?: string;
}

export type FailureEvidence =
  | { kind: "execution"; result: ExecutionFailure; argv: string[] }
  | { kind: "error"; error: ClassifiableError };

export interface ErrorVerdict {
  category: ErrorCategory;
  action: RecoveryAction;
  /** True when repeating the same operation could plausibly succeed. */
  retryable: boolean;
  /** Why this classification was reached, for logs and trajectories. */
  reason: string;
  /** A concise, model-facing instruction appended to the observation. */
  hint: string;
}
