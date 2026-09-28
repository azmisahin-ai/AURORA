# AURORA

**Autonomous Unified Research & Operations Runtime Agent**

A provider-independent agent runtime in TypeScript. Built phase by phase, every
claim either tested or explicitly marked *DOĞRULANACAK*.

## Status

- **Phase 0** — research + ADRs: ✅ complete (`docs/research/`, `docs/adr/`)
- **Phase 1** — core agent loop + CLI + LLM providers: ✅ complete
- Phases 2–10: not started. See `docs/roadmap.md`.

## Requirements

- Node.js ≥ 20
- An LLM provider: either a local [Ollama](https://ollama.com) server, or any
  OpenAI-compatible endpoint.

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

## Usage

```bash
# With a local Ollama server
ollama serve            # in another terminal
node dist/cli/index.js run "Merhaba de"

# Override per-invocation
node dist/cli/index.js run "Node.js hakkında araştırma yap" --max-iterations 10

# Any OpenAI-compatible endpoint
AURORA_LLM_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=http://localhost:1234/v1 \
AURORA_MODEL=local-model \
node dist/cli/index.js run "Merhaba de"
```

If the configured provider is unreachable, the CLI exits non-zero with a
specific message. It never reports a mock or an empty answer as success.

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

## Architecture

See `docs/architecture.md`. The layering rule is strict:
`core → providers → tools → api/cli`, with `core` never importing a concrete
provider. Decisions are recorded in `docs/adr/`.

## Security posture

Web content is treated as `UNTRUSTED DATA`, never as instructions, and will be
wrapped in nonce-delimited markers once the web tools land (Phase 3). Prompt
injection is **not** claimed to be solved — the goal is defense-in-depth and
auditability. See `docs/research/security.md` and `docs/adr/004`.

## Adding knowledge for future sessions

Repository-specific context lives in `AGENTS.md`. See
`docs/research/sources.md` for the sourced research behind every design choice.
