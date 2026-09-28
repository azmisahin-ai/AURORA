# AURORA — Roadmap

Status legend: ✅ done · 🚧 in progress · ⬜ not started · ⏭️ deferred

| Faz | Ad | Bağımlılık | Süre (tahmini) | Durum |
|---|---|---|---|---|
| 0 | Research + Architecture + ADR | — | 1–2 gün | ✅ |
| 1 | Core Agent Loop + CLI | Phase 0 | 2–3 gün | ✅ |
| 2 | Tool System + Permissions | Phase 1 | 2–3 gün | ✅ |
| 3 | Web Research + Knowledge | Phase 2 | 3–4 gün | ✅ |
| 4 | Code Execution + Verification | Phase 3 | 3–4 gün | ✅ |
| 5 | Sub-Agent System | Phase 4 | 3–4 gün | ✅ |
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

## Phase 3 acceptance

- [x] Research is possible with **no search API key**: `web_fetch` alone
      suffices; `web_search` degrades to an explanatory message.
      (`tests/integration/web-research.test.ts` § "degraded mode")
- [x] Knowledge written with its metadata and retrievable by keyword, with
      provenance (source URL, `retrievedAt`, `verified`) intact.
- [x] Prompt injection **fails**: fetched content is wrapped in a random-nonce
      `UNTRUSTED DATA` block, the payload is confined to exactly one block, and
      the payload never appears before the block opens.
- [x] SSRF is refused: `file://`, `localhost`, `169.254.169.254`, private
      literals, **and** the IPv6 hex form the URL parser rewrites them to.
      Verified against real DNS with `127.0.0.1.nip.io`.
- [x] Redirects are re-validated hop by hop.
- [x] Live end-to-end: a real model fetches a real page and writes a real
      knowledge entry, asserted **on disk** (`tests/integration/research-live.test.ts`).
- [x] `aurora research "<topic>"` and `aurora knowledge {list,search,show}` work
      from the terminal.

> No phase is advanced until the previous phase's acceptance criteria are met.

## Phase 4 acceptance

- [x] Failure classification covers transient/configuration/authentication/
      network/code/validation/permission/unknown, with an action per class
      (`tests/unit/errors/error-classifier.test.ts`).
- [x] Retry is **bounded**: `maxVerifications` caps the verify→repair loop, and
      exhausting it ends the run as `max_verifications`, never `completed`
      (`tests/unit/agent/verification.test.ts` § "escalates").
- [x] Verification runs on an **external signal** — a real process exit code —
      not the model's self-assessment (ADR 001/006).
- [x] The gate fires only after a workspace-mutating tool **succeeded**; a
      failed write and a non-mutating tool do not trigger it.
- [x] A `skipped` check is never reported as a pass, and the CLI prints
      `completed WITHOUT verification`.
- [x] Exit code 0 alone is not a pass: a vacuous `node --test` run (0 test
      files, exit 0 on Node v24.21.0) is treated as failure.
- [x] `run_tests` runs a real suite and reports the verdict from the exit code;
      the model-facing tool and the loop-trusted verifier share one parser.
- [x] Live end-to-end: the loop writes a red suite, the verifier rejects the
      completion, the model repairs it, and the green run is accepted —
      asserted against real processes (`tests/integration/verification-live.test.ts`).
- [x] Verification is opt-in; defaults preserve Phase 1–3 behaviour.

> No phase is advanced until the previous phase's acceptance criteria are met.

## Phase 5 acceptance

- [x] The main agent can delegate a research task to a Researcher sub-agent and
      get its result back (`tests/unit/agent/subagent-manager.test.ts`).
- [x] Sub-agents run in-process as role-based instances, not microservices
      (ADR 007).
- [x] Context isolation: a sub-agent receives only its role prompt and the
      delegated task — never the parent's transcript.
- [x] Least privilege is structural: a role's toolset is the intersection of its
      tool list and the parent's grant, with `FULL_ACCESS` never propagated. The
      reviewer's registry contains no write tool at all.
- [x] Sub-agents cannot delegate — `delegate` is absent from every role registry
      by construction, not by a depth check.
- [x] A delegated workspace mutation still triggers the parent's external
      verifier (`mutatedWorkspace` propagates dynamically).
- [x] A sub-agent's answer is wrapped as `UNTRUSTED DATA`.
- [x] Cost is bounded twice: per-delegation role budget and per-run
      `maxSubAgents`; exhausting the latter returns an error, not a crash.
- [x] Delegation is opt-in; `AURORA_MAX_SUB_AGENTS=0` restores the pre-Phase-5
      registry.
- [x] Live end-to-end: a real model delegates to a real coder sub-agent that
      writes a real file, asserted on disk and on the trajectory
      (`tests/integration/subagent-live.test.ts`).

> No phase is advanced until the previous phase's acceptance criteria are met.
