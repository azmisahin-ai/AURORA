import { describe, it, expect } from "vitest";
import {
  apiConfirmationGate,
  assertSafeBinding,
  isLoopbackHost,
  tokenMatches,
} from "../../../src/api/index.js";

describe("api binding safety (ADR 011 §3)", () => {
  it("recognises the loopback spellings", () => {
    for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST", " 127.0.0.1 "]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com", ""]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it("allows a loopback bind with no token", () => {
    expect(() => assertSafeBinding("127.0.0.1", "")).not.toThrow();
    expect(() => assertSafeBinding("localhost", "   ")).not.toThrow();
  });

  it("refuses a public bind without a token", () => {
    // The failure this guards: binding a command-executing agent to a public
    // interface with no auth. Fail loudly at startup, never serve.
    expect(() => assertSafeBinding("0.0.0.0", "")).toThrow(/AURORA_API_TOKEN/);
    expect(() => assertSafeBinding("192.168.1.10", "")).toThrow(/Refusing to bind/);
  });

  it("allows a public bind once a token is set", () => {
    expect(() => assertSafeBinding("0.0.0.0", "s3cret")).not.toThrow();
  });
});

describe("token comparison", () => {
  it("accepts the exact token and rejects everything else", () => {
    expect(tokenMatches("abc123", "abc123")).toBe(true);
    expect(tokenMatches("abc123", "abc124")).toBe(false);
    expect(tokenMatches("abc123", "")).toBe(false);
    // A prefix must not pass: the comparison is over the whole value.
    expect(tokenMatches("abc123", "abc")).toBe(false);
  });

  it("does not throw on length mismatch (constant-time hashing)", () => {
    expect(() => tokenMatches("short", "a-much-longer-token-value")).not.toThrow();
  });
});

describe("api confirmation gate policy", () => {
  const request = { tool: "write_file", summary: "write x" };

  it("denies mutation by default and allows it only when opted in", async () => {
    // Default API runs must not be a remote command executor.
    expect(await apiConfirmationGate(false).request(request)).toBe("denied");
    expect(await apiConfirmationGate(true).request(request)).toBe("approved");
  });
});
