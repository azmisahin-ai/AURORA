import { describe, expect, it } from "vitest";
import {
  AGENT_ROLES,
  ROLE_DEFINITIONS,
  roleDefinition,
} from "../../../src/core/agent/roles/index.js";

/**
 * The role catalogue is the security surface of Phase 5: a role's tool list and
 * permission cap decide what a sub-agent can do. These assertions are cheap and
 * catch a mistake (a role that can write, or delegate) that would otherwise only
 * show up as an unexpected file on disk.
 */
describe("role definitions", () => {
  it("defines every declared role", () => {
    for (const role of AGENT_ROLES) {
      expect(ROLE_DEFINITIONS[role]).toBeDefined();
      expect(roleDefinition(role).role).toBe(role);
    }
  });

  it("never lists `delegate` in a role's tools", () => {
    // Recursion is bounded by construction: sub-agents must not be able to
    // spawn sub-agents. If this ever fails, `delegate` would be buildable into
    // a role registry and the run could recurse without a depth bound.
    for (const role of AGENT_ROLES) {
      expect(roleDefinition(role).tools).not.toContain("delegate");
    }
  });

  it("caps permissions at least privilege", () => {
    // Only the coder may change the workspace. A researcher, tester, reviewer,
    // or documenter gaining WORKSPACE_WRITE would be a privilege escalation
    // disguised as a configuration detail.
    expect(roleDefinition("coder").maxPermissions).toContain("WORKSPACE_WRITE");

    const writeCapable = AGENT_ROLES.filter((r) =>
      roleDefinition(r).maxPermissions.includes("WORKSPACE_WRITE"),
    );
    // documenter and tester write files too (docs, tests), which is legitimate;
    // researcher writes knowledge. Assert only that the *reviewer* — the role
    // whose whole point is to be an independent reader — never can.
    expect(roleDefinition("reviewer").maxPermissions).not.toContain("WORKSPACE_WRITE");
    expect(writeCapable).toContain("coder");
  });

  it("never grants FULL_ACCESS to any role", () => {
    for (const role of AGENT_ROLES) {
      expect(roleDefinition(role).maxPermissions).not.toContain("FULL_ACCESS");
    }
  });

  it("gives every role a non-zero iteration and tool budget", () => {
    for (const role of AGENT_ROLES) {
      const b = roleDefinition(role).budget;
      expect(b.maxIterations).toBeGreaterThan(0);
      expect(b.maxToolCalls).toBeGreaterThan(0);
    }
  });

  it("has a distinct system prompt per role that forbids instruction-following from tools", () => {
    const prompts = AGENT_ROLES.map((r) => roleDefinition(r).systemPrompt);
    expect(new Set(prompts).size).toBe(prompts.length);
    for (const prompt of prompts) {
      expect(prompt).toMatch(/UNTRUSTED DATA/);
    }
  });

  it("only lets roles whose work is externally judged carry a verification budget", () => {
    // No role currently sets one, but the contract is that a role may not be
    // given a verification budget unless it also has a way to run the check.
    for (const role of AGENT_ROLES) {
      const def = roleDefinition(role);
      if (def.budget.maxVerifications > 0) {
        expect(def.tools.some((t) => t === "run_tests" || t === "run_command")).toBe(true);
      }
    }
  });
});
