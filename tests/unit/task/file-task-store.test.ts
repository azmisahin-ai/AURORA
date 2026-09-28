import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileTaskStore,
  normalizeTaskId,
} from "../../../src/core/task/FileTaskStore.js";
import { TaskNotFoundError, TaskTransitionError } from "../../../src/core/task/types.js";

let root: string;
let store: FileTaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aurora-tasks-"));
  store = new FileTaskStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("normalizeTaskId", () => {
  it("strips path separators so an id cannot escape the store root", () => {
    expect(normalizeTaskId("../../etc/passwd")).toBe("etc-passwd");
    expect(normalizeTaskId("a/b/c")).toBe("a-b-c");
  });

  it("rejects an id that normalises to nothing or to a dot name", () => {
    expect(() => normalizeTaskId("///")).toThrow(/Invalid task id/);
    expect(() => normalizeTaskId("..")).toThrow(/Invalid task id/);
    expect(() => normalizeTaskId(".")).toThrow(/Invalid task id/);
  });
});

describe("FileTaskStore.create / get", () => {
  it("persists a queued record with a metadata sidecar", async () => {
    const task = await store.create({ prompt: "summarise a file", tags: ["demo"] });

    expect(task.status).toBe("queued");
    expect(task.attempts).toBe(0);
    expect(task.tags).toEqual(["demo"]);

    const onDisk = JSON.parse(await readFile(join(root, `${task.id}.json`), "utf8"));
    expect(onDisk.prompt).toBe("summarise a file");
    expect(onDisk.status).toBe("queued");

    const reread = await store.get(task.id);
    expect(reread?.id).toBe(task.id);
  });

  it("refuses an empty prompt", async () => {
    await expect(store.create({ prompt: "   " })).rejects.toThrow(/must not be empty/);
  });

  it("refuses to clobber an existing id", async () => {
    await store.create({ prompt: "first", id: "fixed" });
    await expect(store.create({ prompt: "second", id: "fixed" })).rejects.toThrow(
      /already exists/,
    );
  });

  it("returns null for an unknown id", async () => {
    expect(await store.get("nope")).toBeNull();
  });
});

describe("FileTaskStore.update — transition enforcement", () => {
  it("applies a legal transition", async () => {
    const task = await store.create({ prompt: "x" });
    const running = await store.update(task.id, "running");
    expect(running.status).toBe("running");
    expect(running.finishedAt).toBeUndefined();
  });

  it("stamps finishedAt when reaching a terminal state", async () => {
    const task = await store.create({ prompt: "x" });
    await store.update(task.id, "running");
    const done = await store.update(task.id, "completed");
    expect(done.finishedAt).toBeDefined();
  });

  it("throws TaskTransitionError on an illegal move", async () => {
    const task = await store.create({ prompt: "x" });
    // queued → completed skips running entirely.
    await expect(store.update(task.id, "completed")).rejects.toBeInstanceOf(
      TaskTransitionError,
    );
  });

  it("throws TaskNotFoundError for an unknown id", async () => {
    await expect(store.update("ghost", "running")).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it("does not let a plain update perform running → queued", async () => {
    const task = await store.create({ prompt: "x" });
    await store.update(task.id, "running");
    await expect(store.update(task.id, "queued")).rejects.toBeInstanceOf(
      TaskTransitionError,
    );
  });
});

describe("FileTaskStore.requeue", () => {
  it("is the named path from running back to queued", async () => {
    const task = await store.create({ prompt: "x" });
    await store.update(task.id, "running");
    const requeued = await store.requeue(task.id, { error: "bound hit" });
    expect(requeued.status).toBe("queued");
    expect(requeued.error).toBe("bound hit");
  });

  it("is also legal from waiting", async () => {
    const task = await store.create({ prompt: "x" });
    await store.update(task.id, "running");
    await store.update(task.id, "waiting");
    const requeued = await store.requeue(task.id);
    expect(requeued.status).toBe("queued");
  });

  it("refuses to requeue a terminal task", async () => {
    const task = await store.create({ prompt: "x" });
    await store.update(task.id, "running");
    await store.update(task.id, "completed");
    await expect(store.requeue(task.id)).rejects.toBeInstanceOf(TaskTransitionError);
  });
});

describe("FileTaskStore.claimNext", () => {
  it("claims the oldest queued task and bumps its attempt count", async () => {
    const first = await store.create({ prompt: "first", id: "a" });
    await store.create({ prompt: "second", id: "b" });

    const claimed = await store.claimNext();
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.startedAt).toBeDefined();

    // The second claim takes the other task, not the running one.
    const second = await store.claimNext();
    expect(second?.id).toBe("b");
  });

  it("returns null when nothing is queued", async () => {
    expect(await store.claimNext()).toBeNull();
  });

  it("does not block the queue on a task with no attempts left", async () => {
    const poisoned = await store.create({ prompt: "poison", id: "poison", maxAttempts: 1 });
    await store.claimNext(); // consumes the single attempt
    await store.requeue(poisoned.id); // back to queued, but attempts == max

    const good = await store.create({ prompt: "good", id: "good" });
    const claimed = await store.claimNext();

    expect(claimed?.id).toBe(good.id);
    const dead = await store.get(poisoned.id);
    expect(dead?.status).toBe("failed");
  });
});

describe("FileTaskStore.recover", () => {
  it("requeues an interrupted task that still has attempts left", async () => {
    const task = await store.create({ prompt: "x", maxAttempts: 3 });
    await store.claimNext(); // running, attempts = 1

    // Simulate a crash: a brand-new store on the same directory.
    const revived = new FileTaskStore(root);
    const report = await revived.recover();

    expect(report.requeued).toEqual([task.id]);
    expect(report.exhausted).toEqual([]);
    const after = await revived.get(task.id);
    expect(after?.status).toBe("queued");
    expect(after?.error).toMatch(/Recovered/);
  });

  it("fails an interrupted task that has no attempts left", async () => {
    await store.create({ prompt: "x", id: "one", maxAttempts: 1 });
    await store.claimNext(); // running, attempts = 1 == maxAttempts

    const revived = new FileTaskStore(root);
    const report = await revived.recover();

    expect(report.requeued).toEqual([]);
    expect(report.exhausted).toEqual(["one"]);
    const after = await revived.get("one");
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/no attempts remain/);
  });

  it("leaves queued and terminal tasks untouched", async () => {
    await store.create({ prompt: "queued", id: "q" });
    const done = await store.create({ prompt: "done", id: "d" });
    await store.update(done.id, "running");
    await store.update(done.id, "completed");

    const revived = new FileTaskStore(root);
    const report = await revived.recover();

    expect(report.requeued).toEqual([]);
    expect(report.exhausted).toEqual([]);
    expect((await revived.get("q"))?.status).toBe("queued");
    expect((await revived.get("d"))?.status).toBe("completed");
  });

  it("reports a corrupt record instead of dropping or crashing on it", async () => {
    const good = await store.create({ prompt: "good", id: "good" });
    await store.claimNext();
    await writeFile(join(root, "broken.json"), "{ this is not json", "utf8");

    const revived = new FileTaskStore(root);
    const report = await revived.recover();

    expect(report.corrupt).toEqual(["broken"]);
    expect(report.requeued).toEqual([good.id]);
    // The corrupt file is left in place for an operator to inspect.
    const names = await readdir(root);
    expect(names).toContain("broken.json");
  });

  it("treats an unknown status as corruption", async () => {
    await writeFile(
      join(root, "weird.json"),
      JSON.stringify({ prompt: "x", status: "zombie" }),
      "utf8",
    );
    const report = await store.recover();
    expect(report.corrupt).toEqual(["weird"]);
  });
});

describe("FileTaskStore durability", () => {
  it("writes atomically, leaving no temp files behind", async () => {
    const task = await store.create({ prompt: "x" });
    await store.update(task.id, "running");
    await store.update(task.id, "completed");

    const names = await readdir(root);
    expect(names.filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(names).toEqual([`${task.id}.json`]);
  });

  it("never exposes a torn record to a concurrent reader", async () => {
    // Atomicity is the whole point of temp-file + rename, so it must be
    // observable. A reader hammering the record while it is rewritten must
    // never see an unparseable file. Measured on this host: temp+rename yields
    // 0 torn reads, a plain `writeFile` yields hundreds, so this test fails if
    // the rename is ever replaced by an in-place write.
    const task = await store.create({ prompt: "seed", id: "atomic" });
    const big = (tag: string) => tag.repeat(256 * 1024);

    let torn = 0;
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        let raw: string;
        try {
          raw = await readFile(join(root, "atomic.json"), "utf8");
        } catch {
          continue; // ENOENT before the first write; not a torn read.
        }
        try {
          JSON.parse(raw);
        } catch {
          torn++;
        }
      }
    })();

    for (let i = 0; i < 40; i++) {
      await store.update("atomic", i % 2 === 0 ? "running" : "waiting", {
        output: big(i % 2 === 0 ? "A" : "B"),
      });
    }
    stop = true;
    await reader;

    expect(torn).toBe(0);
    // And no temp files survive the churn.
    const names = await readdir(root);
    expect(names.filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect((await store.get(task.id))?.status).toBe("waiting");
  });

  it("keeps list() working even if one record is unreadable", async () => {
    await store.create({ prompt: "good", id: "good" });
    await writeFile(join(root, "broken.json"), "not json", "utf8");
    const listed = await store.list();
    expect(listed.map((t) => t.id)).toEqual(["good"]);
  });
});

describe("FileTaskStore.list filtering", () => {
  it("filters by status and tag, and honours a limit", async () => {
    await store.create({ prompt: "a", id: "a", tags: ["x"] });
    await store.create({ prompt: "b", id: "b", tags: ["y"] });
    await store.claimNext(); // a → running

    expect((await store.list({ status: "running" })).map((t) => t.id)).toEqual(["a"]);
    expect((await store.list({ tag: "y" })).map((t) => t.id)).toEqual(["b"]);
    expect((await store.list({ limit: 1 })).length).toBe(1);
  });
});
