import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "../../src/core/agent/AgentLoop.js";
import { Planner } from "../../src/core/planner/Planner.js";
import { CommandVerifier } from "../../src/providers/execution/CommandVerifier.js";
import { LocalExecutionProvider } from "../../src/providers/execution/LocalExecutionProvider.js";
import { CommandValidator } from "../../src/security/CommandValidator.js";
import { PermissionManager } from "../../src/security/PermissionManager.js";
import { PathValidator } from "../../src/security/PathValidator.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";
import { writeFileTool } from "../../src/tools/filesystem/WriteFileTool.js";
import { silentLogger } from "../../src/observability/Logger.js";
import { ScriptedLLM, finalTurn, toolTurn } from "../unit/helpers.js";

/**
 * End-to-end verification against a **real** `node --test` process, real
 * files, and a real exit code. No part of the verdict is scripted: the loop's
 * decision to accept or repair comes from the process, which is the whole
 * point of the external-signal design (ADR 001).
 */

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "aurora-verify-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function verifier(opts: { permissions?: Parameters<PermissionManager["has"]>[0][] } = {}) {
  return new CommandVerifier({
    command: "node --test",
    execution: new LocalExecutionProvider(),
    commandValidator: new CommandValidator({ allowed: ["node"] }),
    permissions: new PermissionManager(opts.permissions ?? ["COMMAND_EXECUTION"]),
    cwd: workspace,
    timeoutMs: 20_000,
    logger: silentLogger,
  });
}

/** A real ToolRegistry with only the write tool, for the loop-level tests. */
function writeTools() {
  return new ToolRegistry({
    permissions: new PermissionManager(["READ_ONLY", "WORKSPACE_WRITE"]),
    workspace,
    pathValidator: new PathValidator([workspace]),
    commandValidator: new CommandValidator({ allowed: ["node"] }),
    execution: new LocalExecutionProvider(),
    logger: silentLogger,
  }).register(writeFileTool);
}

function makeLoop(llm: ScriptedLLM, maxVerifications: number) {
  return new AgentLoop({
    llm,
    planner: new Planner(),
    tools: writeTools(),
    verifier: verifier(),
    limits: { maxIterations: 10, maxToolCalls: 10, timeoutMs: 60_000, maxVerifications },
    logger: silentLogger,
  });
}

describe("CommandVerifier against a real process", () => {
  it("passes on a green suite (exit 0)", async () => {
    await writeFile(
      join(workspace, "a.test.mjs"),
      `import { test } from "node:test";\nimport assert from "node:assert";\ntest("ok", () => assert.equal(1, 1));\n`,
    );
    const outcome = await verifier().verify();
    expect(outcome.kind).toBe("pass");
    expect(outcome.observation).toMatch(/exit code: 0/);
  });

  it("fails on a red suite (exit 1) and carries the failure as evidence", async () => {
    await writeFile(
      join(workspace, "b.test.mjs"),
      `import { test } from "node:test";\nimport assert from "node:assert";\ntest("bad", () => assert.equal(1, 2));\n`,
    );
    const outcome = await verifier().verify();
    expect(outcome.kind).toBe("fail");
    expect(outcome.evidence?.exitCode).toBe(1);
    expect(outcome.observation).toMatch(/1 !== 2|not ok|fail/i);
  });

  it("fails a vacuous run: node --test exits 0 with no test files", async () => {
    // Verified on Node v24.21.0: `node --test` prints pass 0 / fail 0 and exits
    // 0 when its glob matches nothing. A verifier that trusted the exit code
    // alone would rubber-stamp an empty run, so this must be a failure.
    const outcome = await verifier().verify();
    expect(outcome.kind).toBe("fail");
    expect(outcome.evidence?.exitCode).toBe(0);
    expect(outcome.observation).toMatch(/ran no tests/);
  });

  it("fails on a syntax error", async () => {
    await writeFile(join(workspace, "c.test.mjs"), "this is not javascript(((\n");
    const outcome = await verifier().verify();
    expect(outcome.kind).toBe("fail");
  });

  it("skips — not passes — when COMMAND_EXECUTION is not granted", async () => {
    await writeFile(
      join(workspace, "d.test.mjs"),
      `import { test } from "node:test";\ntest("ok", () => {});\n`,
    );
    const outcome = await verifier({ permissions: ["READ_ONLY"] }).verify();
    expect(outcome.kind).toBe("skipped");
    expect(outcome.reason).toMatch(/COMMAND_EXECUTION/);
    expect(outcome.observation).toMatch(/UNVERIFIED/);
  });

  it("skips when the command is not allowed by policy", async () => {
    const blocked = new CommandVerifier({
      command: "rm -rf /",
      execution: new LocalExecutionProvider(),
      commandValidator: new CommandValidator({ allowed: ["node"] }),
      permissions: new PermissionManager(["COMMAND_EXECUTION"]),
      cwd: workspace,
      timeoutMs: 5_000,
      logger: silentLogger,
    });
    const outcome = await blocked.verify();
    expect(outcome.kind).toBe("skipped");
    expect(outcome.reason).toMatch(/rejected/);
  });
});

describe("AgentLoop ↔ real verifier", () => {
  it("rejects a bogus completion and repairs it into a green suite", async () => {
    // 1st edit writes a suite that fails; the verifier rejects completion.
    // 2nd edit overwrites it with a green one; the verifier passes.
    const llm = new ScriptedLLM([
      toolTurn("write_file", {
        path: "x.test.mjs",
        content: `import { test } from "node:test";\nimport assert from "node:assert";\ntest("bad", () => assert.equal(1, 2));\n`,
      }),
      finalTurn("I wrote the test"),
      toolTurn("write_file", {
        path: "x.test.mjs",
        content: `import { test } from "node:test";\nimport assert from "node:assert";\ntest("ok", () => assert.equal(1, 1));\n`,
      }),
      finalTurn("Fixed"),
    ]);

    const result = await makeLoop(llm, 3).run("write a passing test");

    expect(result.status).toBe("completed");
    expect(result.verifications).toBe(2);
    expect(result.lastVerification?.kind).toBe("pass");
    // The rejection must have been fed back to the model.
    expect(
      llm.calls.some((c) => JSON.stringify(c.messages).includes("EXTERNAL VERIFICATION FAILED")),
    ).toBe(true);
  });

  it("escalates instead of claiming success when the suite never goes green", async () => {
    const red = () =>
      toolTurn("write_file", {
        path: "y.test.mjs",
        content: `import { test } from "node:test";\nimport assert from "node:assert";\ntest("bad", () => assert.equal(1, 2));\n`,
      });
    const llm = new ScriptedLLM([red(), finalTurn("done"), red(), finalTurn("again"), red()]);

    const result = await makeLoop(llm, 2).run("make tests pass");

    expect(result.status).toBe("max_verifications");
    expect(result.error).toMatch(/budget exhausted/i);
  });
});
