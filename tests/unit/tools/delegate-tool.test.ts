import { describe, expect, it } from "vitest";
import { delegateTool } from "../../../src/tools/agent/DelegateTool.js";
import type {
  SubAgentManagerPort,
  SubAgentResult,
} from "../../../src/core/agent/subagent/index.js";
import type { ToolContext } from "../../../src/tools/types.js";
import { silentLogger } from "../../../src/observability/Logger.js";
import { PathValidator } from "../../../src/security/PathValidator.js";
import { CommandValidator } from "../../../src/security/CommandValidator.js";
import { LocalExecutionProvider } from "../../../src/providers/execution/LocalExecutionProvider.js";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * A scripted manager. Doubles the sub-agent boundary (a real manager runs a
 * whole loop); the `SubAgentManagerPort` interface is the real one.
 */
class ScriptedManager implements SubAgentManagerPort {
  readonly requests: Array<{ role: string; task: string }> = [];
  constructor(private readonly result: Partial<SubAgentResult>) {}
  remaining() {
    return 1;
  }
  async run(request: { role: string; task: string }): Promise<SubAgentResult> {
    this.requests.push(request);
    return {
      role: request.role as SubAgentResult["role"],
      status: "completed",
      output: "sub-agent answer",
      iterations: 3,
      toolCalls: 2,
      mutatedWorkspace: false,
      ...this.result,
    };
  }
}

async function ctx(): Promise<{ ctx: ToolContext; cleanup: () => Promise<void> }> {
  const workspace = await mkdtemp(join(tmpdir(), "aurora-delegate-"));
  return {
    ctx: {
      workspace,
      pathValidator: new PathValidator([workspace]),
      commandValidator: new CommandValidator({ allowed: ["node"] }),
      execution: new LocalExecutionProvider(),
      logger: silentLogger,
      signal: new AbortController().signal,
    },
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  };
}

describe("delegate tool", () => {
  it("offers no permission of its own and is not declared as mutating", () => {
    const tool = delegateTool(new ScriptedManager({}));
    // Delegation touches nothing itself; the sub-agent's tools are checked in
    // their own registry. Declaring a mutation here would make the parent
    // verify even a read-only research delegation.
    expect(tool.requiredPermissions).toEqual([]);
    expect(tool.mutatesWorkspace).toBeUndefined();
  });

  it("exposes the role list to the model in its description", () => {
    const tool = delegateTool(new ScriptedManager({}));
    for (const role of ["researcher", "coder", "tester", "reviewer", "documenter"]) {
      expect(tool.description).toContain(role);
    }
  });

  it("passes the role and task through and wraps the answer as untrusted", async () => {
    const manager = new ScriptedManager({ output: "the answer" });
    const tool = delegateTool(manager);
    const { ctx: c, cleanup } = await ctx();
    try {
      const out = await tool.execute({ role: "researcher", task: "find X" }, c);
      expect(out.ok).toBe(true);
      expect(manager.requests).toEqual([{ role: "researcher", task: "find X" }]);
      expect(out.output).toMatch(/sub-agent: researcher/);
      // A sub-agent's answer routinely quotes fetched pages, so it sits on the
      // untrusted side of the boundary like the content it summarises.
      expect(out.output).toMatch(/UNTRUSTED DATA/);
      expect(out.output).toMatch(/the answer/);
    } finally {
      await cleanup();
    }
  });

  it("reports a delegated workspace mutation so the parent verifier is not skipped", async () => {
    const manager = new ScriptedManager({ mutatedWorkspace: true });
    const tool = delegateTool(manager);
    const { ctx: c, cleanup } = await ctx();
    try {
      const out = await tool.execute({ role: "coder", task: "write" }, c);
      expect(out.mutatedWorkspace).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("marks a failed sub-agent run as not ok and surfaces its error", async () => {
    const manager = new ScriptedManager({ status: "max_iterations", error: "ran out" });
    const tool = delegateTool(manager);
    const { ctx: c, cleanup } = await ctx();
    try {
      const out = await tool.execute({ role: "coder", task: "loop" }, c);
      expect(out.ok).toBe(false);
      expect(out.output).toMatch(/status: max_iterations/);
      expect(out.output).toMatch(/error: ran out/);
    } finally {
      await cleanup();
    }
  });

  it("validates the role against the fixed set", async () => {
    const tool = delegateTool(new ScriptedManager({}));
    const parsed = tool.inputSchema.safeParse({ role: "hacker", task: "x" });
    expect(parsed.success).toBe(false);
  });

  it("requires a non-empty task", async () => {
    const tool = delegateTool(new ScriptedManager({}));
    expect(tool.inputSchema.safeParse({ role: "coder", task: "" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ role: "coder", task: "ok" }).success).toBe(true);
  });
});
