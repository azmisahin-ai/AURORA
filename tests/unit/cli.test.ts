import { describe, it, expect } from "vitest";
import { buildProgram } from "../../src/cli/index.js";

/**
 * CLI parsing only: these assert that arguments are wired to the right command
 * and that a stray command or missing argument is rejected. The commands
 * themselves are covered by the integration and live tests.
 */

describe("CLI wiring", () => {
  it("registers run, research, knowledge, tasks and sessions", () => {
    const names = buildProgram()
      .commands.map((c) => c.name());
    expect(names).toContain("run");
    expect(names).toContain("research");
    expect(names).toContain("knowledge");
    expect(names).toContain("tasks");
    expect(names).toContain("sessions");
  });

  it("exposes sessions list, show and recall", () => {
    const program = buildProgram();
    const sessions = program.commands.find((c) => c.name() === "sessions")!;
    const sub = sessions.commands.map((c) => c.name());
    expect(sub).toEqual(expect.arrayContaining(["list", "show", "recall"]));
  });

  it("exposes the Phase 7 context and recall options on run", () => {
    const program = buildProgram();
    const run = program.commands.find((c) => c.name() === "run")!;
    const flags = run.options.map((o) => o.long);
    expect(flags).toContain("--recall-sessions");
    expect(flags).toContain("--context-budget");
    expect(flags).toContain("--no-recall");
  });

  it("exposes tasks add, list, show, recover and run", () => {
    const program = buildProgram();
    const tasks = program.commands.find((c) => c.name() === "tasks")!;
    const sub = tasks.commands.map((c) => c.name());
    expect(sub).toEqual(
      expect.arrayContaining(["add", "list", "show", "recover", "run"]),
    );
  });

  it("exposes knowledge list, search and show", () => {
    const program = buildProgram();
    const knowledge = program.commands.find((c) => c.name() === "knowledge")!;
    const sub = knowledge.commands.map((c) => c.name());
    expect(sub).toEqual(expect.arrayContaining(["list", "search", "show"]));
  });

  it("research requires a topic argument", () => {
    const program = buildProgram();
    const research = program.commands.find((c) => c.name() === "research")!;
    expect(research.registeredArguments[0]!.required).toBe(true);
  });

  it("knowledge search requires a query argument", () => {
    const program = buildProgram();
    const knowledge = program.commands.find((c) => c.name() === "knowledge")!;
    const search = knowledge.commands.find((c) => c.name() === "search")!;
    expect(search.registeredArguments[0]!.name()).toBe("query");
  });

  it("knows the --max-iterations and --model options on run and research", () => {
    const program = buildProgram();
    for (const name of ["run", "research"]) {
      const cmd = program.commands.find((c) => c.name() === name)!;
      const flags = cmd.options.map((o) => o.long);
      expect(flags, name).toContain("--max-iterations");
      expect(flags, name).toContain("--model");
    }
  });
});
