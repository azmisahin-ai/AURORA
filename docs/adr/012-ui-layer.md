# ADR 012 — UI: layer placement, no-build choice, and untrusted-render policy

Status: Accepted (Phase 10)
Date: 2026-09-28
Related: ADR 001 (core architecture), ADR 004 (security/permissions),
ADR 010 (security hardening), ADR 011 (HTTP API)

## Context

Phase 10 is the last layer: a web UI over the API. The Phase 0 plan fixed the
shape before any code existed:

> **Kural:** UI, çekirdek stabil olduktan sonra eklenir. Çekirdek API'sine
> bağlanır.

and the deliverables: a task panel, an agent panel (active agents/sub-agents), a
knowledge browser, and a trajectory view (tool-call history).

Three questions have to be answered before any code, and one of them is a
security question, not a styling one:

1. **Framework or none?** React/Vue/Svelte with a bundler, or plain ES modules?
2. **Where does `ui/` sit?** It is a separate package per the roadmap — separate
   from what, exactly?
3. **How is untrusted content rendered?** This is the important one. The UI's
   whole job is to display: agent output, tool observations, and knowledge
   entries that were **fetched from the open web** (Phase 3). All of that is
   `UNTRUSTED DATA` by ADR 004. A web UI that renders it as HTML turns a
   prompt-injection payload into a **stored XSS** — the same bytes that were
   data in the agent loop become executable in an operator's browser.

## Decision 1 — No framework, no build step

The UI is plain ES modules, plain CSS, and one HTML file. No bundler, no JSX, no
`node_modules` for the UI.

Reasoning, consistent with ADR 011 §1:

- **The dependency rule is the same one.** ADR 011 refused a web framework for
  five routes because AURORA keeps a thin dependency list. A frontend toolchain
  (React + a bundler + a dev server + a plugin tree) is a *much* larger surface
  than the server framework that was refused. Refusing the small one and
  accepting the large one would be incoherent.
- **The UI is a read-mostly viewer.** It polls three list endpoints and renders
  tables, a detail pane and a trajectory list. There is no client-side state
  graph that would justify a reactive framework.
- **No build step means no build artifact to serve.** The API serves `ui/`
  directly (Decision 2). There is no `dist/`, no sourcemap leak, no stale bundle
  — and `npm run build` stays "compile `src/`", unchanged.
- **Testability is preserved.** Formatting and status-mapping rules live in a
  pure module (`ui/lib/format.js`) that Node imports directly, so they are
  unit-tested with no DOM at all. The DOM builders (`ui/lib/dom.js`,
  `ui/lib/panels.js`) are tested under `jsdom`, which is a **dev-only**
  dependency — it is not shipped and not needed to run the UI. This distinction
  is stated because "no DOM needed" would have been false for the builders.

**Revisit trigger, stated rather than implied:** if the UI needs real-time
streaming, optimistic local state, or a component tree deep enough that manual
DOM updates become the source of bugs, adopt a framework then. Not now.

## Decision 2 — Layer placement: `ui/` is a separate package served by `api`

```
core → providers → tools → api/cli → ui
                              ▲
                              └── serves ui/ as static files, and ui/ calls
                                  only the HTTP API
```

- `ui/` is a **separate package** (its own `ui/package.json`, no dependencies)
  because it has a different runtime target (a browser), a different module
  graph, and no compile step. `tsconfig.json` already excludes `ui`.
- `ui/` talks to the core **only over HTTP**, through `src/api`. It imports no
  `src/` module, so it cannot become a second entry point into `core` — the
  failure ADR 001 exists to prevent.
- `src/api` serves the files. This keeps the UI same-origin with the API, which
  is what lets the CSP in Decision 3 be strict (`connect-src 'self'`) and avoids
  CORS entirely.

Serving static files means handling a path from the network, so it goes through
the existing `PathValidator` (ADR 004) rooted at `ui/` — the same containment
check the filesystem tools use, not a second implementation. `..` traversal and
symlink escape are already that class's tested job.

The symlink half is worth stating explicitly, because the first cut of this route
got it wrong: it used `resolve`, the *lexical* check, which accepts a path that
only looks contained. A file `ui/escape.txt` that is a symlink to
`../outside/secret.txt` passes the lexical check and is then served — and this
route is reachable **without a token**. The route therefore uses `resolveReal`,
the symlink-aware method, which is why it is `async`. A mutation test (M1) breaks
exactly this and expects the suite to go red.

### Auth: the shell is public, the data is not

`GET /health` is unauthenticated (ADR 011 §3). Phase 10 adds the UI assets to
that set, for a specific reason: a browser **cannot attach an `Authorization`
header to a top-level navigation**, so a token-gated `index.html` is unreachable
without a URL-borne token — and a token in a URL is logged by every proxy on the
path. That is a worse trade.

So: **the shell is served without a token; every data route still requires one.**
The shell contains no data and no secrets — it is the same source that is in the
repository. The UI asks for the token once and keeps it in **`sessionStorage`**,
not `localStorage`: it should not outlive the tab, and it should not be readable
by a future same-origin script months later. If no token is configured (the
loopback default), the UI needs no prompt.

## Decision 3 — Untrusted content is rendered as text, never as HTML

This is the decision the phase turns on. Two layers, because one is not enough:

1. **Structural: text-only rendering.** Every value from the API is inserted with
   `textContent`. There is no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or
   `document.write` anywhere in `ui/`. The single DOM builder (`ui/lib/dom.js`)
   has no code path that can interpret a string as markup — a knowledge entry
   whose body is `<img src=x onerror=…>` becomes visible *characters*, which is
   also the honest thing to show an operator inspecting a suspicious source.
   This is enforced by a **source-guard test**, because the property is "no such
   call exists", and a behavioral test can only probe the payloads we thought of.
2. **Defense-in-depth: a restrictive CSP.** Static responses carry
   `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
   img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors
   'none'; object-src 'none'`. With `script-src 'self'` and no inline scripts or
   styles, an injected `<script>` would not execute even if the structural layer
   were bypassed. `connect-src 'self'` also means a successful injection could
   not exfiltrate to an attacker's origin.

The UI additionally never renders a link whose `href` came from the API as a
clickable anchor with an arbitrary scheme — external source URLs are shown as
text plus a link restricted to `http`/`https`, mirroring the `UrlValidator` rule
from Phase 3. A `javascript:` URL in a knowledge entry's `source` field must not
become a clickable script.

**What this does not claim.** The UI does not sanitize HTML for display, because
it never renders HTML. If a future panel genuinely needs rich rendering (e.g.
rendered Markdown), it must go through an explicit, audited sanitizer — that is
tagged **DOĞRULANACAK** below, not assumed.

## Consequences

- No UI dependency, no build step; `npm run build` and `npm test` are unchanged
  in scope. The UI is served from source.
- The UI is testable in two ways that need no browser: pure modules under
  `ui/lib/` are imported and unit-tested by Node, and the XSS property is
  guarded by a source scan. A real-browser smoke test (the environment has one)
  is used to confirm the panels actually load and that an injected payload
  renders inert — recorded in the Phase 10 report.
- The API grows read endpoints for the panels — `GET /runs`, `GET /tasks`, `GET
  /knowledge`, `GET /knowledge/:kind/:slug` — plus the static route. This is the
  "route count growth" trigger ADR 011 named; it is still a handful of routes, so
  the `node:http` decision stands, and ADR 011 §1 records when to revisit.
- A public UI shell is a deliberate, bounded exposure: it is source that is
  already public in the repository, and it carries no data.

## Open items (DOĞRULANACAK)

- **Markdown/rich rendering.** Not implemented; would require an audited
  sanitizer and a fresh ADR. Until then everything is text.
- **CSRF.** With a bearer token in a header (not a cookie), classic CSRF does not
  apply — an attacker's page cannot read `sessionStorage` for this origin and
  cannot set the header cross-origin without a CORS preflight we do not allow.
  This reasoning is sound but is **not** covered by a dedicated test; tagged
  DOĞRULANACAK.

## Resolved after the initial ADR (2026-09-29)

- **Real-time updates (was: "the UI polls; there is no SSE/WebSocket endpoint").**
  The run view now streams over SSE: the runtime emits into a single `EventBus`,
  `GET /runs/:id/events` (and `GET /events`) frame it as `text/event-stream`, and
  `ui/lib/api.js` consumes it with `fetch` + a streaming reader rather than
  `EventSource` — `EventSource` cannot send an `Authorization` header, and a
  token in a query string is logged by every proxy on the path (§2 above). The
  client reconnects with `?after=<lastSequence>` and the server replays the gap
  from a bounded ring, so a reconnect does not silently lose events. List views
  still poll; only the run timeline streams.
- **`app.js` event wiring had no automated test (was a "Kalan Problem" in the
  Phase 10 report).** The pure rules it depends on are now unit-tested
  (`eventClass`, `summarizeEvent` in `tests/unit/ui/format.test.ts`) and the
  timeline builder is tested under jsdom (`eventTimeline`, including a hostile
  payload, in `tests/unit/ui/panels.test.ts`). The `fetch`-based SSE client
  (`ui/lib/api.js`) is tested against a real `node:http` server in
  `tests/integration/ui-sse-client.test.ts` — reconnect with `?after`, gap
  detection, and disposer teardown are all exercised over a real socket. The
  `app.js` wiring itself is now covered too: `tests/integration/ui-app-wiring.test.ts`
  boots the module under jsdom against the real `index.html` and a real
  `node:http` server, then clicks through to a run — asserting that the timeline
  mounts, that the subscription is torn down when the operator leaves the Agents
  view (proved by the server observing the client abort, not merely by the
  timeline disappearing), and that a replay gap marks the timeline. Three
  mutations (removing the teardown, dropping `onGap`, removing the timeline)
  each turn the suite red.

## Sources (accessed 2026-09-28)

- MDN — Content-Security-Policy `script-src` and `connect-src` —
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy
- OWASP — Cross Site Scripting Prevention Cheat Sheet (output encoding) —
  https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
- MDN — `sessionStorage` vs `localStorage` lifetime —
  https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage
- Phase 3 `docs/research/security.md` — untrusted-data handling (ADR 004)

> CSP header values are cited from the specification; that they *contain* a given
> payload in a specific browser is **DOĞRULANACAK** by the browser smoke test in
> the Phase 10 report, not assumed from the spec.
