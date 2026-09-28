# ADR 008 — Task Persistence: Atomic Records, Checked Transitions, Bounded Recovery

- Status: Accepted
- Date: 2026-09-28

## Context

Phase 6 makes tasks survive a restart. The plan's deliverable is
`src/core/task/TaskStore.ts` with six states — `queued`, `running`, `waiting`,
`completed`, `failed`, `cancelled` — and one acceptance criterion:

> "Restart sonrası `running` task'lar `queued`'a alınıp yeniden başlatılabiliyor."
> (After a restart, `running` tasks are moved to `queued` and can be restarted.)

The research pass on durable runtimes (`docs/research/frameworks-comparison.md`)
found that every framework offering durability — LangGraph checkpointing,
Vercel AI SDK 7 durable steps, Inngest step memoization, Nexora durable runs —
shares the same idea: the *state* of work is externalised so a process restart
is not a data loss event. None of them, however, decides what should happen to
work that was interrupted mid-flight. That is the interesting question here.

Three sub-questions had to be settled before writing code.

**How durable is durable?** A record written with `writeFile` directly can be
observed half-written by a concurrent reader. If the record is the thing that
makes recovery possible, a torn record is a task that cannot be recovered — the
exact failure Phase 6 exists to prevent. This is measurable, and was measured.

**What does an illegal state change do?** A store that silently accepts
`completed → running` would let a finished task be run again, or a cancelled one
resurrected. The lifecycle has to be enforced by the store, not by convention.

**Should every interrupted task be requeued?** ADR 001 and ADR 006 both
established that retries are bounded and that exhaustion escalates rather than
loops forever. Applying the plan's acceptance criterion literally — every
`running` task becomes `queued` — would violate that: a task interrupted on its
last allowed attempt would be requeued and crash again, indefinitely.

## Decision

### 1. One JSON record per task, written atomically

`FileTaskStore` keeps `<root>/<id>.json` per task. Every write goes to a
temp file in the same directory and is `rename`d into place; `rename` is atomic
within a filesystem, so a reader sees either the old record or the new one.

This is not asserted on faith. A probe on this host, rewriting a 2 MB record
while a concurrent reader parsed it repeatedly:

| write strategy | torn reads observed | clean reads |
|---|---|---|
| temp file + `rename` | **0** | 84 |
| direct `writeFile` | **221** | 244 |

The test `never exposes a torn record to a concurrent reader`
(`tests/unit/task/file-task-store.test.ts`) encodes this: it hammers the record
during 40 rewrites and requires zero unparseable reads. Replacing the rename
with an in-place write makes it fail, which is how the guarantee is kept honest.

### 2. Transitions are explicit; terminal means "no plain exit"

`TASK_TRANSITIONS` in `src/core/task/types.ts` is the single source of truth.
`update()` refuses any move not in the table, including self-transitions.

Terminal states (`completed`, `failed`, `cancelled`) have **no outgoing edges**
in the table, so "terminal" means exactly "cannot move by a plain transition".
Reviving a task is possible only through a named operation — `requeue()` — the
same rule that keeps `running → queued` out of the table. A plain `update()`
cannot reset a task mid-run, and a failed task is not silently revivable; a
caller that wants another attempt must say so explicitly.

`queued → failed` is in the table because a task can fail *before* it runs: an
exhausted record is failed rather than left to block the queue.

### 3. Recovery is bounded, and exhaustion is a failure

`recover()` walks every record and acts only on `running` ones:

- **attempts remain** → `queued`, with the reason recorded in `error`.
- **attempts exhausted** → `failed`, with the reason recorded.

This is the plan's acceptance criterion plus the bound that ADR 001/006 require.
The distinction is reported, not hidden: `RecoveryReport` separates `requeued`
from `exhausted`, and `claimNext()` also fails an exhausted queued record rather
than skipping it silently, so one poisoned task cannot stall the queue.

Corrupt records are **reported** (`RecoveryReport.corrupt`) and left on disk.
A record we cannot read is precisely what an operator needs to know about;
deleting it would erase the evidence.

### 4. The runner owns the outcome→status mapping, behind a port

`TaskRunner` is where persistence meets the agent loop, so it owns exactly one
decision: what a run outcome means for the lifecycle. That mapping
(`nextTaskStatus`) is a small explicit table:

| run status | task status | rationale |
|---|---|---|
| `completed` | `completed` | the external check agreed (ADR 006) |
| `aborted` | `waiting` | paused by the caller; resumable |
| `max_verifications` | `waiting` | needs escalation, not a blind rewrite |
| `timeout` / `max_iterations` / `max_tool_calls` | retry | hit a bound, not wrong |
| `error` | `failed` | the work itself did not succeed |

"retry" means `queued` while attempts remain, `failed` when they do not. A run
that hit a resource bound did not produce a wrong answer, so retrying is
legitimate; an `error` is a real failure, and retrying it blindly would just
repeat it.

`TaskRunner` depends on a `TaskExecutor` port, and `AgentRuntime` supplies an
adapter (`createTaskExecutor`). `core/task` therefore imports no provider and no
concrete tool, preserving the layering rule (`core → providers → tools →
api/cli`).

### 5. Scope: one process, stated plainly

Mutations are serialised in-process so concurrent callers cannot interleave a
read-modify-write. There is **no cross-process lock**; two processes sharing one
task directory are not supported. An advisory lock would look like a guarantee
without being one, so the limitation is documented instead of papered over.

## Consequences

- A crashed run is recoverable, and the recovery is bounded: no infinite requeue
  loop, and a task that used its last attempt fails with a stated reason.
- The lifecycle cannot be corrupted through the public API; illegal moves throw
  `TaskTransitionError`, unknown ids throw `TaskNotFoundError`.
- Durability is real, not nominal: the atomicity claim has a test that fails if
  the implementation regresses.
- The store is a single-process component. Horizontal scaling needs a different
  store behind the same `TaskStore` interface — which is the point of the
  interface, and the natural place for a SQLite or Postgres implementation later
  (ADR 002 made the same bet for knowledge).
- The outcome mapping ties Phase 6 to Phase 4's escalation semantics:
  `max_verifications` and `aborted` park in `waiting` rather than being retried,
  so a task needing human input is visibly distinct from one that merely needs
  another attempt.

## Alternatives considered

**Requeue every `running` task on recovery.** Matches the acceptance criterion
literally, but re-runs a task that already exhausted its attempts, looping
forever. Rejected in favour of bounded recovery with an explicit `exhausted`
outcome.

**A single JSON file holding all tasks.** Simpler to read, but one crash during
a write loses every task, and concurrent updates contend on one file. Rejected:
per-record files give per-task atomicity and let a corrupt record be isolated
and reported rather than taking the store down with it.

**In-place writes with a `.bak` fallback.** Cheaper than a rename, but a reader
can still observe the torn file between the write and the fallback, and the
fallback logic itself is a second failure path. Rejected in favour of the atomic
rename.

**A cross-process advisory lock.** Would imply multi-process safety the
implementation does not actually provide on every filesystem. Rejected in favour
of documenting single-process scope.
