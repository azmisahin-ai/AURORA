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
- **`node --test` exits 0 when it finds no test files** (Node v24.21.0 — verify
  with a probe before trusting any assumption about runner exit codes). Anything
  that treats exit 0 as "tests passed" must also check that tests actually ran;
  see `ranNoTests` in `TestSummary.ts`.

## Environment quirks

- **Ollama may or may not be installed.** Do not assume it is running; the live
  integration test skips (and prints why) when it is unreachable.
- **`$HOME` is ephemeral — `/workspace` is not.** The container's home directory
  is reset between sessions: anything installed under `~/.local`, `~/.ollama` or
  logged to `/tmp` is gone on the next session, including a running `ollama
  serve`. Install tooling and model blobs under `/workspace` instead:
  - Ollama binary: `/workspace/.tools/ollama/bin/ollama`
  - Model store: `/workspace/.ollama-models` (`OLLAMA_MODELS`)
  - Server log: `/workspace/.tools/ollama/serve.log`
  Start it with:
  `OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS=/workspace/.ollama-models nohup /workspace/.tools/ollama/bin/ollama serve > /workspace/.tools/ollama/serve.log 2>&1 &`
  - There is no `zstd` CLI and no `python-zstandard`, but `libzstd.so.1` exists.
    `/workspace/.tools/zstd-decompress.py` decompresses `.tar.zst` release
    assets via ctypes; the Ollama release ships only `.tar.zst` for Linux.
- Network egress works (npm registry, docs.ollama.com reachable).
- `file_editor` create/write can fail on a directory that does not exist yet —
  `mkdir -p` the parent first.

## Layout

```
src/core/        agent loop, planner, errors, sub-agents/roles (later: memory/task/context)
src/providers/   LLM/web/execution adapters implementing owned interfaces
src/tools/       tool registry and tools (Phase 2: read/write/list/run_command, Phase 4: run_tests, Phase 5: delegate)
src/security/    permissions, path/command validation (later: url, redaction)
src/cli/         commander entry point
src/api/         HTTP API over injected ports (Phase 9, ADR 011)
docs/research/   sourced research notes
docs/adr/        architecture decision records
knowledge/       runtime knowledge store (gitignored contents)
```

## Tool system (Phase 2)

`Tool` (`src/tools/types.ts`) carries a **zod** `inputSchema` that is the single
source of truth: `ToolRegistry.definitions()` derives the JSON Schema offered to
the model from it and `execute()` validates arguments against the same schema.

`ToolRegistry` implements the loop's `ToolExecutor` port, so `core` still imports
no tool code. It enforces, in order: known tool → permissions → schema →
execution. A denied call is logged and returned to the model as unavailable; the
model cannot argue past the gate.

Permissions (`src/security/PermissionManager.ts`): `READ_ONLY`,
`WORKSPACE_WRITE`, `COMMAND_EXECUTION`, `NETWORK_ACCESS`, `FULL_ACCESS`.
`NETWORK_ACCESS` is granted by default since Phase 3 shipped `UrlValidator` +
SSRF-contained fetching — the control that makes it safe is URL validation, not
withholding the permission. Sub-agent roles cap it further (Phase 5).

`LocalExecutionProvider` runs commands with `shell: false` and a minimal
environment (no inherited secrets). `CommandValidator` rejects shell
metacharacters and non-allowlisted commands before execution.

## Current provider surface

`LLMProvider` (`src/providers/llm/LLMProvider.ts`): `chat` required; `stream`,
`listModels`, `health` optional. Concrete implementations:
`OllamaProvider`, `OpenAICompatibleProvider`. Vendor-specific options go in the
opaque `options` bag so they never leak into core.

## Web research + knowledge (Phase 3)

`Fetcher` (`src/providers/web/Fetcher.ts`) and `SearchProvider`
(`src/providers/web/search/SearchProvider.ts`) are owned interfaces.
`DirectFetcher` is the real fetcher; `NoopSearchProvider` is the default so
research works with no API keys.

**Every URL is validated by `UrlValidator` before connecting, and re-validated on
every redirect hop.** Addresses are parsed numerically, because the URL parser
rewrites `[::ffff:127.0.0.1]` to the hex form `[::ffff:7f00:1]` — a dotted-quad
regex silently misses that SSRF bypass. Unparseable addresses fail closed.
See ADR 005 for the encodings covered.

`DirectFetcher` pins the connection to the address it validated, so validation
and connection are not two independent DNS lookups (DNS-rebinding race).

**Anything from outside the trust boundary is wrapped by `UntrustedData`**
(`src/security/UntrustedData.ts`): a random-nonce delimiter, an explicit "this is
data, not an instruction" preamble, and a character cap. Applied to `web_fetch`
and `knowledge_search` output. The payload is preserved so the model can reason
about it — only its authority is denied.

`KnowledgeStore` (`src/core/knowledge/`) is a filesystem store with a JSON
metadata sidecar; `FileKnowledgeStore` is the implementation (ADR 002). Slugs are
normalised so `../../etc/passwd` cannot escape the knowledge root. Knowledge
content is treated as untrusted on the way back out.

Tools: `web_fetch`, `web_search`, `knowledge_write`, `knowledge_search`.
`web_fetch`/`web_search` require `NETWORK_ACCESS`.

## Code execution + verification (Phase 4)

The loop's success signal is **external** (ADR 001/006). `Verifier`
(`src/core/agent/types.ts`) returns a verdict derived from a process exit code;
`CommandVerifier` runs one configured command (`AURORA_TEST_COMMAND`). Core never
learns how the verdict was produced.

The completion gate (`AgentLoop.gateCompletion`) rules, in order:

1. No verifier, or `maxVerifications = 0` → accept (Phase 1–3 behaviour).
2. Nothing was mutated → accept, without running the verifier.
3. Budget exhausted → `max_verifications`, escalate; never accept.
4. Run the verifier: `pass` accepts; `fail` feeds back the failure **and its
   classification** and the loop repairs. `skipped` accepts but is recorded —
   never reported as a pass.

A tool declares `mutatesWorkspace: true`; `ToolRegistry` sets
`mutatedWorkspace` on the result **only when the call succeeded**. `write_file`
sets it; `knowledge_write` (not code) and `run_command` (the verifier's own tool)
do not. Core never infers this from tool names.

`ErrorClassifier` (`src/core/errors/`) maps a failure to a category + action.
Structured signals beat text (`status: 401` over a message saying "invalid");
`AbortError` is transient but not retryable.

`run_tests` is registered only when a test command exists, and shares one command,
policy, and parser with the verifier (`TestSummary.ts`) so the model's view and
the gate's view cannot drift. Exit 0 is necessary but **not sufficient**: a
vacuous run is a failure (`ranNoTests`).

## Sub-agents (Phase 5, ADR 007)

Delegation is a **tool** (`delegate`), so it appears in the trajectory like any
other action. It stands up a `SubAgentManager` (`src/core/agent/subagent/`),
which runs a role-scoped `AgentLoop`. Roles are fixed
(`src/core/agent/roles/definitions.ts`): `researcher`, `coder`, `tester`,
`reviewer`, `documenter` — each with a system prompt, a tool list, a permission
cap, and a budget. `AURORA_MAX_SUB_AGENTS=0` disables delegation entirely.

Four invariants, each with a test:

1. **Context isolation** — a sub-agent's first provider call has exactly two
   messages: the role prompt and the task. It never sees the parent transcript.
   The role prompt *replaces* the parent's; it does not extend it.
2. **Least privilege is structural** — a role's registry is built from its tool
   list ∩ the parent's grant, minus `FULL_ACCESS`. A tool the role cannot afford
   is *absent*, not denied at call time. The reviewer's registry has no
   `write_file` at all.
3. **No recursion** — `delegate` is registered into the parent registry only;
   role registries are built from a catalog that excludes it. A sub-agent cannot
   reach it, so there is no depth bound to get wrong.
4. **Delegated edits are verified** — `delegate` reports `mutatedWorkspace`
   **dynamically** when the sub-agent changed the workspace. `ToolRegistry` ORs
   this with the tool's static declaration (on success only), so the parent's
   Phase 4 gate still fires for a delegated edit. `ToolResult.mutatedWorkspace`
   and `RunResult.mutatedWorkspace` carry it.

A sub-agent's answer is wrapped with `wrapUntrusted` before it reaches the
parent: it is our own model's text, but a researcher quotes fetched pages.

**Wiring note:** `AgentRuntime` builds the registry first (which yields the
`RoleToolsetBuilder`), then constructs the manager and registers `delegate` back
into the registry. Two steps because the tool layer needs the manager and the
manager needs the tool layer; the alternative inverts the ADR 001 dependency
direction.

## Tasks (Phase 6, ADR 008)

`core/task` keeps a durable record per unit of work: `<taskDir>/<id>.json`,
written **atomically** (temp file + `rename`). This is the phase's whole point,
so the atomicity claim is measured, not asserted: rewriting a 2 MB record while
a concurrent reader parses it yields 0 torn reads with `rename` and ~221 with a
plain `writeFile` (measured on Node v24.21.0). The test
`never exposes a torn record to a concurrent reader` fails if the rename is ever
replaced by an in-place write.

States: `queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`.
Every legal move is in one table (`TASK_TRANSITIONS`); an illegal move throws
`TaskTransitionError`, and a plain `update()` cannot perform `running → queued`
— that is the named `requeue()` operation. Terminal states have no outgoing
plain transition, so "terminal" means exactly "cannot move by `update`".

`recover()` runs on startup and is **bounded** (ADR 001/006): a `running` task
goes back to `queued` while attempts remain, and to `failed` when they do not —
never an infinite requeue. `RecoveryReport` separates `requeued`, `exhausted`
and `corrupt`; corrupt records are reported and left on disk, not deleted.

`TaskRunner` maps a run outcome to a lifecycle state by an explicit table:
`completed`→`completed`, `aborted`/`max_verifications`→`waiting`,
`timeout`/`max_iterations`/`max_tool_calls`→retry (or `failed` when exhausted),
`error`→`failed`. It depends on a `TaskExecutor` port; `AgentRuntime`
(`createTaskExecutor`) supplies the adapter, so `core/task` imports no provider.

CLI: `aurora tasks add | list | show | recover | run`. `tasks run` recovers
first, then drains the queue. `AURORA_TASK_DIR` (default `./tasks`),
`AURORA_TASK_MAX_ATTEMPTS` (default 3).

**Scope:** one process. Mutations are serialised in-process; there is no
cross-process lock, and two processes sharing a task directory are not
supported. Documented rather than papered over with an advisory lock.

## Memory tiers and bounded context (Phase 7)

Three memory tiers (`docs/adr/009-memory-and-bounded-context.md`):

| Tier | Scope | Storage | Where |
|---|---|---|---|
| Working | current run's transcript | in-memory | `InMemoryWorkingMemory` |
| Session | one conversation | file (one JSON per record) | `FileSessionStore` |
| Knowledge | cross-session research | filesystem, **tool-driven** | `FileKnowledgeStore` (Phase 3) |

The Knowledge tier is **not** duplicated; retrieval stays behind
`knowledge_search` because "which retrieval mechanism" is an open question.

`AgentLoop` keeps the full transcript in `messages`; each provider call gets a
*bounded view* from `ContextBuilder` (port `ContextPort`, so `core/agent` does
not depend on the concrete builder). Compaction order, cheapest and least-lossy
first: (1) in budget → unchanged, (2) shorten oversized tool observations (head
+ tail, visible marker), (3) elide whole oldest **turns**, (4) still over →
report `overBudget`, never drop the task. Individual messages are never split
from their `tool_calls` — providers reject an orphaned `tool` message.

The **protected head** is the leading run of `system`/`user` messages (system
prompt, recall block, task), *counted dynamically* — a fixed count would stop
protecting the task the moment recall was added. The omission notice goes after
the head, never into the system prompt (the trust anchor, ADR 004).

`FileSessionStore` writes atomically (temp + `rename`, the Phase 6 lesson) and
is single-process. `SessionRecord` is an auditable **extract**, not a
transcript. `buildSessionRecall` is **extractive, never model-generated**: a
model summary would re-enter context as unverified fact (ADR 001); model
summarisation stays DOĞRULANACAK. The recall block is wrapped by `wrapUntrusted`
(nonce + size cap) and injected by `AgentLoop` as a **user** message *before* the
task, so the task stays the last instruction.

`AgentRuntime.runTask` recalls, runs, then persists. `recall()` returns
`undefined` when disabled or nothing is stored, so a first run is identical to
pre-Phase-7. A session save failure is logged and never fails the run.

Env: `AURORA_SESSION_DIR` (default `./sessions`), `AURORA_RECALL_SESSIONS`
(default 3; 0 disables). Context uses the existing `AURORA_TOKEN_BUDGET`.
CLI: `aurora sessions list | show | recall`; `run` gained `--recall-sessions`,
`--no-recall`, `--context-budget`.

Measured with the real builder (4 KB observations, 8 000-token budget): 200
turns / 203 414 raw tokens → 7 181 bounded tokens. Raw history grows linearly;
the bounded view plateaus.

**Timeout correctness:** the loop marks a timeout with a `timedOut` flag rather
than re-deriving it from `Date.now() >= deadline`; `setTimeout` can fire a hair
before the clock reaches the deadline, which mislabelled a genuine timeout as
`aborted` (intermittent, cold-start only).

## Security hardening (Phase 8, ADR 010)

Four gaps closed; the existing controls (path traversal, SSRF, command
allowlist, untrusted wrapping, permissions, timeouts) were **not** rewritten.

**`SecretRedactor`** redacts by credential *shape* — vendor prefixes (`sk-`,
`sk-ant-`, `ghp_`/`github_pat_`, `AKIA`, `xox`, `AIza`, `sk_live_`), JWTs,
`Bearer` tokens, PEM blocks, and `scheme://user:password@host`. The one loose
pattern (`password = …`) is filtered by `looksLikeSecret` so ordinary prose is
untouched; the false-positive corpus is a test, not a comment. `redactValue`
handles cycles (`[Circular]`) and leaves `Error` objects intact.

Scope is deliberate: logs and confirmation prompts are redacted, the **model's
observations are not** — a file containing a key must stay readable. That
boundary is stated, not implied.

**`ConfirmationGate`** is three-valued: `approved | denied | unavailable`.
Collapsing `denied` into `unavailable` would make an unattended run
indistinguishable from a user's refusal. `AllowAllGate` (default), `DenyAllGate`,
`PromptGate` (injected `ask`, so it is testable without a TTY). The gate fires
when a tool sets `mutatesWorkspace` **or** requires `COMMAND_EXECUTION` — a
shell command can change the machine without declaring a workspace mutation.
Only the CLI builds a `PromptGate`; the library falls back to `DenyAllGate`,
because `prompt` has no safe default without stdin.

**`KeyedRateLimiter`** bounds *network* tools with a per-tool token bucket. A
denial is an observation telling the model to slow down, not a throw: the loop
must stay recoverable. The clock is injected — otherwise the only interesting
test is a flaky sleep.

**`maxArgumentBytes`** (default 64 KiB) rejects a call whose serialised
arguments exceed it, checked right after schema validation and *before* the
confirmation prompt, so a giant payload never reaches a terminal.

**Wiring is tested.** `buildToolRegistry` maps config → concrete cap/gate/
redactor/limiter, each overridable via `opts.*`. `tests/unit/tools/
build-tool-registry.test.ts` asserts the wiring, because a control that exists
but is not connected is not a control. Two mutants (redactor wiring removed,
config limiter branch forced off) passed before that file existed and fail now.

Secrets reach the confirmation prompt and the denial log only after redaction;
the summary shown to the user is built from the *redacted* arguments, so a
summary cannot leak what the arguments scrubbed.

`booleanFromString` treats `"false"`/`"0"` as false — `z.coerce.boolean()` makes
`"false"` truthy; there is a regression test.

Env: `AURORA_REDACT_LOGS` (default true), `AURORA_MAX_ARGUMENT_BYTES` (64 KiB),
`AURORA_TOOL_RATE_LIMIT` / `AURORA_TOOL_RATE_REFILL` (20 / 1; 0 disables),
`AURORA_CONFIRM_MODE` (`allow` | `deny` | `prompt`), `AURORA_CONFIRM_STRICT`.
CLI: `run --confirm | --no-confirm | --confirm-strict`.

**Open, tagged DOĞRULANACAK:** selective observation redaction (redact
`run_command` output but not `read_file`) is plausible but not designed; done
badly it breaks tool use. Rate limits are in-process and reset on restart.

## HTTP API (Phase 9, ADR 011)

`src/api` is a peer of `cli`: it depends on `core` through a **narrow port** and
on `security`; `core` never imports it. The framework is Node's built-in
`node:http` — the research (ADR 011) is cited, and the decision is that five
routes do not justify a web framework's dependency surface. Revisit if the route
count grows or runtime portability becomes a goal.

- **Ports, not providers.** `createApiServer` takes `RuntimePort` (`runTask`,
  `health`), a `FileTaskStore`, a `FileKnowledgeStore`, and optional logger /
  `SecretRedactor`. `AgentRuntime` satisfies `RuntimePort` structurally. Tests
  pass a scripted fake, which is why `tests/integration/api.test.ts` needs **no
  Ollama**.
- **Runs are async by default.** `POST /agent/run` → `202` + `runId`;
  `GET /runs/:id`; `POST /agent/cancel` aborts via `AbortController`. `?wait=1`
  runs inline, bounded by `AURORA_API_MAX_SYNC_MS` (answers `202`, never hangs).
- **Trust model.** Loopback default; `assertSafeBinding` **refuses a
  non-loopback bind without a token** at startup. Bearer auth via
  `tokenMatches` (sha256 + `timingSafeEqual`, so length does not leak).
  `/health` is the only unauthenticated route. Body cap enforced *while
  streaming*; per-client rate limit reuses `KeyedRateLimiter`.
- **Fail closed on mutation.** `apiConfirmationGate(allowMutation)` returns
  `AllowAllGate` only when opted in, else `DenyAllGate`. Default is deny, because
  an HTTP request has no terminal to confirm a state-changing tool. This is the
  Phase 8 gate port being reused, not a second policy.
- **Responses are scrubbed.** A provider error surfaced over HTTP — thrown *or*
  carried in an `error`-status result — passes through `SecretRedactor`; log
  redaction does not reach a response body.
- **Runs are not persisted** (deliberate): a half-executed command is not
  resumable; durable work is Phase 6 `tasks`.

Env: `AURORA_API_HOST` (127.0.0.1), `AURORA_API_PORT` (8787; 0 = ephemeral),
`AURORA_API_TOKEN` (empty), `AURORA_API_ALLOW_MUTATION` (false),
`AURORA_API_MAX_BODY_BYTES` (256 KiB), `AURORA_API_RATE_LIMIT` /
`AURORA_API_RATE_REFILL` (60 / 1; 0 disables), `AURORA_API_MAX_CONCURRENT_RUNS`
(2), `AURORA_API_MAX_SYNC_MS` (30000). CLI: `aurora serve
[--host --port --allow-mutation]`.

**Open, tagged DOĞRULANACAK:** there is no TLS termination in-process — a
non-loopback deployment is expected to sit behind a reverse proxy. Multi-tenant
authz (per-token scopes) is not designed; the token is a single shared secret.

## Test harness note

`vitest.config.ts` sets `fileParallelism: false`. All five live integration
tests drive the **same** single Ollama instance; in parallel they queue behind
one another until a 300s test timeout fires — a flake unrelated to the code
under test. Serialising files costs a few seconds on the unit suite and makes
the suite deterministic. This is a harness fix, not a skip.
