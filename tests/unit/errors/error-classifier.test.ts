import { describe, expect, it } from "vitest";
import { ErrorClassifier } from "../../../src/core/errors/ErrorClassifier.js";
import type { ExecutionFailure } from "../../../src/core/errors/types.js";

const classifier = new ErrorClassifier();

function exec(over: Partial<ExecutionFailure>, argv = ["npm", "test"]) {
  return classifier.classify({
    kind: "execution",
    argv,
    result: {
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      ...over,
    },
  });
}

describe("ErrorClassifier — execution evidence", () => {
  it("classifies a timeout as transient and retryable", () => {
    const v = exec({ timedOut: true });
    expect(v.category).toBe("TRANSIENT");
    expect(v.action).toBe("retry");
    expect(v.retryable).toBe(true);
  });

  it("classifies a null exit code as configuration (failed to start)", () => {
    const v = exec({ exitCode: null });
    expect(v.category).toBe("CONFIGURATION");
    expect(v.action).toBe("report_to_user");
    expect(v.retryable).toBe(false);
  });

  it("classifies a failing test assertion as CODE → inspect_and_fix", () => {
    const v = exec({
      stderr: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal",
    });
    expect(v.category).toBe("CODE");
    expect(v.action).toBe("inspect_and_fix");
    expect(v.hint).toMatch(/fix the code/i);
  });

  it("classifies a TypeScript error as CODE", () => {
    const v = exec({ stdout: "src/a.ts(3,5): error TS2322: Type 'string' is not assignable" });
    expect(v.category).toBe("CODE");
  });

  it("classifies 'command not found' as CONFIGURATION", () => {
    const v = exec({ stderr: "sh: vitest: command not found" }, ["vitest"]);
    expect(v.category).toBe("CONFIGURATION");
    expect(v.action).toBe("report_to_user");
  });

  it("classifies a missing bare dependency as CONFIGURATION", () => {
    const v = exec({ stderr: "Error: Cannot find module 'vitest'" });
    expect(v.category).toBe("CONFIGURATION");
  });

  it("classifies a missing *relative* module as CODE, not configuration", () => {
    // A wrong relative path is the agent's own bug, not a missing install.
    const v = exec({ stderr: "Error: Cannot find module './missing.js'" });
    expect(v.category).toBe("CODE");
    expect(v.action).toBe("inspect_and_fix");
  });

  it("classifies EACCES as PERMISSION → request_permission", () => {
    const v = exec({ stderr: "Error: EACCES: permission denied, open '/etc/shadow'" });
    expect(v.category).toBe("PERMISSION");
    expect(v.action).toBe("request_permission");
  });

  it("classifies a network failure as NETWORK and retryable", () => {
    const v = exec({ stderr: "Error: connect ECONNREFUSED 127.0.0.1:11434" });
    expect(v.category).toBe("NETWORK");
    expect(v.action).toBe("backoff_retry");
    expect(v.retryable).toBe(true);
  });

  it("classifies an authentication failure as AUTHENTICATION", () => {
    const v = exec({ stderr: "HTTP 401 Unauthorized: invalid api key" });
    expect(v.category).toBe("AUTHENTICATION");
    expect(v.action).toBe("report_to_user");
  });

  it("classifies a lint error as CODE", () => {
    const v = exec({ stdout: "eslint found 3 problems" });
    expect(v.category).toBe("CODE");
  });

  it("falls back to UNKNOWN → stop rather than guessing", () => {
    const v = exec({ stderr: "something inscrutable happened" });
    expect(v.category).toBe("UNKNOWN");
    expect(v.action).toBe("stop");
    expect(v.retryable).toBe(false);
  });
});

describe("ErrorClassifier — thrown error evidence", () => {
  const err = (over: Record<string, unknown>) =>
    classifier.classify({ kind: "error", error: { message: "x", ...over } });

  it("treats HTTP 401/403 as AUTHENTICATION", () => {
    expect(err({ status: 401 }).category).toBe("AUTHENTICATION");
    expect(err({ status: 403 }).category).toBe("AUTHENTICATION");
  });

  it("treats HTTP 429 as TRANSIENT with backoff", () => {
    const v = err({ status: 429 });
    expect(v.category).toBe("TRANSIENT");
    expect(v.action).toBe("backoff_retry");
  });

  it("treats HTTP 5xx as TRANSIENT", () => {
    expect(err({ status: 503 }).category).toBe("TRANSIENT");
  });

  it("treats a Node network code as NETWORK", () => {
    expect(err({ code: "ECONNREFUSED" }).category).toBe("NETWORK");
    expect(err({ code: "ETIMEDOUT" }).retryable).toBe(true);
  });

  it("treats ENOENT as CONFIGURATION", () => {
    expect(err({ code: "ENOENT" }).category).toBe("CONFIGURATION");
  });

  it("treats EACCES as PERMISSION", () => {
    expect(err({ code: "EACCES" }).action).toBe("request_permission");
  });

  it("does NOT retry an AbortError even though it is transient", () => {
    const v = err({ name: "AbortError", message: "The operation was aborted" });
    expect(v.category).toBe("TRANSIENT");
    expect(v.action).toBe("stop");
    expect(v.retryable).toBe(false);
  });

  it("honours a provider's explicit retryable hint", () => {
    const v = err({ message: "transient glitch", retryable: true });
    expect(v.action).toBe("backoff_retry");
    expect(v.retryable).toBe(true);
  });

  it("prefers structured signals over misleading text", () => {
    // The message mentions "invalid" (a VALIDATION cue) but status 401 wins.
    const v = err({ status: 401, message: "invalid api key" });
    expect(v.category).toBe("AUTHENTICATION");
  });
});
