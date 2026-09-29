/**
 * API client (ADR 012 §2).
 *
 * The UI talks to the core **only** over HTTP; it imports no `src/` module, so
 * it cannot become a second entry point into `core`. Same-origin, so no CORS.
 *
 * The bearer token is kept in `sessionStorage`, not `localStorage`: it should
 * not outlive the tab, and it should not be readable by a future same-origin
 * script months later. It is sent as a header, never in a URL — a token in a
 * URL is logged by every proxy on the path.
 */

const TOKEN_KEY = "aurora.apiToken";

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(value) {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage disabled (private mode): the UI still works on a tokenless loopback */
  }
}

export class ApiError extends Error {
  constructor(status, body) {
    const detail = body && typeof body.error === "string" ? body.error : `HTTP ${status}`;
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(path, { ...options, headers });
  let body = null;
  const text = await res.text();
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

export const api = {
  health: () => request("/health"),
  listRuns: () => request("/runs"),
  getRun: (id) => request(`/runs/${encodeURIComponent(id)}`),
  startRun: (task) =>
    request("/agent/run", { method: "POST", body: JSON.stringify({ task }) }),
  cancelRun: (id) =>
    request("/agent/cancel", { method: "POST", body: JSON.stringify({ runId: id }) }),
  listTasks: (params = {}) => request(`/tasks${query(params)}`),
  getTask: (id) => request(`/tasks/${encodeURIComponent(id)}`),
  listKnowledge: (params = {}) => request(`/knowledge${query(params)}`),
  getKnowledge: (kind, slug) =>
    request(`/knowledge/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}`),
  searchKnowledge: (params) => request(`/knowledge/search${query(params)}`),
};

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs === "" ? "" : `?${qs}`;
}
