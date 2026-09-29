import pino, { type Logger } from "pino";
import { SecretRedactor } from "../security/SecretRedactor.js";

export type { Logger };

/**
 * Structured logger with two independent redaction layers (ADR 010):
 *
 *  1. **Path-based** (pino `redact`): exact names — `apiKey`, `authorization`.
 *     Cheap and precise, but blind to a secret inside an arbitrary string.
 *  2. **Shape-based** (`SecretRedactor` via a `logMethod` hook): credential
 *     *shapes* anywhere in an argument, e.g. a token inside an error message or
 *     a command string. This is what catches the leak path the path list misses.
 *
 * Both are on by default. `createLogger(level, { redact: false })` disables only
 * the shape layer, for tests that need to read a raw value back.
 */
export function createLogger(
  level: string = "info",
  opts: { redact?: boolean } = {},
): Logger {
  const shapeRedaction = opts.redact !== false;
  const redactor = shapeRedaction ? new SecretRedactor() : undefined;

  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "apiKey",
        "*.apiKey",
        "headers.authorization",
        "headers.Authorization",
        "OPENAI_COMPATIBLE_API_KEY",
        "*.OPENAI_COMPATIBLE_API_KEY",
      ],
      censor: "[REDACTED]",
    },
    ...(redactor
      ? {
          hooks: {
            logMethod(
              args: Parameters<typeof pino.prototype.info>,
              method: (...a: unknown[]) => void,
            ) {
              // Redact string arguments and strings nested in plain objects;
              // leave non-plain values (Errors, class instances) intact so a
              // stack trace is not silently replaced by a copy.
              const scrubbed = args.map((arg) =>
                typeof arg === "string"
                  ? redactor.redactString(arg)
                  : redactor.redactValue(arg),
              );
              return method.apply(this, scrubbed);
            },
          },
        }
      : {}),
  });
}

export const silentLogger: Logger = pino({ level: "silent" });
