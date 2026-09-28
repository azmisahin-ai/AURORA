# ADR 006 — External Verification and the Bounded Repair Loop

- Status: Accepted
- Date: 2026-09-28

## Context

Phase 4 gives the agent the ability to run code. That creates a subtler problem
than Phase 3's untrusted input: **the agent can now claim success it has not
earned.** A model will happily write a file, announce "done", and stop — even
when the file does not compile. If the runtime accepts that claim, the agent's
success signal is only as reliable as the model's self-assessment, and the
Phase 0 research is explicit that this is not reliable:

> Modelin kendi çıktısını değerlendirmesi güvenilir değil — **harici bir
> doğrulama sinyali** gerekli (test sonucu, doküman eşleşmesi vb.).

Self-correction loops that grade their own output can converge on a
confidently-worded wrong answer. The plan's required fix is a `plan → implement
→ test → review → repair` cycle anchored on an **external** signal, with a
bounded retry count and an escalation path when the bound is hit.

The design question is not "should there be verification" but *what* counts as
verification, *when* it runs, and *what happens* when it never passes.

## Decision

### 1. Verification is an external signal, behind a port

`Verifier` (`src/core/agent/types.ts`) returns a pass/fail verdict derived from
a process exit code — a signal the model does not author. It is injected into
`AgentLoop` as an optional dependency. Core never learns how the verdict was
produced; `CommandVerifier` (`src/providers/execution/`) is the only
implementation, and it runs a single configured command.

Rejected: asking the model to review its own diff. That is the failure mode
being defended against, not a solution to it.

### 2. The gate fires only after a workspace mutation

A verifier is pointless on a pure research task — there is no code to test — and
running one would poison the trajectory with irrelevant failures. So the loop
runs the verifier **only when a tool that declares `mutatesWorkspace: true`
succeeded during the run.**

The flag is declared per tool and set by `ToolRegistry` only on **success**. A
failed write is not a mutation, so it does not trigger verification. The flag is
deliberately narrow:

- `write_file` sets it.
- `knowledge_write` does **not** — a knowledge entry is not code.
- `run_command` does **not** — it is the very tool the verifier executes;
  treating it as a mutation would make verification trigger itself.

`hasMutated` is never inferred from tool names in `core`. Core asks the tool
layer; the tool layer knows its tools.

### 3. "Completed" means the external check agreed

The loop's completion path is gated by `gateCompletion`, in this order:

1. No verifier, or `maxVerifications = 0` → accept (exactly Phase 1–3 behaviour).
2. Nothing was mutated → accept, without calling the verifier.
3. Budget exhausted → stop with status `max_verifications` and a message; **do
   not** loop further and **do not** accept.
4. Otherwise run the verifier. `pass` accepts; `fail` appends a message to the
   context describing the failure **and its classification**, and the loop
   iterates so the model can repair the cause rather than guess at it.

A run that hits the bound ends `max_verifications`, not `completed`. Escalation
is a distinct, visible outcome — the plan requires an escalation path, and
silently accepting after N failed checks would defeat the whole mechanism.

### 4. A skipped check is not a pass

If the run lacks `COMMAND_EXECUTION`, or the command is rejected by
`CommandValidator`, the verifier returns `kind: "skipped"` with a reason. The
run may still complete (there was nothing else to do), but the outcome is
recorded as skipped, surfaced on `RunResult.lastVerification`, and the CLI
prints `completed WITHOUT verification`. Presenting an unchecked result as
verified is the exact dishonesty this phase exists to prevent.

### 5. Exit code 0 is necessary but not sufficient

Verified against Node v24.21.0: `node --test` **exits 0 when its glob matches no
test files**, printing `ℹ pass 0 / ℹ fail 0`. A verifier trusting the exit code
alone would report an empty run as a pass — a vacuous green. `ranNoTests`
(`TestSummary.ts`) detects a parseable summary that proves nothing ran, and both
`CommandVerifier` and `run_tests` treat that as failure.

The shared parser matters as much as the check: the model-facing tool and the
loop-trusted verifier must read runner output the same way, or the model and the
gate would disagree about what "the tests passed" means. Parsing is best-effort
and returns `undefined` rather than a guess when a format is unrecognised —
`undefined` is never interpreted as "zero tests".

### 6. Failure is classified, and the classification is fed back

`ErrorClassifier` maps a failure to a category and an action
(`TRANSIENT → retry`, `CODE → inspect_and_fix`, `PERMISSION →
request_permission`, `CONFIGURATION/AUTHENTICATION → report_to_user`,
`UNKNOWN → stop`). The verdict is included in the message the model receives, so
a configuration error is not "repaired" as if it were a code bug.

Classification prefers structured signals over text: `status: 401` wins over a
message containing "invalid". An `AbortError` is transient but **not** retryable
— retrying a cancellation is wrong even though the category is right.

### 7. Verification is opt-in

`AURORA_TEST_COMMAND` empty and `AURORA_MAX_VERIFICATIONS=0` by default.
Phase 4 changes no existing run's behaviour unless a project configures a check.
A default test command would be a guess about the project, and a wrong guess is
worse than no check.

## Consequences

- The loop cannot report success after editing the workspace unless a real
  process agreed. Where no verifier is configured, this guarantee is absent —
  and `RunResult.verifications` being unset makes that visible rather than
  implied.
- The verify→repair loop is bounded by `maxVerifications`; each attempt costs a
  real process run plus a model turn, so the bound is also the cost ceiling.
- `run_tests` is only registered when a test command exists; a tool that always
  fails would be worse than an absent one.
- The agent's own `run_tests` and the loop's verifier share one command, one
  policy, and one parser. They cannot drift.
- Tests for the loop use a scripted verifier. That doubles a **boundary** (a
  process the unit test cannot run), not an internal function; the real
  `CommandVerifier` is exercised end-to-end against real `node --test` processes
  in `tests/integration/verification-live.test.ts`.
