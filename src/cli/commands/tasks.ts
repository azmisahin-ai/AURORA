import type { Command } from "commander";
import { loadConfig } from "../../config/Config.js";
import { createLogger } from "../../observability/Logger.js";
import { FileTaskStore } from "../../core/task/FileTaskStore.js";
import { TaskRunner } from "../../core/task/TaskRunner.js";
import { AgentRuntime } from "../../core/agent/AgentRuntime.js";
import type { TaskStatus } from "../../core/task/types.js";

const STATUSES: readonly TaskStatus[] = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
];

export function registerTasksCommand(program: Command): void {
  const tasks = program
    .command("tasks")
    .description("Manage durable tasks (Phase 6)");

  tasks
    .command("add")
    .description("Create a queued task")
    .argument("<prompt>", "the task text handed to the agent")
    .option("--max-attempts <n>", "attempts before the task is failed")
    .option("--tag <tag...>", "labels for the task")
    .action(async (prompt: string, options: { maxAttempts?: string; tag?: string[] }) => {
      const config = loadConfig();
      const store = new FileTaskStore(config.taskDir);
      const task = await store.create({
        prompt,
        maxAttempts: options.maxAttempts ? Number(options.maxAttempts) : config.taskMaxAttempts,
        ...(options.tag ? { tags: options.tag } : {}),
      });
      process.stdout.write(`${task.id}\t${task.status}\t${task.prompt}\n`);
    });

  tasks
    .command("list")
    .description("List tasks")
    .option("--status <status>", `one of: ${STATUSES.join(" | ")}`)
    .option("--tag <tag>", "filter by tag")
    .option("--limit <n>", "max rows")
    .action(async (options: { status?: string; tag?: string; limit?: string }) => {
      const config = loadConfig();
      const store = new FileTaskStore(config.taskDir);
      const records = await store.list({
        ...(options.status ? { status: asStatus(options.status) } : {}),
        ...(options.tag ? { tag: options.tag } : {}),
        ...(options.limit ? { limit: Number(options.limit) } : {}),
      });
      if (records.length === 0) {
        process.stdout.write(`No tasks in ${config.taskDir}.\n`);
        return;
      }
      for (const t of records) {
        const attempts = `${t.attempts}/${t.maxAttempts}`;
        process.stdout.write(
          `${t.id.padEnd(40)} ${t.status.padEnd(10)} attempts=${attempts.padEnd(5)} ${t.prompt}\n`,
        );
      }
    });

  tasks
    .command("show")
    .description("Print one task record")
    .argument("<id>", "task id")
    .action(async (id: string) => {
      const config = loadConfig();
      const store = new FileTaskStore(config.taskDir);
      const task = await store.get(id);
      if (!task) {
        process.stderr.write(`aurora: no task "${id}".\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
    });

  tasks
    .command("recover")
    .description("Requeue interrupted (running) tasks after a restart")
    .action(async () => {
      const config = loadConfig();
      const store = new FileTaskStore(config.taskDir);
      const report = await store.recover();
      process.stdout.write(
        `recovered: requeued=${report.requeued.length} ` +
          `exhausted=${report.exhausted.length} corrupt=${report.corrupt.length}\n`,
      );
      for (const id of report.requeued) process.stdout.write(`  requeued ${id}\n`);
      for (const id of report.exhausted) process.stdout.write(`  exhausted ${id}\n`);
      for (const id of report.corrupt) {
        process.stderr.write(`aurora: unreadable task record "${id}" left in place.\n`);
      }
    });

  tasks
    .command("run")
    .description("Recover, then run queued tasks through the agent")
    .option("--max-tasks <n>", "stop after this many tasks", "1")
    .option("--model <name>", "override AURORA_MODEL")
    .action(async (options: { maxTasks?: string; model?: string }) => {
      const env = { ...process.env };
      if (options.model) env.AURORA_MODEL = options.model;
      const config = loadConfig(env);
      const logger = createLogger(config.logLevel);
      const runtime = new AgentRuntime({ config, logger });

      if (runtime.llm.health) {
        const healthy = await runtime.llm.health();
        if (!healthy) {
          process.stderr.write(
            `aurora: LLM provider "${runtime.llm.name}" is not reachable.\n`,
          );
          process.exitCode = 1;
          return;
        }
      }

      const store = new FileTaskStore(config.taskDir);
      const recovered = await store.recover();
      if (recovered.requeued.length > 0 || recovered.exhausted.length > 0) {
        process.stderr.write(
          `aurora: recovery: requeued=${recovered.requeued.length} ` +
            `exhausted=${recovered.exhausted.length}\n`,
        );
      }

      const runner = new TaskRunner({ store, executor: runtime.createTaskExecutor(), logger });
      const reports = await runner.drain(Number(options.maxTasks ?? "1"));

      if (reports.length === 0) {
        process.stdout.write("No queued tasks.\n");
        return;
      }
      for (const { task, outcome } of reports) {
        process.stdout.write(`[${task.id}] ${task.status} (run: ${outcome.status})\n`);
        if (outcome.output) process.stdout.write(`${outcome.output}\n`);
      }
      if (reports.some((r) => r.task.status === "failed")) process.exitCode = 1;
    });
}

function asStatus(value: string): TaskStatus {
  if (!(STATUSES as readonly string[]).includes(value)) {
    throw new Error(`Unknown status "${value}". Expected one of: ${STATUSES.join(", ")}`);
  }
  return value as TaskStatus;
}
