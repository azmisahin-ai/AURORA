# AURORA — Agent Notes

Persistent context for coding agents working in this repository.

## What this is

A provider-independent TypeScript agent runtime ("AURORA"). It is being built
phase by phase against `docs/roadmap.md`. **Do not advance a phase until the
previous phase's acceptance criteria are met and its tests pass.**

## Build & test

```bash
npm install
npm run build        # tsc
npm run typecheck    # tsc --noEmit
npm test             # vitest run (unit + integration)
npm run test:unit
```

## Non-negotiable project rules

1. **No fabricated claims.** Every technical assertion in docs must cite a
   source with an access date, or be tagged **DOĞRULANACAK**
   (`docs/research/sources.md` holds the consolidated list).
2. **No untested "success".** A test that was not run is not a pass. A skipped
   integration test must be reported as SKIP, never PASS.
3. **Provider independence.** Nothing in `src/core/**` may import from
   `src/providers/**` or from a vendor SDK. Providers implement AURORA-owned
   interfaces (`docs/adr/003`).
4. **Layering.** `core → providers → tools → api/cli`. Dependencies point
   inward only.
5. **Bounded loops.** Every agent loop has `maxIterations`, `maxToolCalls`, and
   a timeout. Exhaustion is a reported status, not an infinite retry.
6. **External verification only.** Self-critique without an external signal
   (test/lint/compiler output) is not a valid verifier (`docs/adr/001`).
7. **Untrusted data separation.** Web/tool content is `UNTRUSTED DATA`; it is
   never treated as a system instruction (`docs/adr/004`).
8. Write TypeScript with `strict` + `noUncheckedIndexedAccess`; run
   `npm run typecheck` before finishing.

## Testing conventions

- Tests live in `tests/unit/**` and `tests/integration/**`.
- Provider tests use a **real local HTTP server** (`node:http` on `127.0.0.1:0`)
  — not a mocked provider — so the actual client/NDJSON/error paths run.
- Live-provider tests skip when the provider is unavailable and print why.
  Env switches: `AURORA_TEST_OLLAMA=0|1`.
- Test doubles are acceptable only at genuine I/O boundaries (network, process);
  do not mock internal functions.

## Environment quirks

- **Ollama is not installed in the default build environment.** Do not assume it
  is running. The live integration test skips accordingly.
- Network egress works (npm registry, docs.ollama.com reachable).
- `file_editor` create/write can fail on a directory that does not exist yet —
  `mkdir -p` the parent first.

## Layout

```
src/core/        agent loop, planner, (later) memory/task/context/errors
src/providers/   LLM/web/execution adapters implementing owned interfaces
src/tools/       tool registry and tools (later phases)
src/security/    path/url/command validation, secret redaction (later)
src/cli/         commander entry point
docs/research/   sourced research notes
docs/adr/        architecture decision records
knowledge/       runtime knowledge store (gitignored contents)
```

## Current provider surface

`LLMProvider` (`src/providers/llm/LLMProvider.ts`): `chat` required; `stream`,
`listModels`, `health` optional. Concrete implementations:
`OllamaProvider`, `OpenAICompatibleProvider`. Vendor-specific options go in the
opaque `options` bag so they never leak into core.
