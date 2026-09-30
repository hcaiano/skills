---
name: cyber-audit
description: "Check whether this machine is affected by a named CVE, malicious package, or supply-chain advisory; read-only, writes a report."
argument-hint: "<CVE / advisory / package>"
---

# cyber-audit

Determine whether this machine is exposed to one named advisory, and leave a
written audit trail.

## Hard rules

- **Read-only on the machine.** You diagnose; the user remediates. No installs,
  removes, upgrades, restarts, config changes, or file writes outside
  `~/security-audits/`. Reading the advisory is expected: fetch it from
  authoritative sources, or use the full text the user provided.
- **No `sudo`.**
- Record a check that needs a state-changing command as "not checked (would
  require state change)" instead of running it.
- **One report per invocation**, even for "Not affected": it is the audit
  trail.

## Workflow

1. **Scope from the advisory.** Establish the affected package or binary,
   affected versions, platform, and attack vector (supply chain / RCE / local /
   network) from the advisory itself. Given only a CVE ID or package name, look
   the advisory up or ask for its full text before auditing; an ungrounded
   verdict is worse than none. Done when the affected versions cite the
   advisory.
2. **Check.** Read `uname -s`, then read
   [references/checks.md](references/checks.md) and pick the checks for this
   advisory's ecosystem and this OS. Run independent checks in parallel.
3. **Build the table** as you go: one row per check with its concrete result
   (version, path, "None", "N/A", or "not checked" with the reason). Done when
   every picked check has a row and every gap needed for the verdict is named.
4. **Write the report.** Run `mkdir -p ~/security-audits`, then write
   `~/security-audits/YYYY-MM-DD-<short-kebab-slug>.md` from the template
   below, with today's date from the environment. When the verdict is
   Affected, put the remediation command under **Follow-ups** for the user to
   run.
5. **Report the verdict** to the user in one line plus the report path.

## Report template

```markdown
# <Subject> — Audit

**Date:** YYYY-MM-DD
**Host:** <this machine>

## <CVEs | Advisory> in scope

- **<ID or source> "<Name>"** — <one-line description>. <Affected versions or scope>.

## Audit results

| Check | Result |
|---|---|
| <Check 1> | <Result> |
| <Check 2> | <Result> |

## Verdict

**<Not affected. | Affected. | Partially affected. | Inconclusive.>**

- <Rationale bullet 1>
- <Rationale bullet 2>

## Action taken

None — diagnostic only, no files modified outside the report directory.

## Follow-ups

- <Actionable item, or "None">
```

## Verdict

The attack vector decides which check proves exposure:

- **Supply-chain / malicious package**: a present vulnerable version is
  exposure, because its install-time and import-time payloads may already have
  run. Presence is **Affected** whether or not anything is running; the report
  states the observed package state, not that a payload ran.
- **Network / service (RCE)**: exposure needs the vulnerable code running and
  reachable, so the process and listener checks decide.

Verdicts:

- **Not affected.** Absent, or installed but patched; for network/service
  advisories, also installed but not running and not exposed.
- **Affected.** A vulnerable version present and reachable by the attack
  vector.
- **Partially affected.** Network/service advisories only: installed and
  running but only partly reachable, e.g. bound to loopback or exposed only
  behind auth or a firewall. Spell out the mitigation. A fully stopped service
  is **Not affected**.
- **Inconclusive.** A check needed to prove absence, version, or reachability
  could not run. Name that check and the missing evidence in the report.
