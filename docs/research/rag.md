# RAG — Research Notes

Access date: **2026-09-28**.

Scope: retrieval-augmented generation strategies relevant to AURORA's Knowledge
Memory. The MVP uses no vector database; this file records what the upgrade path
looks like and what was actually verified.

## 1. Retrieval strategy ladder

Sources consulted (secondary/blog-level unless noted):

- futureagi.com, "LLM Agent Architectures 2026"
  <https://futureagi.com/blog/llm-agent-architectures-core-components>
- servicesground.com, "Agentic Reasoning Patterns (2026)"
  <https://servicesground.com/blog/agentic-reasoning-patterns>

| Strategy | Mechanism | Cost | When |
|---|---|---|---|
| Keyword / full-text | Inverted index, BM25/FTS5 | Lowest | Small corpus, exact terms |
| Dense vector | Embedding ANN search | Medium | Semantic paraphrase |
| Hybrid | Fuse lexical + dense | Higher | Best recall/robustness |

**DOĞRULANACAK:** No primary source was opened in this pass that benchmarks
keyword vs dense vs hybrid for an agent-knowledge corpus of AURORA's size. The
ranking above reflects general consensus, not a measurement we ran.

## 2. Why AURORA defers a vector DB

- Zylos Research (2026-04-05) notes vector+graph stores are the *long-term*
  tier, implying they are not required at the working/session scope
  (<https://zylos.ai/research/2026-04-05-ai-agent-memory-architectures-persistent-knowledge>,
  accessed 2026-09-28).
- The dominant practical pattern for coding agents is a plain markdown file
  injected into context — no retrieval infrastructure at all (same source).
- Therefore the MVP's "filesystem + JSON metadata + keyword search" is a
  defensible starting point, and SQLite FTS5 is the smallest credible upgrade
  (BM25 ranking, zero external service).

## 3. Provenance as a first-class requirement

Because retrieval can surface stale or wrong content ("false memory",
arXiv 2603.29194), every knowledge entry carries:

```json
{
  "topic": "ollama-api-chat",
  "source": "https://docs.ollama.com/api/chat",
  "retrievedAt": "2026-09-28T00:00:00Z",
  "provider": "web-fetch",
  "verified": true
}
```

Retrieval results must return this metadata alongside the text so the agent can
prefer verified, recent, primary sources over unverified ones.

## 4. Chunking

**DOĞRULANACAK:** No chunking benchmark was run. The MVP stores whole extracted
documents per topic file (with a token cap applied at injection time rather than
at storage time). Revisit when the corpus exceeds what fits in a single context.

## Open questions

- Chunk size / overlap for future embedding index.
- Reranking: none planned for MVP.
- Evaluation: no retrieval-quality metric defined yet (**DOĞRULANACAK**).
