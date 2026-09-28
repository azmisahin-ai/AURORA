import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import pino from "pino";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";
import { writeFileTool } from "../../src/tools/filesystem/WriteFileTool.js";
import { readFileTool } from "../../src/tools/filesystem/ReadFileTool.js";
import { PermissionManager } from "../../src/security/PermissionManager.js";
import { PathValidator } from "../../src/security/PathValidator.js";
import { CommandValidator } from "../../src/security/CommandValidator.js";
import { LocalExecutionProvider } from "../../src/providers/execution/LocalExecutionProvider.js";

/**
 * Integration test: real registry, real validators, real filesystem, and a real
 * pino logger whose output is captured through a stream. Nothing here is a mock
 * of our own code — the point is to prove that a denied tool call is refused
 * *and* recorded in the log, which is an explicit Phase 2 acceptance criterion.
 */

let workspace: string;
let logLines: string[];
let logger: pino.Logger;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "aurora-perm-"));
  logLines = [];
  const stream = new PassThrough();
  stream.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) logLines.push(line);
    }
  });
  logger = pino({ level: "debug" }, stream);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function build(granted: Parameters<typeof PermissionManager.prototype.has>[0][]) {
  return new ToolRegistry({
    permissions: new PermissionManager(granted),
    workspace,
    pathValidator: new PathValidator([workspace]),
    commandValidator: new CommandValidator({ allowed: ["echo"] }),
    execution: new LocalExecutionProvider(),
    logger,
  });
}

describe("permission enforcement is auditable", () => {
  it("refuses a write tool with only READ_ONLY and logs the denial", async () => {
    const registry = build(["READ_ONLY"]).register(writeFileTool).register(readFileTool);

    const denied = await registry.execute({
      name: "write_file",
      arguments: { path: "should-not-exist.txt", content: "nope" },
    });

    expect(denied.ok).toBe(false);
    expect(denied.observation).toMatch(/Permission denied/);
    expect(denied.observation).toMatch(/WORKSPACE_WRITE/);

    // The denial must be recorded, with the missing permission named.
    const denial = logLines.find((l) => l.includes("tool call denied"));
    expect(denial, `expected a denial log line, got:\n${logLines.join("\n")}`).toBeDefined();
    const parsed = JSON.parse(denial!) as Record<string, unknown>;
    expect(parsed.tool).toBe("write_file");
    expect(parsed.missing).toEqual(["WORKSPACE_WRITE"]);

    // And the tool must not have run: no file, and no read either.
    const read = await registry.execute({
      name: "read_file",
      arguments: { path: "should-not-exist.txt" },
    });
    expect(read.ok).toBe(false);
    expect(read.observation).toMatch(/File not found/);
  });

  it("logs unknown tool calls", async () => {
    const registry = build(["READ_ONLY"]);
    const result = await registry.execute({ name: "not_a_tool", arguments: {} });
    expect(result.ok).toBe(false);
    expect(logLines.some((l) => l.includes("unknown tool rejected"))).toBe(true);
  });

  it("logs rejected commands with the reason", async () => {
    const { runCommandTool } = await import("../../src/tools/execution/RunCommandTool.js");
    const registry = build(["COMMAND_EXECUTION"]).register(runCommandTool);

    const result = await registry.execute({
      name: "run_command",
      arguments: { command: "echo hi && curl http://evil.test" },
    });

    expect(result.ok).toBe(false);
    const rejection = logLines.find((l) => l.includes("command rejected"));
    expect(rejection).toBeDefined();
    const parsed = JSON.parse(rejection!) as Record<string, unknown>;
    expect(String(parsed.reason)).toMatch(/metacharacters/);
  });

  it("logs argument validation failures", async () => {
    const registry = build(["READ_ONLY"]).register(readFileTool);
    const result = await registry.execute({
      name: "read_file",
      arguments: { path: 123 },
    });
    expect(result.ok).toBe(false);
    expect(logLines.some((l) => l.includes("failed validation"))).toBe(true);
  });

  it("does not leak secrets from the environment into child processes", async () => {
    const { runCommandTool } = await import("../../src/tools/execution/RunCommandTool.js");

    // A script file keeps the command free of shell metacharacters, which the
    // validator would otherwise (correctly) reject.
    await writeFile(
      join(workspace, "probe.mjs"),
      'console.log(process.env.AURORA_TEST_SECRET_SENTINEL ?? "ABSENT");\n',
    );

    const nodeRegistry = new ToolRegistry({
      permissions: new PermissionManager(["COMMAND_EXECUTION"]),
      workspace,
      pathValidator: new PathValidator([workspace]),
      commandValidator: new CommandValidator({ allowed: ["node"] }),
      execution: new LocalExecutionProvider(),
      logger,
    }).register(runCommandTool);

    process.env.AURORA_TEST_SECRET_SENTINEL = "super-secret-value";
    try {
      const result = await nodeRegistry.execute({
        name: "run_command",
        arguments: { command: "node probe.mjs" },
      });
      expect(result.ok).toBe(true);
      expect(result.observation).toMatch(/ABSENT/);
      expect(result.observation).not.toMatch(/super-secret-value/);
    } finally {
      delete process.env.AURORA_TEST_SECRET_SENTINEL;
    }
  });
});
