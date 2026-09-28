import { describe, expect, it } from "vitest";
import { PermissionManager } from "../../../src/security/PermissionManager.js";

describe("PermissionManager", () => {
  it("grants only what was given", () => {
    const pm = new PermissionManager(["READ_ONLY"]);
    expect(pm.has("READ_ONLY")).toBe(true);
    expect(pm.has("WORKSPACE_WRITE")).toBe(false);
    expect(pm.has("COMMAND_EXECUTION")).toBe(false);
  });

  it("FULL_ACCESS implies every other permission", () => {
    const pm = new PermissionManager(["FULL_ACCESS"]);
    for (const p of ["READ_ONLY", "WORKSPACE_WRITE", "COMMAND_EXECUTION", "NETWORK_ACCESS"] as const) {
      expect(pm.has(p)).toBe(true);
    }
  });

  it("allows a tool when every requirement is granted", () => {
    const pm = new PermissionManager(["READ_ONLY", "WORKSPACE_WRITE"]);
    expect(pm.check(["READ_ONLY"])).toEqual({ allowed: true });
    expect(pm.allows(["READ_ONLY", "WORKSPACE_WRITE"])).toBe(true);
  });

  it("reports exactly which permissions are missing", () => {
    const pm = new PermissionManager(["READ_ONLY"]);
    const decision = pm.check(["READ_ONLY", "COMMAND_EXECUTION", "NETWORK_ACCESS"]);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.missing).toEqual(["COMMAND_EXECUTION", "NETWORK_ACCESS"]);
    }
  });

  it("an empty grant set denies any requirement", () => {
    const pm = new PermissionManager();
    expect(pm.allows(["READ_ONLY"])).toBe(false);
  });

  it("a tool requiring no permissions is always allowed", () => {
    const pm = new PermissionManager();
    expect(pm.allows([])).toBe(true);
  });

  it("lists the granted set", () => {
    expect(new PermissionManager(["READ_ONLY"]).list()).toEqual(["READ_ONLY"]);
  });
});
