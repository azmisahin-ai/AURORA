import { describe, expect, it } from "vitest";
import {
  AllowAllGate,
  DenyAllGate,
  PromptGate,
} from "../../../src/security/ConfirmationGate.js";

describe("AllowAllGate / DenyAllGate", () => {
  it("allow-all approves", async () => {
    expect(await new AllowAllGate().request({ tool: "t", summary: "s" })).toBe("approved");
  });

  it("deny-all denies", async () => {
    expect(await new DenyAllGate().request({ tool: "t", summary: "s" })).toBe("denied");
  });

  it("carries a stable name for audit logs", () => {
    expect(new AllowAllGate().name).toBe("allow-all");
    expect(new DenyAllGate().name).toBe("deny-all");
  });
});

describe("PromptGate", () => {
  const req = { tool: "run_command", summary: "command=echo hi" };

  it("approves on 'y' and 'yes', case-insensitively", async () => {
    for (const answer of ["y", "Y", "yes", "YES"]) {
      const gate = new PromptGate({ ask: async () => answer });
      expect(await gate.request(req)).toBe("approved");
    }
  });

  it("denies on anything that is not an explicit yes", async () => {
    for (const answer of ["n", "no", "", "maybe", "yess"]) {
      const gate = new PromptGate({ ask: async () => answer });
      expect(await gate.request(req)).toBe("denied");
    }
  });

  it("reports unavailable when there is no input (EOF)", async () => {
    const gate = new PromptGate({ ask: async () => undefined });
    expect(await gate.request(req)).toBe("unavailable");
  });

  it("passes a question mentioning the tool and summary", async () => {
    let seen = "";
    const gate = new PromptGate({
      ask: async (q) => {
        seen = q;
        return "n";
      },
    });
    await gate.request(req);
    expect(seen).toContain("run_command");
    expect(seen).toContain("command=echo hi");
  });
});
