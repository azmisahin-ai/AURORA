import pino, { type Logger } from "pino";

export type { Logger };

/** Structured logger. `silent` maps to pino's silent level for tests. */
export function createLogger(level: string = "info"): Logger {
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
  });
}

export const silentLogger: Logger = pino({ level: "silent" });
