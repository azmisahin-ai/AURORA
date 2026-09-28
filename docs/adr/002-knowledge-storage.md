# ADR 002 — Knowledge Storage: Filesystem + JSON Metadata (MVP)

- Status: Accepted
- Date: 2026-09-28

## Context

AURORA needs durable, cross-session knowledge (research results, API facts,
technical notes) with provenance. Options ranged from a plain filesystem to a
vector DB to a hybrid vector+graph store.

Research (`docs/research/memory-systems.md`, `rag.md`) found:

- The dominant pattern in real coding agents is the simplest one: a markdown file
  injected into context at session start (Zylos Research, 2026-04).
- Vector+graph stores are described as the *long-term* tier and are not required
  at working/session scope.
- Retrieval can surface stale/incorrect content ("false memory",
  arXiv 2603.29194), so provenance metadata is mandatory regardless of backend.

## Decision

Use a **filesystem-backed knowledge store** with a JSON metadata sidecar.

Layout:

```text
knowledge/
  topics/<topic>/<slug>.md      # synthesized, curated content
  sources/<source-slug>.md      # raw extracted source, as fetched
  research/<date>-<slug>/report.md
```

Each entry's metadata:

```json
{
  "topic": "ollama-api-chat",
  "source": "https://docs.ollama.com/api/chat",
  "retrievedAt": "2026-09-28T00:00:00Z",
  "provider": "web-fetch",
  "verified": true
}
```

Access is via a `KnowledgeStore` **interface**; `FileKnowledgeStore` is the MVP
implementation. Search is keyword-based over topic/source slugs and metadata.

## Rationale

- Zero external dependency; inspectable with `cat`/`git`; trivially auditable.
- Provenance-first design keeps the door open for any future backend without
  changing callers.
- Matches the plan's "MVP'de DB zorunlu değil" and the observed industry pattern.

## Alternatives considered

- **SQLite FTS5** — good upgrade, but adds schema/migration overhead before the
  corpus justifies it. Deferred, not rejected.
- **Embeddings + vector DB** — rejected for MVP: operational cost, and no
  benchmark established that it beats keyword search at this scale
  (**DOĞRULANACAK**).
- **Vector + graph (Mem0-style)** — rejected: overkill for MVP.

## Consequences

- Keyword search has limited semantic recall; acceptable at MVP scale.
- Whole-document storage (no chunking) will eventually exceed context; the
  token-budget cap at injection time mitigates this but is a known limit.
- Migration path: implement `SqLiteFtsKnowledgeStore` behind the same interface
  when the corpus grows of a keyword index. No caller changes required.

## Compliance

- `KnowledgeStore` is an interface; `FileKnowledgeStore` is the only MVP impl.
- Integration test: write → read → search round-trip with metadata preserved.
