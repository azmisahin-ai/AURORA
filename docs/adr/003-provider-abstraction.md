# ADR 003 — Provider Abstraction: Interfaces Over Frameworks

- Status: Accepted
- Date: 2026-09-28

## Context

AURORA must not lock into any LLM, search, fetch, or execution vendor. The
framework survey (`docs/research/frameworks-comparison.md`) found no framework
wins on all axes; framework choice alone can shift benchmark results by up to 30
percentage points (uvik.net), so the choice is real but never universally right.

## Decision

1. Define AURORA-owned interfaces for every external capability:
   - `LLMProvider` — `chat`, optional `stream`, optional `listModels`, optional
     `health`.
   - `Fetcher` — fetch a URL → text/markdown.
   - `SearchProvider` — query → results.
   - `ExecutionProvider` — run a command → exit code + stdout/stderr.
   - `KnowledgeStore` — read/write/search knowledge (ADR 002).
2. Ship concrete MVP implementations:
   - `OllamaProvider` and `OpenAICompatibleProvider` (LLM).
   - `DirectFetcher` (fetch).
   - `NoopSearchProvider` (search — no API key required).
   - `LocalExecutionProvider` (execution).
3. **No framework is a dependency of `core`.** Any framework integration is an
   adapter behind one of the interfaces above and must be removable without
   touching `core`.
4. Providers are selected by configuration (`AURORA_LLM_PROVIDER`, …) with a
   factory/registry, not by imports scattered through the codebase.

## Rationale

- Enforces the plan's "Provider bağımsızlığı" rule.
- Matches the industry finding that mature teams use two or three frameworks
  *behind* their own abstractions (requesty.ai).
- Keeps `NoopSearchProvider` viable so the system works with zero API keys.

## Alternatives considered

- **Adopt LangGraph/OpenAI SDK directly in core** — rejected: couples core to a
  vendor and its release cadence; would violate `core → providers` separation.
- **Single monolithic provider module** — rejected: blocks per-capability
  swapping and complicates testing.

## Consequences

- Slight boilerplate: each new vendor needs an adapter.
- The interface must stay minimal to avoid leaking vendor-specific features
  (e.g. Ollama's `think` field) into core. Vendor-specific options go in an
  opaque `options` bag.
- Streaming is optional (`stream?`) so providers that can't stream are still
  valid.

## Compliance

- Unit tests exercise `AgentLoop` against a fake `LLMProvider` implementing the
  interface only.
- Integration tests for Ollama are skipped when Ollama is absent (reported SKIP).
