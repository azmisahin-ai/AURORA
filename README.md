# AURORA

**Autonomous Unified Research & Operations Runtime Agent**

A provider-independent agent runtime in TypeScript. Built phase by phase, every
claim either tested or explicitly marked *DOĞRULANACAK*.

## Status

- **Phase 0** — research + ADRs: ✅ complete (`docs/research/`, `docs/adr/`)
- **Phase 1** — core agent loop + CLI + LLM providers: ✅ complete
- **Phase 2** — tool system + permissions: ✅ complete
- **Phase 3** — web research + knowledge store: ✅ complete
- **Phase 4** — code execution + external verification loop: ✅ complete
- **Phase 5** — sub-agent system (roles, delegation, least privilege): ✅ complete
- **Phase 6** — persistence + task recovery (durable tasks, restart recovery): ✅ complete
- **Phase 7** — context management + memory tiers (session records, recall): ✅ complete
- **Phase 8** — security hardening (redaction, confirmation gate, rate limits): ✅ complete
- **Phase 9** — CLI + HTTP API (`aurora serve`): ✅ complete
- **Phase 10** — UI, a separate layer (`AURORA_UI_DIR`): ✅ complete. See
  `docs/adr/012`, `docs/reports/phase-10.md`.

## Requirements

- Node.js ≥ 20
- An LLM provider: either a local [Ollama](https://ollama.com) server, or any
  OpenAI-compatible endpoint.

### Model capability (read this first)

The runtime is model-agnostic, but multi-step tool calling needs a capable
model. Verified on 2026-09-29 against Ollama v0.34.4 on a CPU-only host:

| Model | Result |
|---|---|
| `llama3.2:1b` | Too weak. Emits malformed/nested tool calls, omits required arguments, loops to a bound. |
| `llama3.2:3b` | Works for single-tool tasks; marginal for multi-step research. |
| `qwen2.5:7b` | Passes every live integration test, including research and sub-agents. |

If a run ends non-zero, the CLI prints the reason; rule out the model first.

### Windows

The CLI works on Windows (verified via `pathToFileURL`-based entry detection;
see `src/cli/index.ts`). On PowerShell, set env vars per-invocation with
`$env:`, not `VAR=value`:

```powershell
$env:AURORA_MODEL = "qwen2.5:7b"
node dist/cli/index.js run "Merhaba de"
```

`npm install`, `npm run build`, `npm run dev`, and `aurora serve` all work from
`C:\AURORA`. If a command exits silently, that is a bug, not expected
behaviour — every command either prints a result or a specific error.

## Install

```bash
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and adjust. Every value can also be passed inline.
Key variables:

| Variable | Default | Meaning |
|---|---|---|
| `AURORA_LLM_PROVIDER` | `ollama` | `ollama` or `openai-compatible` |
| `AURORA_MODEL` | `llama3.2` | Model name |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint |
| `OPENAI_COMPATIBLE_BASE_URL` | — | OpenAI-compatible endpoint |
| `OPENAI_COMPATIBLE_API_KEY` | — | Bearer token, if required |
| `AURORA_MAX_ITERATIONS` | `25` | Hard iteration bound |
| `AURORA_MAX_TOOL_CALLS` | `50` | Hard tool-call bound |
| `AURORA_TIMEOUT_MS` | `120000` | Wall-clock bound per run |
| `AURORA_WORKSPACE` | `./workspace` | Sandbox root for file tools |
| `AURORA_KNOWLEDGE_DIR` | `./knowledge` | Knowledge store root |
| `AURORA_TEST_COMMAND` | — | External check for Phase 4 verification |
| `AURORA_MAX_VERIFICATIONS` | `0` | Cap on verify→repair attempts; 0 disables |
| `AURORA_MAX_SUB_AGENTS` | `3` | Cap on sub-agent delegations; 0 disables (Phase 5) |
| `AURORA_TASK_DIR` | `./tasks` | Durable task record root (Phase 6) |
| `AURORA_TASK_MAX_ATTEMPTS` | `3` | Attempts before a task is failed rather than requeued |
| `AURORA_SESSION_DIR` | `./sessions` | Session memory root (Phase 7) |
| `AURORA_RECALL_SESSIONS` | `3` | Prior sessions injected as untrusted recall; 0 disables |
| `AURORA_API_HOST` | `127.0.0.1` | API bind address (Phase 9) |
| `AURORA_API_PORT` | `8787` | API port; `0` picks a free port |
| `AURORA_API_TOKEN` | — | Bearer token; required for a non-loopback bind |
| `AURORA_API_ALLOW_MUTATION` | `false` | Whether HTTP runs may change the workspace |
| `AURORA_UI_DIR` | `./ui` | Directory served at `/` and `/ui/*`; empty disables the UI (Phase 10) |

## Usage

```bash
# With a local Ollama server. Use a capable model — see "Model capability" above.
ollama serve            # in another terminal
AURORA_MODEL=qwen2.5:7b node dist/cli/index.js run "Merhaba de"

# Same, in dev mode (no build step; runs the TypeScript directly via tsx)
AURORA_MODEL=qwen2.5:7b npm run dev -- run "Merhaba de"

# Override per-invocation
node dist/cli/index.js run "Node.js hakkında araştırma yap" --max-iterations 10

# Require an external check before the run may report success (Phase 4)
node dist/cli/index.js run "fix the failing test" \
  --test-command "npm test" --max-verifications 3

# Allow role-based sub-agents to be delegated to (Phase 5; default 3, 0 disables)
node dist/cli/index.js run "implement and test the parser" --max-sub-agents 4

# Durable tasks (Phase 6): queue work, survive a restart, then run it
node dist/cli/index.js tasks add "summarise the README"
node dist/cli/index.js tasks list
node dist/cli/index.js tasks recover    # requeue tasks interrupted by a crash
node dist/cli/index.js tasks run --max-tasks 3

# Any OpenAI-compatible endpoint
AURORA_LLM_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=http://localhost:1234/v1 \
AURORA_MODEL=local-model \
node dist/cli/index.js run "Merhaba de"

# HTTP API (Phase 9). Loopback only, and mutation denied unless opted in.
node dist/cli/index.js serve
curl -s localhost:8787/health
curl -s "localhost:8787/knowledge/search?q=ollama"
curl -s -X POST localhost:8787/agent/run \
  -H 'content-type: application/json' -d '{"task":"summarise the README"}'
```

### HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Provider reachability (the only unauthenticated route) |
| `POST` | `/agent/run` | Start a run; `202` + `runId` (`?wait=1` for inline) |
| `POST` | `/agent/cancel` | Abort a run by `runId` |
| `GET` | `/runs/:id` | Run status and result |
| `GET` | `/tasks/:id` | A persisted task record |
| `GET` | `/knowledge` | Knowledge entries (metadata only; `?kind=` filter) |
| `GET` | `/knowledge/:kind/:slug` | One entry including its body |
| `GET` | `/knowledge/search?q=` | Knowledge search with provenance |
| `GET` | `/runs` | All live runs, newest first |
| `GET` | `/` , `/ui/*` | Operator UI (only when `AURORA_UI_DIR` is set) |

The API binds to loopback by default and **refuses to start** on a non-loopback
address unless `AURORA_API_TOKEN` is set. Because an HTTP request has no terminal,
an HTTP run gets a **deny-all confirmation gate** by default, so a state-changing
tool is refused; set `AURORA_API_ALLOW_MUTATION=true` (or `serve
--allow-mutation`) to opt in. See `docs/adr/011`.

If the configured provider is unreachable, the CLI exits non-zero with a
specific message. It never reports a mock or an empty answer as success.

### Operator UI

The UI is a separate layer: framework-free ES modules in `ui/`, served by the API,
connected to the core only over HTTP. It imports no `src/` module.

```bash
node dist/cli/index.js serve          # serves ./ui by default
node dist/cli/index.js serve --no-ui  # API only
# then open http://127.0.0.1:8787/
```

Three panels — Tasks, Agents (live and finished runs, trajectory), Knowledge.
Every value from the API is inserted as **text**; the UI has no `innerHTML`,
`eval`, or inline handler, and the API sends a `default-src 'none'` CSP. A
knowledge entry containing `<script>` or `onerror=` renders as inert text. The
shell is public so a browser can load it; the data routes stay token-gated (the
token lives in `sessionStorage` and is sent as a header, never in a URL).

## Testing

```bash
npm test              # everything
npm run test:unit     # unit tests only
npm test -- tests/integration   # live-provider tests
```

Unit tests for the providers run a **real local HTTP server** over loopback and
make **real fetch calls** — the network boundary is exercised, not mocked.

The live-Ollama integration test **skips** (and says so) when Ollama is not
running. A skipped test is never reported as a pass. Force the behaviour with:

```bash
AURORA_TEST_OLLAMA=0 npm test   # force-skip
AURORA_TEST_OLLAMA=1 npm test   # force-run (fails if unreachable)
```

Live tests assert on real, on-disk evidence, not the model's prose, so a run that
only claims success fails. Because sampling models are stochastic, the research
and sub-agent tests allow up to `AURORA_TEST_LIVE_ATTEMPTS` (default 3) full runs
before concluding; the assertion itself is unchanged. The retry tolerates luck,
not an incapable model — `llama3.2:1b` fails these tests even at 2 attempts.

## Architecture

See `docs/architecture.md`. The layering rule is strict:
`core → providers → tools → api/cli`, with `core` never importing a concrete
provider. Decisions are recorded in `docs/adr/`.

## Security posture

Web content is treated as `UNTRUSTED DATA`, never as instructions, and is
wrapped in nonce-delimited markers (Phase 3). Prompt injection is **not** claimed
to be solved — the goal is defense-in-depth and auditability. See
`docs/research/security.md` and `docs/adr/004`.

After the agent changes the workspace, it may not report success unless an
**external** check (a real process exit code) agreed; the verify→repair loop is
bounded and escalates when the bound is hit (Phase 4, `docs/adr/006`). A check
that could not run is reported as `skipped`, never as a pass.

Phase 8 adds operator-facing controls (`docs/adr/010`): credentials are redacted
from logs and confirmation prompts by *shape* (not only by known key path), a
state-changing tool call passes through a three-valued confirmation gate
(`approved | denied | unavailable`), network tools are rate-limited per tool, and
a tool call whose arguments exceed `AURORA_MAX_ARGUMENT_BYTES` is refused. Set
`AURORA_CONFIRM_MODE=deny` (or run `aurora run --confirm`) to gate mutations, and
`aurora run --no-confirm` for unattended use. Redaction covers operator-visible
surfaces, not the model's observations — a file containing a key stays readable,
so a session can inspect it deliberately.

Phase 9 exposes the runtime over HTTP (`docs/adr/011`). The API is
**read/research-shaped by default**: it binds to loopback, refuses to start on a
public address without a token, and runs with a deny-all confirmation gate unless
`AURORA_API_ALLOW_MUTATION=true` is set deliberately. Requests are
rate-limited per client, the body is capped while streaming, and concurrency is
bounded, so a caller cannot turn the agent into an unbounded queue.

## Adding knowledge for future sessions

Repository-specific context lives in `AGENTS.md`. See
`docs/research/sources.md` for the sourced research behind every design choice.
