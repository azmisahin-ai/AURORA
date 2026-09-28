# Security — Research Notes

Access date: **2026-09-28**.

Scope: prompt injection, SSRF, path traversal, and command execution — the threat
surface AURORA opens the moment it fetches web content and runs commands.

## 1. Prompt injection is LLM01 and is unsolved

Sources:

- Microsoft Learn, "Defend against indirect prompt injection attacks"
  <https://learn.microsoft.com/en-us/security/zero-trust/sfi/defend-indirect-prompt-injection>
  (accessed 2026-09-28): "A defense-in-depth approach—combining prompt
  sanitization, content isolation, behavioral monitoring, and policy
  enforcement—provides a robust framework for mitigating these risks. By assuming
  indirect prompt injection is inevitable and designing systems to contain and
  respond to it …"
- aakashx.com, "Prompt Injection: 6 Attacks and 6 Defenses"
  <https://www.aakashx.com/blog/prompt-injection-attacks-defenses> (accessed
  2026-09-28): "No current technique fully prevents prompt injection in
  adversarial settings. The realistic goal is defense-in-depth …"
- theroadtoenterprise.com, "Prompt Injection Defense, the OWASP LLM Top 10
  Applied" <https://theroadtoenterprise.com/blog/prompt-injection-ai-features-production>
  (updated 2026-08-01): "In the OWASP LLM Top 10 2025, prompt injection ranks as
  LLM01 because it is the entry point for most other LLM risks."

**Direct vs indirect:** "Direct prompt injection occurs when a user deliberately
inputs malicious instructions … Indirect prompt injection happens when an LLM
processes external, untrusted content (such as web pages, emails, or PDF
documents) containing hidden instructions" (dev.to summary of OWASP LLM01,
accessed 2026-09-28). AURORA's web-fetch tool is the indirect-injection surface.

## 2. The defense-in-depth layers that the sources agree on

Synthesized from theroadtoenterprise.com (four layers: separation, allowlists,
validation, audit logging) and Microsoft Learn:

1. **Structural separation** — wrap untrusted content in delimiters so the model
   can distinguish data from instructions:
   > "Wrap untrusted content in structural markers so the model can tell data
   > from instruction." (theroadtoenterprise.com)
2. **Tool-call allowlists** — "constrain the LLM's tool surface to a server-side
   allowlist so an injected instruction cannot pick a tool the user could not
   have picked." (same source)
3. **Output validation / least privilege** — "Validate every model response
   against the authenticated user's actual permissions and refuse anything
   outside them." (same source)
4. **Audit logging** — "Log every LLM call as a security event so refusals
   turn [into] …" (same source; sentence truncated in source snippet).
5. **Content isolation + behavioral monitoring + policy enforcement** across the
   prompt path (Microsoft Learn).

## 3. Concrete mechanism chosen: nonce-delimited untrusted blocks

The plan specifies wrapping untrusted content as:

```
<untrusted-{nonce}> ...web content... </untrusted-{nonce}>
```

with a fresh random `nonce` per request so the content cannot forge the closing
delimiter. This is a direct implementation of defense layer #1 above.

Additional agreed controls:

- **Token limit** on tool responses (prevents context flooding / smothering the
  system prompt).
- **Cross-origin interaction restriction** (only `http`/`https`; local/private
  addresses refused).
- **User confirmation** for state-changing operations.
- Text such as `Ignore previous instructions…` must be treated as **data**, never
  as a system instruction.

## 4. SSRF

- AURORA's `web_fetch` can be pointed at internal services. The standard
  mitigation is URL validation: allow only `http`/`https`, resolve the host, and
  reject loopback / link-local / private ranges (e.g. `127.0.0.0/8`,
  `169.254.0.0/16` — the cloud metadata endpoint `169.254.169.254`, `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, `::1`, `fc00::/7`).
- **DOĞRULANACAK:** No primary OWASP/SSRF cheat-sheet was opened in this pass;
  the CIDR list above is standard practice and must be verified against a primary
  source before publishing. The test cases (`file://`, `localhost`,
  `169.254.169.254` rejection) are specified in the plan and are testable
  regardless.

## 5. Path traversal

- All filesystem tools resolve paths against `AURORA_WORKSPACE` and must reject
  anything escaping it (`../../etc/passwd`). Implementation: resolve to an
  absolute real path and assert it is inside the workspace root. (Standard
  practice; **DOĞRULANACAK** against a primary source.)

## 6. Command execution

- Allowlist/denylist per `AURORA_ALLOWED_COMMANDS` / `AURORA_BLOCKED_COMMANDS`.
- Prefer executing without a shell (argument arrays) to avoid shell-metacharacter
  injection.
- Apply timeouts and output-size caps.

## 7. Explicit non-claim

AURORA does **not** claim to "solve" prompt injection. The goal is containment
and auditability, consistent with every source cited above. The acceptance test
verifies that a *specific* injection attempt fails, not that the class is solved.

## Sources

See `docs/research/sources.md` for the full list with access dates.
