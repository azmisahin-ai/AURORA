# ADR 010 — Security Hardening: Redaction by Shape, a Three-Valued Confirmation Gate, and Rate Limits as Loop Bounds

- Status: Accepted
- Date: 2026-09-28

## Context

Phase 8's checklist (from `docs/adr/004-security-and-permissions.md` and the
research notes in `docs/research/security.md`) lists ten items. Several already
exist and are tested: path traversal (`PathValidator`), SSRF (`UrlValidator`),
the command allowlist (`CommandValidator`), prompt-injection containment
(`UntrustedData`), tool permissions (`PermissionManager`), timeouts and request
size caps scattered across fetchers and tools.

Four gaps remained, and each one raised a design question rather than a coding
task.

**1. Secrets in logs.** The logger censors a fixed set of *key paths*
(`headers.authorization`, `*.apiKey`). That is exact but blind: a token inside an
error string, a command line, or a URL is not at a known path. Shape-based
redaction closes the gap — but a redactor that fires on ordinary prose is worse
than none, because operators learn to ignore `[REDACTED]`.

**2. User confirmation.** ADR 004 says "state-changing operations require user
confirmation *where practical*". Phase 8 has to make "where practical" concrete
without breaking unattended runs.

**3. Rate limiting.** What is it *for*? A local operator can already run any
command by hand; the tool layer is not a security boundary against its own user.

**4. Redaction scope.** Should the model's *observations* be scrubbed too, or
only logs? This is the boundary question, and getting it wrong either leaks
secrets into context or makes the agent unable to read a file that happens to
contain a fake key.

## Decision

### 1. Redact by credential shape, but only unambiguous shapes

`SecretRedactor` (new) matches vendor-prefixed and fixed-length credentials:
OpenAI `sk-…`, Anthropic `sk-ant-…`, GitHub `ghp_…`/`github_pat_…`, AWS
`AKIA…`, Slack `xox…`, Google `AIza…`, Stripe `sk_live_…`, JWTs, `Bearer`
tokens, PEM private-key blocks, and `scheme://user:password@host` URLs. These
have essentially no false-positive surface: the prefix plus the length *is* the
format.

The one loose pattern — `password = …`, `api_key: …` — is filtered by
`looksLikeSecret`: the value must mix letters and digits, or be ≥ 20 chars, or
be a dense opaque blob. `"the secret sauce: deliciousness"` is therefore left
alone; `api_key = "a1b2c3d4e5f6g7h8i9j0"` is redacted. A false-positive corpus
is a **test**, not a comment.

Redaction is applied by the logger through a pino `logMethod` hook, and by the
registry to the string passed to the confirmation prompt. The path-based pino
`redact` list stays: the two layers are complementary, and the ADR that removed
either would be wrong.

### 2. The confirmation gate has three outcomes, not a boolean

`ConfirmationGate.request()` returns `approved | denied | unavailable`.
Collapsing `denied` and `unavailable` into `false` would make an unattended CI
run indistinguishable from a user saying no: the first must proceed under its
configured policy, the second must stop.

- `AllowAllGate` — the default (`confirmMode=allow`). An unattended run should
  not deadlock on a prompt; the controls that actually constrain it are
  permissions, validators, and the allowlist.
- `DenyAllGate` (`confirmMode=deny`) — refuse, for auditors or CI wanting zero
  mutation.
- `PromptGate` — reads via an **injected** `ask` function, so the gate is
  testable without a TTY. The CLI is the only layer that owns stdin, so it is
  the only place a `PromptGate` is constructed. Any answer other than an
  explicit yes is a no.

The registry gates a tool when `mutatesWorkspace === true` **or** it requires
`COMMAND_EXECUTION`. The second clause matters: a shell command can change the
machine even when the tool does not declare a workspace mutation.

With `confirmMode=prompt` and no TTY, `--confirm-strict` denies rather than
silently approving; without it, the run proceeds under policy.

### 3. Rate limits bound loops, not users

A per-tool token bucket (`KeyedRateLimiter`) caps *network* tools. The threat is
a model that fetches a page, fails to parse it, and refetches sixty times. A
per-tool bucket means a chatty filesystem tool cannot starve the network budget.
The clock is **injected**: `Date.now()` would make the only interesting test — a
token comes back after the window — a flaky sleep.

On denial the tool returns an observation telling the model to slow down, rather
than throwing: the loop must remain recoverable, and the message is the signal
the model needs.

### 4. A hard cap on tool arguments

`maxArgumentBytes` (default 64 KiB) rejects a call whose serialised arguments
exceed it, checked immediately after schema validation. A model pasting a whole
file into a tool call is a context-flooding attempt; the cap is cheaper at the
door than in each tool. It is applied before the confirmation prompt, so a giant
payload never reaches a terminal.

### 5. Redaction scope: logs and prompts, not the model's observations

Fetched content and file contents are **not** scrubbed before they reach the
model. Scrubbing them would break the agent's legitimate job — reading a
configuration fixture, a test vector, or a document that mentions a key. The
secret-hygiene boundary AURORA claims is: *operator-visible surfaces* (logs,
confirmation prompts, audit text) are redacted. It does **not** claim to stop a
secret from entering the model's context. That boundary is stated here rather
than left implicit, so a later phase can widen it deliberately if needed.

## Consequences

- Two redaction layers exist; a future reader must know both are load-bearing.
- The gate's three outcomes are a small API, but every caller must handle all
  three. The registry does; a future caller that treats `unavailable` as `false`
  would reintroduce the unattended-vs-denied confusion this ADR exists to
  prevent.
- `prompt` mode is impossible to set safely in a library context (there is no
  stdin); the library fails closed (`DenyAllGate`) rather than approving.
- Rate limits and the argument cap are **observable** in the trajectory, so a
  denial is never silent.
- Model-observation redaction remains DOĞRULANACAK: a selective policy (e.g.
  redact `run_command` observations but not `read_file`) is plausible but not
  yet designed, and doing it badly would break tool use.

## Alternatives considered

- **Boolean confirmation.** Rejected: loses the unattended/denied distinction.
- **Redact observations too.** Rejected: breaks legitimate reads; the stated
  boundary is more honest.
- **A `BlockingRateLimiter` that sleeps.** Rejected: a single denial would stall
  the run; returning an observation keeps the loop in control.
- **Deny network tools entirely by default.** Rejected: Phase 3 shipped a
  contained fetcher precisely so network access is usable; the guard is URL
  validation plus a rate limit, not withholding the capability.
