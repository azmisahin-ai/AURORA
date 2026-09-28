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
- **verify**: Reflexion step. Uses an **external signal** only (test/lint/build
  output). Never the model's bare self-assessment.

Bounded by `maxIterations`, `maxToolCalls`, and `AURORA_TIMEOUT_MS`. On bound
exhaustion: escalate (report + stop).

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

This repository is being built phase by phase. As of the Phase 0/1 report:

- **Phase 0** — research docs and ADRs: complete.
- **Phase 1** — Config, LLM provider interfaces + Ollama/OpenAI-compatible
  providers, `AgentLoop`, `AgentRuntime`, `Planner`, CLI: see the phase report.

### Environment constraints observed during the build

- Node.js v24.21.0, npm 11.19.1.
- **Ollama is not installed and not running in this environment.** Any test that
  requires a live Ollama is skipped and reported as SKIP. Unit tests use a real
  local HTTP server (not a mocked provider) to exercise the HTTP/NDJSON code
  paths.
- Network egress works (npm registry and docs.ollama.com reachable), so research
  was performed live rather than from memory.

## 7. References

- `docs/roadmap.md` — phase plan and status.
- `docs/adr/*` — architectural decisions.
- `docs/research/*` — sourced research notes.
