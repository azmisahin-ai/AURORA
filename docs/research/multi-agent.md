# Multi-Agent — Research Notes

Access date: **2026-09-28**.

Scope: sub-agent architectures and role decomposition for AURORA Phase 5.

## 1. Multi-agent orchestration shapes

Source: futureagi.com, "LLM Agent Architectures 2026"
<https://futureagi.com/blog/llm-agent-architectures-core-components> (accessed
2026-09-28):

> "Multiple specialised agents collaborate. Common shapes: planner-executor,
> supervisor-worker, maker-checker. Most production multi-agent systems compose
> ReAct, Plan-and-Execute, or Reflexion inside the individual agents and use the
> orchestration runtime to handle handoffs."

Source: digitalapplied.com, "Agent Architecture Patterns: 2026 Taxonomy Guide"
<https://www.digitalapplied.com/blog/agent-architecture-patterns-taxonomy-2026>:

> "supervisor-worker + verifier-critic for high-stakes multi-agent; graph
> orchestration for production-grade observability."

AURORA's role set (Researcher, Coder, Tester, Reviewer, Documenter) is closest to
the **supervisor-worker** shape with a **maker-checker** (Coder↔Tester/Reviewer)
sub-pattern.

## 2. Context isolation is the whole point

- MLflow: multi-agent is chosen "when the task exceeds a single agent's context
  window or requires parallel specialization"
  (<https://mlflow.org/articles/types-of-ai-agent-architectures-2026-developer-guide>,
  accessed 2026-09-28).
- This implies each sub-agent must get a **bounded, isolated context** — not the
  parent's full transcript. Phase 5's acceptance test asserts context isolation,
  not just "it spawned".

## 3. Cost and failure modes

- arahi.ai: "ReAct beats Plan-Execute beats Multi-Agent for most starting
  points" — i.e. do not reach for multi-agent first
  (<https://arahi.ai/blog/ai-agent-architecture>, accessed 2026-09-28).
- Multi-agent systems add coordination failure modes; the plan therefore gives
  each sub-agent an explicit **budget** (max iterations, max tool calls) and a
  **permission set**.

## 4. Design constraints derived for AURORA

1. Sub-agents are **in-process, role-based instances**, not microservices — keeps
   the MVP debuggable (matches arahi.ai's "single-file code is fine" ethos).
2. Each sub-agent receives: task, isolated context slice, permission set, tool
   subset, budget.
3. Handoffs carry a structured result, not raw transcripts.
4. Verification (Tester/Reviewer) depends on **external signals** — see
   `agent-architectures.md` §3.

## Open questions

- **DOĞRULANACAK:** Whether to add parallelism across sub-agents in MVP. The plan
  defers it; no concurrency benchmark was run.
- **DOĞRULANACAK:** Token accounting per sub-agent (how to attribute shared
  context cost) is undefined.
