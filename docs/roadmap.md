# AURORA — Roadmap

Status legend: ✅ done · 🚧 in progress · ⬜ not started · ⏭️ deferred

| Faz | Ad | Bağımlılık | Süre (tahmini) | Durum |
|---|---|---|---|---|
| 0 | Research + Architecture + ADR | — | 1–2 gün | ✅ |
| 1 | Core Agent Loop + CLI | Phase 0 | 2–3 gün | ✅ |
| 2 | Tool System + Permissions | Phase 1 | 2–3 gün | ✅ |
| 3 | Web Research + Knowledge | Phase 2 | 3–4 gün | 🚧 |
| 4 | Code Execution + Verification | Phase 3 | 3–4 gün | ⬜ |
| 5 | Sub-Agent System | Phase 4 | 3–4 gün | ⬜ |
| 6 | Persistence + Task Recovery | Phase 5 | 2–3 gün | ⬜ |
| 7 | Context + Memory | Phase 6 | 2–3 gün | ⬜ |
| 8 | Security Hardening | Phase 7 | 3–4 gün | ⬜ |
| 9 | CLI + API | Phase 8 | 2–3 gün | ⬜ |
| 10 | UI (ayrı katman) | Phase 9 | 4–5 gün | ⬜ |

## Phase 0 acceptance

- [x] `docs/research/*.md` created for architectures, memory, RAG, multi-agent,
      MCP, security, frameworks, Ollama API.
- [x] `docs/research/sources.md` lists every URL with access date.
- [x] `docs/adr/001..004` written.
- [x] All unverified claims tagged **DOĞRULANACAK** (see `sources.md` §
      "Consolidated list").

## Phase 1 acceptance

- [x] `aurora run "Merhaba de"` returns a real LLM response to the terminal.
      Verified against Ollama v0.34.4 + `qwen3.5:4b`.
- [x] If Ollama is absent, it errors clearly — never reports a mock as working.
- [x] Unit tests pass; integration tests gated on Ollama presence.

## Phase 2 acceptance

- [x] The agent can use permitted tools; a tool call without the required
      permission is refused **and** recorded in the log
      (`tests/integration/permissions.test.ts`).
- [x] `ToolRegistry` is the loop's `ToolExecutor`; `core` still imports no tool
      code (dependency direction intact).
- [x] Tool arguments are validated against the tool's zod schema before
      execution; the JSON Schema offered to the model is derived from the same
      schema.
- [x] `PathValidator` rejects `../../etc/passwd`, absolute paths outside the
      workspace, NUL bytes, and symlink escapes.
- [x] `CommandValidator` rejects shell metacharacters and non-allowlisted
      commands; execution is `shell: false`.
- [x] Live end-to-end: a real model writes a file through the tool system and
      the file is verified on disk (`tests/integration/tool-use-live.test.ts`).

> No phase is advanced until the previous phase's acceptance criteria are met.
