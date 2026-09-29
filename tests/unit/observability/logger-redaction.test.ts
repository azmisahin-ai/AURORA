import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import pino from "pino";
import { SecretRedactor } from "../../../src/security/SecretRedactor.js";

/**
 * The logger's shape redaction is a pino `logMethod` hook. These tests drive
 * the same hook wiring `createLogger` installs, against a capturing stream, so
 * the assertion is on real serialised output rather than on the redactor alone.
 */

function capturingLogger() {
  const lines: string[] = [];
  const stream = new PassThrough();
  stream.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) lines.push(line);
  });
  const redactor = new SecretRedactor();
  const logger = pino(
    {
      level: "debug",
      hooks: {
        logMethod(
          args: Parameters<typeof pino.prototype.info>,
          method: (...a: unknown[]) => void,
        ) {
          const scrubbed = args.map((arg) =>
            typeof arg === "string" ? redactor.redactString(arg) : redactor.redactValue(arg),
          );
          return method.apply(this, scrubbed);
        },
      },
    },
    stream,
  );
  return { logger, lines };
}

describe("logger shape redaction", () => {
  it("scrubs a key inside a plain message string", () => {
    const { logger, lines } = capturingLogger();
    logger.info("provider rejected key sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(lines.join("\n")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(lines.join("\n")).toContain("[REDACTED:openai-key]");
  });

  it("scrubs a key nested in a logged object", () => {
    const { logger, lines } = capturingLogger();
    logger.warn({ note: "token xoxb-1234567890-abcdefghijkl" }, "upstream error");
    expect(lines.join("\n")).not.toContain("xoxb-1234567890-abcdefghijkl");
    expect(lines.join("\n")).toContain("[REDACTED:slack-token]");
  });
});
