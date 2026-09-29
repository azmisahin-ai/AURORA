import type { Command } from "commander";
import { loadConfig } from "../../config/Config.js";
import { FileSessionStore } from "../../core/memory/SessionMemory.js";
import { buildSessionRecall } from "../../core/memory/SessionRecall.js";
import type { SessionRecord } from "../../core/memory/types.js";

export interface SessionsCommandOptions {
  json?: boolean;
  limit?: string;
}

/** `aurora sessions list | show | recall` — inspect the Session memory tier. */
export function registerSessionsCommand(program: Command): void {
  const sessions = program
    .command("sessions")
    .description("Inspect stored session records (Phase 7 memory)");

  sessions
    .command("list")
    .description("List stored sessions, newest first")
    .option("--json", "print raw JSON")
    .option("--limit <n>", "show at most n records")
    .action(async (options: SessionsCommandOptions) => {
      const { store, records } = await load(options);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
        return;
      }
      if (records.length === 0) {
        process.stdout.write(`no sessions in ${store}\n`);
        return;
      }
      for (const record of records) {
        process.stdout.write(`${formatLine(record)}\n`);
      }
    });

  sessions
    .command("show")
    .description("Show one session record")
    .argument("<id>", "session id")
    .action(async (id: string) => {
      const config = loadConfig(process.env);
      const store = new FileSessionStore({ dir: config.sessionDir });
      const record = await store.get(id);
      if (!record) {
        process.stderr.write(`aurora: no session "${id}"\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    });

  sessions
    .command("recall")
    .description("Print the recall block a new run would inject")
    .option("--limit <n>", "number of prior sessions to distil")
    .action(async (options: SessionsCommandOptions) => {
      const config = loadConfig(process.env);
      const store = new FileSessionStore({ dir: config.sessionDir });
      const limit = numberOr(options.limit, config.recallSessions);
      const records = await store.recent(limit);
      const recall = buildSessionRecall(records);
      if (!recall) {
        process.stdout.write("(nothing to recall)\n");
        return;
      }
      process.stdout.write(`${recall}\n`);
    });
}

async function load(
  options: SessionsCommandOptions,
): Promise<{ store: string; records: SessionRecord[] }> {
  const config = loadConfig(process.env);
  const store = new FileSessionStore({ dir: config.sessionDir });
  const limit = numberOr(options.limit, Number.POSITIVE_INFINITY);
  const records = await store.list();
  return { store: config.sessionDir, records: records.slice(0, limit) };
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatLine(record: SessionRecord): string {
  const status = record.status ?? "-";
  const summary = record.output
    ? record.output.replace(/\s+/g, " ").slice(0, 60)
    : record.task.replace(/\s+/g, " ").slice(0, 60);
  return `${record.id}  ${status.padEnd(14)} ${record.updatedAt}  ${summary}`;
}
