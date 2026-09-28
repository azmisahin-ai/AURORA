# MCP (Model Context Protocol) — Research Notes

Access date: **2026-09-28**.

## 1. What MCP is

Source: official spec, <https://modelcontextprotocol.io/specification/2026-07-28>
and <https://modelcontextprotocol.io/specification/2025-11-25/architecture>
(accessed 2026-09-28):

> "Model Context Protocol (MCP) is an open protocol that enables seamless
> integration between LLM applications and external data sources and tools."

> "The protocol uses JSON-RPC 2.0 messages to establish communication between:
> Hosts: LLM applications that initiate connections; Clients: Connectors within
> the host application; Servers: Services that provide context and capabilities."

Architecture: "client-host-server … each host can run multiple client instances.
… clear security boundaries and isolating concerns."

## 2. Primitives

Source: MCP spec (2026-07-28) and webfuse.com "MCP Cheat Sheet (2026)"
<https://www.webfuse.com/mcp-cheat-sheet> (accessed 2026-09-28).

| Primitive | Direction | List method | Get/Call | Use case |
|---|---|---|---|---|
| Tools | Server → Client | `tools/list` | `tools/call` | Execute actions, fetch live data |
| Resources | Server → Client | `resources/list` | `resources/read` | Read-only context |
| Prompts | Server → Client | `prompts/list` | `prompts/get` | Reusable templates |
| Sampling | Client → Server | — | `sampling/createMessage` | Server requests an LLM completion |
| Elicitation | Server → Client | — | — | Server-initiated request for user info |

Servers declare capabilities (resource subscriptions, tools, prompts); clients
declare capabilities (sampling, notification handling). "Both parties must
respect declared capabilities throughout the session." (spec, 2025-11-25
architecture page).

## 3. Transports

Source: webfuse.com cheat sheet (accessed 2026-09-28):

- **stdio** — no network overhead, single-client by design, natural isolation;
  "Best for local tools: filesystem, CLI, databases".
- **Streamable HTTP (remote)** — HTTP POST + SSE; multiple concurrent clients;
  auth via bearer tokens / API keys / OAuth 2.0 / custom headers.

## 4. The 2026-07-28 spec revision (stateless direction)

Source: MCP blog, "The 2026-07-28 Specification"
<https://blog.modelcontextprotocol.io/posts/2026-07-28> (accessed 2026-09-28):

- The protocol "evolved into a stateless architecture".
- "retired the `initialize`/`initialized` exchange along with the `Mcp-Session-Id`
  header (SEP-2575, SEP-2567). Each request now travels on its own, carrying its
  protocol version, client identity, and client capabilities in `_meta`."
- New optional `server/discover` RPC replaces mandatory initialization.
- Server-to-client requests (sampling, elicitation) move to "Multi Round-Trip
  Requests (MRTR), removing the need for constantly open bidirectional streams".

**Implication for AURORA:** the protocol is still moving. Any MCP adapter must be
isolated behind an interface so a spec change does not ripple into `core`.

## 5. Decision for AURORA

- MCP is **optional**, added after the MVP. The plan's rationale holds: MCP's
  value is interoperability with third-party tool servers; the MVP does not need
  it to demonstrate a working agent loop.
- MCP support across the ecosystem is near-universal (morphllm.com), so deferring
  costs little and avoids coupling to a spec that changed materially in 2026.

## Open questions

- **DOĞRULANACAK:** Whether to implement stdio transport, streamable HTTP, or
  both first. No prototype was built in this pass.
- **DOĞRULANACAK:** Which MCP client library to use (official TS SDK vs hand
  rolled JSON-RPC) — not evaluated.
