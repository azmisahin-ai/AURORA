/**
 * Panels (ADR 012). Each builder returns DOM nodes and inserts every API value
 * with `textContent` via `el` — see `dom.js` for why that is the whole point.
 */

import { el, externalLink } from "./dom.js";
import {
  formatAge,
  formatDuration,
  formatStep,
  formatTime,
  statusClass,
  summarizeTrajectory,
  truncate,
} from "./format.js";

/** A status chip. `status` is data; `statusClass` maps it through an allowlist. */
export function statusChip(status) {
  return el("span", { class: `chip ${statusClass(status)}`, text: String(status ?? "unknown") });
}

function empty(message) {
  return el("p", { class: "empty", text: message });
}

/** Task panel: durable work from Phase 6. */
export function taskList(tasks, onSelect) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [empty("No tasks yet.")];
  const rows = tasks.map((task) =>
    el("tr", {}, [
      el("td", {}, [statusChip(task.status)]),
      el("td", { class: "mono", text: truncate(task.id, 20) }),
      el("td", { text: truncate(task.prompt, 80) }),
      el("td", { class: "num", text: `${task.attempts}/${task.maxAttempts}` }),
      el("td", { class: "nowrap", text: formatAge(task.updatedAt) }),
      el("td", {}, [
        el("button", {
          class: "link",
          text: "view",
          on: { click: () => onSelect?.(task.id) },
        }),
      ]),
    ]),
  );
  return [
    el("table", { class: "grid" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Status" }),
          el("th", { text: "Id" }),
          el("th", { text: "Prompt" }),
          el("th", { text: "Attempts" }),
          el("th", { text: "Updated" }),
          el("th", { text: "" }),
        ]),
      ]),
      el("tbody", {}, rows),
    ]),
  ];
}

export function taskDetail(task) {
  if (!task) return [empty("Select a task.")];
  return [
    el("dl", { class: "kv" }, [
      el("dt", { text: "Status" }),
      el("dd", {}, [statusChip(task.status)]),
      el("dt", { text: "Id" }),
      el("dd", { class: "mono", text: task.id }),
      el("dt", { text: "Prompt" }),
      el("dd", { text: task.prompt }),
      el("dt", { text: "Attempts" }),
      el("dd", { text: `${task.attempts} / ${task.maxAttempts}` }),
      el("dt", { text: "Created" }),
      el("dd", { text: formatTime(task.createdAt) }),
      el("dt", { text: "Updated" }),
      el("dd", { text: formatTime(task.updatedAt) }),
      ...(task.error ? [el("dt", { text: "Error" }), el("dd", { class: "danger", text: task.error })] : []),
    ]),
    ...(task.output
      ? [el("h3", { text: "Output" }), el("pre", { class: "out", text: task.output })]
      : []),
  ];
}

/** Agent panel: live and finished runs from the Phase 9 registry. */
export function runList(runs, { onSelect, onCancel }) {
  if (!Array.isArray(runs) || runs.length === 0) return [empty("No runs in this server's history.")];
  const rows = runs.map((run) =>
    el("tr", {}, [
      el("td", {}, [statusChip(run.status)]),
      el("td", { class: "mono", text: truncate(run.id, 20) }),
      el("td", { text: truncate(run.task, 80) }),
      el("td", { class: "nowrap", text: formatDuration(run.startedAt, run.finishedAt) }),
      el("td", { class: "nowrap", text: formatAge(run.startedAt) }),
      el("td", {}, [
        el("button", { class: "link", text: "view", on: { click: () => onSelect?.(run.id) } }),
        run.status === "running"
          ? el("button", {
              class: "link danger",
              text: "cancel",
              on: { click: () => onCancel?.(run.id) },
            })
          : null,
      ]),
    ]),
  );
  return [
    el("table", { class: "grid" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Status" }),
          el("th", { text: "Id" }),
          el("th", { text: "Task" }),
          el("th", { text: "Duration" }),
          el("th", { text: "Started" }),
          el("th", { text: "" }),
        ]),
      ]),
      el("tbody", {}, rows),
    ]),
  ];
}

export function runDetail(run) {
  if (!run) return [empty("Select a run.")];
  const result = run.result;
  const stats = result ? summarizeTrajectory(result.trajectory) : null;
  return [
    el("dl", { class: "kv" }, [
      el("dt", { text: "Status" }),
      el("dd", {}, [statusChip(run.status)]),
      el("dt", { text: "Id" }),
      el("dd", { class: "mono", text: run.id }),
      el("dt", { text: "Task" }),
      el("dd", { text: run.task }),
      el("dt", { text: "Started" }),
      el("dd", { text: formatTime(run.startedAt) }),
      ...(run.finishedAt ? [el("dt", { text: "Finished" }), el("dd", { text: formatTime(run.finishedAt) })] : []),
      ...(run.error ? [el("dt", { text: "Error" }), el("dd", { class: "danger", text: run.error })] : []),
      ...(stats
        ? [
            el("dt", { text: "Loop" }),
            el("dd", {
              text:
                `${stats.steps} steps · ${stats.toolCalls} tool calls` +
                (stats.verifications ? ` · ${stats.verifications} verifications` : ""),
            }),
          ]
        : []),
      ...(result
        ? [el("dt", { text: "Iterations" }), el("dd", { text: String(result.iterations) })]
        : []),
    ]),
    ...(result?.output ? [el("h3", { text: "Output" }), el("pre", { class: "out", text: result.output })] : []),
    ...(result?.trajectory ? [el("h3", { text: "Trajectory" }), trajectory(result.trajectory)] : []),
  ];
}

/**
 * Trajectory view: the tool-call history. Each assistant message, tool call and
 * observation is untrusted text and is rendered as text.
 */
export function trajectory(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return empty("No trajectory recorded.");
  const items = entries.map((entry, index) => {
    const title = `#${entry.iteration ?? index} · ${formatStep(entry.step)}`;
    const body = [];
    if (entry.assistantContent) {
      body.push(el("div", { class: "traj-assistant", text: truncate(entry.assistantContent, 600) }));
    }
    if (entry.toolCall) {
      body.push(
        el("div", { class: "traj-tool" }, [
          el("span", { class: "tag", text: `tool: ${entry.toolCall.name ?? "?"}` }),
          el("pre", { class: "out", text: safeJson(entry.toolCall.arguments) }),
        ]),
      );
    }
    if (entry.toolResult) {
      body.push(
        el("div", { class: "traj-result" }, [
          el("span", { class: entry.toolResult.ok ? "tag ok" : "tag bad", text: entry.toolResult.ok ? "result" : "error" }),
          el("pre", { class: "out", text: truncate(safeJson(entry.toolResult), 1200) }),
        ]),
      );
    }
    if (entry.verification) {
      body.push(
        el("div", { class: "traj-verify" }, [
          el("span", { class: "tag", text: `verification: ${entry.verification.kind}` }),
          el("pre", { class: "out", text: truncate(entry.verification.observation ?? "", 800) }),
        ]),
      );
    }
    return el("details", { class: "traj" }, [
      el("summary", { text: title }),
      ...body,
    ]);
  });
  return el("div", { class: "trajectory" }, items);
}

/** Knowledge browser: topics, sources and research, with provenance. */
export function knowledgeList(entries, onSelect) {
  if (!Array.isArray(entries) || entries.length === 0) return [empty("The knowledge store is empty.")];
  const rows = entries.map((entry) =>
    el("tr", {}, [
      el("td", { text: entry.kind }),
      el("td", { class: "mono", text: entry.slug }),
      el("td", { text: entry.title }),
      el("td", {}, [provenance(entry.source)]),
      el("td", {}, [entry.verified ? el("span", { class: "tag ok", text: "verified" }) : el("span", { class: "tag", text: "unverified" })]),
      el("td", { class: "nowrap", text: formatAge(entry.retrievedAt) }),
      el("td", {}, [
        el("button", { class: "link", text: "view", on: { click: () => onSelect?.(entry) } }),
      ]),
    ]),
  );
  return [
    el("table", { class: "grid" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Kind" }),
          el("th", { text: "Slug" }),
          el("th", { text: "Title" }),
          el("th", { text: "Source" }),
          el("th", { text: "Verified" }),
          el("th", { text: "Retrieved" }),
          el("th", { text: "" }),
        ]),
      ]),
      el("tbody", {}, rows),
    ]),
  ];
}

/**
 * A source is a URL that was fetched from the open web (Phase 3) — data, not a
 * trusted reference. Only http/https becomes clickable; anything else, notably
 * `javascript:`, is shown as inert text (ADR 012 §3).
 */
function provenance(source) {
  if (typeof source !== "string" || source === "") return el("span", { class: "muted", text: "—" });
  return externalLink(source, truncate(source, 60));
}

export function knowledgeDetail(entry) {
  if (!entry) return [empty("Select an entry.")];
  return [
    el("dl", { class: "kv" }, [
      el("dt", { text: "Kind" }),
      el("dd", { text: entry.kind }),
      el("dt", { text: "Slug" }),
      el("dd", { class: "mono", text: entry.slug }),
      el("dt", { text: "Title" }),
      el("dd", { text: entry.title }),
      ...(entry.topic ? [el("dt", { text: "Topic" }), el("dd", { text: entry.topic })] : []),
      el("dt", { text: "Source" }),
      el("dd", {}, [provenance(entry.source)]),
      el("dt", { text: "Retrieved" }),
      el("dd", { text: formatTime(entry.retrievedAt) }),
      el("dt", { text: "Provider" }),
      el("dd", { text: entry.provider ?? "—" }),
      el("dt", { text: "Verified" }),
      el("dd", { text: entry.verified ? "yes" : "no" }),
    ]),
    ...(entry.content
      ? [
          el("h3", { text: "Content" }),
          // Untrusted: rendered as text, so a payload is visible, not executed.
          el("pre", { class: "out", text: entry.content }),
        ]
      : []),
  ];
}

/** `JSON.stringify` that cannot throw on a circular or exotic value. */
function safeJson(value) {
  if (value === undefined) return "";
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
