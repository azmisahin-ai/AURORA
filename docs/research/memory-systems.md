# Memory Systems — Research Notes

Access date for all sources in this file: **2026-09-28**.

## 1. The three-tier production consensus

Source: Zylos Research, "AI Agent Memory Architectures: From Context Windows to
Persistent Knowledge" <https://zylos.ai/research/2026-04-05-ai-agent-memory-architectures-persistent-knowledge>
(accessed 2026-09-28):

> "The production consensus in 2025-2026 is a three-tier hierarchy:
> 1. In-context working memory — the current session's raw message buffer, tool
>    calls, and active state. Ephemeral. Cleared on session end.
> 2. Session-scoped compressed memory — summarized or extracted facts from the
>    current session, readable on demand.
> 3. Long-term persistent store — cross-session knowledge, user preferences,
>    learned workflows, persisted in vector+graph storage."

AURORA maps these to **Working / Session / Knowledge** memory (Phase 7). Note the
plan deliberately replaces the vector+graph store with a filesystem-based store
for the MVP.

## 2. Academic grounding

Source: arXiv 2603.29194v1, "Multi-Layered Memory Architectures for LLM Agents:
An Experimental Evaluation of Long-Term Context Retention"
<https://arxiv.org/html/2603.29194v1> (accessed 2026-09-28).

- "decomposes dialogue history into working, episodic, and semantic layers with
  adaptive gating and retention regularization."
- Motivation: "Traditional concatenation of dialogue history leads to memory
  interference and computational inefficiency."
- Reported gains on LOCOMO / LOCCO: "improved retention persistence, reduced
  false memory rate, and enhanced reasoning."

Note the naming difference: the paper says *working / episodic / semantic*;
AURORA says *working / session / knowledge*. The tiering concept is the same.

## 3. A concrete reference implementation — Mem0

Source: Zylos Research (same URL as §1), describing Mem0's April 2026 paper
(arXiv 2504.19413):

- Two-phase pipeline: LLM extraction → conflict detection → graph update.
- Three scopes: user / session / agent.
- Hybrid backend: vector similarity + knowledge-graph traversal.
- Claimed vs OpenAI native memory on LOCOMO: "26% higher response accuracy, 91%
  lower p95 latency, and 90% fewer tokens versus full-context methods."

**DOĞRULANACAK:** those percentages come from Mem0's own paper/claims relayed by a
secondary source; not independently reproduced here.

## 4. The simplest pattern that works — declarative memory files

Source: Zylos Research (same URL as §1):

> "The most widely adopted memory pattern in AI coding agents is also the
> simplest: a markdown file in the project root that is injected into the LLM's
> context at the start of every session. Claude Code reads `CLAUDE.md`; Codex
> reads `AGENTS.md`; Cursor reads `.cursorrules`."

This validates AURORA's MVP choice: filesystem + JSON metadata, no vector DB.

## 5. Implications for AURORA

| Layer | Scope | Storage | Compaction strategy |
|---|---|---|---|
| Working | Current task/loop | In-memory | Sliding window + tool-result truncation |
| Session | One conversation | File (JSON) | Summarize when over token budget |
| Knowledge | Cross-session | Filesystem + JSON metadata | Topic files, keyword search |

- **Context growth must be bounded** — both sources stress that naive history
  concatenation causes "memory interference" and "quadratic context growth".
  Phase 7's `ContextBuilder` must enforce a token budget, not just append.
- **False memories are a real failure mode** (arXiv 2603.29194). AURORA should
  keep provenance metadata (`source`, `retrievedAt`, `verified`) so memory entries
  can be audited rather than blindly injected.

## Open questions

- **DOĞRULANACAK:** Which retrieval mechanism to adopt when the filesystem store
  is outgrown (SQLite FTS5 vs embeddings vs hybrid). The plan lists SQLite FTS5
  as the next step; no benchmark was run to justify it.
