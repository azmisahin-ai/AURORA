# ADR 011 — HTTP API: layer placement, framework, and trust model

Status: Accepted (Phase 9)
Date: 2026-09-28
Related: ADR 001 (core architecture), ADR 004 (security/permissions),
ADR 010 (security hardening)

## Context

Phase 9 adds the "API" half of `api/cli`. Phase 0 deferred the framework choice
to this phase on purpose: "Framework seçimleri (Express/Fastify/Hono) Phase 9'da
araştırılarak yapılacak. MVP'de HTTP API yok, CLI var."

Three questions have to be answered before any code:

1. Which HTTP layer — a framework, or Node's built-in `http`?
2. Where does the API sit relative to `core` and `cli`?
3. What is the API's **trust model**? This runtime executes commands and writes
   files; exposing it over HTTP is a privilege-boundary decision, not a routing
   decision.

## Decision 1 — Framework: Node's built-in `node:http`

The 2026 framework landscape (sourced below) is genuinely three-tiered, and each
option is defensible:

| Option | Strength | Why not chosen here |
|---|---|---|
| Express 5 | 30–76M weekly downloads, universal familiarity, vast middleware | Weaker TypeScript story (`@types/express`), slowest of the three, and no built-in schema validation or structured logging — the two things this API actually needs. |
| Fastify 5 | Native TypeScript, JSON-schema validation, **built-in pino logger**, fast | A good fit, but it brings its own request/reply/schema/plugin model. AURORA already owns zod schemas, pino, and a config loader; Fastify would duplicate them. |
| Hono 5 | Web-Standard `Request`/`Response`, runtime-portable, very fast, tiny | The portability is real value *if* portability is a goal. For a process-scoped operational API that runs on Node beside the runtime, `@hono/node-server` is an adapter layer between two abstractions we do not need to span. |
| **`node:http`** | **Zero new dependency; no version-drift or transitive-dependency surface (see the `@hono/node-server` advisory history below); the API surface here is five routes** | It means writing a ~60-line router by hand. Acceptable at this size; revisit if the route count grows past a handful. |

The deciding factors are **dependency surface** and **scope**:

- This is a small, process-scoped operational API (health, run, cancel, task
  lookup, knowledge search). It is not a public product API that will be
  fronted by a CDN or run on Workers. The framework's marquee features
  (validation, logging, plugins, edge portability) are either already supplied
  by AURORA's own stack or irrelevant to the deployment target.
- `@hono/node-server` in particular has a recent **Directory Traversal**
  advisory (`>=2.0.0-rc.1 <2.0.5` and `<1.19.17`) and an unthrottled-resource
  advisory (`>=2.0.0 <2.0.10`). Those affect its static-file and body handling,
  which we would not use — but adding a dependency whose advisories we must
  reason about, to route five endpoints, is a poor trade for a security-focused
  runtime.
- The project keeps a deliberately thin dependency list (`cheerio`,
  `commander`, `pino`, `turndown`, `undici`, `zod`). Adding a web framework is a
  category of dependency this phase does not need.

**Performance is not a factor.** Every sourced comparison agrees that with real
work behind the route — and here every request drives an LLM or a filesystem
read — the frameworks converge to a few thousand req/s. Benchmark deltas of
45K vs 77K req/s are irrelevant when the handler calls a model.

This is recorded as a decision, not a law: the ADR names the trigger to revisit
(route count growth, or a real need for runtime portability).

## Decision 2 — Layer placement

`api` depends on `core` (via a narrow port) and on `security`, exactly like
`cli`. `core` must never import `api` (ADR 001). Concretely:

- `src/api/server.ts` builds a `node:http` server from injected **ports**
  (`RuntimePort` for running/cancelling agents, a `TaskStore`, a
  `KnowledgeStore`). It constructs no provider and knows no LLM.
- `AgentRuntime` satisfies `RuntimePort` structurally, so the composition root
  passes the real runtime in, but the server can equally be tested with a
  scripted fake — which is how the API tests run with **no Ollama**.
- `bin`/CLI: `aurora serve` constructs the runtime and the server.

## Decision 3 — Trust model (the important one)

An HTTP API in front of an agent that runs commands and writes files is a
privilege boundary. Choices, each with a test:

1. **Loopback by default.** `AURORA_API_HOST` defaults to `127.0.0.1`, not
   `0.0.0.0`. A bind to a non-loopback address is **refused at startup unless an
   auth token is configured** — binding a command-executing agent to a public
   interface with no auth is a misconfiguration so dangerous that failing loudly
   is better than serving.
2. **Bearer token auth when configured.** `AURORA_API_TOKEN`, compared with a
   constant-time equality to avoid a timing oracle. Health is the only
   unauthenticated route (an operator must be able to probe liveness without a
   secret; it leaks nothing that `curl /` would not).
3. **Fail closed on mutation over HTTP.** This is the ADR 010 seam paying off.
   An API request has no stdin, so there is no one to answer a confirmation
   prompt. `AURORA_API_ALLOW_MUTATION` defaults to **false**: a `POST /agent/run`
   runs with a `DenyAllGate`, so a state-changing tool is refused. Running a
   mutating workload over HTTP is an explicit opt-in
   (`AURORA_API_ALLOW_MUTATION=true`, which uses `AllowAllGate`). The default
   API is therefore *read/research-shaped*, not a remote command executor.
4. **Bounded request body.** `AURORA_API_MAX_BODY_BYTES` caps the request body
   (default 256 KiB), enforced while streaming: the connection is destroyed once
   the cap is crossed, so a client cannot exhaust memory before the handler runs.
5. **Rate limiting per client.** A `KeyedRateLimiter` (the Phase 8 class, reused
   rather than reinvented) keyed by remote address, returning `429` with
   `Retry-After`.
6. **JSON in, JSON out; no HTML.** Error responses are JSON with a stable shape;
   `Content-Type` is set explicitly. No route echoes raw request bytes.
7. **Secrets never invalidated by a health check.** `/health` reports provider
   *reachability*, not credentials.

### Long-running work over HTTP

A run can take minutes. Two mechanisms:

- **Async by default:** `POST /agent/run` returns `202` with a `runId`
  immediately; `GET /runs/:id` reports status/result; `POST /agent/cancel`
  aborts via an `AbortController`. This is the natural shape for an agent and
  avoids holding a socket open for minutes.
- **Optional sync:** `?wait=1` (or `{wait:true}`) runs inline and returns the
  finished `RunResult`, bounded by `AURORA_API_MAX_SYNC_MS` (default 30 s), after
  which the run keeps going and the response is `202`. A caller who asked to
  wait is never left with a hung socket.

`RunRegistry` is bounded: at most `AURORA_API_MAX_CONCURRENT_RUNS` (default 2)
run at once; beyond that a new run is rejected `429` rather than queued
unboundedly. Runs live in memory only — a server restart loses in-flight runs,
which is honest (a half-executed command is not resumable), and is stated here
rather than implied. Durable work belongs to Phase 6 tasks (`aurora tasks`),
which persist; the API is the interactive surface.

## Consequences

- No new runtime dependency; the API is testable with a real server on
  `127.0.0.1:0` and a fake runtime port, so its integration tests need no model.
- The mutation opt-in means the default `POST /agent/run` cannot write files;
  callers who need that use the CLI or flip the flag deliberately.
- Handler growth is now a cost we own. The revisit trigger is explicit in
  Decision 1.

## Sources (accessed 2026-09-28)

- APIScout — Hono vs Fastify vs Express: API Framework 2026 —
  https://apiscout.dev/guides/hono-vs-fastify-vs-express-api-framework-2026
- Cadence — Express vs Fastify vs Hono in 2026 —
  https://cadence.withremote.ai/blog/express-vs-fastify-vs-hono
- PkgPulse — Express vs Fastify 2026 —
  https://www.pkgpulse.com/guides/express-vs-fastify-2026
- Kanopy Labs — Hono vs Express vs Fastify 2026 —
  https://kanopylabs.com/blog/hono-vs-express-vs-fastify-backend-frameworks
- honojs/node-server — README —
  https://github.com/honojs/node-server
- Snyk — `@hono/node-server` advisories —
  https://security.snyk.io/package/npm/%40hono%2Fnode-server

> Benchmark figures above are vendor/secondary and are **DOĞRULANACAK** for our
> workload; they are cited to show *why performance was not the deciding
> factor*, not as AURORA measurements.
