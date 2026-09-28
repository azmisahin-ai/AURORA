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
        │                  tools                      │  Phases 2–4
        │  (web, filesystem, execution, knowledge)    │
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
        │  task │ context │ errors                    │
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

## 3. Memory tiers (Phase 7)

| Tier | Scope | Storage |
|---|---|---|
| Working | current task | in-memory |
| Session | one conversation | file (JSON) |
| Knowledge | cross-session | filesystem + metadata |

## 4. Knowledge layout (ADR 002)

```
knowledge/
  topics/<topic>/<slug>.md
  sources/<source-slug>.md
  research/<date>-<slug>/report.md
```

With JSON metadata (`topic`, `source`, `retrievedAt`, `provider`, `verified`).

## 5. Security (ADR 004)

- Untrusted web content wrapped in nonce delimiters, never treated as
  instructions.
- Permission model: READ_ONLY / WORKSPACE_WRITE / COMMAND_EXECUTION /
  NETWORK_ACCESS / FULL_ACCESS.
- Path traversal, SSRF, and command allowlist/denylist validation.
- Secret redaction in logs; zod config validation.

## 6. Current build state

This repository is being built phase by phase. As of the Phase 4 report:

- **Phase 0** — research docs and ADRs: complete.
- **Phase 1** — Config, LLM provider interfaces + Ollama/OpenAI-compatible
  providers, `AgentLoop`, `AgentRuntime`, `Planner`, CLI: complete.
- **Phase 2** — tool system, permissions, path/command validation: complete.
- **Phase 3** — web research, SSRF containment, untrusted-data wrapping,
  knowledge store: complete.
- **Phase 4** — code execution, error classification, external verification and
  the bounded repair loop: complete.

### Environment constraints observed during the build

- Node.js v24.21.0, npm 11.19.1.
- **Ollama may or may not be present.** Live-provider tests skip (and say so)
  when it is unreachable. Unit tests use a real local HTTP server (not a mocked
  provider) to exercise the HTTP/NDJSON code paths.
- **`node --test` exits 0 when it matches no test files** (verified on Node
  v24.21.0). Verification treats that vacuous run as failure; see `ranNoTests`.
- Network egress works (npm registry and docs.ollama.com reachable), so research
  was performed live rather than from memory.

## 7. References

- `docs/roadmap.md` — phase plan and status.
- `docs/adr/*` — architectural decisions.
- `docs/research/*` — sourced research notes.
