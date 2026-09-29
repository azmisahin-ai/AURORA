import { describe, expect, it } from "vitest";
import { SecretRedactor } from "../../../src/security/SecretRedactor.js";

const redactor = new SecretRedactor();

function redact(input: string): string {
  return redactor.redactString(input);
}

describe("SecretRedactor shapes", () => {
  it("redacts an OpenAI key", () => {
    const out = redact("key: sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).toContain("[REDACTED:openai-key]");
  });

  it("labels an Anthropic key as anthropic, not openai", () => {
    const out = redact("sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345");
    expect(out).toContain("[REDACTED:anthropic-key]");
    expect(out).not.toContain("openai-key");
  });

  it("redacts a GitHub fine-grained token", () => {
    const out = redact("token github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz");
    expect(out).toContain("[REDACTED:github-token]");
  });

  it("redacts an AWS access key id", () => {
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED:aws-access-key-id]");
  });

  it("redacts a Slack token", () => {
    expect(redact("xoxb-1234567890-abcdefghijkl")).toContain("[REDACTED:slack-token]");
  });

  it("redacts a Google API key", () => {
    const key = `AIza${"a".repeat(35)}`;
    expect(redact(key)).toContain("[REDACTED:google-api-key]");
  });

  it("redacts a Stripe live key", () => {
    expect(redact("sk_live_abcdefghijklmnop1234")).toContain("[REDACTED:stripe-key]");
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redact(`Bearer-ish ${jwt}`)).toContain("[REDACTED:jwt]");
  });

  it("redacts a bearer token keeping the scheme", () => {
    const out = redact("Authorization: Bearer abcdefghijklmnopqrstuvwx.0123456789");
    expect(out).toContain("Bearer");
    expect(out).toContain("[REDACTED:bearer-token]");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwx.0123456789");
  });

  it("redacts a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    const out = redact(pem);
    expect(out).toContain("[REDACTED:pem-private-key]");
    expect(out).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("redacts the password in a URL but keeps user and scheme", () => {
    const out = redact("postgres://admin:hunter2@db.internal:5432/app");
    expect(out).toContain("postgres://admin:");
    expect(out).toContain("@db.internal:5432/app");
    expect(out).not.toContain("hunter2");
  });
});

describe("SecretRedactor credential assignments", () => {
  it("redacts an api_key assignment whose value looks secret", () => {
    expect(redact('api_key = "a1b2c3d4e5f6g7h8i9j0"')).toContain("[REDACTED:credential]");
  });

  it("redacts a password assignment", () => {
    expect(redact("password: correct-horse-battery-staple-123")).toContain(
      "[REDACTED:credential]",
    );
  });

  it("leaves a prose 'secret' assignment alone", () => {
    const text = "the secret sauce: deliciousness";
    expect(redact(text)).toBe(text);
  });

  it("leaves a short non-secret-looking value alone", () => {
    const text = "token = abc";
    expect(redact(text)).toBe(text);
  });
});

describe("SecretRedactor false positives", () => {
  const corpus = [
    "The quick brown fox jumps over the lazy dog.",
    "Read src/core/agent/AgentLoop.ts and summarise its loop shape.",
    "npm test -- --reporter=verbose",
    "version 1.2.3 is the latest release",
    "GET /api/health returned 200 OK",
    "hash: deadbeefdeadbeefdeadbeefdeadbeef",
    "The meeting is at 2026-09-28T18:43:18Z",
    "email support@example.com for help",
  ];

  for (const line of corpus) {
    it(`does not alter: ${line.slice(0, 40)}`, () => {
      expect(redact(line)).toBe(line);
    });
  }

  it("reports no findings for clean text", () => {
    expect(redactor.redact("nothing to see here").findings).toEqual([]);
  });
});

describe("SecretRedactor reporting and options", () => {
  it("counts multiple hits of the same kind", () => {
    const out = redactor.redact(
      "sk-abcdefghijklmnopqrstuvwxyz0123456789 and sk-zyxwvutsrqponmlkjihgfedcba9876543210",
    );
    expect(out.findings).toEqual([{ kind: "openai-key", count: 2 }]);
  });

  it("is safe to call twice on shared patterns (no lastIndex bleed)", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactor.redactString(key)).toContain("[REDACTED");
    expect(redactor.redactString(key)).toContain("[REDACTED");
  });

  it("honours disabledKinds", () => {
    const noJwt = new SecretRedactor({ disabledKinds: ["jwt"] });
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(noJwt.redactString(jwt)).toBe(jwt);
  });

  it("hasSecret is true only when something matches", () => {
    expect(redactor.hasSecret("sk-abcdefghijklmnopqrstuvwxyz0123456789")).toBe(true);
    expect(redactor.hasSecret("plain prose")).toBe(false);
  });
});

describe("SecretRedactor.redactValue", () => {
  it("redacts strings nested in plain objects and arrays", () => {
    const out = redactor.redactValue({
      note: "token sk-abcdefghijklmnopqrstuvwxyz0123456789",
      list: ["xoxb-1234567890-abcdefghijkl", "clean"],
    }) as Record<string, unknown>;
    expect(String(out.note)).toContain("[REDACTED:openai-key]");
    expect((out.list as string[])[0]).toContain("[REDACTED:slack-token]");
    expect((out.list as string[])[1]).toBe("clean");
  });

  it("leaves an Error instance intact", () => {
    const err = new Error("boom sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(redactor.redactValue(err)).toBe(err);
  });

  it("does not hang on a cycle", () => {
    const cyclic: Record<string, unknown> = { name: "a" };
    cyclic.self = cyclic;
    const out = redactor.redactValue(cyclic) as Record<string, unknown>;
    expect(out.self).toBe("[Circular]");
  });
});
