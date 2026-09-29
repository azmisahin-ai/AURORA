# AURORA — Architecture

Autonomous Unified Research & Operations Runtime Agent.

This document describes the target architecture and the current state of the
build. It is updated as phases land.

## 1. Layers

Dependency direction is strictly inward:

```
        ┌────────────────────────────────────────────┐
        │                api / cli                    │  Phase 9
        └───────────────┬────────────────────────────┘
                        │
        ┌───────────────▼────────────────────────────┐
        │                  tools                      │  Phases 2–5
        │  (web, filesystem, execution, knowledge,    │
        │   agent/delegate)                           │
        └───────────────┬────────────────────────────┘
                        │
        ┌───────────────▼────────────────────────────┐
        │                providers                    │  Phases 1,3,4
        │  LLM │ Fetcher │ Search │ Execution         │
        │  (interfaces + concrete adapters)           │
        └───────────────┬────────────────────────────┘
                        │
        ┌───────────────▼────────────────────────────┐
        │                  core                       │  Phases 1,5,6,7
        │  agent │ planner │ memory │ knowledge │     │
        │  task │ context │ errors │ subagent/roles   │
        └────────────────────────────────────────────┘
```

`core` owns the interfaces it depends on and **must not import** `providers`
(ADR 001, ADR 003).

## 2. Core agent loop

```
observe → reason → plan → execute → verify → (repeat until done | bound hit)
```

- **observe**: assemble context (task, memories, knowledge, recent tool results).
- **reason**: call `LLMProvider.chat` / `.stream`.
- **plan**: `Planner.update(reasoning)` → next step or completion.
- **execute**: select and run a tool (permission-checked).
- **verify**: the completion gate (`AgentLoop.gateCompletion`). Fires **only**
  when a tool declaring `mutatesWorkspace` succeeded this run, and only when a
  `Verifier` is configured. It reads an **external signal** — a process exit code
  — never the model's bare self-assessment. A failing check feeds its
  classification back for repair; exhausting `maxVerifications` escalates with
  status `max_verifications`.

Bounded by `maxIterations`, `maxToolCalls`, `maxVerifications`, and
`AURORA_TIMEOUT_MS`. On bound exhaustion: escalate (report + stop).

## 3. Sub-agents (Phase 5, ADR 007)

`delegate` is a tool, so a delegation is visible in the trajectory. It stands up
a `SubAgentManager` (core), which runs a role-scoped `AgentLoop` with the role's
own system prompt, tool subset, and budget.

```
parent loop ──delegate(role, task)──▶ SubAgentManager ──▶ role AgentLoop
      ▲                                                        │
      └──────────── result (UNTRUSTED DATA) ◀──────────────────┘
```

- **Context isolation** — a sub-agent sees its role prompt and the task, never
  the parent's transcript.
- **Least privilege, structurally** — a role's registry is built from its tool
  list intersected with the parent's grant; a tool the role cannot afford is
  absent, not denied at call time. `FULL_ACCESS` never propagates.
- **No recursion** — `delegate` is not in any role's registry, so a sub-agent
  cannot reach it. Bounded by construction, not by a depth counter.
- **Delegated edits are verified** — a sub-agent that changed the workspace
  reports `mutatedWorkspace` dynamically, so the parent's Phase 4 verifier still
  runs before the answer is accepted.
- **Bounded twice** — per-delegation role budget and per-run `maxSubAgents`.
  `AURORA_MAX_SUB_AGENTS=0` disables delegation entirely.

## 4. Task persistence (Phase 6, ADR 008)

`core/task` keeps a durable record per unit of work: `<taskDir>/<id>.json`,
written atomically (temp file + `rename`).

```
TaskStore ── claimNext() ──▶ TaskRunner ── TaskExecutor port ──▶ AgentLoop
   ▲                              │                                   │
   └── update/requeue ◀── outcome ┤◀──── RunResult ───────────────────┘
   └── recover() on restart       │
```

- **States** — `queued`, `running`, `waiting`, `completed`, `failed`,
  `cancelled`, with every legal transition in one table. Terminal states have no
  outgoing plain transition; reviving goes through the named `requeue()`.
- **Recovery is bounded** — on restart a `running` task returns to `queued`
  while attempts remain, and is `failed` when they do not. Corrupt records are
  reported, not deleted.
- **Outcome mapping** — a resource-bound run (`timeout`, `max_iterations`,
  `max_tool_calls`) retries; an `error` fails; `aborted` and `max_verifications`
  park in `waiting`.
- **Layering holds** — `core/task` drives work through a `TaskExecutor` port;
  `AgentRuntime` supplies the adapter. No provider import.

## 5. Memory tiers (Phase 7, ADR 009)

| Tier | Scope | Storage |
|---|---|---|
| Working | current run's transcript | in-memory |
| Session | one conversation | file (one JSON per record) |
| Knowledge | cross-session | filesystem + metadata (ADR 002, tool-driven) |

```
AgentLoop ── full transcript (messages) ──┐
                                          ▼
                            ContextBuilder (bounded view per provider call)
                            1. in budget → unchanged
                            2. oversized tool observations shortened
                            3. oldest middle turns elided; head + tail kept
                            4. still over budget → reported, task never dropped

AgentRuntime.runTask ──▶ recall() ──▶ buildSessionRecall ──▶ wrapUntrusted
     │                        ▲                                   │
     └── after run ──▶ FileSessionStore (temp + rename)      injected as a
                                                              USER message
```

- **Session records are extracts, not transcripts** — task, status, tools,
  truncated answer, counters. Written atomically (temp + `rename`, the Phase 6
  lesson) and read back by a later process purely from disk.
- **Recall is extractive, never model-generated** — a deterministic assembly of
  stored fields. A generated summary would re-enter context as unverified fact
  (ADR 001); model summarisation stays DOĞRULANACAK.
- **Recall re-enters as UNTRUSTED user data** — nonce-wrapped and size-capped
  (ADR 004), injected *before* the task so the task stays the last instruction.
- **Bounded, not faithful** — the loop keeps the full transcript; only the
  provider call is trimmed. Compaction is lossy in a stated order, cheapest and
  least-lossy first, and never removes the system prompt, the recall block, or
  the task.

## 6. Knowledge layout (ADR 002)

```
knowledge/
  topics/<topic>/<slug>.md
  sources/<source-slug>.md
  research/<date>-<slug>/report.md
```

With JSON metadata (`topic`, `source`, `retrievedAt`, `provider`, `verified`).

## 7. Security (ADR 004, ADR 010)

- Untrusted web content wrapped in nonce delimiters, never treated as
  instructions.
- Permission model: READ_ONLY / WORKSPACE_WRITE / COMMAND_EXECUTION /
  NETWORK_ACCESS / FULL_ACCESS.
- Path traversal, SSRF, and command allowlist/denylist validation.
- Secret redaction in logs; zod config validation.
- **Phase 8 additions (ADR 010):**
  - Shape-based `SecretRedactor` (vendor prefixes, JWTs, bearer tokens, PEM
    blocks, URL passwords) applied to logs and confirmation prompts — not to the
    model's observations, which stay raw so a file containing a key is still
    readable. That boundary is stated, not implied.
  - A three-valued `ConfirmationGate` (`approved | denied | unavailable`) for
    state-changing tools: a declared workspace mutation or any
    `COMMAND_EXECUTION` tool. The CLI owns the only `PromptGate`; the library
    fails closed.
  - A per-tool `KeyedRateLimiter` bounding network tools (denial is an
    observation, not a throw) and a hard `maxArgumentBytes` cap applied before
    validation and before the prompt.
  - `buildToolRegistry` wiring is itself under test: config → cap/gate/redactor/
    limiter, with mutation guards.

## 8. HTTP API (Phase 9, ADR 011)

`src/api` is a peer of `cli`: it depends on `core` through a narrow port and on
`security`, and `core` never imports it. The server is a real `node:http` server
built from injected ports — no web framework, so no new dependency surface for
five routes (ADR 011 §1).

```
node:http ── auth ── rate limit ── router ──┬─▶ /health            (RuntimePort.health)
                                            ├─▶ /agent/run ──▶ RunRegistry ──▶ RuntimePort.runTask
                                            ├─▶ /agent/cancel ──▶ RunRegistry.cancel (AbortController)
                                            ├─▶ /runs/:id       (RunRegistry)
                                            ├─▶ /tasks/:id      (FileTaskStore)
                                            └─▶ /knowledge/search (FileKnowledgeStore)
```

- **Ports, not providers** — the server knows `RuntimePort` (`runTask`,
  `health`), not `LLMProvider`. `AgentRuntime` satisfies it structurally, so the
  real runtime is passed in production and a scripted fake in tests; the API
  suite therefore needs no model.
- **Async by default** — `POST /agent/run` returns `202` + `runId`; a run is
  polled via `GET /runs/:id` and aborted via `POST /agent/cancel`. `?wait=1`
  runs inline, bounded by `AURORA_API_MAX_SYNC_MS`, and answers `202` rather than
  hanging if the bound is reached.
- **Bounded** — at most `AURORA_API_MAX_CONCURRENT_RUNS` run at once (further
  requests get `429`), finished history is pruned, the body is capped while
  streaming, and requests are rate-limited per client by the Phase 8 limiter.
- **Runs are not persisted** — deliberately. A half-executed command is not
  resumable; durable work is Phase 6's `tasks`. Stated, not implied.
- **Trust model (ADR 011 §3)** — loopback bind by default; a non-loopback bind
  is refused at startup without a token; bearer auth is constant-time; `/health`
  is the only unauthenticated route.
- **Fail closed on mutation** — `AURORA_API_ALLOW_MUTATION` defaults to false, so
  an HTTP run gets a deny-all `ConfirmationGate`: a state-changing tool is
  refused because there is no terminal to confirm it. The Phase 8 seam is reused,
  not duplicated — this is the clearest payoff of keeping the gate a port.
- **Errors are scrubbed** — a provider error surfaced over HTTP (thrown or
  carried in an `error`-status result) passes through `SecretRedactor`, because
  log redaction does not reach a response body.

## 9. Current build state

This repository is being built phase by phase. As of the Phase 9 report:

- **Phase 0** — research docs and ADRs: complete.
- **Phase 1** — Config, LLM provider interfaces + Ollama/OpenAI-compatible
  providers, `AgentLoop`, `AgentRuntime`, `Planner`, CLI: complete.
- **Phase 2** — tool system, permissions, path/command validation: complete.
- **Phase 3** — web research, SSRF containment, untrusted-data wrapping,
  knowledge store: complete.
- **Phase 4** — code execution, error classification, external verification and
  the bounded repair loop: complete.
- **Phase 5** — role-based sub-agents, context isolation, least-privilege role
  toolsets, delegation as a tool, delegated-edit verification: complete.
- **Phase 6** — durable tasks: atomic records, checked transitions, bounded
  restart recovery, `tasks` CLI: complete.
- **Phase 7** — memory tiers and bounded context: session records on disk,
  extractive untrusted recall, budget-bounded provider calls, `sessions` CLI:
  complete.
- **Phase 8** — security hardening: shape-based secret redaction, three-valued
  confirmation gate, per-tool network rate limiting, argument size cap, and
  tested `buildToolRegistry` wiring: complete.
- **Phase 9** — CLI + API: `aurora serve`, a `node:http` API over injected ports
  with async runs, cancellation, bounded concurrency, auth, rate limiting and a
  fail-closed mutation policy: complete.

### Environment constraints observed during the build

- Node.js v24.21.0, npm 11.19.1.
- **Ollama may or may not be present.** Live-provider tests skip (and say so)
  when it is unreachable. Unit tests use a real local HTTP server (not a mocked
  provider) to exercise the HTTP/NDJSON code paths, and the API tests use a real
  server with a scripted runtime port.
- **`node --test` exits 0 when it matches no test files** (verified on Node
  v24.21.0). Verification treats that vacuous run as failure; see `ranNoTests`.
- Network egress works (npm registry and docs.ollama.com reachable), so research
  was performed live rather than from memory.

## 10. References

- `docs/roadmap.md` — phase plan and status.
- `docs/adr/*` — architectural decisions.
- `docs/research/*` — sourced research notes.
