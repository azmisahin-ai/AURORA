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
| 6 | Persistence + Task Recovery | Phase 5 | 2–3 gün | ✅ |
| 7 | Context + Memory | Phase 6 | 2–3 gün | ✅ |
| 8 | Security Hardening | Phase 7 | 3–4 gün | ✅ |
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

## Phase 6 acceptance

- [x] A task record is durable: written atomically (temp file + `rename`), so a
      concurrent reader never observes a torn record. The claim has a test that
      fails if the rename is replaced by an in-place write
      (`tests/unit/task/file-task-store.test.ts`).
- [x] The six states (`queued`, `running`, `waiting`, `completed`, `failed`,
      `cancelled`) and every legal transition are declared in one table;
      an illegal move throws rather than silently corrupting the lifecycle.
- [x] Terminal states have no outgoing plain transitions; reviving a task goes
      through the named `requeue()` operation only.
- [x] After a restart, a `running` task is moved back to `queued` and can be
      restarted — the plan's criterion, verified by constructing a *second*
      store on the same directory (a real restart, not a flag)
      (`tests/integration/task-recovery.test.ts`).
- [x] Recovery is bounded (ADR 001/006): an interrupted task with no attempts
      left is `failed`, not requeued forever; the two outcomes are reported
      separately.
- [x] Corrupt records are reported and left in place, never silently dropped.
- [x] One poisoned record cannot stall the queue: an exhausted `queued` task is
      failed and skipped by `claimNext()`.
- [x] A run outcome maps to a lifecycle state by an explicit table; a
      resource-bound run retries, an `error` fails, `aborted` and
      `max_verifications` park in `waiting`.
- [x] `core/task` imports no provider or concrete tool; it drives work through a
      `TaskExecutor` port supplied by the composition root (ADR 001).
- [x] CLI: `tasks add | list | show | recover | run`; `recover` prints the
      requeued/exhausted/corrupt counts.

> No phase is advanced until the previous phase's acceptance criteria are met.

## Phase 7 acceptance

- [x] Context is bounded, not concatenated: each provider call is built by
      `ContextBuilder` against `AURORA_TOKEN_BUDGET`, while the loop keeps the
      full transcript. Measured on this host (4 KB observations, 8 000-token
      budget): 200 turns / 203 414 raw tokens → 7 181 bounded tokens
      (`docs/adr/009-memory-and-bounded-context.md`).
- [x] Compaction is ordered cheapest-and-least-lossy first: oversized tool
      observations are shortened (head + tail with a visible marker), then
      whole *turns* are elided oldest-first. Individual messages are never
      split from their `tool_calls` (`tests/unit/context/context-builder.test.ts`).
- [x] The system prompt, the recall block, and the task (the leading
      system/user run) survive every compaction. The protected head is counted
      dynamically, not fixed, so adding recall cannot silently unprotect the
      task. The omission notice is inserted after the head, never into the
      system prompt.
- [x] A transcript that still exceeds budget after every legal elision is
      reported (`overBudget`); the task is never dropped to fit.
- [x] Three memory tiers exist and are distinct: Working (in-memory transcript),
      Session (durable JSON records), Knowledge (Phase 3, tool-driven). The
      Knowledge tier is not duplicated.
- [x] Session records are durable across a real restart: a second runtime reads
      prior sessions from disk only
      (`tests/integration/session-memory.test.ts`; live:
      `tests/integration/memory-live.test.ts`).
- [x] Recall is *extractive*, not model-generated, and re-enters context wrapped
      as UNTRUSTED user data (nonce-delimited, size-capped) — never a system
      message. Model-based summarisation stays DOĞRULANACAK (ADR 009).
- [x] Session persistence cannot fail a run: a save error is logged and the
      run's output is returned unchanged.
- [x] Live end-to-end against real Ollama: a real run's session is written to
      disk and recalled by a fresh runtime, asserted on the record and recall
      block, not on model prose (`tests/integration/memory-live.test.ts`).
- [x] CLI: `sessions list | show | recall`; `run` gained `--recall-sessions`,
      `--no-recall`, `--context-budget`.

> No phase is advanced until the previous phase's acceptance criteria are met.

## Phase 8 acceptance

- [x] Credentials are redacted from operator-visible surfaces by *shape*, not
      only by known key path: vendor prefixes, JWTs, bearer tokens, PEM blocks
      and URL passwords (`tests/unit/security/secret-redactor.test.ts`). The
      path-based pino `redact` list is kept; the two layers are complementary.
- [x] Redaction does not fire on ordinary prose: an explicit false-positive
      corpus (code paths, `npm test`, versions, HTTP status lines, hashes,
      timestamps, e-mails) is asserted unchanged; 0/8 in the corpus.
- [x] A state-changing tool is confirmed before it runs. The gate has **three**
      outcomes — `approved`, `denied`, `unavailable` — because collapsing
      "denied" into "no input" would make an unattended run indistinguishable
      from a user's refusal (ADR 010).
- [x] The gate covers both a declared workspace mutation **and** any
      `COMMAND_EXECUTION` tool; a denied call does not execute and is logged
      (`tests/unit/tools/tool-registry-hardening.test.ts`).
- [x] A tool call whose serialised arguments exceed `AURORA_MAX_ARGUMENT_BYTES`
      is refused *before* validation and *before* the prompt, so a giant payload
      never reaches a terminal.
- [x] Network tools are bounded per tool by a token bucket; a denial returns an
      observation telling the model to slow down rather than throwing, keeping
      the loop recoverable. The clock is injected, so refill is tested exactly.
- [x] Secrets are scrubbed from the confirmation question and from the
      tool-denial log; the summary shown to the user is built from the *redacted*
      arguments, so a summary cannot leak what the arguments scrubbed.
- [x] The library fails closed: `prompt` mode has no safe default outside a
      terminal, so only the CLI builds a `PromptGate`; the library falls back to
      `DenyAllGate`.
- [x] `buildToolRegistry` wiring is itself tested (config → cap/gate/redactor/
      limiter), because a control that exists but is not connected is not a
      control. Two mutants that passed before this test existed are now caught.
- [x] `booleanFromString` treats `"false"`/`"0"` as false — the
      `z.coerce.boolean()` trap is a regression test, not a comment.
- [x] Live integration: real child processes, a real HTTP server, the real
      registry, real validators and a real pino logger
      (`tests/integration/security-hardening.test.ts`; canlı suite dahil
      481 test / 0 FAIL).

> No phase is advanced until the previous phase's acceptance criteria are met.

