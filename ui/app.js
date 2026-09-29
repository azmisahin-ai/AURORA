/**
 * AURORA operator UI (Phase 10, ADR 012).
 *
 * A read-mostly viewer: it polls three list endpoints, renders them as text,
 * and can start/cancel a run. Every value from the API is inserted with
 * `textContent` (see `dom.js`); this module never sets innerHTML.
 */

import { api, ApiError, getToken, setToken } from "./lib/api.js";
import { clear, el, render } from "./lib/dom.js";
import { KNOWLEDGE_KINDS, TASK_STATUSES } from "./lib/format.js";
import {
  knowledgeDetail,
  knowledgeList,
  runDetail,
  runList,
  taskDetail,
  taskList,
} from "./lib/panels.js";

const POLL_MS = 4000;

const state = {
  view: "tasks",
  tasks: [],
  runs: [],
  knowledge: [],
  taskFilter: { status: "", tag: "" },
  knowledgeFilter: { kind: "" },
  selectedTaskId: null,
  selectedRunId: null,
  selectedKnowledge: null,
  error: null,
  timer: null,
};

const dom = {};

function boot() {
  dom.status = document.getElementById("conn-status");
  dom.token = document.getElementById("token-input");
  dom.tokenSave = document.getElementById("token-save");
  dom.tokenRow = document.getElementById("token-row");
  dom.taskForm = document.getElementById("task-form");
  dom.taskInput = document.getElementById("task-input");
  dom.content = document.getElementById("content");
  dom.detail = document.getElementById("detail");
  dom.taskFilter = document.getElementById("task-filter");
  dom.knowledgeFilter = document.getElementById("knowledge-filter");

  buildChrome();

  dom.token.value = getToken();
  if (getToken()) dom.tokenRow.classList.add("hidden");

  for (const tab of document.querySelectorAll("[data-view]")) {
    tab.addEventListener("click", () => selectView(tab.dataset.view));
  }

  dom.tokenSave.addEventListener("click", () => {
    setToken(dom.token.value.trim());
    dom.tokenRow.classList.add("hidden");
    void refresh();
  });

  dom.taskForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitTask();
  });

  dom.taskFilter.addEventListener("change", () => {
    state.taskFilter.status = dom.taskFilter.value;
    void refresh();
  });

  dom.knowledgeFilter.addEventListener("change", () => {
    state.knowledgeFilter.kind = dom.knowledgeFilter.value;
    void refresh();
  });

  selectView("tasks");
  state.timer = setInterval(() => void refresh(), POLL_MS);
}

function buildChrome() {
  render(
    dom.taskFilter,
    [el("option", { text: "All statuses", attrs: { value: "" } })].concat(
      TASK_STATUSES.map((s) => el("option", { text: s, attrs: { value: s } })),
    ),
  );
  render(
    dom.knowledgeFilter,
    [el("option", { text: "All kinds", attrs: { value: "" } })].concat(
      KNOWLEDGE_KINDS.map((k) => el("option", { text: k, attrs: { value: k } })),
    ),
  );
}

function selectView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll("[data-view]")) {
    tab.classList.toggle("active", tab.dataset.view === view);
  }
  const showTaskFilter = view === "tasks";
  const showKnowledgeFilter = view === "knowledge";
  dom.taskFilter.classList.toggle("hidden", !showTaskFilter);
  dom.knowledgeFilter.classList.toggle("hidden", !showKnowledgeFilter);
  dom.taskForm.classList.toggle("hidden", view !== "tasks");
  clear(dom.detail);
  void refresh();
}

async function refresh() {
  try {
    if (state.view === "tasks") {
      const data = await api.listTasks(state.taskFilter);
      state.tasks = data?.results ?? [];
      state.error = null;
    } else if (state.view === "agents") {
      const data = await api.listRuns();
      state.runs = data?.results ?? [];
      state.error = null;
    } else {
      const data = await api.listKnowledge(state.knowledgeFilter);
      state.knowledge = data?.results ?? [];
      state.error = null;
    }
    setStatus(true);
  } catch (cause) {
    setStatus(false, cause);
  }
  renderView();
}

function setStatus(ok, cause) {
  if (ok) {
    dom.status.textContent = "connected";
    dom.status.className = "conn ok";
    return;
  }
  const message = cause instanceof ApiError ? `${cause.status} ${cause.message}` : String(cause);
  dom.status.textContent = `disconnected — ${message}`;
  dom.status.className = "conn bad";
  if (cause instanceof ApiError && cause.status === 401) dom.tokenRow.classList.remove("hidden");
}

function renderView() {
  if (state.view === "tasks") {
    render(dom.content, taskList(state.tasks, (id) => void showTask(id)));
  } else if (state.view === "agents") {
    render(
      dom.content,
      runList(state.runs, {
        onSelect: (id) => void showRun(id),
        onCancel: (id) => void cancelRun(id),
      }),
    );
  } else {
    render(dom.content, knowledgeList(state.knowledge, (entry) => void showKnowledge(entry)));
  }
}

async function showTask(id) {
  state.selectedTaskId = id;
  try {
    const task = await api.getTask(id);
    render(dom.detail, taskDetail(task));
  } catch (cause) {
    render(dom.detail, [el("p", { class: "danger", text: `Could not load task: ${message(cause)}` })]);
  }
}

async function showRun(id) {
  state.selectedRunId = id;
  try {
    const run = await api.getRun(id);
    render(dom.detail, runDetail(run));
  } catch (cause) {
    render(dom.detail, [el("p", { class: "danger", text: `Could not load run: ${message(cause)}` })]);
  }
}

async function showKnowledge(entry) {
  state.selectedKnowledge = entry;
  // The list route returns metadata only; fetch the body for the detail view so
  // the panel shows content rather than an empty section.
  try {
    const full = await api.getKnowledge(entry.kind, entry.slug);
    render(dom.detail, knowledgeDetail(full));
  } catch (cause) {
    render(dom.detail, [
      el("p", { class: "danger", text: `Could not load entry: ${message(cause)}` }),
    ]);
  }
}

async function submitTask() {
  const task = dom.taskInput.value.trim();
  if (task === "") return;
  try {
    await api.startRun(task);
    dom.taskInput.value = "";
    selectView("agents");
  } catch (cause) {
    render(dom.detail, [el("p", { class: "danger", text: `Could not start run: ${message(cause)}` })]);
  }
}

async function cancelRun(id) {
  try {
    await api.cancelRun(id);
    await refresh();
  } catch (cause) {
    render(dom.detail, [el("p", { class: "danger", text: `Could not cancel: ${message(cause)}` })]);
  }
}

function message(cause) {
  return cause instanceof ApiError ? `${cause.status} ${cause.message}` : String(cause);
}

boot();
