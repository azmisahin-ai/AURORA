import { describe, expect, it } from "vitest";
import { Planner } from "../../src/core/planner/Planner.js";

describe("Planner", () => {
  const planner = new Planner();

  it("selects a tool step when the model requested a tool", () => {
    const step = planner.update({
      iteration: 1,
      reasoning: "I should read the file",
      requestedToolCalls: [
        { name: "read_file", arguments: { path: "a.txt" } },
      ],
    });
    expect(step.kind).toBe("tool");
    expect(step.toolName).toBe("read_file");
    expect(step.toolArguments).toEqual({ path: "a.txt" });
  });

  it("takes the first tool when several are requested", () => {
    const step = planner.update({
      iteration: 1,
      reasoning: "",
      requestedToolCalls: [
        { name: "first", arguments: {} },
        { name: "second", arguments: {} },
      ],
    });
    expect(step.toolName).toBe("first");
  });

  it("finishes when the model produced no tool call", () => {
    const step = planner.update({ iteration: 2, reasoning: "Done.", requestedToolCalls: [] });
    expect(step.kind).toBe("final");
  });
});
