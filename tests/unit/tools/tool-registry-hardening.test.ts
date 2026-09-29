import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { ToolRegistry } from "../../../src/tools/ToolRegistry.js";
import { defineTool } from "../../../src/tools/types.js";
import { PermissionManager } from "../../../src/security/PermissionManager.js";
import { PathValidator } from "../../../src/security/PathValidator.js";
import { CommandValidator } from "../../../src/security/CommandValidator.js";
import { LocalExecutionProvider } from "../../../src/providers/execution/LocalExecutionProvider.js";
import { silentLogger } from "../../../src/observability/Logger.js";
import {
  AllowAllGate,
  DenyAllGate,
  PromptGate,
  type ConfirmationGate,
} from "../../../src/security/ConfirmationGate.js";
import { RateLimiter, KeyedRateLimiter } from "../../../src/security/RateLimiter.js";
import { SecretRedactor } from "../../../src/security/SecretRedactor.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "aurora-hard-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

interface RegistryOverrides {
  gate?: ConfirmationGate;
  rateLimiter?: KeyedRateLimiter;
  redactor?: SecretRedactor;
  maxArgumentBytes?: number;
}

function registry(
  granted: Parameters<typeof PermissionManager.prototype.has>[0][],
  overrides: RegistryOverrides = {},
) {
  return new ToolRegistry({
    permissions: new PermissionManager(granted),
    workspace,
    pathValidator: new PathValidator([workspace]),
    commandValidator: new CommandValidator({ allowed: ["echo", "git"] }),
    execution: new LocalExecutionProvider(),
    logger: silentLogger,
    ...(overrides.gate !== undefined ? { confirmationGate: overrides.gate } : {}),
    ...(overrides.rateLimiter !== undefined ? { rateLimiter: overrides.rateLimiter } : {}),
    ...(overrides.redactor !== undefined ? { redactor: overrides.redactor } : {}),
    ...(overrides.maxArgumentBytes !== undefined
      ? { maxArgumentBytes: overrides.maxArgumentBytes }
      : {}),
  });
}

const writeishTool = defineTool({
  name: "writeish",
  description: "Needs write access and mutates the workspace",
  inputSchema: z.object({ path: z.string().default("x.txt") }),
  requiredPermissions: ["WORKSPACE_WRITE"] as const,
  mutatesWorkspace: true,
  async execute() {
    return { ok: true, output: "wrote" };
  },
});

const readishTool = defineTool({
  name: "readish",
  description: "Reads without changing anything",
  inputSchema: z.object({ path: z.string().default("x.txt") }),
  requiredPermissions: ["READ_ONLY"] as const,
  async execute() {
    return { ok: true, output: "read" };
  },
});

const execTool = defineTool({
  name: "execish",
  description: "Runs a command",
  inputSchema: z.object({ command: z.string().default("echo hi") }),
  requiredPermissions: ["COMMAND_EXECUTION"] as const,
  async execute() {
    return { ok: true, output: "ran" };
  },
});

const netTool = defineTool({
  name: "netish",
  description: "Reaches the network",
  inputSchema: z.object({ url: z.string().default("https://example.com") }),
  requiredPermissions: ["NETWORK_ACCESS"] as const,
  async execute() {
    return { ok: true, output: "fetched" };
  },
});

describe("ToolRegistry — confirmation gate", () => {
  it("asks before a mutating tool and runs it when approved", async () => {
    const seen: string[] = [];
    const gate = new PromptGate({
      ask: async (q) => {
        seen.push(q);
        return "y";
      },
    });
    const r = registry(["WORKSPACE_WRITE"], { gate }).register(writeishTool);
    const result = await r.execute({ name: "writeish", arguments: { path: "a.txt" } });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("writeish");
    expect(seen[0]).toContain("path=a.txt");
  });

  it("refuses a mutating tool the user denies, without running it", async () => {
    let ran = false;
    const spy = defineTool({
      name: "spy",
      description: "mutating and observable",
      inputSchema: z.object({}),
      requiredPermissions: ["WORKSPACE_WRITE"] as const,
      mutatesWorkspace: true,
      async execute() {
        ran = true;
        return { ok: true, output: "ran" };
      },
    });
    const r = registry(["WORKSPACE_WRITE"], { gate: new DenyAllGate() }).register(spy);
    const result = await r.execute({ name: "spy", arguments: {} });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/denied/i);
    expect(ran).toBe(false);
  });

  it("gates command execution even without a declared mutation", async () => {
    const r = registry(["COMMAND_EXECUTION"], { gate: new DenyAllGate() }).register(execTool);
    const result = await r.execute({ name: "execish", arguments: { command: "echo hi" } });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/denied/i);
  });

  it("does not ask about a read-only tool", async () => {
    let asked = false;
    const gate = new PromptGate({
      ask: async () => {
        asked = true;
        return "y";
      },
    });
    const r = registry(["READ_ONLY"], { gate }).register(readishTool);
    const result = await r.execute({ name: "readish", arguments: {} });
    expect(result.ok).toBe(true);
    expect(asked).toBe(false);
  });

  it("proceeds when the gate reports unavailable and nothing is strict", async () => {
    const gate = new PromptGate({ ask: async () => undefined });
    const r = registry(["WORKSPACE_WRITE"], { gate }).register(writeishTool);
    const result = await r.execute({ name: "writeish", arguments: {} });
    expect(result.ok).toBe(true);
  });

  it("allow-all runs mutating tools without asking", async () => {
    const r = registry(["WORKSPACE_WRITE"], { gate: new AllowAllGate() }).register(writeishTool);
    expect((await r.execute({ name: "writeish", arguments: {} })).ok).toBe(true);
  });

  it("redacts secrets in the prompt arguments", async () => {
    let seen = "";
    const gate = new PromptGate({
      ask: async (q) => {
        seen = q;
        return "y";
      },
    });
    const cmd = defineTool({
      name: "cmd",
      description: "runs a command",
      inputSchema: z.object({ command: z.string() }),
      requiredPermissions: ["COMMAND_EXECUTION"] as const,
      async execute() {
        return { ok: true, output: "ok" };
      },
    });
    const r = registry(["COMMAND_EXECUTION"], { gate, redactor: new SecretRedactor() }).register(cmd);
    await r.execute({
      name: "cmd",
      arguments: { command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789' x" },
    });
    expect(seen).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

describe("ToolRegistry — argument size cap", () => {
  it("rejects a call whose arguments exceed the cap", async () => {
    const r = registry(["WORKSPACE_WRITE"], { maxArgumentBytes: 200 }).register(writeishTool);
    const result = await r.execute({
      name: "writeish",
      arguments: { path: "x".repeat(500) },
    });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/limit is 200/);
  });

  it("allows a call within the cap", async () => {
    const r = registry(["WORKSPACE_WRITE"], { maxArgumentBytes: 200 }).register(writeishTool);
    expect((await r.execute({ name: "writeish", arguments: { path: "a.txt" } })).ok).toBe(true);
  });

  it("applies the cap before validation errors are surfaced", async () => {
    // A huge, schema-invalid payload should be reported as too large, not as a
    // schema issue — the size cap is the outermost guard.
    const r = registry(["WORKSPACE_WRITE"], { maxArgumentBytes: 100 }).register(writeishTool);
    const result = await r.execute({ name: "writeish", arguments: { wrong: "y".repeat(500) } });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/limit is 100/);
  });
});

describe("ToolRegistry — rate limiting", () => {
  it("limits a network tool and lets a non-network tool through", async () => {
    const limiter = new KeyedRateLimiter({ capacity: 1, refillPerSecond: 0.0001 });
    const r = registry(["NETWORK_ACCESS", "READ_ONLY"], { rateLimiter: limiter })
      .register(netTool)
      .register(readishTool);

    expect((await r.execute({ name: "netish", arguments: {} })).ok).toBe(true);
    const second = await r.execute({ name: "netish", arguments: {} });
    expect(second.ok).toBe(false);
    expect(second.observation).toMatch(/Rate limit/);
    // The read tool shares nothing with the network bucket.
    expect((await r.execute({ name: "readish", arguments: {} })).ok).toBe(true);
  });

  it("keeps a separate bucket per tool", async () => {
    const limiter = new KeyedRateLimiter({ capacity: 1, refillPerSecond: 0.0001 });
    const r = registry(["NETWORK_ACCESS"], { rateLimiter: limiter })
      .register(netTool)
      .register(
        defineTool({
          name: "netish2",
          description: "another network tool",
          inputSchema: z.object({}),
          requiredPermissions: ["NETWORK_ACCESS"] as const,
          async execute() {
            return { ok: true, output: "fetched" };
          },
        }),
      );
    expect((await r.execute({ name: "netish", arguments: {} })).ok).toBe(true);
    expect((await r.execute({ name: "netish2", arguments: {} })).ok).toBe(true);
    expect((await r.execute({ name: "netish", arguments: {} })).ok).toBe(false);
  });

  it("with no limiter configured, network calls are unbounded", async () => {
    const r = registry(["NETWORK_ACCESS"]).register(netTool);
    for (let i = 0; i < 5; i++) {
      expect((await r.execute({ name: "netish", arguments: {} })).ok).toBe(true);
    }
  });
});
