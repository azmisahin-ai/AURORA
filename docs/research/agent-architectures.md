# Agent Architectures — Research Notes

Access date for all sources in this file: **2026-09-28**.

Scope: the five canonical single-agent / orchestration architectures (ReAct,
Plan-Execute, Reflexion, Tree-of-Thoughts, Multi-Agent), how they trade off, and
which one AURORA should adopt for its MVP.

> Convention used across `docs/research/*`: claims carry an inline citation. Where
> a claim could not be confirmed against a primary/authoritative source it is
> tagged **DOĞRULANACAK**.

## 1. The five canonical architectures

Source: MLflow, "Types of AI Agent Architectures: 2026 Developer Guide"
<https://mlflow.org/articles/types-of-ai-agent-architectures-2026-developer-guide>
(accessed 2026-09-28).

Source: Arahi AI, "AI Agent Architecture in 2026: The Practical Reference"
<https://arahi.ai/blog/ai-agent-architecture> (accessed 2026-09-28).

| Architecture | Core idea | When it wins | Cost / latency |
|---|---|---|---|
| ReAct | Interleave thought → action → observation in one live loop | Open-ended tool use, unknown solution path | Low |
| Plan-Execute | Produce a full step list first, then execute each step | Long-horizon, enumerable subtasks, parallelism | Medium |
| Reflexion | Add a verbalized self-critique / memory after each cycle | Accuracy-critical tasks (latency secondary) | Medium-high |
| Tree-of-Thoughts | Explore multiple reasoning branches, backtrack | Problems needing search/backtracking | Very high (10–100x CoT tokens) |
| Multi-Agent | Several specialized agents with an orchestration runtime | Task exceeds one context window / needs specialization | High |

### 1.1 ReAct

- "ReAct is the safe default for simple tool-use agents because it interleaves
  thought, action, and observation in a single loop." (futureagi.com,
  <https://futureagi.com/blog/llm-agent-architectures-core-components>, accessed
  2026-09-28).
- "Start simple — begin with a ReAct loop and add complexity only when data
  justifies it." (MLflow, same URL as above).

### 1.2 Plan-Execute

- "Plan-and-Execute is stronger for long-horizon tasks where a separate planner
  produces a step list before execution." (futureagi.com, accessed 2026-09-28).
- MLflow: choose Plan-Execute "when the task has clear, enumerable subtasks and
  parallelism is possible".

### 1.3 Reflexion

- "Reflexion improves on both by adding a verbalized self-critique loop that
  learns from past mistakes." (futureagi.com, accessed 2026-09-28).
- MLflow: choose Reflexion "when output accuracy is the primary metric and
  latency is secondary".

### 1.4 Tree-of-Thoughts

- MLflow: choose ToT "when the problem space requires exploring multiple
  reasoning paths".
- servicesground.com reports "Tree of Thoughts solved 74% of Game of 24
  mathematical tasks using GPT-4, compared to just 4% with standard
  Chain-of-Thought … The tradeoff: ToT costs 10–100x more tokens than CoT"
  (<https://servicesground.com/blog/agentic-reasoning-patterns>, accessed
  2026-09-28). This specific 74% / 4% figure originates from the original
  Game-of-24 paper; the secondary source is cited here. **DOĞRULANACAK:** the
  primary arXiv paper was not opened in this pass.

### 1.5 Multi-Agent

- Common shapes: "planner-executor, supervisor-worker, maker-checker". "Most
  production multi-agent systems compose ReAct, Plan-and-Execute, or Reflexion
  inside the individual agents and use the orchestration runtime to handle
  handoffs." (futureagi.com, accessed 2026-09-28).
- MLflow: choose Multi-Agent "when the task exceeds a single agent's context
  window or requires parallel specialization".

## 2. The production recommendation: ReAct + Reflexion

Source: digitalapplied.com, "Agent Architecture Patterns: 2026 Taxonomy Guide"
<https://www.digitalapplied.com/blog/agent-architecture-patterns-taxonomy-2026>
(accessed 2026-09-28):

> "ReAct is still the right single-agent default. Reflexion is the right add-on
> when failure modes repeat. ReAct + Reflexion is the production-grade
> single-agent stack. Add plan-and-execute when planning is the bottleneck; add
> verifier-critic when output quality is the bottleneck."

This matches the AURORA plan's stated choice (ReAct base loop + Reflexion
verification layer). The citation above is the external grounding for that
decision.

## 3. Critical caveat — self-critique needs an external signal

Reflexion is only useful if the critique is grounded in something outside the
model's own opinion. This directly informs Phase 4 of the plan.

- Preprints.org, "Limits of Self-Correction in LLMs: An Information-Theoretic
  Analysis" <https://www.preprints.org/frontend/manuscript/39eedf90ab65aa6c4e3d4498868bc56a/download_pub>
  (posted 2026-04-09; **not peer-reviewed**): "The formal analysis identifies
  conditions under which scaling a single model's self-evaluation may be
  insufficient for reliable validation in generate-then-judge workflows. …
  Investment in external selection infrastructure (formal verification tools,
  test generation, invariant libraries, diverse [verifiers]) …"
- arXiv 2606.05976v1, "The Self-Correction Illusion: LLMs Correct Others but Not
  Themselves" <https://arxiv.org/html/2606.05976v1> (accessed 2026-09-28):
  models "confidently catch and repair errors in external content, routinely fail
  to identify identical errors in their own reasoning traces".
- Arthur, "Self-Correction Loops for AI Agents, Explained"
  <https://www.arthur.ai/column/what-is-a-self-correction-loop-for-ai-agents>
  (accessed 2026-09-28): a correction loop "feeds a post-LLM guardrail failure
  back to the LLM with a targeted correction prompt, then retries and re-checks
  until the response passes or hits a retry limit." This is the concrete shape of
  a **bounded retry** loop.

**Decision input for AURORA:** the Reflexion layer must consume an *external*
verification signal (test result, lint output, compiler error), never the model's
bare self-assessment. See `docs/adr/001-core-architecture.md` and Phase 4.

## 4. Orchestration runtimes (context, not chosen for MVP)

- "The runtime owns state, retries, checkpoints, and handoffs." (futureagi.com,
  accessed 2026-09-28).
- Arahi AI recommends explicitly naming six layers — perception, reasoning,
  planning, memory, tool use, oversight — even for small agents: "Single-file
  code is fine; muddled abstractions are not." (accessed 2026-09-28).

## Open questions

- **DOĞRULANACAK:** Empirical numbers (74% vs 4% Game-of-24; ReWOO 30–50% token
  reduction) were read from secondary blogs, not the primary papers
  (Yao et al. ToT; Xu et al. ReWOO). Verify against arXiv before quoting in any
  user-facing material.
- **DOĞRULANACAK:** "1,445% surge in multi-agent inquiries" (Gartner, via
  requesty.ai) — secondary citation only.
