import type {
  ErrorCategory,
  ErrorVerdict,
  FailureEvidence,
  RecoveryAction,
} from "./types.js";

/**
 * Classifies a failure into a category and a recovery action.
 *
 * Ordering matters: the first rule that matches wins, so the checks are
 * arranged from most specific (structured signals: exit reason, error code,
 * HTTP status) to least specific (free-text patterns in stderr). Structured
 * signals are trusted over text because they cannot be faked by program output.
 *
 * The text patterns below are **heuristics** derived from common tool output
 * (Node.js, npm, TypeScript, test runners). They are deliberately conservative:
 * an unrecognised failure is `UNKNOWN` / `stop`, never a guessed repair.
 */
export class ErrorClassifier {
  classify(evidence: FailureEvidence): ErrorVerdict {
    return evidence.kind === "execution"
      ? this.classifyExecution(evidence.result, evidence.argv)
      : this.classifyError(evidence.error);
  }

  private classifyExecution(
    result: import("./types.js").ExecutionFailure,
    argv: string[],
  ): ErrorVerdict {
    const command = argv[0] ?? "(unknown)";

    // Structured: a killed process is its own category, not a code problem.
    if (result.timedOut) {
      return verdict(
        "TRANSIENT",
        "retry",
        true,
        `"${command}" exceeded its time limit`,
        "The command timed out. Narrow the scope or raise the timeout, then try again.",
      );
    }

    const text = `${result.stdout}\n${result.stderr}`;

    // Structured: the process could not even be spawned (exitCode null).
    if (result.exitCode === null) {
      return verdict(
        "CONFIGURATION",
        "report_to_user",
        false,
        `"${command}" did not produce an exit code (failed to start)`,
        `The command "${command}" could not be started. Check that it is installed and on PATH.`,
      );
    }

    return this.classifyText(text, command, result.exitCode);
  }

  private classifyError(
    error: import("./types.js").ClassifiableError,
  ): ErrorVerdict {
    // Structured: HTTP status, then the provider's own retryability hint.
    if (error.status === 401 || error.status === 403) {
      return verdict(
        "AUTHENTICATION",
        "report_to_user",
        false,
        `HTTP ${error.status} indicates rejected credentials`,
        "Authentication failed. The credential is missing, invalid, or lacks access.",
      );
    }
    if (error.status === 429) {
      return verdict(
        "TRANSIENT",
        "backoff_retry",
        true,
        "HTTP 429 rate limit",
        "The service is rate-limiting. Retrying after a delay may succeed.",
      );
    }
    if (error.status !== undefined && error.status >= 500) {
      return verdict(
        "TRANSIENT",
        "backoff_retry",
        true,
        `HTTP ${error.status} server error`,
        "The remote service returned a server error. Retrying may succeed.",
      );
    }

    // Structured: Node.js system error codes.
    const byCode = this.classifyErrorCode(error.code);
    if (byCode) return byCode;

    // Structured: AbortError is a deliberate stop, never a retry.
    if (error.name === "AbortError") {
      return verdict(
        "TRANSIENT",
        "stop",
        false,
        "Operation was aborted",
        "The operation was cancelled, so it was not completed.",
      );
    }

    if (error.retryable === true) {
      return verdict(
        "TRANSIENT",
        "backoff_retry",
        true,
        "Provider marked the error retryable",
        "A transient error occurred. Retrying may succeed.",
      );
    }

    return this.classifyText(error.message, "(operation)", undefined);
  }

  /** Maps a Node.js `SystemError.code` to a verdict, or null if unrecognised. */
  private classifyErrorCode(code: string | undefined): ErrorVerdict | null {
    switch (code) {
      case "EACCES":
      case "EPERM":
        return verdict(
          "PERMISSION",
          "request_permission",
          false,
          `System error ${code}`,
          "A permission was refused. This needs a broader grant; it cannot be fixed by retrying.",
        );
      case "ECONNREFUSED":
      case "ECONNRESET":
      case "ETIMEDOUT":
      case "ENOTFOUND":
      case "EAI_AGAIN":
      case "EHOSTUNREACH":
      case "ENETUNREACH":
        return verdict(
          "NETWORK",
          "backoff_retry",
          true,
          `Network error ${code}`,
          "A network error occurred. Check connectivity; retrying may succeed.",
        );
      case "ENOENT":
        return verdict(
          "CONFIGURATION",
          "report_to_user",
          false,
          `System error ${code}: file or executable not found`,
          "A required file or command is missing. Check the setup.",
        );
      case "ERR_INVALID_ARG_TYPE":
      case "ERR_INVALID_ARG_VALUE":
        return verdict(
          "VALIDATION",
          "fix_input",
          false,
          `Invalid argument (${code})`,
          "An argument was invalid. Correct it before retrying.",
        );
      default:
        return null;
    }
  }

  /**
   * Text-pattern classification. Kept separate so the ordered rules read as a
   * single table; each entry is an independent signal, not a chain.
   */
  private classifyText(
    text: string,
    subject: string,
    exitCode: number | undefined,
  ): ErrorVerdict {
    const lower = text.toLowerCase();

    if (/command not found|is not recognized as|no such file or directory/.test(lower)) {
      return verdict(
        "CONFIGURATION",
        "report_to_user",
        false,
        `"${subject}" references a missing command or file`,
        "A required command or file does not exist. Check the setup before retrying.",
      );
    }

    if (/cannot find module|module not found|err_module_not_found/.test(lower)) {
      // A relative specifier means the code points at a wrong path (a code bug);
      // a bare specifier means a dependency is not installed (configuration).
      const relative = /cannot find module\s+['"]?\.{1,2}\//.test(lower);
      return relative
        ? verdict(
            "CODE",
            "inspect_and_fix",
            false,
            "Relative module path could not be resolved",
            "An import points at a path that does not exist. Fix the path and re-run.",
          )
        : verdict(
            "CONFIGURATION",
            "report_to_user",
            false,
            "A dependency module is not installed",
            "A dependency is missing. Install dependencies before re-running.",
          );
    }

    if (/eacces|permission denied|operation not permitted/.test(lower)) {
      return verdict(
        "PERMISSION",
        "request_permission",
        false,
        "Filesystem or capability permission was refused",
        "A permission was refused. This needs a broader grant, not a retry.",
      );
    }

    if (
      /unauthori[sz]ed|authentication failed|invalid api key|invalid token|401|403|forbidden/.test(
        lower,
      )
    ) {
      return verdict(
        "AUTHENTICATION",
        "report_to_user",
        false,
        "Authenticated request was rejected",
        "Authentication failed. Check the credential before retrying.",
      );
    }

    if (
      /econnrefused|econnreset|etimedout|enotfound|eai_again|socket hang up|network error|getaddrinfo/.test(
        lower,
      )
    ) {
      return verdict(
        "NETWORK",
        "backoff_retry",
        true,
        "Network-level failure",
        "A network error occurred. Check connectivity; retrying may succeed.",
      );
    }

    if (
      /assertionerror|expected .* to|test failed|failing tests?|\b✖\b|^\s*fail\b|pytest|jest/.test(
        lower,
      )
    ) {
      return verdict(
        "CODE",
        "inspect_and_fix",
        false,
        "A test assertion failed",
        "The code under test is incorrect. Read the failure, fix the code, and re-run.",
      );
    }

    if (/error ts\d+|typescript|\btsc\b|syntaxerror|unexpected token|parse error/.test(lower)) {
      return verdict(
        "CODE",
        "inspect_and_fix",
        false,
        "Compilation or syntax error",
        "The code does not compile. Fix the reported error and re-run.",
      );
    }

    if (/eslint|lint error/.test(lower)) {
      return verdict(
        "CODE",
        "inspect_and_fix",
        false,
        "Lint error",
        "Lint reported a problem. Fix it and re-run.",
      );
    }

    if (/invalid|must be|required|validation|schema/.test(lower)) {
      return verdict(
        "VALIDATION",
        "fix_input",
        false,
        "Input failed validation",
        "The input was invalid. Correct it before retrying.",
      );
    }

    return verdict(
      "UNKNOWN",
      "stop",
      false,
      exitCode === undefined
        ? `Unrecognised failure from ${subject}`
        : `Unrecognised failure in "${subject}" (exit ${exitCode})`,
      "The failure could not be classified. Inspect the output and decide manually.",
    );
  }
}

function verdict(
  category: ErrorCategory,
  action: RecoveryAction,
  retryable: boolean,
  reason: string,
  hint: string,
): ErrorVerdict {
  return { category, action, retryable, reason, hint };
}
