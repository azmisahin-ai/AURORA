# ADR 001 — Core Architecture: ReAct + Reflexion with Layered Boundaries

- Status: Accepted
- Date: 2026-09-28
- Deciders: AURORA build

## Context

AURORA must run an autonomous research-and-operations loop. The research pass
(`docs/research/agent-architectures.md`) surveyed the five canonical architectures
and found the production consensus is: start with ReAct, add Reflexion only when
failure modes repeat, and require an *external* signal before trusting any
self-critique.

## Decision

1. The base loop is **ReAct** (`observe → reason → plan → execute → verify`).
2. A **Reflexion-style verification layer** sits on top, and it may only act on
   an **external verification signal** (test result, compiler/lint output, tool
   error) — never on the model's bare self-assessment.
3. The codebase is split into strict layers:
   `core → providers → tools → api/cli`. **`core` must not import `providers`.**
   Dependency direction is inward: providers implement interfaces owned by core
   or by a shared `providers/*` interface module; tools depend on core types and
   on provider *interfaces*, not concrete providers.
4. Every loop is **bounded**: `maxIterations`, `maxToolCalls`, and a global
   timeout. Exceeding a bound triggers escalation (report + stop), not an
   unbounded retry.

## Rationale

- ReAct as default is supported independently by futureagi.com and MLflow (see
  research file §1.1).
- ReAct + Reflexion as the "production-grade single-agent stack" is the explicit
  recommendation of digitalapplied.com (§2).
- The external-signal requirement is forced by arXiv 2606.05976 ("LLMs correct
  others but not themselves") and the information-theoretic analysis (§3).
- Layering enforces the plan's provider-independence rule and makes providers
  swappable behind interfaces.

## Alternatives considered

- **Plan-Execute first** — rejected for MVP: planning is not the observed
  bottleneck, and it adds a second LLM round-trip per task.
- **Tree-of-Thoughts** — rejected: 10–100x token cost for no MVP benefit.
- **Framework adoption (LangGraph etc.)** — deferred; see ADR 003.

## Consequences

- Verification quality depends on having *real* external signals (tests), so
  Phase 4 is a hard dependency for meaningful Reflexion.
- Two-loop design (base + verify) increases complexity; kept minimal by making
  verification a distinct step in `AgentLoop`, not a separate agent.
- Bounded retries mean some tasks will legitimately fail and escalate; this is
  intended and must be surfaced to the user, not hidden.

## Compliance

- `tests/unit` asserts max-iteration and max-tool-call bounds.
- A lint rule / code review check keeps `core` free of `providers` imports.
