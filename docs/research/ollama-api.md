# Ollama API — Research Notes

Access date: **2026-09-28**. Primary source: `docs.ollama.com`.

Scope: the exact request/response shapes AURORA's `OllamaProvider` must speak.
This file is the specification the provider code is written against, so every
field below is quoted from the official docs.

## 1. `POST /api/chat`

Source: <https://docs.ollama.com/api/chat> (accessed 2026-09-28).

Request body fields (verified):

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | string | yes | Model name |
| `messages` | object[] | yes | `{role, content}` history |
| `tools` | object[] | no | Function tools the model may call |
| `format` | `"json"` \| JSON schema | no | Structured output |
| `options` | object | no | Runtime generation options |
| `stream` | boolean | no | **default `true`** |
| `think` | boolean \| `"high"\|"medium"\|"low"\|"max"` | no | Separate thinking output |
| `keep_alive` | string \| number | no | e.g. `5m`, `0` = unload |
| `logprobs` | boolean | no | Token log probabilities |
| `top_logprobs` | integer | no | Most likely tokens at each position |

Response body fields (verified): `model`, `created_at`, `message`
(`role`, `content`, `thinking`, `tool_calls[].function.{name,description,arguments}`,
`images`), `done`, `done_reason`, `total_duration`, `load_duration`,
`prompt_eval_count`, `prompt_eval_cached_count`, `prompt_eval_duration`,
`eval_count`, `eval_duration`, `logprobs[]`.

Minimal verified example from the docs:

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "gemma4",
  "messages": [ { "role": "user", "content": "why is the sky blue?" } ]
}'
```

## 2. Streaming

Source: <https://docs.ollama.com/api/streaming> and
<https://docs.ollama.com/capabilities/streaming> (accessed 2026-09-28).

- "Certain API endpoints stream responses by default, such as `/api/generate`.
  These responses are provided in the newline-delimited JSON format (i.e. the
  `application/x-ndjson` content type)."
- Streaming is disabled with `{"stream": false}` — the response is then a single
  `application/json` object.
- Each NDJSON line is a partial object; the final line has `done: true` and
  `done_reason` (e.g. `"stop"`).

## 3. Tool calling

Source: Ollama blog "Streaming responses with tool calling"
<https://ollama.com/blog/streaming-tool>; docs capabilities/streaming; and
localaimaster.com "Ollama Tool Calling" (accessed 2026-09-28).

- Tools are passed in the request `tools` array.
- In streaming mode, a `tool_calls` array appears in a message chunk:

  ```json
  {"model":"qwen3","created_at":"...","message":{"role":"assistant","content":"",
   "tool_calls":[{"function":{"name":"get_current_weather",
   "arguments":{"format":"celsius"}}}]},"done":false}
  ```

- Official guidance: "Watch for streamed `tool_calls` in each chunk, execute the
  requested tool, and append tool outputs back into the conversation."
- "It is necessary to accumulate the partial fields in order to maintain the
  history of the conversation. This is particularly important for tool calling
  where the thinking, tool call from the model, and the executed tool result must
  be passed back to the model in the next request."

**Provider implication:** `OllamaProvider.stream()` must yield chunks that retain
`tool_calls`, and the caller must concatenate partial content. The provider must
not drop `tool_calls` while streaming.

## 4. NDJSON parsing robustness

Because the stream is newline-delimited, the provider must:

1. Buffer raw bytes and split on `\n` (a chunk may contain a partial line, or
   several lines).
2. `JSON.parse` each complete line; skip empty lines.
3. Stop on `done: true`.

**DOĞRULANACAK:** The docs do not state whether a JSON object may ever contain a
literal newline. Assumption: one JSON object per line, no embedded newlines.
Verified by test against a local server in Phase 3 integration; not yet verified
against a live Ollama in this environment (Ollama is not installed here — see
`docs/architecture.md`).

## 5. Environment note for this build

Ollama is **not** available in the current build environment (no `ollama`
binary; nothing listening on `localhost:11434`). Therefore every integration
test that requires a live Ollama is skipped and reported as SKIP, never as PASS.
Unit tests use a local mock HTTP server, which is a *real* HTTP round-trip
against a *real* server — not a mocked provider — and is reported as such.
