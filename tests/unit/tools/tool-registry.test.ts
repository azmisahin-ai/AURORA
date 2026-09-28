import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "aurora-reg-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const echoTool = defineTool({
  name: "echo_tool",
  description: "Echoes its input",
  inputSchema: z.object({ value: z.string() }),
  requiredPermissions: ["READ_ONLY"] as const,
  async execute(input) {
    return { ok: true, output: input.value };
  },
});

const writeishTool = defineTool({
  name: "writeish",
  description: "Needs write access",
  inputSchema: z.object({}),
  requiredPermissions: ["WORKSPACE_WRITE"] as const,
  async execute() {
    return { ok: true, output: "wrote" };
  },
});

const throwingTool = defineTool({
  name: "thrower",
  description: "Always throws",
  inputSchema: z.object({}),
  requiredPermissions: [] as const,
  async execute() {
    throw new Error("kaboom");
  },
});

function registry(granted: Parameters<typeof PermissionManager.prototype.has>[0][]) {
  return new ToolRegistry({
    permissions: new PermissionManager(granted),
    workspace,
    pathValidator: new PathValidator([workspace]),
    commandValidator: new CommandValidator({ allowed: ["echo"] }),
    execution: new LocalExecutionProvider(),
    logger: silentLogger,
  });
}

describe("ToolRegistry registration", () => {
  it("registers and finds tools", () => {
    const r = registry(["READ_ONLY"]).register(echoTool);
    expect(r.has("echo_tool")).toBe(true);
    expect(r.get("echo_tool")?.name).toBe("echo_tool");
    expect(r.list()).toHaveLength(1);
  });

  it("rejects duplicate names", () => {
    const r = registry(["READ_ONLY"]).register(echoTool);
    expect(() => r.register(echoTool)).toThrow(/already registered/);
  });

  it("rejects invalid names", () => {
    const bad = { ...echoTool, name: "bad name!" };
    expect(() => registry(["READ_ONLY"]).register(bad)).toThrow(/Invalid tool name/);
  });

  it("reports unknown tools", () => {
    expect(registry(["READ_ONLY"]).has("nope")).toBe(false);
  });
});

describe("ToolRegistry.definitions", () => {
  it("offers permitted tools with a JSON Schema", () => {
    const r = registry(["READ_ONLY"]).register(echoTool).register(writeishTool);
    const defs = r.definitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe("echo_tool");
    const schema = defs[0]?.parameters as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect((schema.properties as Record<string, unknown>).value).toBeDefined();
  });

  it("hides tools whose permissions are not granted", () => {
    const r = registry([]).register(echoTool).register(writeishTool);
    expect(r.definitions()).toHaveLength(0);
  });

  it("exposes all tools under FULL_ACCESS", () => {
    const r = registry(["FULL_ACCESS"]).register(echoTool).register(writeishTool);
    expect(r.definitions().map((d) => d.name).sort()).toEqual(["echo_tool", "writeish"]);
  });
});

describe("ToolRegistry.execute — permission gate", () => {
  it("denies a tool whose permissions are missing and says which", async () => {
    const r = registry(["READ_ONLY"]).register(writeishTool);
    const result = await r.execute({ name: "writeish", arguments: {} });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/Permission denied/);
    expect(result.observation).toMatch(/WORKSPACE_WRITE/);
  });

  it("allows the tool once the permission is granted", async () => {
    const r = registry(["WORKSPACE_WRITE"]).register(writeishTool);
    const result = await r.execute({ name: "writeish", arguments: {} });
    expect(result.ok).toBe(true);
    expect(result.observation).toBe("wrote");
  });

  it("does not execute a denied tool", async () => {
    let ran = false;
    const spy = defineTool({
      name: "spy",
      description: "records execution",
      inputSchema: z.object({}),
      requiredPermissions: ["COMMAND_EXECUTION"] as const,
      async execute() {
        ran = true;
        return { ok: true, output: "ran" };
      },
    });
    const r = registry(["READ_ONLY"]).register(spy);
    await r.execute({ name: "spy", arguments: {} });
    expect(ran).toBe(false);
  });

  it("reports missingPermissions for a tool", () => {
    const r = registry(["READ_ONLY"]).register(writeishTool);
    expect(r.missingPermissions("writeish")).toEqual(["WORKSPACE_WRITE"]);
    expect(r.missingPermissions("echo_tool")).toEqual([]);
  });
});

describe("ToolRegistry.execute — validation and errors", () => {
  it("rejects arguments that fail the schema, without executing", async () => {
    const r = registry(["READ_ONLY"]).register(echoTool);
    const result = await r.execute({ name: "echo_tool", arguments: { value: 42 } });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/Invalid arguments/);
  });

  it("converts a thrown tool error into a non-fatal observation", async () => {
    const r = registry([]).register(throwingTool);
    const result = await r.execute({ name: "thrower", arguments: {} });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/kaboom/);
    expect(result.fatal).toBeUndefined();
  });

  it("reports an unknown tool call", async () => {
    const r = registry(["READ_ONLY"]);
    const result = await r.execute({ name: "ghost", arguments: {} });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/Unknown tool "ghost"/);
  });

  it("passes the workspace and validators to the tool", async () => {
    let seenWorkspace = "";
    const inspector = defineTool({
      name: "inspect",
      description: "captures context",
      inputSchema: z.object({}),
      requiredPermissions: [] as const,
      async execute(_input, ctx) {
        seenWorkspace = ctx.workspace;
        return { ok: true, output: ctx.workspace };
      },
    });
    const r = registry([]).register(inspector);
    await r.execute({ name: "inspect", arguments: {} });
    expect(seenWorkspace).toBe(workspace);
  });
});

describe("filesystem tools via registry (round-trip)", () => {
  it("writes a file then reads it back", async () => {
    const { writeFileTool } = await import("../../../src/tools/filesystem/WriteFileTool.js");
    const { readFileTool } = await import("../../../src/tools/filesystem/ReadFileTool.js");
    const r = registry(["READ_ONLY", "WORKSPACE_WRITE"])
      .register(writeFileTool)
      .register(readFileTool);

    const write = await r.execute({
      name: "write_file",
      arguments: { path: "notes/todo.txt", content: "hello aurora" },
    });
    expect(write.ok).toBe(true);

    const read = await r.execute({
      name: "read_file",
      arguments: { path: "notes/todo.txt" },
    });
    expect(read.ok).toBe(true);
    expect(read.observation).toBe("hello aurora");
  });

  it("refuses to write outside the workspace", async () => {
    const { writeFileTool } = await import("../../../src/tools/filesystem/WriteFileTool.js");
    const r = registry(["WORKSPACE_WRITE"]).register(writeFileTool);
    const result = await r.execute({
      name: "write_file",
      arguments: { path: "../../escaped.txt", content: "nope" },
    });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/escapes the allowed roots/);
  });

  it("lists files recursively and skips node_modules", async () => {
    const { listFilesTool } = await import("../../../src/tools/filesystem/ListFilesTool.js");
    await mkdir(join(workspace, "node_modules"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "junk.js"), "x");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "a.ts"), "a");
    const r = registry(["READ_ONLY"]).register(listFilesTool);
    const result = await r.execute({
      name: "list_files",
      arguments: { path: ".", recursive: true },
    });
    expect(result.ok).toBe(true);
    expect(result.observation).toMatch(/src\/a\.ts/);
    expect(result.observation).not.toMatch(/node_modules/);
  });
});

describe("run_command tool via registry", () => {
  it("runs an allowlisted command and captures stdout", async () => {
    const { runCommandTool } = await import("../../../src/tools/execution/RunCommandTool.js");
    const r = registry(["COMMAND_EXECUTION"]).register(runCommandTool);
    const result = await r.execute({
      name: "run_command",
      arguments: { command: "echo hello-aurora" },
    });
    expect(result.ok).toBe(true);
    expect(result.observation).toMatch(/hello-aurora/);
    expect(result.observation).toMatch(/exit code: 0/);
  });

  it("rejects a malicious command without executing it", async () => {
    const { runCommandTool } = await import("../../../src/tools/execution/RunCommandTool.js");
    const r = registry(["COMMAND_EXECUTION"]).register(runCommandTool);
    const result = await r.execute({
      name: "run_command",
      arguments: { command: "echo hi; rm -rf /" },
    });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/Command rejected/);
  });

  it("rejects a non-allowlisted command", async () => {
    const { runCommandTool } = await import("../../../src/tools/execution/RunCommandTool.js");
    const r = registry(["COMMAND_EXECUTION"]).register(runCommandTool);
    const result = await r.execute({
      name: "run_command",
      arguments: { command: "whoami" },
    });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/not on the allowed list/);
  });
});
