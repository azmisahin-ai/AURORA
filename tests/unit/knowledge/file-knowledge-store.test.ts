import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileKnowledgeStore,
  normalizeSlug,
} from "../../../src/core/knowledge/FileKnowledgeStore.js";

let root: string;
let store: FileKnowledgeStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aurora-knowledge-"));
  store = new FileKnowledgeStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("normalizeSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(normalizeSlug("Ollama API Chat!")).toBe("ollama-api-chat");
  });

  it("strips path separators so a slug cannot escape its directory", () => {
    expect(normalizeSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(normalizeSlug("a/b/c")).toBe("a-b-c");
  });

  it("rejects a slug that normalises to nothing", () => {
    expect(() => normalizeSlug("///")).toThrow(/Invalid knowledge slug/);
  });
});

describe("FileKnowledgeStore.write / read", () => {
  it("writes markdown plus a metadata sidecar", async () => {
    const entry = await store.write({
      kind: "topic",
      slug: "ollama-api-chat",
      title: "Ollama Chat API",
      content: "# Chat\n\nPOST /api/chat.",
      source: "https://docs.ollama.com/api/chat",
      verified: true,
      tags: ["ollama", "api"],
    });

    expect(entry.path).toBe("topics/ollama-api-chat.md");
    expect(entry.metadata.verified).toBe(true);
    expect(entry.metadata.source).toBe("https://docs.ollama.com/api/chat");

    const onDisk = await readFile(join(root, "topics", "ollama-api-chat.md"), "utf8");
    expect(onDisk).toContain("POST /api/chat");

    const meta = JSON.parse(
      await readFile(join(root, "topics", "ollama-api-chat.meta.json"), "utf8"),
    );
    expect(meta.provider).toBe("agent");
    expect(meta.tags).toEqual(["ollama", "api"]);
    expect(typeof meta.retrievedAt).toBe("string");
  });

  it("defaults verified to false and stamps retrievedAt", async () => {
    const entry = await store.write({
      kind: "source",
      slug: "unverified-note",
      title: "Unverified",
      content: "claim",
    });
    expect(entry.metadata.verified).toBe(false);
    expect(Date.parse(entry.metadata.retrievedAt)).not.toBeNaN();
  });

  it("round-trips content and metadata through read", async () => {
    await store.write({
      kind: "research",
      slug: "2026-09-28-ollama",
      title: "Ollama research",
      content: "findings",
      topic: "ollama",
      notes: "DOĞRULANACAK: streaming tool calls",
    });
    const entry = await store.read("research", "2026-09-28-ollama");
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("findings");
    expect(entry!.metadata.topic).toBe("ollama");
    expect(entry!.metadata.notes).toContain("DOĞRULANACAK");
  });

  it("returns null for a missing entry", async () => {
    expect(await store.read("topic", "does-not-exist")).toBeNull();
  });

  it("cannot be tricked into writing outside the knowledge root", async () => {
    const entry = await store.write({
      kind: "topic",
      slug: "../../escape",
      title: "Escape attempt",
      content: "x",
    });
    expect(entry.path.startsWith("topics/")).toBe(true);
    expect(entry.path).not.toContain("..");
  });
});

describe("FileKnowledgeStore.list", () => {
  it("lists entries newest first and filters by kind and topic", async () => {
    await store.write({
      kind: "topic",
      slug: "a",
      title: "A",
      content: "a",
      topic: "ollama",
      retrievedAt: "2026-01-01T00:00:00Z",
    });
    await store.write({
      kind: "topic",
      slug: "b",
      title: "B",
      content: "b",
      topic: "ollama",
      retrievedAt: "2026-02-01T00:00:00Z",
    });
    await store.write({
      kind: "source",
      slug: "c",
      title: "C",
      content: "c",
      topic: "other",
      retrievedAt: "2026-03-01T00:00:00Z",
    });

    const all = await store.list();
    expect(all.map((m) => m.slug)).toEqual(["c", "b", "a"]);

    const topics = await store.list({ kind: "topic" });
    expect(topics.map((m) => m.slug).sort()).toEqual(["a", "b"]);

    const ollama = await store.list({ topic: "ollama" });
    expect(ollama.map((m) => m.slug).sort()).toEqual(["a", "b"]);
  });

  it("returns an empty list when the root has no content", async () => {
    expect(await store.list()).toEqual([]);
  });
});

describe("FileKnowledgeStore.search", () => {
  beforeEach(async () => {
    await store.write({
      kind: "topic",
      slug: "ollama-api-chat",
      title: "Ollama Chat API",
      content: "The /api/chat endpoint returns NDJSON when streaming is enabled.",
      topic: "ollama",
      source: "https://docs.ollama.com/api/chat",
      verified: true,
      tags: ["ollama", "streaming"],
    });
    await store.write({
      kind: "source",
      slug: "unrelated",
      title: "Gardening notes",
      content: "Tomatoes need sunlight.",
      topic: "garden",
    });
  });

  it("ranks a title/tag match above an unrelated entry", async () => {
    const hits = await store.search({ text: "ollama" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.entry.metadata.slug).toBe("ollama-api-chat");
    expect(hits.every((h) => h.entry.metadata.slug !== "unrelated")).toBe(true);
  });

  it("finds entries by a term only present in the body", async () => {
    const hits = await store.search({ text: "NDJSON" });
    expect(hits.map((h) => h.entry.metadata.slug)).toContain("ollama-api-chat");
  });

  it("finds entries by provenance (source URL)", async () => {
    const hits = await store.search({ text: "docs.ollama.com" });
    expect(hits.map((h) => h.entry.metadata.slug)).toContain("ollama-api-chat");
  });

  it("returns provenance metadata alongside the content", async () => {
    const hits = await store.search({ text: "ollama" });
    const meta = hits[0]!.entry.metadata;
    expect(meta.source).toBe("https://docs.ollama.com/api/chat");
    expect(meta.verified).toBe(true);
    expect(meta.retrievedAt).toBeTruthy();
  });

  it("filters by kind and topic", async () => {
    expect(await store.search({ text: "ollama", kind: "source" })).toEqual([]);
    expect((await store.search({ text: "ollama", topic: "ollama" })).length).toBe(1);
    expect(await store.search({ text: "ollama", topic: "garden" })).toEqual([]);
  });

  it("respects the limit", async () => {
    await store.write({
      kind: "topic",
      slug: "ollama-more",
      title: "Ollama more",
      content: "ollama ollama ollama",
    });
    const hits = await store.search({ text: "ollama", limit: 1 });
    expect(hits.length).toBe(1);
  });

  it("returns nothing for an empty or stopword-only query", async () => {
    expect(await store.search({ text: "" })).toEqual([]);
    expect(await store.search({ text: "the and of" })).toEqual([]);
  });

  it("recovers content when the metadata sidecar is missing", async () => {
    await rm(join(root, "topics", "ollama-api-chat.meta.json"));
    const hits = await store.search({ text: "NDJSON" });
    expect(hits.length).toBe(1);
    expect(hits[0]!.entry.metadata.verified).toBe(false);
    expect(hits[0]!.entry.metadata.provider).toBe("unknown");
  });
});
