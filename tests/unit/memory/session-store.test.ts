import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "../../../src/core/memory/SessionMemory.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aurora-sessions-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileSessionStore", () => {
  it("saves and reads a session back", async () => {
    const store = new FileSessionStore({ dir });
    const record = FileSessionStore.toRecord({
      task: "research ollama",
      status: "completed",
      output: "done",
      toolsUsed: ["web_fetch"],
      iterations: 3,
      toolCalls: 2,
    });
    await store.save(record);

    const loaded = await store.get(record.id);
    expect(loaded?.task).toBe("research ollama");
    expect(loaded?.status).toBe("completed");
    expect(loaded?.toolsUsed).toEqual(["web_fetch"]);
  });

  it("persists across a fresh store instance (restart simulation)", async () => {
    const first = new FileSessionStore({ dir });
    const record = FileSessionStore.toRecord({ task: "t", status: "completed" });
    await first.save(record);

    const reopened = new FileSessionStore({ dir });
    expect((await reopened.get(record.id))?.task).toBe("t");
  });

  it("returns undefined for a missing id instead of throwing", async () => {
    const store = new FileSessionStore({ dir });
    expect(await store.get("nope")).toBeUndefined();
  });

  it("lists newest first by updatedAt", async () => {
    const store = new FileSessionStore({ dir });
    await store.save({
      id: "old",
      task: "old",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      toolsUsed: [],
    });
    await store.save({
      id: "new",
      task: "new",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      toolsUsed: [],
    });
    expect((await store.list()).map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("excludes ids in recent()", async () => {
    const store = new FileSessionStore({ dir });
    await store.save({
      id: "a",
      task: "a",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      toolsUsed: [],
    });
    await store.save({
      id: "b",
      task: "b",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      toolsUsed: [],
    });
    expect((await store.recent(5, ["b"])).map((r) => r.id)).toEqual(["a"]);
  });

  it("preserves createdAt on overwrite and refreshes updatedAt", async () => {
    const store = new FileSessionStore({ dir });
    await store.save({
      id: "s",
      task: "t",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      toolsUsed: [],
    });
    await store.save({
      id: "s",
      task: "t2",
      createdAt: "2099-01-01T00:00:00Z", // a wrong value must be ignored
      updatedAt: "2099-01-01T00:00:00Z",
      toolsUsed: [],
    });
    const loaded = await store.get("s");
    expect(loaded?.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(loaded?.updatedAt).not.toBe("2099-01-01T00:00:00Z");
  });

  it("truncates a long output to the configured cap", async () => {
    const store = new FileSessionStore({ dir, maxOutputChars: 10 });
    const record = FileSessionStore.toRecord({ task: "t", output: "x".repeat(100) });
    await store.save(record);
    expect((await store.get(record.id))?.output).toHaveLength(10);
  });

  it("rejects an id containing a path separator", async () => {
    const store = new FileSessionStore({ dir });
    await expect(
      store.save({
        id: "../escape",
        task: "t",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        toolsUsed: [],
      }),
    ).rejects.toThrow(/Invalid session id/);
  });

  it("skips an unreadable record rather than failing the whole list", async () => {
    const store = new FileSessionStore({ dir });
    await store.save(FileSessionStore.toRecord({ task: "good" }));
    await writeFile(join(dir, "broken.json"), "{ not json", "utf8");
    expect((await store.list()).map((r) => r.task)).toEqual(["good"]);
  });

  it("never leaves a temp file behind after a successful save", async () => {
    const store = new FileSessionStore({ dir });
    await store.save(FileSessionStore.toRecord({ task: "t" }));
    const names = await readdir(dir);
    expect(names.every((n) => !n.includes(".tmp-"))).toBe(true);
  });

  it("returns an empty list when the directory does not exist", async () => {
    const store = new FileSessionStore({ dir: join(dir, "missing") });
    expect(await store.list()).toEqual([]);
  });

  it("serialises concurrent saves without corruption", async () => {
    const store = new FileSessionStore({ dir });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.save({
          id: `s${i}`,
          task: `t${i}`,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          toolsUsed: [],
        }),
      ),
    );
    expect(await store.list()).toHaveLength(10);
  });
});
