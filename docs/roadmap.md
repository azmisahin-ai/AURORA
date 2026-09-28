# AURORA — Roadmap

Status legend: ✅ done · 🚧 in progress · ⬜ not started · ⏭️ deferred

| Faz | Ad | Bağımlılık | Süre (tahmini) | Durum |
|---|---|---|---|---|
| 0 | Research + Architecture + ADR | — | 1–2 gün | ✅ |
| 1 | Core Agent Loop + CLI | Phase 0 | 2–3 gün | 🚧 |
| 2 | Tool System + Permissions | Phase 1 | 2–3 gün | ⬜ |
| 3 | Web Research + Knowledge | Phase 2 | 3–4 gün | ⬜ |
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

- [ ] `aurora run "Merhaba de"` returns a real LLM response to the terminal.
- [ ] If Ollama is absent, it errors clearly — never reports a mock as working.
- [ ] Unit tests pass; integration tests gated on Ollama presence.

> No phase is advanced until the previous phase's acceptance criteria are met.
