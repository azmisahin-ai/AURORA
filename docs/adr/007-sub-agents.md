# ADR 007 — Sub-Agents: In-Process Roles, Least Privilege, No Recursion

- Status: Accepted
- Date: 2026-09-28

## Context

Phase 5 adds role-based sub-agents. The research pass
(`docs/research/multi-agent.md`) established three things that shape this
decision:

1. Multi-agent is chosen "when the task exceeds a single agent's context window
   or requires parallel specialization" (MLflow). The value is therefore
   **context isolation**, not concurrency.
2. "ReAct beats Plan-Execute beats Multi-Agent for most starting points"
   (arahi.ai). Multi-agent is the expensive option, so it must be optional and
   bounded.
3. Multi-agent adds coordination failure modes; the mitigation is an explicit
   per-agent **budget** and **permission set**.

The Phase 5 plan also fixed the deliverable shape: "Ayrı process/microservice
değil. Aynı runtime içinde rol tabanlı instance." — in-process role-based
instances, each with a task, context, permission, tool set, and budget.

Two questions had to be settled before writing code.

**How does a sub-agent get spawned?** The parent is a ReAct loop driven by an
LLM. It can only act through tools. So spawning has to be a tool the model can
call, which makes the delegation visible in the trajectory like any other
action. The alternative — the runtime deciding on its own to spawn sub-agents —
would make the delegation invisible and un-auditable.

**What stops a sub-agent from changing the workspace behind the parent's
back?** Phase 4 established that an edit must be followed by an external
verification (ADR 006). If a sub-agent edits code, the parent must not accept
its answer without the verifier's agreement. But the parent's loop only knows
about mutations from the tools *it* ran. A `delegate` call is not itself a
mutation, yet the sub-agent it ran may have been.

## Decision

### 1. Delegation is a tool, and the tool layer owns the manager's construction

`delegate` (`src/tools/agent/DelegateTool.ts`) is the only way to spend
sub-agent budget. Its `role` argument is a `z.enum` over the fixed role set, so
the model cannot invent a role.

`SubAgentManager` (`src/core/agent/subagent/`) is a **core** class — it composes
`AgentLoop`, which lives in core, and must not know about concrete tools. It
takes a `RoleToolsetBuilder` port; the tool layer supplies the implementation.
`AgentRuntime` (the composition root) wires the two together.

This creates one ordering wrinkle: the tool layer needs the manager to register
`delegate`, and the manager needs the tool layer for role toolsets. `AgentRuntime`
resolves it in two steps — build the registry (which yields the builder), then
construct the manager and register `delegate` back into the registry. The
alternative, letting the manager import the tool layer, would invert the
dependency direction that ADR 001 protects.

### 2. Context isolation is the point, so a sub-agent gets its own prompt

A sub-agent starts from **its role's system prompt and the delegated task only**.
It never receives the parent's transcript. This is asserted directly
(`tests/unit/agent/subagent-manager.test.ts` § "isolated context"): the
sub-agent's first provider call must have exactly two messages.

The role prompt *replaces* the parent's rather than extending it. Extending
would blur the two agents into one large context — the exact failure the
research warns about — and would let the parent's framing leak instructions into
a role that was supposed to be independent (notably the reviewer).

### 3. Least privilege is structural, not a runtime check

A role's toolset is the intersection of its declared tool list and the parent
run's granted permissions, with `FULL_ACCESS` never propagated. Two mechanisms
enforce it:

- `intersectPermissions` computes the granted set as
  `parent.granted ∩ role.maxPermissions`, minus `FULL_ACCESS`.
- `roleToolsetBuilder.build` builds a **fresh `ToolRegistry`** containing only
  the role's tools. A tool the role lists but cannot afford is *dropped*, not
  offered and then denied at call time.

The reviewer role is the clearest case: it has no `write_file` in its registry
at all. It is not that the reviewer is forbidden from writing; the capability
does not exist in its world.

### 4. Sub-agents cannot delegate — by construction, not by a depth check

`delegate` is registered into the **parent** registry only. Role registries are
built from a catalog that deliberately excludes it. No role lists it, and even
if one did, the catalog would not contain it.

This is a stronger guarantee than a `depth` counter: there is no code path by
which a sub-agent could reach `delegate`, so there is no bound to get wrong.
Recursion is bounded by the shape of the object graph.

### 5. A delegated edit still triggers the parent's verifier

`ToolResult` and `ToolExecutionResult` gained a **dynamic** `mutatedWorkspace`
flag, distinct from the tool's static `mutatesWorkspace` declaration.
`ToolRegistry` sets the dynamic flag when the tool reports a change it caused
indirectly, and ORs it with the static one — on success only.

`delegate` reports `mutatedWorkspace: true` when the sub-agent it ran changed
the workspace. The parent loop then sets its own `hasMutated`, and its Phase 4
gate runs the verifier before accepting. A delegated edit is therefore verified
exactly as a direct one would be.

`RunResult` gained a matching `mutatedWorkspace` field so the propagation is
visible to callers, not just internal to the loop.

### 6. A sub-agent's answer is untrusted data

`delegate` wraps the sub-agent's output with `wrapUntrusted`, on the same
reasoning as `knowledge_search`: the answer is our own model's text, but a
researcher routinely quotes fetched pages, so it sits on the untrusted side of
the boundary like the content it summarises. A role's output cannot smuggle
instructions into the parent.

### 7. Bounded by two levels of budget, and opt-in

- **Per delegation**: each role has `maxIterations`, `maxToolCalls`, and
  `maxVerifications` (0 for every current role — no role's work is judged by the
  code verifier yet).
- **Per run**: `maxSubAgents` caps total delegations. Once exhausted, `delegate`
  returns an error result and the model is told, rather than the run failing.

`AURORA_MAX_SUB_AGENTS=0` disables delegation entirely: no `delegate` tool is
registered, no role toolsets are built, and the registry is exactly the
pre-Phase-5 one. The default is 3.

## Alternatives considered

- **Separate process / microservice per sub-agent.** Rejected for the MVP: the
  stated value is context isolation and least privilege, and both are *harder*
  to observe across a process boundary, not easier. The research explicitly
  favours in-process for debuggability.
- **Runtime-decided spawning (no `delegate` tool).** Rejected: it hides the
  delegation from the trajectory, and it spends budget without the model asking.
- **A depth counter instead of an absent tool.** Rejected: a counter is a bound
  that can be set wrong; an absent tool is a bound that cannot be reached.
- **Sharing the parent's transcript with sub-agents.** Rejected: it defeats the
  reason to have sub-agents at all.
- **Parallel sub-agent execution.** Deferred; the research flagged it as
  DOĞRULANACAK and no concurrency benchmark exists. Sequential delegation keeps
  the budget accounting exact.

## Consequences

- The parent model must be capable enough to write a self-contained task. A
  vague delegation produces a vague result, and the parent cannot see the
  sub-agent's reasoning to recover — only its final answer. This is inherent to
  context isolation, and it is why the role prompts tell each role what a good
  answer looks like.
- Verification of delegated work is *coarse*: the parent runs its verifier after
  the delegation returns, not inside it. A sub-agent that writes broken code and
  reports success is caught by the parent's verifier, but only after the
  delegation has ended.
- `delegate`'s `ok` is `status === "completed"`. A sub-agent that hit its own
  iteration bound returns `ok: false` with the error text, so the parent sees a
  failure rather than a truncated success.

## Compliance

- `tests/unit/agent/roles.test.ts` — no role lists `delegate`, no role has
  `FULL_ACCESS`, only roles with a way to run a check carry a verification
  budget.
- `tests/unit/agent/subagent-manager.test.ts` — context isolation, per-role
  budget, `maxSubAgents` enforcement, mutation propagation.
- `tests/integration/role-toolsets.test.ts` — with the real registry builder:
  `delegate` absent from every role registry, roles never exceed the parent's
  grant, `FULL_ACCESS` never propagates.
- `tests/integration/subagent-live.test.ts` — a real model delegates to a real
  coder sub-agent that writes a real file, asserted on disk and on the
  trajectory.
