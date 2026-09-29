import { describe, it, expect } from "vitest";
import { buildProgram } from "../../src/cli/index.js";
import { buildConfirmationGate } from "../../src/cli/commands/run.js";
import { serveEnvOverrides } from "../../src/cli/commands/serve.js";
import { didPersistFinding } from "../../src/cli/commands/research.js";
import type { RunResult, TrajectoryEntry } from "../../src/core/agent/types.js";

/**
 * CLI parsing only: these assert that arguments are wired to the right command
 * and that a stray command or missing argument is rejected. The commands
 * themselves are covered by the integration and live tests.
 */

describe("CLI confirmation gate mapping", () => {
  const request = { tool: "write_file", summary: "write x" };

  it("keeps allow as allow and deny as deny", async () => {
    // The bug this guards: mapping every non-prompt mode to AllowAllGate, which
    // silently turned AURORA_CONFIRM_MODE=deny into "approve everything".
    expect(await buildConfirmationGate("allow", false).request(request)).toBe("approved");
    expect(await buildConfirmationGate("deny", false).request(request)).toBe("denied");
  });

  it("denies unanswerable prompt mode only when strict", async () => {
    const originalIsTTY = process.stdin.isTTY;
    try {
      (process.stdin as { isTTY?: boolean }).isTTY = false;
      expect(await buildConfirmationGate("prompt", true).request(request)).toBe("denied");
      expect(await buildConfirmationGate("prompt", false).request(request)).toBe("approved");
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = originalIsTTY;
    }
  });
});

describe("CLI wiring", () => {
  function entry(partial: Partial<TrajectoryEntry>): TrajectoryEntry {
    return {
      iteration: 1,
      step: { kind: "final" },
      assistantContent: "",
      ...partial,
    } as TrajectoryEntry;
  }
  function result(trajectory: TrajectoryEntry[]): RunResult {
    return { status: "completed", output: "", iterations: 1, toolCalls: 1, trajectory };
  }

  it("treats a research run as persisted only on a successful knowledge_write", () => {
    // The bug this guards: the loop can report `completed` with no tool call at
    // all, and `research` used to call that a success. The command now exits
    // non-zero unless the finding was really stored.
    expect(didPersistFinding(result([]))).toBe(false);
    expect(
      didPersistFinding(
        result([
          entry({
            toolCall: { name: "knowledge_write", arguments: {} },
            toolResult: { ok: false, observation: "Invalid arguments" },
          }),
        ]),
      ),
    ).toBe(false);
    expect(
      didPersistFinding(
        result([
          entry({
            toolCall: { name: "web_fetch", arguments: {} },
            toolResult: { ok: true, observation: "fetched" },
          }),
          entry({
            toolCall: { name: "knowledge_write", arguments: {} },
            toolResult: { ok: true, observation: "saved" },
          }),
        ]),
      ),
    ).toBe(true);
  });

  it("registers run, research, knowledge, tasks, sessions and serve", () => {
    const names = buildProgram()
      .commands.map((c) => c.name());
    expect(names).toContain("run");
    expect(names).toContain("research");
    expect(names).toContain("knowledge");
    expect(names).toContain("tasks");
    expect(names).toContain("sessions");
    expect(names).toContain("serve");
  });

  it("exposes the Phase 9 serve options", () => {
    const program = buildProgram();
    const serve = program.commands.find((c) => c.name() === "serve")!;
    const flags = serve.options.map((o) => o.long);
    expect(flags).toContain("--host");
    expect(flags).toContain("--port");
    expect(flags).toContain("--allow-mutation");
  });

  it("maps --no-ui to the ui flag commander actually produces", () => {
    // The bug this guards: typing the option as `noUi` and reading
    // `options.noUi`. Commander stores `--no-ui` as `ui: false`, so that code
    // compiles and is always undefined — the flag silently does nothing.
    // Assert the *mapping*, not just that the flag is registered: a
    // registration-only assertion stays green when the action reads the wrong
    // field.
    const serve = buildProgram().commands.find((c) => c.name() === "serve")!;
    serve.parseOptions(["--no-ui"]);
    const options = serve.opts() as { ui?: boolean };
    expect(options.ui).toBe(false);
    expect(serveEnvOverrides(options).AURORA_UI_DIR).toBe("");

    const untouched = buildProgram().commands.find((c) => c.name() === "serve")!;
    expect(serveEnvOverrides(untouched.opts() as { ui?: boolean }).AURORA_UI_DIR).toBeUndefined();
  });

  it("maps the other serve options onto their env vars", () => {
    const env = serveEnvOverrides({
      host: "0.0.0.0",
      port: "9000",
      model: "m",
      allowMutation: true,
    });
    expect(env.AURORA_API_HOST).toBe("0.0.0.0");
    expect(env.AURORA_API_PORT).toBe("9000");
    expect(env.AURORA_MODEL).toBe("m");
    expect(env.AURORA_API_ALLOW_MUTATION).toBe("true");
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

  it("exposes the Phase 8 confirmation options on run", () => {
    const program = buildProgram();
    const run = program.commands.find((c) => c.name() === "run")!;
    const flags = run.options.map((o) => o.long);
    expect(flags).toContain("--confirm");
    expect(flags).toContain("--no-confirm");
    expect(flags).toContain("--confirm-strict");
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
