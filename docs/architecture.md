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

## 5. Memory tiers (Phase 7)

| Tier | Scope | Storage |
|---|---|---|
| Working | current task | in-memory |
| Session | one conversation | file (JSON) |
| Knowledge | cross-session | filesystem + metadata |

## 6. Knowledge layout (ADR 002)

```
knowledge/
  topics/<topic>/<slug>.md
  sources/<source-slug>.md
  research/<date>-<slug>/report.md
```

With JSON metadata (`topic`, `source`, `retrievedAt`, `provider`, `verified`).

## 7. Security (ADR 004)

- Untrusted web content wrapped in nonce delimiters, never treated as
  instructions.
- Permission model: READ_ONLY / WORKSPACE_WRITE / COMMAND_EXECUTION /
  NETWORK_ACCESS / FULL_ACCESS.
- Path traversal, SSRF, and command allowlist/denylist validation.
- Secret redaction in logs; zod config validation.

## 8. Current build state

This repository is being built phase by phase. As of the Phase 6 report:

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

### Environment constraints observed during the build

- Node.js v24.21.0, npm 11.19.1.
- **Ollama may or may not be present.** Live-provider tests skip (and say so)
  when it is unreachable. Unit tests use a real local HTTP server (not a mocked
  provider) to exercise the HTTP/NDJSON code paths.
- **`node --test` exits 0 when it matches no test files** (verified on Node
  v24.21.0). Verification treats that vacuous run as failure; see `ranNoTests`.
- Network egress works (npm registry and docs.ollama.com reachable), so research
  was performed live rather than from memory.

## 8. References

- `docs/roadmap.md` — phase plan and status.
- `docs/adr/*` — architectural decisions.
- `docs/research/*` — sourced research notes.
