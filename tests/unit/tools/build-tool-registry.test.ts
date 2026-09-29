import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import pino from "pino";
import { buildToolRegistry } from "../../../src/tools/index.js";
import { loadConfig } from "../../../src/config/Config.js";
import { silentLogger } from "../../../src/observability/Logger.js";
import { DenyAllGate } from "../../../src/security/ConfirmationGate.js";
import { KeyedRateLimiter } from "../../../src/security/RateLimiter.js";

/**
 * The registry builder is where Phase 8 policy (config → concrete gate,
 * redactor, rate limiter, argument cap) is wired. These tests assert the
 * wiring, because a control that exists but is never connected is not a
 * control — and a mutation that disconnected the redactor would otherwise pass
 * every registry test that constructs its own registry.
 */

let workspace: string;
let knowledgeDir: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "aurora-build-"));
  knowledgeDir = await mkdtemp(join(tmpdir(), "aurora-build-know-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(knowledgeDir, { recursive: true, force: true });
});

function build(env: Record<string, string> = {}) {
  return buildToolRegistry({
    config: loadConfig({ AURORA_KNOWLEDGE_DIR: knowledgeDir, ...env }),
    logger: silentLogger,
    workspace,
  });
}

describe("buildToolRegistry wires the Phase 8 argument cap", () => {
  it("enforces a small configured cap through a real tool call", async () => {
    const built = build({ AURORA_MAX_ARGUMENT_BYTES: "100" });
    const result = await built.registry.execute({
      name: "write_file",
      arguments: { path: "a.txt", content: "x".repeat(500) },
    });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/limit is 100/);
  });
});

describe("buildToolRegistry wires the confirmation policy", () => {
  it("deny mode refuses a state-changing tool", async () => {
    const built = build({ AURORA_CONFIRM_MODE: "deny" });
    const result = await built.registry.execute({
      name: "write_file",
      arguments: { path: "nope.txt", content: "no" },
    });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/denied/i);
  });

  it("allow mode (default) writes without asking", async () => {
    const built = build();
    const result = await built.registry.execute({
      name: "write_file",
      arguments: { path: "yes.txt", content: "ok" },
    });
    expect(result.ok).toBe(true);
  });

  it("an injected gate overrides config", async () => {
    const built = buildToolRegistry({
      config: loadConfig({ AURORA_KNOWLEDGE_DIR: knowledgeDir, AURORA_CONFIRM_MODE: "allow" }),
      logger: silentLogger,
      workspace,
      confirmationGate: new DenyAllGate(),
    });
    const result = await built.registry.execute({
      name: "write_file",
      arguments: { path: "no.txt", content: "no" },
    });
    expect(result.ok).toBe(false);
  });
});

describe("buildToolRegistry wires rate limiting", () => {
  it("bounds a network tool through a configured limiter", async () => {
    // web_search with the noop provider returns without touching the network,
    // so the only thing that can deny the second call is the rate limiter.
    const built = buildToolRegistry({
      config: loadConfig({ AURORA_KNOWLEDGE_DIR: knowledgeDir }),
      logger: silentLogger,
      workspace,
      rateLimiter: new KeyedRateLimiter({ capacity: 1, refillPerSecond: 0.0001 }),
    });
    const first = await built.registry.execute({
      name: "web_search",
      arguments: { query: "anything" },
    });
    expect(first.ok).toBe(true);
    const second = await built.registry.execute({
      name: "web_search",
      arguments: { query: "anything" },
    });
    expect(second.ok).toBe(false);
    expect(second.observation).toMatch(/Rate limit/);
  });

  it("leaves network tools unbounded when toolRateLimit is 0", async () => {
    const built = build({ AURORA_TOOL_RATE_LIMIT: "0" });
    for (let i = 0; i < 4; i++) {
      const result = await built.registry.execute({
        name: "web_search",
        arguments: { query: "anything" },
      });
      // Still not rate-limited: it reaches the noop provider's own answer.
      expect(result.ok).toBe(true);
      expect(result.observation).not.toMatch(/Rate limit/);
    }
  });

  it("derives a limiter from the configured capacity when none is injected", async () => {
    // Capacity 3, effectively no refill: the 4th call must be denied, which
    // can only happen if the *config-derived* limiter is wired in. This is the
    // mutation guard for the `toolRateLimit > 0` branch itself.
    const built = build({ AURORA_TOOL_RATE_LIMIT: "3", AURORA_TOOL_RATE_REFILL: "0.0001" });
    const calls = [];
    for (let i = 0; i < 4; i++) {
      calls.push(
        await built.registry.execute({ name: "web_search", arguments: { query: "anything" } }),
      );
    }
    expect(calls.slice(0, 3).every((r) => r.ok)).toBe(true);
    expect(calls[3]?.ok).toBe(false);
    expect(calls[3]?.observation).toMatch(/Rate limit/);
  });
});

describe("buildToolRegistry wires secret redaction from config", () => {
  function capturingBuilder(env: Record<string, string>) {
    const lines: string[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) lines.push(line);
    });
    const logger = pino({ level: "debug" }, stream);
    const built = buildToolRegistry({
      config: loadConfig({ AURORA_KNOWLEDGE_DIR: knowledgeDir, ...env }),
      logger,
      workspace,
    });
    return { built, lines };
  }

  it("scrubs a credential from a tool-denial log by default", async () => {
    const { built, lines } = capturingBuilder({ AURORA_CONFIRM_MODE: "deny" });
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    await built.registry.execute({
      name: "write_file",
      arguments: { path: "x.txt", content: `key=${secret}` },
    });
    expect(lines.join("\n")).not.toContain(secret);
  });
});
