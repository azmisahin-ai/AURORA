import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import pino from "pino";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";
import { runCommandTool } from "../../src/tools/execution/RunCommandTool.js";
import { webFetchTool } from "../../src/tools/web/WebFetchTool.js";
import { writeFileTool } from "../../src/tools/filesystem/WriteFileTool.js";
import { PermissionManager } from "../../src/security/PermissionManager.js";
import { PathValidator } from "../../src/security/PathValidator.js";
import { CommandValidator } from "../../src/security/CommandValidator.js";
import { UrlValidator } from "../../src/security/UrlValidator.js";
import { DirectFetcher } from "../../src/providers/web/DirectFetcher.js";
import { LocalExecutionProvider } from "../../src/providers/execution/LocalExecutionProvider.js";
import { DenyAllGate } from "../../src/security/ConfirmationGate.js";
import { KeyedRateLimiter } from "../../src/security/RateLimiter.js";
import { SecretRedactor } from "../../src/security/SecretRedactor.js";

/**
 * Integration: the Phase 8 controls (command allowlist, SSRF guard, confirmation
 * gate, rate limit, log redaction) exercised through the *real* registry, the
 * real validators, a real child process, a real pino logger and a real HTTP
 * server. No module under test is mocked; the only stand-in is the interactive
 * prompt, which is an injected function by design.
 */

let workspace: string;
let root: string;
let logLines: string[];
let logger: pino.Logger;
let serverClosed: () => Promise<void>;
let serverPort = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aurora-hardening-int-"));
  workspace = join(root, "workspace");

  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  serverPort = address.port;
  serverClosed = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await serverClosed();
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function build(
  granted: Parameters<PermissionManager["has"]>[0][],
  opts: {
    gate?: DenyAllGate;
    rateLimiter?: KeyedRateLimiter;
    redactor?: SecretRedactor;
  } = {},
) {
  return new ToolRegistry({
    permissions: new PermissionManager(granted),
    workspace,
    pathValidator: new PathValidator([workspace]),
    commandValidator: new CommandValidator({
      allowed: ["echo", "npm", "node"],
      blocked: ["rm", "curl"],
    }),
    execution: new LocalExecutionProvider(),
    logger,
    ...(opts.gate !== undefined ? { confirmationGate: opts.gate } : {}),
    ...(opts.rateLimiter !== undefined ? { rateLimiter: opts.rateLimiter } : {}),
    ...(opts.redactor !== undefined ? { redactor: opts.redactor } : {}),
  });
}

function setupLogger() {
  logLines = [];
  const stream = new PassThrough();
  stream.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) logLines.push(line);
  });
  logger = pino({ level: "debug" }, stream);
}

describe("command execution is allowlisted end to end", () => {
  it("runs an allowlisted command in a real child process", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace, { recursive: true });
    setupLogger();
    const registry = build(["COMMAND_EXECUTION"]).register(runCommandTool);
    const result = await registry.execute({
      name: "run_command",
      arguments: { command: "echo hello-hardening" },
    });
    expect(result.ok).toBe(true);
    expect(result.observation).toContain("hello-hardening");
  });

  it("refuses a shell-chained command and records the refusal", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace, { recursive: true });
    setupLogger();
    const registry = build(["COMMAND_EXECUTION"]).register(runCommandTool);
    const result = await registry.execute({
      name: "run_command",
      arguments: { command: "echo hi; rm -rf /" },
    });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/rejected/i);
    expect(logLines.join("\n")).toContain("command rejected");
  });

  it("refuses a blocked binary even when it is not on the allowlist", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace, { recursive: true });
    setupLogger();
    const registry = build(["COMMAND_EXECUTION"]).register(runCommandTool);
    const result = await registry.execute({
      name: "run_command",
      arguments: { command: "curl http://example.com" },
    });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/rejected/i);
  });
});

describe("SSRF guard is enforced through the registry", () => {
  it("refuses the cloud metadata address", async () => {
    setupLogger();
    const registry = build(["NETWORK_ACCESS"]).register(
      webFetchTool(new DirectFetcher(new UrlValidator())),
    );
    const result = await registry.execute({
      name: "web_fetch",
      arguments: { url: "http://169.254.169.254/latest/meta-data/" },
    });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/routable|blocked/i);
  });

  it("refuses a file:// URL", async () => {
    setupLogger();
    const registry = build(["NETWORK_ACCESS"]).register(
      webFetchTool(new DirectFetcher(new UrlValidator())),
    );
    const result = await registry.execute({
      name: "web_fetch",
      arguments: { url: "file:///etc/passwd" },
    });
    expect(result.ok).toBe(false);
  });

  it("refuses localhost in production configuration", async () => {
    setupLogger();
    const registry = build(["NETWORK_ACCESS"]).register(
      webFetchTool(new DirectFetcher(new UrlValidator())),
    );
    const result = await registry.execute({
      name: "web_fetch",
      arguments: { url: "http://localhost:11434/api/tags" },
    });
    expect(result.ok).toBe(false);
  });
});

describe("confirmation gate refuses state-changing tools", () => {
  it("does not write when a deny-all gate is installed", async () => {
    setupLogger();
    const registry = build(["WORKSPACE_WRITE"], { gate: new DenyAllGate() }).register(writeFileTool);
    const result = await registry.execute({
      name: "write_file",
      arguments: { path: "denied.txt", content: "nope" },
    });
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/denied/i);

    const { readFile } = await import("node:fs/promises");
    await expect(readFile(join(workspace, "denied.txt"), "utf8")).rejects.toThrow();
  });
});

describe("rate limiting bounds a looping network tool", () => {
  it("denies the (capacity+1)th network call and logs it", async () => {
    setupLogger();
    const limiter = new KeyedRateLimiter({ capacity: 2, refillPerSecond: 0.0001 });
    const registry = build(["NETWORK_ACCESS"], { rateLimiter: limiter }).register(
      webFetchTool(
        new DirectFetcher(new UrlValidator({ allowPrivate: true }), {
          allowPrivate: true,
          pinConnections: false,
        }),
      ),
    );
    const port = serverPort;
    const url = `http://127.0.0.1:${port}/`;

    expect((await registry.execute({ name: "web_fetch", arguments: { url } })).ok).toBe(true);
    expect((await registry.execute({ name: "web_fetch", arguments: { url } })).ok).toBe(true);
    const third = await registry.execute({ name: "web_fetch", arguments: { url } });
    expect(third.ok).toBe(false);
    expect(third.observation).toMatch(/Rate limit/);
    expect(logLines.join("\n")).toContain("rate-limited");
  });
});

describe("secrets are redacted from registered log events", () => {
  it("scrubs a credential from a logged tool denial", async () => {
    setupLogger();
    const registry = build(["READ_ONLY"], { redactor: new SecretRedactor() }).register(
      writeFileTool,
    );
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    await registry.execute({
      name: "write_file",
      arguments: { path: "x.txt", content: `key=${secret}` },
    });
    const log = logLines.join("\n");
    expect(log).not.toContain(secret);
  });
});
