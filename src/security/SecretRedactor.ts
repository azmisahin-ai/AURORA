/**
 * Pattern-based secret scrubbing (Phase 8, ADR 010).
 *
 * The logger already censors a fixed list of *known key paths*
 * (`headers.authorization`, `*.apiKey`, …) via pino's `redact`. That is exact
 * but blind: a secret that arrives inside an arbitrary string — an error
 * message, a tool observation echoed to a log, a URL with embedded credentials
 * — is not caught, because it is not at a known path.
 *
 * This redactor closes that gap by matching credential *shapes* in text. It is
 * deliberately conservative: a redactor that fires on ordinary prose is worse
 * than none, because operators learn to ignore `[REDACTED]`. Every named
 * pattern is anchored on a vendor prefix or a fixed length, and the one loose
 * pattern (`credential` assignments) additionally requires a value that looks
 * like a secret — see `looksLikeSecret`.
 *
 * Scope: **logs and audit text**. Observations handed to the model are not
 * scrubbed by default — a tool that reads a fixture containing a fake key would
 * otherwise be unusable. AURORA does not claim to prevent a secret from
 * reaching the model; see ADR 010 for the stated boundary.
 */

export interface RedactionFinding {
  /** Stable machine name for the matched pattern, e.g. `openai-key`. */
  kind: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  findings: RedactionFinding[];
}

interface SecretPattern {
  kind: string;
  /** Global regex, applied to a string. */
  re: RegExp;
  /**
   * Replacement for the *whole* match. May inspect capture groups. Defaults to
   * a `[REDACTED:kind]` placeholder.
   */
  replace?: (...groups: string[]) => string;
}

const PLACEHOLDER = (kind: string) => `[REDACTED:${kind}]`;

/**
 * Vendor-prefixed and fixed-length credentials. These have essentially no
 * false-positive surface: the prefix plus the length is the credential format.
 */
const SHAPE_PATTERNS: readonly SecretPattern[] = [
  {
    kind: "pem-private-key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // OpenAI first, and it must not swallow the `sk-ant-` form: the negative
  // lookahead excludes it so an Anthropic key is labelled correctly.
  { kind: "openai-key", re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{24,}\b/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { kind: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    kind: "bearer-token",
    re: /\bBearer(\s+)([A-Za-z0-9._~+/-]{20,}=*)/g,
    // Keep the scheme so a log line still reads "Bearer [REDACTED]".
    replace: (_m, ws) => `Bearer${ws}${PLACEHOLDER("bearer-token")}`,
  },
  {
    kind: "url-password",
    // scheme://user:password@host — keep the user and scheme, drop the password.
    re: /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: (_m, scheme, user) => `${scheme}${user}:${PLACEHOLDER("password")}@`,
  },
];

/**
 * Loose `name = value` assignments. Ranked last and post-filtered, because
 * prose such as "secret sauce: deliciousness" would otherwise match.
 */
const CREDENTIAL_NAME =
  /\b(password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key|token)\b["']?(\s*[:=]\s*)(["']?)([^\s"',;]{8,})\3/gi;

/**
 * A value that plausibly is a secret rather than a word: it mixes letters and
 * digits, or it is long enough that a human would not have written it as prose,
 * or it is a dense opaque blob. This is what keeps the loose pattern honest.
 */
function looksLikeSecret(value: string): boolean {
  if (/[0-9]/.test(value) && /[A-Za-z]/.test(value)) return true;
  if (value.length >= 20) return true;
  if (/^[A-Za-z0-9+/=_-]{32,}$/.test(value)) return true;
  return false;
}

export interface SecretRedactorOptions {
  /** Extra patterns, applied first. */
  extraPatterns?: readonly SecretPattern[];
  /** Kinds to skip, e.g. to stop redacting JWTs in a JWT test suite. */
  disabledKinds?: readonly string[];
}

export class SecretRedactor {
  private readonly patterns: readonly SecretPattern[];
  private readonly disabled: ReadonlySet<string>;

  constructor(opts: SecretRedactorOptions = {}) {
    this.patterns = [...(opts.extraPatterns ?? []), ...SHAPE_PATTERNS];
    this.disabled = new Set(opts.disabledKinds ?? []);
  }

  /** Scrub a string, reporting what matched and how often. */
  redact(input: string): RedactionResult {
    if (input.length === 0) return { text: input, findings: [] };
    const counts = new Map<string, number>();
    let text = input;

    for (const pattern of this.patterns) {
      if (this.disabled.has(pattern.kind)) continue;
      // A fresh lastIndex per pass: the pattern objects are shared and stateful.
      pattern.re.lastIndex = 0;
      if (!pattern.re.test(text)) continue;
      pattern.re.lastIndex = 0;

      const replace = pattern.replace ?? (() => PLACEHOLDER(pattern.kind));
      let hits = 0;
      text = text.replace(pattern.re, (...args: unknown[]) => {
        hits++;
        const groups = args.slice(0, -2).map((a) => String(a ?? ""));
        return replace(...groups);
      });
      if (hits > 0) counts.set(pattern.kind, (counts.get(pattern.kind) ?? 0) + hits);
    }

    // The loose assignment pattern runs last so a vendor pattern wins the label.
    CREDENTIAL_NAME.lastIndex = 0;
    if (CREDENTIAL_NAME.test(text)) {
      CREDENTIAL_NAME.lastIndex = 0;
      let hits = 0;
      text = text.replace(
        CREDENTIAL_NAME,
        (_m, name: string, sep: string, quote: string, value: string) => {
          if (!looksLikeSecret(value)) return _m;
          hits++;
          return `${name}${sep}${quote}${PLACEHOLDER("credential")}${quote}`;
        },
      );
      if (hits > 0) counts.set("credential", (counts.get("credential") ?? 0) + hits);
    }

    return {
      text,
      findings: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
    };
  }

  /** Convenience for callers that only want the scrubbed string. */
  redactString(input: string): string {
    return this.redact(input).text;
  }

  /**
   * Deep-redact a structured value for logging. Plain objects and arrays are
   * walked; strings are scrubbed; everything else (functions, primitives,
   * class instances) is passed through. Depth-bounded and cycle-safe so a log
   * call can never hang or overflow on a hostile object.
   */
  redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (typeof value === "string") return this.redactString(value);
    if (value === null || typeof value !== "object") return value;
    if (depth >= 6) return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, depth + 1, seen));
    }
    // Only walk plain objects. An Error or a class instance is left intact so
    // logging it does not strip its prototype or its stack.
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = this.redactValue(item, depth + 1, seen);
    }
    return out;
  }

  /** True when the text contains anything this redactor would replace. */
  hasSecret(input: string): boolean {
    return this.redact(input).findings.length > 0;
  }
}
