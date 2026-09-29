// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { el, render, externalLink, isSafeHref } from "../../../ui/lib/dom.js";
import {
  statusChip,
  taskList,
  runList,
  runDetail,
  knowledgeList,
  knowledgeDetail,
  trajectory,
} from "../../../ui/lib/panels.js";

/**
 * Behavioral tests for the DOM builders, under jsdom. They complement — not
 * replace — the source guard: here we prove a specific hostile payload ends up
 * as text; the guard proves no markup sink exists at all (ADR 012 §3).
 */

const XSS = '<img src=x onerror="globalThis.__pwned = true">';

describe("dom builder", () => {
  it("inserts text as text, not markup", () => {
    const node = el("div", { text: XSS });
    document.body.append(node);
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toBe(XSS);
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    node.remove();
  });

  it("renders children and skips nullish ones", () => {
    const node = el("div", {}, [el("span", { text: "a" }), null, undefined, el("span", { text: "b" })]);
    expect(node.children).toHaveLength(2);
  });

  it("replaces contents on render", () => {
    const container = document.createElement("div");
    container.append(document.createElement("p"));
    render(container, [el("span", { text: "new" })]);
    expect(container.querySelector("p")).toBeNull();
    expect(container.textContent).toBe("new");
  });
});

describe("external links are scheme-restricted", () => {
  it("accepts only http/https", () => {
    expect(isSafeHref("https://example.com")).toBe(true);
    expect(isSafeHref("http://example.com")).toBe(true);
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,<script>")).toBe(false);
    expect(isSafeHref("file:///etc/passwd")).toBe(false);
    expect(isSafeHref("not a url")).toBe(false);
    expect(isSafeHref(undefined)).toBe(false);
  });

  it("renders a javascript: source as inert text, not an anchor", () => {
    const node = externalLink("javascript:alert(1)", "click");
    expect(node.tagName).not.toBe("A");
    expect(node.textContent).toBe("click");
  });

  it("renders an http source as an anchor with a hardened rel", () => {
    const node = externalLink("https://docs.ollama.com", "docs");
    expect(node.tagName).toBe("A");
    expect(node.getAttribute("rel")).toBe("noopener noreferrer");
    expect(node.getAttribute("target")).toBe("_blank");
  });
});

describe("panels render untrusted content as text", () => {
  it("a hostile knowledge content and source stay inert", () => {
    const entry = {
      kind: "source",
      slug: "evil",
      title: `Title ${XSS}`,
      content: `Body ${XSS}`,
      source: `javascript:alert(1)`,
      verified: false,
      retrievedAt: new Date().toISOString(),
    };
    const nodes = knowledgeDetail(entry);
    const container = document.createElement("div");
    container.append(...nodes);
    document.body.append(container);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(XSS);
    expect(container.querySelector("a")).toBeNull();
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    container.remove();
  });

  it("a hostile trajectory tool result stays inert", () => {
    const entries = [
      {
        iteration: 1,
        step: "execute",
        assistantContent: `thinking ${XSS}`,
        toolCall: { name: "read_file", arguments: { path: XSS } },
        toolResult: { ok: false, error: XSS },
      },
    ];
    const container = document.createElement("div");
    container.append(trajectory(entries));
    document.body.append(container);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("read_file");
    container.remove();
  });

  it("a hostile task prompt and status stay inert", () => {
    const tasks = [
      {
        id: "t1",
        prompt: XSS,
        status: `</span><script>alert(1)</script>`,
        attempts: 1,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const container = document.createElement("div");
    container.append(...taskList(tasks, () => {}));
    document.body.append(container);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // The status chip maps an unknown status to a safe class, never the raw value.
    const chip = container.querySelector(".chip")!;
    expect(chip.className).toBe("chip status-unknown");
    container.remove();
  });

  it("maps known statuses to their classes", () => {
    expect(statusChip("running").className).toBe("chip status-running");
    expect(statusChip("failed").className).toBe("chip status-failed");
  });

  it("renders empty states instead of throwing on absent data", () => {
    expect(taskList([], () => {}).length).toBeGreaterThan(0);
    expect(runList(null, {}).length).toBeGreaterThan(0);
    expect(knowledgeList(undefined, () => {}).length).toBeGreaterThan(0);
    expect(runDetail(null).length).toBeGreaterThan(0);
  });

  it("renders a run's trajectory summary and steps", () => {
    const run = {
      id: "run-1",
      task: "do a thing",
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: {
        status: "completed",
        output: "done",
        iterations: 2,
        toolCalls: 1,
        trajectory: [{ iteration: 1, step: "execute", assistantContent: "hi", toolCall: { name: "echo" } }],
      },
    };
    const container = document.createElement("div");
    container.append(...runDetail(run));
    expect(container.textContent).toContain("done");
    expect(container.textContent).toContain("1 tool calls");
    expect(container.textContent).toContain("echo");
  });
});
