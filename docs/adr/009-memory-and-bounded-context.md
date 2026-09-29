# ADR 009 — Memory & Bounded Context: Three Tiers, External Records, Extract-not-Summarise

- Status: Accepted
- Date: 2026-09-28

## Context

Phase 7's deliverables are `ContextBuilder`, `WorkingMemory` and
`SessionMemory`, with one stated acceptance criterion:

> "Context compaction, memory katmanları, token budget."
> (Context compaction, memory tiers, token budget.)

The research pass (`docs/research/memory-systems.md`) is blunt about the failure
this phase exists to prevent: an agent loop that concatenates every message
grows without bound, and as the transcript grows the model stops attending to
the original task — "memory interference". The loop built in Phase 1 appends
every observation forever. That is a bug, and Phase 7 is where it is fixed.

Three questions had to be settled before writing code.

**What is a memory tier, really?** The research names three: Working (current
loop), Session (one conversation, cross-restart), Knowledge (long-term,
cross-session). The Knowledge tier already exists from Phase 3 (`FileKnowledgeStore`, ADR 002) and is tool-driven. Phase 7 must add Working and Session
without either duplicating Knowledge or re-litigating it.

**How does Session memory re-enter the context?** A stored prior session is a
*summary* — but a summary written by whom? ADR 001 established that a model
evaluating its own output is not a trustworthy signal. A model-written
self-summary would smuggle unverified claims back into the context as if they
were memory. This is a correctness question, not a style one.

**Is compaction lossy, and is that acceptable?** Bounding context means dropping
something. The design must say *what* is dropped, in *what order*, and must
never drop the thing the run is defined by.

## Decision

### 1. Three tiers, one of them already built

| Tier | Scope | Storage | Introduced |
|---|---|---|---|
| Working | current run's transcript | in-memory (`InMemoryWorkingMemory`) | Phase 7 |
| Session | one conversation | file, one JSON per record (`FileSessionStore`) | Phase 7 |
| Knowledge | cross-session research | filesystem, tool-driven (`FileKnowledgeStore`) | Phase 3 (ADR 002) |

The Knowledge tier is deliberately **not** re-implemented. Retrieval into
context stays explicit and tool-driven (`knowledge_search`), because the
research doc lists "which retrieval mechanism" (always-inject vs. retrieve) as
an explicit open question and prematurely embedding it into every prompt would
answer a question the project has not settled. This is recorded as
DOĞRULANACAK, not decided by default.

### 2. Session records are external and atomic, not model-written

`SessionRecord` is a small extract: task, timestamps, status, a truncated final
answer, the tool names used, iteration/tool-call counts. It is written by
`AgentRuntime.runTask` after a run completes, and it is loaded by a *later*
runtime purely from disk.

Durability reuses the Phase 6 lesson verbatim (ADR 008): every write goes to a
temp file and is `rename`d into place, so a crash cannot leave a half-written
record that a later `recent()` would choke on. The store is single-process, like
`FileTaskStore`, and says so.

### 3. Recall is *extractive*, never generated

`buildSessionRecall` assembles the recall block from stored fields — task,
status, tools, truncated answer. It does **not** ask a model to summarise. Two
reasons:

1. A generated summary is an unverified claim re-entering context as if it were
   fact; ADR 001's whole thesis is that this is untrustworthy as an *evaluation*
   signal, and memory is a stronger position than evaluation.
2. A deterministic extract is auditable: the operator can read exactly what a
   run was seeded with. Model-based summarisation is left as DOĞRULANACAK.

### 4. Recall re-enters as UNTRUSTED user data

A prior session's text — especially an output derived from a fetched page — is
data, not authority. The block is wrapped by `wrapUntrusted` (ADR 004) with a
fresh nonce and a size cap, and `AgentLoop` injects it as a **user** message,
never a `system` message, immediately *before* the task. The task therefore
remains the last user message — the run's actual instruction is not displaced by
its own history.

### 5. The transcript is full; the provider call is bounded

The loop keeps the complete transcript in `messages`. Each provider call gets a
*bounded view* from `ContextBuilder` (ADR 009's port):

```
 1. In budget                     → transcript unchanged, zero loss
 2. Shorten oversized observations → keep head + tail, insert a visible marker
 3. Elide whole middle turns       → oldest first, protect the head and the tail
 4. Still over budget?             → report `overBudget`, do not drop the task
```

Steps run cheapest-and-least-lossy first. Whole *turns* are elided, never
individual messages, because splitting an assistant `tool_calls` message from
its `tool` results produces a transcript every provider rejects.

The **protected head** is the leading run of `system`/`user` messages: the
system prompt, any recall block, and the task. It is *counted dynamically*
rather than fixed at 2, because the moment recall was added a fixed count would
have silently stopped protecting the task. The omission notice is inserted
*after* the head, never into the system prompt — the system prompt is the trust
anchor (ADR 004) and is not rewritten.

Token estimation is a labelled heuristic (`HeuristicTokenEstimator`, ~4
chars/token, conservative). AURORA is provider-independent and has no universal
tokenizer, and each Ollama model ships its own; the number decides *when to
compact*, never a hard API limit, so a conservative heuristic is honest here.

## Consequences

- The loop's context is bounded. Measured on this host with the real
  `ContextBuilder` (4 KB observations, 8 000-token budget):

  | turns | raw tokens | bounded tokens |
  |---|---|---|
  | 5 | 5 099 | 5 099 |
  | 25 | 25 439 | 7 181 |
  | 50 | 50 864 | 7 181 |
  | 100 | 101 714 | 7 181 |
  | 200 | 203 414 | 7 181 |

  Raw history grows linearly with the run; the bounded view plateaus. An
  8 000-token budget held a 200-turn, 200 k-token transcript at 7 181 tokens.

- A restart is not a memory wipe: a new process reads prior sessions off disk
  and seeds the next run with them.
- The task and the system prompt survive every compaction; the tests fail if
  they do not (mutation-tested).
- Recall can never become an instruction channel: it is nonce-wrapped,
  size-capped, and injected as user data (ADR 004).
- Session persistence cannot fail a run: a save error is logged and the run's
  output is returned unchanged.

## Alternatives considered

**Summarise prior sessions with the model.** Cheaper in tokens than an extract,
but it injects unverified claims as memory and cannot be audited. Rejected in
favour of a deterministic extract; model summarisation is DOĞRULANACAK.

**Inject the whole prior transcript.** Faithful, but unbounded and re-imports
stale tool output — exactly the memory interference Phase 7 exists to remove.
Rejected in favour of the bounded, extractive recall.

**A fixed protected-head count (`protectedHead: 2`).** Simpler, and correct
until recall was added; then it protects the system prompt and the recall block
and lets the *task* be elided. Rejected in favour of counting the leading
system/user run.

**Elide individual messages instead of turns.** Keeps more recent text, but can
orphan a `tool` message from the `tool_calls` that requested it. Rejected.

**Add a vector DB / embeddings now.** The research explicitly does not require
one for a long-term agent MVP, and a vector store would not answer the
"which retrieval mechanism" question any better than `knowledge_search` does.
Deferred; `KnowledgeStore` and the context port are the seams it would attach
behind (ADR 002's same bet).

**Elide the task rather than exceed the budget.** Never: a run that answers the
wrong question is worse than a run whose prompt is too long. `overBudget` is
reported instead.
