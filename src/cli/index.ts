#!/usr/bin/env node
import { Command } from "commander";
import { registerRunCommand } from "./commands/run.js";
import { registerResearchCommand } from "./commands/research.js";
import { registerKnowledgeCommand } from "./commands/knowledge.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("aurora")
    .description("Autonomous Unified Research & Operations Runtime Agent")
    .version("0.1.0");

  registerRunCommand(program);
  registerResearchCommand(program);
  registerKnowledgeCommand(program);
  return program;
}

// Only execute when invoked as the entry point, so tests can import buildProgram.
const isEntry =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cli/index.js") || process.argv[1].endsWith("cli/index.ts"));

if (isEntry) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`aurora: ${message}\n`);
      process.exitCode = 1;
    });
}
