#!/usr/bin/env node
import { Command } from "commander";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { registerRunCommand } from "./commands/run.js";
import { registerResearchCommand } from "./commands/research.js";
import { registerKnowledgeCommand } from "./commands/knowledge.js";
import { registerTasksCommand } from "./commands/tasks.js";
import { registerSessionsCommand } from "./commands/sessions.js";
import { registerServeCommand } from "./commands/serve.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("aurora")
    .description("Autonomous Unified Research & Operations Runtime Agent")
    .version("0.1.0");

  registerRunCommand(program);
  registerResearchCommand(program);
  registerKnowledgeCommand(program);
  registerTasksCommand(program);
  registerSessionsCommand(program);
  registerServeCommand(program);
  return program;
}

/**
 * True when `argv1` names this module (rather than an import of `buildProgram`).
 *
 * Compares resolved URLs, not string suffixes: on Windows `process.argv[1]` is
 * `C:\AURORA\dist\cli\index.js` with backslashes, so the earlier
 * `endsWith("cli/index.js")` check was false there and the whole CLI silently did
 * nothing. `pathToFileURL` normalises separators, drive letters and escaping on
 * every platform. Exported for a test, since the bug was invisible on Linux.
 */
export function isEntryPoint(
  argv1: string | undefined,
  moduleUrl: string = import.meta.url,
): boolean {
  if (argv1 === undefined) return false;
  // npm's `bin` shim makes argv[1] a symlink; compare the real file too.
  let resolved = argv1;
  try {
    resolved = realpathSync(argv1);
  } catch {
    // Not a real path (e.g. a virtual entry); fall back to the literal value.
  }
  return moduleUrl === pathToFileURL(resolved).href || moduleUrl === pathToFileURL(argv1).href;
}

if (isEntryPoint(process.argv[1])) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`aurora: ${message}\n`);
      process.exitCode = 1;
    });
}
