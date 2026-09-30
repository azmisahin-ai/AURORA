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
| 9 | CLI + API | Phase 8 | 2–3 gün | ✅ |
| 10 | UI (ayrı katman) | Phase 9 | 4–5 gün | ✅ |

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
      483 test / 0 FAIL).

> No phase is advanced until the previous phase's acceptance criteria are met.

## Phase 9 acceptance

Framework choice researched at implementation time, as Phase 0 required, and
recorded in ADR 011.

- [x] **CLI:** `run`, `research`, `tasks`, `knowledge`, `sessions` already
      existed; Phase 9 adds `serve` to start the API. `tests/unit/cli.test.ts`
      asserts every command is registered and that `serve` exposes
      `--host/--port/--allow-mutation`.
- [x] **HTTP API:** `GET /health`, `POST /agent/run`, `POST /agent/cancel`,
      `GET /runs/:id`, `GET /tasks/:id`, `GET /knowledge/search` — all over a
      real `node:http` server in `tests/integration/api.test.ts` (15 tests), with
      a scripted runtime port so the suite needs **no Ollama**.
- [x] **Async by default:** `POST /agent/run` returns `202` + `runId`;
      `GET /runs/:id` reports the result; `POST /agent/cancel` aborts a running
      run via `AbortController` and the run reports `cancelled`. `?wait=1` runs
      inline, bounded by `AURORA_API_MAX_SYNC_MS`, and never hangs a socket.
- [x] **Bounded concurrency:** beyond `AURORA_API_MAX_CONCURRENT_RUNS`, a new
      run is refused `429`, not queued unboundedly. History is pruned, so a
      long-lived server is not a memory leak with a nice API.
- [x] **Trust model (ADR 011 §3):** loopback bind by default; a non-loopback
      bind is **refused at startup without a token**; bearer auth uses a
      constant-time comparison; `/health` is the only unauthenticated route.
- [x] **Fail closed on mutation:** `AURORA_API_ALLOW_MUTATION` defaults to
      false, so an HTTP run uses a deny-all gate — a state-changing tool is
      refused because there is no terminal to confirm it. The Phase 8
      `ConfirmationGate` seam is reused, not duplicated.
- [x] **Bounded request body** enforced *while streaming* (413 + socket
      destroy); malformed JSON is 400, not a silent default.
- [x] **Rate limiting** per client reusing the Phase 8 `KeyedRateLimiter`
      (429 + `Retry-After`); `/health` is exempt so liveness always answers.
- [x] **Secrets do not leak in responses:** a provider error surfaced over HTTP
      — thrown *or* carried in an `error`-status result — is scrubbed, because
      log redaction does not reach a response body.
- [x] **Mutation-tested:** five controls (public-bind refusal, token check,
      mutation gate, body cap, rate limit) were each broken; all five turned the
      suite red, then were restored.
- [x] Verified end to end by hand: `aurora serve` prints the bound address and
      answers `/health`, `/knowledge/search` and `/agent/run` (the last correctly
      reports an unreachable Ollama rather than pretending success).

> No phase is advanced until the previous phase's acceptance criteria are met.


## Phase 10 acceptance

UI is a separate layer (ADR 012): framework-free ES modules served by the API,
connected to the core only over HTTP.

- [x] **Separate layer:** `ui/` imports no `src/` module; it talks to the API
      only. `tsconfig` excludes it, so it cannot be pulled into the core build.
- [x] **Static serving is a security surface, treated as one:** `/` and `/ui/*`
      go through the *same* `PathValidator` the filesystem tools use — and use
      `resolveReal`, not `resolve`, because the route is reachable without a
      token and a lexically-inside file can be a symlink out. CSP
      (`default-src 'none'`), `nosniff`, `no-referrer`, extension allowlist.
- [x] **No markup sink:** the UI never sets `innerHTML`/`outerHTML`/
      `insertAdjacentHTML`/`document.write`, has no `eval`, no inline handler.
      Asserted by scanning the source (`tests/unit/ui/ui-xss-guard.test.ts`),
      not only by probing payloads.
- [x] **Three panels:** Tasks (status filter, detail), Agents (live + finished
      runs, trajectory), Knowledge (kind filter, search, detail).
      `RunRegistry.list()` and `GET /knowledge/:kind/:slug` were added to feed
      them.
- [x] **Token handling:** bearer token in `sessionStorage` (not `localStorage`),
      sent as a header, never in a URL; the shell is public so a browser can load
      it, data routes stay gated (`tests/integration/ui.test.ts`).
- [x] **Mutation-tested:** the symlink check, CSP, token check, href scheme
      allowlist, and `textContent` were each broken; all five turned the suite
      red, then were restored.
- [x] **Verified in a real browser:** a deliberately hostile knowledge entry
      (an `onerror` `<img>`, an inline `<script>`, a `javascript:` source)
      renders as inert text; the page title does not change and the payload does
      not run.

> No phase is advanced until the previous phase's acceptance criteria are met.

---

# Post-Phase-10 roadmap — from MVP core to the goal

Phases 0–10 delivered the runtime core; every acceptance criterion above is met.
This section is the path from *mature MVP core* to the actual goal:

> **A production-grade, local-first TypeScript AI workstation** — multi-architecture
> agents, provider independence, memory + retrieval, MCP, bounded multi-agent
> concurrency, and defense-in-depth security, running against a local model with
> no cloud dependency.

It is the honest gap list from `docs/aurora-capability-assessment.md` §7 and §13
turned into milestones. Nothing here is a wish: each capability names the
acceptance criterion that will prove it, in the same style as the phases above.

## Where we are (2026-09-29)

| Goal axis | State | Evidence |
|---|---|---|
| ReAct | ✅ core loop | `AgentLoop.ts` |
| Reflexion | 🟡 external-signal repair only; no model self-critique | ADR 001/006 — deliberate |
| Plan-Execute | ❌ planner is thin (first tool call, else final) | assessment §2.2 |
| Tree-of-Thoughts | ❌ absent | assessment §2.3 |
| Multi-agent | ✅ 5 roles, least privilege; ❌ sequential only | ADR 007 |
| Provider abstraction | ✅ Ollama + OpenAI-compatible; ❌ no streaming on the latter | ADR 003 |
| Memory | ✅ three tiers; ❌ no vector/hybrid retrieval | ADR 009 |
| RAG | ❌ keyword only | assessment §5.4 |
| MCP | ❌ research only, no code | assessment §7 |
| Security | ✅ strong; ❌ no execution sandbox; ❌ observations not redacted | ADR 004/010 |
| API run persistence | ❌ in-process only | ADR 011 |

## Milestones

Legend: ✅ done · 🚧 in progress · ⬜ not started · ⏭️ deferred

| M | Name | Depends on | Status |
|---|---|---|---|
| **M0** | Capability visibility | — | ✅ |
| **M1** | Model-agnostic hardening & config truth | M0 | ⬜ |
| **M2** | Retrieval — local-first RAG | M1 | ⬜ |
| **M3** | Multi-architecture agents | M1 | ⬜ |
| **M4** | MCP integration | M1 | ⬜ |
| **M5** | Concurrency & durable runs | M2, M4 | ⬜ |
| **M6** | Execution isolation | M5 | ⬜ |
| **M7** | Operator experience & evaluation | M2–M6 | ⬜ |
| **M8** | Multi-tenant deployment | — | ⏭️ |

### M0 — Capability visibility ✅

**Why.** An operator cannot trust a run it cannot see. Before adding
capabilities, the runtime must expose what it is doing, live, and report failure
honestly.

**CAP-004 — event model + live event visibility.** The current focus.

- [x] One `EventBus` is the single record of "what happened"; the agent loop,
      run registry and API all emit into it.
- [x] `GET /runs/:id/events` and `GET /events` stream it as SSE, with
      `?after=<sequence>` reconnect and bounded replay from a ring.
- [x] The operator UI renders the timeline live, over `fetch` (not
      `EventSource`, which cannot send an `Authorization` header).
- [x] A refused mutation is reported as `denied`, never as `completed`
      (ADR 010 in the permission dimension).
- [x] Verified end to end in a real browser: a finished run replays all 7 events
      in order.
- [x] The SSE client is covered by an integration test against a real
      `node:http` server (`tests/integration/ui-sse-client.test.ts`).
- [x] The `app.js` wiring is covered too: `tests/integration/ui-app-wiring.test.ts`
      boots it under jsdom against the real `index.html` and a real server, then
      asserts the timeline mounts, the subscription is torn down on leaving the
      Agents view (server-observed client abort), and a replay gap is marked.
      Three mutations each turn the suite red.

### M1 — Model-agnostic hardening & config truth ⬜

**Why.** "Model-agnostic" is a claim, not yet a fact: the shipped default
(`llama3.2`) is often not pulled, and the OpenAI-compatible provider cannot
stream. Both undercut the local-first promise.

- [ ] The default model is one that is actually reachable, or `aurora` fails at
      startup with a specific, actionable message — no silent wrong default
      (assessment §13.3).
- [ ] `aurora doctor` reports provider reachability, available models, and which
      capabilities the selected model supports (tool calling, streaming).
- [ ] OpenAI-compatible provider implements `stream`; NDJSON/SSE deltas and
      streamed `tool_calls` are parsed and executed, then fed back.
- [ ] Ollama streamed `tool_calls` are verified to be captured mid-stream and
      round-tripped (not only in non-streaming mode).
- [ ] Acceptance: a live test against a **local** OpenAI-compatible server (e.g.
      LM Studio) streams a tool call and completes a task; the same suite passes
      against Ollama.

### M2 — Retrieval: local-first RAG ⬜

**Why.** Keyword-only search degrades as knowledge grows. RAG is the difference
between a notes folder and a research workstation — and it can be done with
**zero new runtime dependencies**.

**Verified on this host (2026-09-29, Node v24.21.0):** `node:sqlite` is built in
and supports **FTS5** and the **trigram** tokenizer. No `better-sqlite3`, no
native build step.

- [ ] `KnowledgeStore` gains an indexed backend (SQLite FTS5) behind the existing
      interface; the file store stays the source of truth (ADR 002 preserved).
- [ ] Hybrid search: BM25 (FTS5) + optional semantic reranking via Ollama
      `/api/embed`, with the embedding model configurable and the feature
      degrading cleanly to BM25 when absent.
- [ ] Chunking preserves provenance: every chunk resolves back to its
      `source`, `retrievedAt`, `verified`.
- [ ] `knowledge_search` returns ranked, cited snippets; the tool result is still
      wrapped as `UNTRUSTED DATA`.
- [ ] Acceptance: a query whose answer shares no literal term with the stored
      text is still found (semantic path), and a literal-term query is found
      without embeddings (BM25 path) — both asserted, not asserted-together.

### M3 — Multi-architecture agents ⬜

**Why.** ReAct alone is the wrong shape for structured work (Plan-Execute) and
for hard reasoning (ToT). The goal names all four architectures.

All strategies live behind the existing `Planner` interface; **ReAct stays the
default**, so nothing regresses.

- [ ] **Plan-Execute:** an explicit plan artifact (steps) produced before acting,
      executed step by step, with bounded replanning on failure. The plan is
      visible in the trajectory and the event timeline.
- [ ] **Reflexion:** bounded self-critique that fires **only when an external
      signal exists** (test/lint/compiler output). Free-floating self-reflection
      is rejected by design (ADR 001) — this milestone must not weaken that rule.
- [ ] **Tree-of-Thoughts:** opt-in bounded branching with an explicit node budget
      and a scoring signal; off by default, because it multiplies cost.
- [ ] Acceptance per strategy: a task that ReAct fails and the new strategy
      passes, asserted against a **real** external signal; plus a test that the
      strategy cannot exceed its budget.

### M4 — MCP integration ⬜

**Why.** The largest structural gap: AURORA cannot reach the MCP ecosystem.
Research is done (`docs/research/mcp.md`); there is no code.

**Verified (2026-09-29):** `@modelcontextprotocol/sdk` **1.31.0** is published.

- [ ] MCP **client**: connect to configured servers over stdio and HTTP,
      discover tools, and adapt them into the AURORA `ToolRegistry`.
- [ ] Permission mapping is explicit and fail-closed: an MCP tool gets a
      declared AURORA permission, or it is not registered. An unknown tool is
      never silently `FULL_ACCESS`.
- [ ] MCP output is untrusted: every result is wrapped as `UNTRUSTED DATA` with a
      fresh nonce, and the confirmation gate applies to mutating MCP tools.
- [ ] Servers are config-driven and **opt-in**; `AURORA_MCP_SERVERS` unset
      restores today's registry exactly.
- [ ] Acceptance: a local MCP server's tool is discovered, called through the
      registry, and its output is provably wrapped as untrusted data; a
      mutating MCP tool is denied without a terminal.

### M5 — Concurrency & durable runs ⬜

**Why.** Sequential sub-agents waste a workstation's capacity, and in-process
API runs vanish on restart (assessment §13.7).

- [ ] Bounded parallel sub-agent execution (a pool, not unbounded `Promise.all`),
      with per-run budgets still enforced and results still isolated.
- [ ] API runs are durable: a run survives a restart, and an interrupted run is
      recovered through the existing `TaskStore` lifecycle (ADR 008) rather than
      a new mechanism.
- [ ] Acceptance: a restart mid-run is recovered (real second process, not a
      flag), and parallel delegation is proven faster than sequential on the same
      host — measured, not asserted.

### M6 — Execution isolation ⬜

**Why.** `CommandValidator` is a *gate*, not isolation. The goal says
production-grade; a command allowlist is not a sandbox.

- [ ] An opt-in isolation backend for `run_command`/`run_tests` (container or
      namespace), behind the existing `ExecutionProvider` interface, so the
      local `spawn` path stays the default for single-user local use.
- [ ] A written threat model of what the local path does and does not protect
      against, so the residual risk is stated rather than implied.
- [ ] Observations can be redacted before they reach the model (opt-in), closing
      assessment §13.10 — off by default so fixtures keep working, with the
      trade-off documented.
- [ ] Acceptance: an escape attempt that succeeds on the local path fails inside
      the isolated backend; the default path is unchanged.

### M7 — Operator experience & evaluation ⬜

**Why.** A workstation needs an evaluation harness, or "it works" is an opinion.

- [ ] An eval suite: a fixed set of tasks with pass/fail, runnable in CI, with a
      regression gate on the pass rate.
- [ ] UI: plan/trajectory view for Plan-Execute, and a retrieval-aware knowledge
      browser for M2.
- [ ] Metrics: per-run latency, token use, tool-call counts, verification
      outcomes — surfaced, not just logged.
- [ ] Acceptance: the eval suite detects a deliberately introduced regression
      (a mutation that lowers the pass rate) and fails the gate.

### M8 — Multi-tenant deployment ⏭️

**Deferred.** AURORA is local-first and single-operator; multi-token auth and
per-tenant scoping solve a problem it does not have. Revisit only if the goal
changes from "local workstation" to "hosted service".

## Definition of done for the goal

The goal is reached when all of the following hold, each with a test:

1. Four architectures selectable per task (M3), ReAct still the default.
2. Retrieval is hybrid and local, with no new runtime dependency (M2).
3. MCP tools are usable and permission-mapped fail-closed (M4).
4. Parallel delegation is bounded and API runs survive restart (M5).
5. Execution can be isolated, and the residual risk of the local path is
   documented (M6).
6. An eval suite gates regressions (M7).
7. Every live claim is backed by a test run against a **local** model, and every
   unverified claim is still tagged **DOĞRULANACAK**.

> Same rule as the phases: no milestone is advanced until the previous
> milestone's acceptance criteria are met and its tests pass.

---

## Production readiness — what is actually missing

The milestones above describe *capabilities*. They do not describe the
*assurance* layer a production system needs. `docs/production-readiness.md`
measures both, with evidence, and splits the remaining work into two finish
lines:

- **Line A — "use it safely today" (P0):** CI, model reachability validation,
  `aurora doctor`, a LICENSE, a release tag, and an eval smoke suite. None of
  this changes the core; it adds the guarantees and packaging that are missing.
- **Line B — the stated goal (P1, = M1–M7):** MCP, RAG, the other architectures,
  parallelism, isolation, metrics.

**Recommended order: Line A first.** A trusted base (CI catches regressions,
eval catches model drift, packaging is legal and versioned) is what makes adding
M2–M7 safe. Adding MCP or RAG on top of a system whose breakage nobody notices
is how a working core quietly becomes an unmaintainable one.

The single most important gap is **CI + eval**: everything else's reliability
depends on being told when it breaks.
