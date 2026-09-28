import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRegistry } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config/Config.js";
import { silentLogger } from "../../src/observability/Logger.js";
import { AGENT_ROLES } from "../../src/core/agent/roles/index.js";
import type { SubAgentManagerPort } from "../../src/core/agent/subagent/index.js";
import type { Permission } from "../../src/security/PermissionManager.js";

/**
 * Integration: the real registry builder, real validators, real permission
 * manager. The point is that least privilege is enforced *structurally* — by
 * which tools exist in a role's registry — not by a check the model could
 * talk its way past.
 */

let workspace: string;
let knowledgeDir: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "aurora-role-reg-"));
  knowledgeDir = await mkdtemp(join(tmpdir(), "aurora-role-know-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(knowledgeDir, { recursive: true, force: true });
});

const fakeManager: SubAgentManagerPort = {
  remaining: () => 1,
  async run() {
    throw new Error("not called in this test");
  },
};

function build(granted?: readonly Permission[], withManager = true) {
  return buildToolRegistry({
    config: loadConfig({ AURORA_KNOWLEDGE_DIR: knowledgeDir }),
    logger: silentLogger,
    workspace,
    ...(granted ? { permissions: granted } : {}),
    ...(withManager ? { subAgentManager: fakeManager } : {}),
  });
}

describe("role toolsets are least-privilege by construction", () => {
  it("offers `delegate` to the parent but never to a sub-agent", () => {
    const built = build();
    expect(built.registry.has("delegate")).toBe(true);

    for (const role of AGENT_ROLES) {
      const { tools } = built.roleToolsetBuilder.build(role);
      // The tool does not exist in a role registry — not merely denied.
      expect(tools.has("delegate")).toBe(false);
    }
  });

  it("omits `delegate` from the parent when no manager is supplied", () => {
    const built = build(undefined, false);
    expect(built.registry.has("delegate")).toBe(false);
  });

  it("gives the reviewer no write tool at all", () => {
    const { tools, permissions } = build().roleToolsetBuilder.build("reviewer");
    expect(permissions).not.toContain("WORKSPACE_WRITE");
    expect(tools.has("write_file")).toBe(false);
    expect(tools.has("read_file")).toBe(true);
  });

  it("gives the coder a write tool", () => {
    const { tools } = build().roleToolsetBuilder.build("coder");
    expect(tools.has("write_file")).toBe(true);
  });

  it("never lets a role exceed the parent's grant", () => {
    // Parent granted read-only. The coder role *would* like WORKSPACE_WRITE,
    // but it cannot exceed what the run was given.
    const built = build(["READ_ONLY"]);
    const { tools, permissions } = built.roleToolsetBuilder.build("coder");
    expect(permissions).toEqual(["READ_ONLY"]);
    expect(tools.has("write_file")).toBe(false);
    expect(tools.has("read_file")).toBe(true);
  });

  it("does not propagate FULL_ACCESS into any role", () => {
    const built = build(["FULL_ACCESS"]);
    for (const role of AGENT_ROLES) {
      const { permissions } = built.roleToolsetBuilder.build(role);
      expect(permissions).not.toContain("FULL_ACCESS");
    }
  });

  it("drops a role tool the role's own permission cap cannot afford", () => {
    // The documenter lists write_file and is capped at WORKSPACE_WRITE, so the
    // tool is offered. A researcher lists knowledge_write and may write — but
    // if the parent withheld WORKSPACE_WRITE, the tool must be gone rather than
    // offered and then denied at call time.
    const built = build(["READ_ONLY", "NETWORK_ACCESS"]);
    const { tools } = built.roleToolsetBuilder.build("researcher");
    expect(tools.has("knowledge_write")).toBe(false);
    expect(tools.has("web_fetch")).toBe(true);
  });

  it("only offers `run_tests` when a test command is configured", () => {
    const without = build();
    expect(without.roleToolsetBuilder.build("tester").tools.has("run_tests")).toBe(false);

    const withTests = buildToolRegistry({
      config: loadConfig({
        AURORA_KNOWLEDGE_DIR: knowledgeDir,
        AURORA_TEST_COMMAND: "node --test",
      }),
      logger: silentLogger,
      workspace,
    });
    expect(withTests.roleToolsetBuilder.build("tester").tools.has("run_tests")).toBe(true);
    // And the researcher, whose role does not list it, still does not get it.
    expect(withTests.roleToolsetBuilder.build("researcher").tools.has("run_tests")).toBe(false);
  });

  it("every role's offered tools satisfy that role's granted permissions", () => {
    const built = build();
    for (const role of AGENT_ROLES) {
      const { tools, permissions } = built.roleToolsetBuilder.build(role);
      const granted = new Set([...permissions, "FULL_ACCESS"]);
      for (const tool of tools.list()) {
        for (const required of tool.requiredPermissions) {
          expect(
            granted.has(required),
            `role "${role}" offers tool "${tool.name}" requiring ${required} without granting it`,
          ).toBe(true);
        }
      }
    }
  });
});
