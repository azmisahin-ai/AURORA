# Frameworks Comparison — Research Notes

Access date for all sources in this file: **2026-09-28**.

Scope: compare the leading agent frameworks/SDKs and decide how (and whether)
AURORA should depend on any of them.

## Summary table

Sources: requesty.ai "Best AI Agent SDKs Compared (2026)"
<https://www.requesty.ai/blog/best-ai-agent-sdks-compared-2026-langchain-crewai-openai-anthropic-google>;
gurusup.com "Best Multi-Agent Frameworks in 2026"
<https://gurusup.com/blog/best-multi-agent-frameworks-2026>; morphllm.com
"AI Agent Frameworks (2026 Update)" <https://www.morphllm.com/ai-agent-framework>;
langfuse.com "Open-Source AI Agent Frameworks" (updated 2026-07-13)
<https://langfuse.com/blog/2025-03-19-ai-agent-comparison>. All accessed
2026-09-28.

| Framework | Language | Model lock-in | Strength | Trade-off |
|---|---|---|---|---|
| LangGraph / LangGraph.js | Python, TS | Agnostic | Stateful graph workflows, checkpointing, used by Uber/Klarna | Heavier, graph-first mental model |
| OpenAI Agents SDK | Python, TS | OpenAI-first | Fastest to a working loop, built-in tracing/guardrails | Vendor affinity; durability is BYO |
| Google ADK 2.0 | Python, Go, TS | Optimized for Gemini | Multi-language, Google Cloud/Vertex integration | Newest; "early" production readiness |
| Claude Agent SDK | Python, TS | Claude-only | Deep OS/coding tools, safety-focused, sub-agents | Model lock-in |
| CrewAI | Python | Agnostic | Role-based multi-agent, fastest prototype (2–4h) | Limited checkpointing |
| Microsoft Agent Framework 1.0 (GA 2026-04-03) | .NET, Python | Agnostic | Enterprise/Azure integration | Azure-centric |
| Mastra | TS | Agnostic | TS-native, built-in workflows/memory/Studio | Opinionated defaults |
| Vercel AI SDK 7 | TS | Agnostic | `ToolLoopAgent`, `WorkflowAgent` durable steps | JS/TS only |

## Key findings

1. **No framework wins on every axis.** requesty.ai: "The agent SDK landscape in
   2026 has matured past the 'pick one framework' era. Most production teams use
   two or three." (accessed 2026-09-28).
2. morphllm.com: "There is no single best. … The best framework is the one that
   matches your specific orchestration pattern and deployment constraints."
3. LangGraph's production credentials (Uber, Klarna; ~400 enterprise deployments;
   34.5M monthly PyPI downloads) are the strongest on the stateful-workflow axis
   (uvik.net <https://uvik.net/blog/agentic-ai-frameworks>, accessed 2026-09-28).
4. MCP support is now near-universal: "Claude Agent SDK has the deepest
   integration. CrewAI supports it natively via `crewai-tools[mcp]`. LangGraph
   integrates MCP servers as tools via adapters." (morphllm.com, accessed
   2026-09-28).

## Decision for AURORA

The plan's stance — **build our own thin abstractions, lock into nothing** — is
supported by the sources above: framework choice "moves agent benchmark
performance by up to 30 percentage points on identical models" (uvik.net), so the
choice is consequential, but no framework is universally correct.

AURORA's `core` must not import any framework. Frameworks are, at most,
*inspiration* and optionally swappable adapters behind our own interfaces
(`LLMProvider`, `ToolRegistry`, …). See `docs/adr/003-provider-abstraction.md`.

## TypeScript-specific runtimes (2026)

Sources: jamesqquick.com "The Best TypeScript Tools for Building AI Agents
(2026)" <https://jamesqquick.com/blog/best-typescript-tools-ai-agents-2026>;
langfuse.com; langchain.com.

- **Mastra** — TS-first, batteries-included: workflow engine with run-state
  snapshots for suspend/resume, pluggable storage, `Studio` dev environment,
  Memory Gateway.
- **LangGraph.js** — durable runtime, checkpointing, any model.
- **Cloudflare Agents SDK** — durable, but Cloudflare-only deployment.
- **Inngest AgentKit** — durable runtime, step memoization and retries.
- **Vercel AI SDK 7** — `ToolLoopAgent` (classic tool-calling loop with stopping
  conditions), `HarnessAgent`, `WorkflowAgent` (durable steps).

The plan named Flue, Strands Agents TypeScript 1.0, kb-agent-framework, and
Nexora-Agent as prior art. **DOĞRULANACAK:** these four were *not* independently
confirmed from primary sources in this pass (only secondary/marketing material
was available). Treat their feature lists as unverified; take ideas, not code.

## Non-negotiable conclusion

Framework choice is deferred. MVP ships its own `LLMProvider` + `AgentLoop`.
Any future framework integration must sit behind an AURORA-owned interface so it
can be removed without touching `core`.
