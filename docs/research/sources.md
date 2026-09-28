# Sources

All URLs below were accessed on **2026-09-28** unless otherwise noted. Where a
claim rests only on a secondary source, the primary is flagged as
**DOĞRULANACAK** in the relevant research file.

## Primary / official

| Source | URL | Used for |
|---|---|---|
| Ollama — Generate a chat message | https://docs.ollama.com/api/chat | `/api/chat` request/response schema |
| Ollama — Streaming | https://docs.ollama.com/api/streaming | NDJSON default, `stream:false` |
| Ollama — Streaming capabilities | https://docs.ollama.com/capabilities/streaming | chunk accumulation, tool calls |
| Ollama blog — Streaming tool calls | https://ollama.com/blog/streaming-tool | `tool_calls` in streamed chunks |
| MCP spec 2026-07-28 | https://modelcontextprotocol.io/specification/2026-07-28 | primitives, JSON-RPC, stateless revision |
| MCP architecture 2025-11-25 | https://modelcontextprotocol.io/specification/2025-11-25/architecture | host/client/server, capability negotiation |
| MCP blog — 2026-07-28 release | https://blog.modelcontextprotocol.io/posts/2026-07-28 | `initialize` retired, MRTR, `_meta` |
| Microsoft Learn — indirect prompt injection | https://learn.microsoft.com/en-us/security/zero-trust/sfi/defend-indirect-prompt-injection | defense-in-depth framing |

## Academic

| Source | URL | Status |
|---|---|---|
| arXiv 2603.29194 — Multi-Layered Memory Architectures | https://arxiv.org/html/2603.29194v1 | preprint, accessed 2026-09-28 |
| arXiv 2606.05976 — The Self-Correction Illusion | https://arxiv.org/html/2606.05976v1 | preprint, accessed 2026-09-28 |
| arXiv 2504.19413 — Mem0 (cited via Zylos) | (via secondary) | **DOĞRULANACAK** |
| Preprints.org — Limits of Self-Correction in LLMs | https://www.preprints.org/frontend/manuscript/39eedf90ab65aa6c4e3d4498868bc56a/download_pub | **not peer-reviewed**, posted 2026-04-09 |

## Industry / blogs (secondary — treated as such)

| Source | URL |
|---|---|
| MLflow — Types of AI Agent Architectures 2026 | https://mlflow.org/articles/types-of-ai-agent-architectures-2026-developer-guide |
| futureagi — LLM Agent Architectures 2026 | https://futureagi.com/blog/llm-agent-architectures-core-components |
| digitalapplied — Agent Architecture Patterns Taxonomy 2026 | https://www.digitalapplied.com/blog/agent-architecture-patterns-taxonomy-2026 |
| arahi.ai — AI Agent Architecture 2026 | https://arahi.ai/blog/ai-agent-architecture |
| servicesground — Agentic Reasoning Patterns 2026 | https://servicesground.com/blog/agentic-reasoning-patterns |
| requesty.ai — Best AI Agent SDKs 2026 | https://www.requesty.ai/blog/best-ai-agent-sdks-compared-2026-langchain-crewai-openai-anthropic-google |
| gurusup — Best Multi-Agent Frameworks 2026 | https://gurusup.com/blog/best-multi-agent-frameworks-2026 |
| morphllm — AI Agent Frameworks 2026 | https://www.morphllm.com/ai-agent-framework |
| uvik.net — Agentic AI Frameworks 2026 | https://uvik.net/blog/agentic-ai-frameworks |
| langfuse — Open-Source AI Agent Frameworks | https://langfuse.com/blog/2025-03-19-ai-agent-comparison |
| LangChain — Best AI agent frameworks 2026 | https://www.langchain.com/resources/ai-agent-frameworks |
| jamesqquick — Best TypeScript Tools for AI Agents 2026 | https://jamesqquick.com/blog/best-typescript-tools-ai-agents-2026 |
| workflowbuilder — Best AI agent frameworks 2026 | https://www.workflowbuilder.io/blog/best-ai-agent-frameworks |
| Zylos Research — AI Agent Memory Architectures | https://zylos.ai/research/2026-04-05-ai-agent-memory-architectures-persistent-knowledge |
| aakashx — Prompt Injection: 6 Attacks and 6 Defenses | https://www.aakashx.com/blog/prompt-injection-attacks-defenses |
| theroadtoenterprise — Prompt Injection Defense, OWASP LLM Top 10 | https://theroadtoenterprise.com/blog/prompt-injection-ai-features-production |
| dev.to — Top 9 AI Security Tools 2026 | https://dev.to/kamya_shah_e69d5dd78f831c/top-9-ai-security-tools-for-prompt-injection-and-data-leakage-in-2026-2in5 |
| Arthur — Self-Correction Loops for AI Agents | https://www.arthur.ai/column/what-is-a-self-correction-loop-for-ai-agents |
| webfuse — MCP Cheat Sheet 2026 | https://www.webfuse.com/mcp-cheat-sheet |

## Consolidated list of unresolved claims (DOĞRULANACAK)

1. Game-of-24 74% vs 4% (ToT) — primary arXiv paper not opened.
2. ReWOO 30–50% token reduction — primary paper not opened.
3. Gartner "1,445% multi-agent inquiries" — secondary only.
4. Mem0's 26% / 91% / 90% LOCOMO figures — vendor paper via secondary.
5. Flue / Strands TS 1.0 / kb-agent-framework / Nexora-Agent feature lists —
   not confirmed from primary sources.
6. SSRF CIDR ranges and path-traversal technique — standard practice, no primary
   OWASP source opened in this pass.
7. Keyword vs dense vs hybrid retrieval ranking — general consensus, not
   measured for AURORA's corpus.
8. NDJSON "one JSON object per line, no embedded newlines" assumption — docs do
   not state this explicitly.
