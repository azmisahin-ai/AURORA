import { basename } from "node:path";

/**
 * Parsed, validated command ready for execution *without a shell*.
 * `argv[0]` is the resolved base command name; the rest are unmodified args.
 */
export interface ValidatedCommand {
  argv: string[];
  base: string;
}

export class CommandValidationError extends Error {
  readonly command: string;
  constructor(message: string, command: string) {
    super(message);
    this.name = "CommandValidationError";
    this.command = command;
  }
}

/**
 * Characters that only mean something to a shell. AURORA executes commands via
 * `spawn` with an argv array and `shell: false`, so these are never interpreted.
 * Rejecting them anyway is defence in depth: it stops an allowlisted command
 * from being turned into a pipeline by a model that assumes a shell, and it
 * keeps the audit log free of ambiguous entries.
 */
const SHELL_METACHARACTERS = /[;&|<>`$(){}[\]\n\r\\]/;

/** Commands that must never be executed regardless of the allowlist. */
const ALWAYS_BLOCKED = new Set([
  "sudo",
  "su",
  "doas",
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "eval",
  "exec",
  "dd",
  "mkfs",
  "mount",
  "umount",
  "chown",
  "chmod",
  "systemctl",
  "service",
  "reboot",
  "shutdown",
  "kill",
  "killall",
  "pkill",
  "crontab",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ftp",
  "socat",
]);

/**
 * Validates a command string against an allowlist/denylist and a structural
 * safety check. Validation is a *gate*, not a sandbox: the execution provider
 * is responsible for the actual environment (cwd, timeout, no shell).
 */
export class CommandValidator {
  private readonly allowed: ReadonlySet<string>;
  private readonly blocked: ReadonlySet<string>;

  constructor(opts: { allowed: Iterable<string>; blocked?: Iterable<string> }) {
    this.allowed = new Set([...opts.allowed].map(normalizeName));
    this.blocked = new Set([...(opts.blocked ?? [])].map(normalizeName));
  }

  /**
   * Parse and validate. Throws `CommandValidationError` on any violation.
   */
  validate(command: string): ValidatedCommand {
    const trimmed = command.trim();
    if (trimmed.length === 0) {
      throw new CommandValidationError("Empty command", command);
    }
    if (SHELL_METACHARACTERS.test(trimmed)) {
      throw new CommandValidationError(
        "Command contains shell metacharacters; shell syntax is not permitted",
        command,
      );
    }

    const argv = tokenize(trimmed);
    if (argv.length === 0) {
      throw new CommandValidationError("Empty command", command);
    }

    const base = normalizeName(argv[0]!);

    if (ALWAYS_BLOCKED.has(base)) {
      throw new CommandValidationError(`Command "${base}" is never permitted`, command);
    }
    if (this.blocked.has(base)) {
      throw new CommandValidationError(`Command "${base}" is on the blocked list`, command);
    }
    if (!this.allowed.has(base)) {
      throw new CommandValidationError(
        `Command "${base}" is not on the allowed list`,
        command,
      );
    }

    return { argv, base };
  }

  /** Non-throwing variant, convenient for the actor path. */
  tryValidate(command: string):
    | { ok: true; value: ValidatedCommand }
    | { ok: false; error: string } {
    try {
      return { ok: true, value: this.validate(command) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** Strip a directory component and any `.exe` suffix. */
function normalizeName(name: string): string {
  return basename(name).replace(/\.exe$/i, "").toLowerCase();
}

/**
 * Minimal POSIX-ish tokenizer: splits on whitespace, honouring single and double
 * quotes. It exists so quoted arguments survive intact; it deliberately does
 * not implement variable expansion, globbing, or escapes beyond `\"`.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) {
    // Unbalanced quotes are a malformed command, not a nicety to paper over.
    throw new CommandValidationError("Unbalanced quote in command", input);
  }
  if (started) tokens.push(current);
  return tokens;
}
