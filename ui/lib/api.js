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
  streamRunEvents: (runId, handlers = {}) => streamEvents(runId, handlers),
};

/**
 * Subscribe to a run's live event stream (M0, CAP-004).
 *
 * `EventSource` cannot send an `Authorization` header, and a token in a query
 * string is logged by every proxy on the path (ADR 012 §2), so this uses
 * `fetch` with a streaming body and parses the SSE frames itself. Returning a
 * disposer (not a promise) lets the caller unsubscribe on a view change.
 *
 * Reconnection is deliberate: after a transport error the client waits, then
 * reconnects with `?after=<lastSequence>` and the server replays the gap from
 * its bounded ring. A gap the ring can no longer cover triggers `onGap` so the
 * UI can say "history truncated" rather than silently skipping events.
 */
function streamEvents(runId, { onEvent, onError, onGap } = {}) {
  const controller = new AbortController();
  let lastSequence = 0;
  let closed = false;
  let timer = null;

  const connect = async () => {
    if (closed) return;
    const path = `/runs/${encodeURIComponent(runId)}/events`;
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch(`${path}${query({ after: lastSequence })}`, {
        headers,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new ApiError(res.status, null);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const payload = parseFrame(frame);
          if (payload !== null) {
            // A sequence that skips ahead means the server's replay ring had
            // already dropped the events in between.
            if (lastSequence !== 0 && payload.sequence > lastSequence + 1) onGap?.(payload.sequence);
            lastSequence = payload.sequence;
            onEvent?.(payload);
          }
        }
      }
    } catch (cause) {
      if (closed || controller.signal.aborted) return;
      onError?.(cause);
    }
    // Reconnect after a short, fixed delay; the server holds the replay ring.
    if (!closed) timer = setTimeout(() => void connect(), 3000);
  };

  void connect();

  return () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    controller.abort();
  };
}

/** Extract the event JSON from one SSE frame, or null for a comment/heartbeat. */
function parseFrame(frame) {
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data: ")) dataLines.push(line.slice("data: ".length));
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length));
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs === "" ? "" : `?${qs}`;
}
