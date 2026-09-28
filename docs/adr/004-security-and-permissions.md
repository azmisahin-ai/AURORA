# ADR 004 — Security and Permissions

- Status: Accepted
- Date: 2026-09-28

## Context

AURORA fetches untrusted web content and executes commands. Both are classic
attack surfaces: indirect prompt injection (OWASP LLM01), SSRF, path traversal,
and arbitrary command execution. Research (`docs/research/security.md`) confirms
prompt injection "cannot be fully prevented"; the achievable goal is
defense-in-depth plus containment.

## Decision

### 1. Treat all external content as UNTRUSTED DATA

- Web/tool content is never a system instruction.
- It is wrapped in **nonce-delimited** markers: `<untrusted-{nonce}> … </untrusted-{nonce}>`,
  with a fresh random nonce per request so content cannot forge the delimiter.
- Tool responses are capped by a token/size limit.
- Cross-origin interactions are restricted.

### 2. Permission model (least privilege)

```
READ_ONLY          → read_file, list_files, knowledge_search
WORKSPACE_WRITE    → write_file, edit_file
COMMAND_EXECUTION  → run_command, run_tests
NETWORK_ACCESS     → web_fetch, web_search
FULL_ACCESS        → all (used sparingly)
```

- Every tool declares `requiredPermissions`; `PermissionManager` rejects calls
  the current context lacks, and the rejection is logged.
- State-changing operations require user confirmation where practical.

### 3. Input/output validation

- **Paths:** resolve against `AURORA_WORKSPACE`; reject anything escaping it
  (`../../etc/passwd`), including via symlinks (real-path check).
- **URLs:** allow only `http`/`https`; reject `file://`, loopback, link-local
  (`169.254.0.0/16`, incl. `169.254.169.254`), and private ranges.
- **Commands:** allowlist/denylist via `AURORA_ALLOWED_COMMANDS` /
  `AURORA_BLOCKED_COMMANDS`; prefer argument arrays over shell strings; enforce
  timeouts and output caps.
- **Secrets:** `SecretRedactor` scrubs known secret patterns from logs.
- **Config:** all config validated by a `zod` schema.

### 4. Audit

- Every permission decision, tool call, and refusal is emitted as a structured
  log event (pino).

## Rationale

- Mirrors the four-layer consensus: structural separation, tool allowlists,
  output validation, audit logging (theroadtoenterprise.com, OWASP LLM01).
- Microsoft Learn: assume indirect injection is inevitable and design to contain
  and respond.

## Explicit non-claims

- AURORA does **not** claim to solve prompt injection.
- The SSRF CIDR list and path-traversal technique are standard practice but were
  read from secondary sources in this pass; they are marked **DOĞRULANACAK** in
  `docs/research/security.md`.

## Consequences

- Nonce wrapping adds tokens to every untrusted block.
- Denylists are inherently incomplete; the allowlist is the primary control.
- Confirmation prompts can impede automation; FULL_ACCESS must be opted into
  explicitly.

## Compliance

Phase 2 (implemented, tested):

- Unit tests: `PathValidator` rejects `../../etc/passwd`, absolute paths outside
  the root, NUL bytes, and **symlink escapes** (`resolveReal`); `CommandValidator`
  rejects shell metacharacters and non-allowlisted/always-blocked commands;
  `PermissionManager` denies and names missing permissions.
- Integration tests: a tool call lacking its permission is refused **and** the
  refusal is asserted in real pino output; a malicious command is refused; child
  processes do not inherit host secrets.

Still pending (Phase 3 / 8):

- `UrlValidator` rejecting `file://`, `localhost`, `169.254.169.254`, and private
  ranges — `NETWORK_ACCESS` is therefore not granted yet.
- Nonce-delimited wrapping of tool/web output and its token cap.
- `SecretRedactor` for logs.
- A prompt-injection attempt being marked untrusted without altering the system
  instruction.

Note: command execution is `shell: false` with an explicit argv array and a
minimal environment, so metacharacter rejection is defence in depth rather than
the only barrier.
