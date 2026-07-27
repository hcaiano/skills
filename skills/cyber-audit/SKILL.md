---
name: cyber-audit
description: "Read-only audit of this machine against a named CVE, malicious package, or supply-chain advisory. Use only when explicitly asked whether this machine is affected; not for general security review, news, breach response, or remediation."
user-invocable: true
argument-hint: "<CVE / advisory / package>"
---

# cyber-audit

Determine whether this machine is exposed to a specific advisory, and leave a written audit trail. **Read-only** is the whole contract: you diagnose, you never remediate.

**Scope boundary.** This is host exposure against a *named external advisory*, not a general security tool. For source/appsec review of a repo use a code-security review skill; for chasing a live misbehaving bug use `debug-mode`. If the user has no specific advisory in hand, this skill is the wrong one.

## Hard rules

- **Read-only on the machine.** No installs, removes, upgrades, restarts, config changes, or file writes outside the report directory. Reading the *advisory* is allowed and expected — fetch the CVE/advisory details from authoritative sources, or use the full text the user provided. The ban is on changing the machine, not on research.
- **No `sudo`.** Never.
- **One report per invocation.** Always end by writing the `.md` report — even a "Not affected" verdict matters as an audit trail.
- If a check needs a state-changing command, **skip it and record "not checked (would require state change)"** in the table. Do not run it.

## Workflow

1. **Scope — grounded, never from memory.** Establish the affected package/binary name, affected versions, platform, and attack vector (supply chain / RCE / local / network) from the advisory itself. If the input is only a CVE ID or package name, look the advisory up (read-only) or ask for the full text *before* auditing — never infer affected versions from model memory. An ungrounded verdict is worse than none.
2. **Run checks in parallel** (multiple Bash calls in one message). Pick the checks relevant to the advisory type — do not run all of them.
3. **Build the table** as you go: one row per check + concrete result (version, path, "None", "N/A").
4. **Write the report** to `~/security-audits/YYYY-MM-DD-<short-kebab-slug>.md` (create the directory if absent). Use today's date from the environment.
5. **Report the verdict** to the user in one line + the report path.

## Check menu (pick what's relevant)

Starting points, not a script — adapt to the advisory. **Prefer each tool's own "list installed" command** (`npm/pnpm ls -g`, `pipx list`, `uv tool list`, `brew list`, `pip list`) over guessing install paths; a filesystem `find` is the fallback for when no lister or manifest covers a location. When you do search paths, make the match path-aware so scoped names (`@vendor/pkg`) are found. **Search scope:** the `~`/`~/code` roots below assume a home checkout — the audit may instead run from a working tree outside `$HOME` (e.g. a `/workspace` checkout), so also search the current working tree and any target path the user named, not only these home directories.

```bash
# --- Node / npm ecosystem (supply-chain advisories) ---
which npm pnpm yarn
npm ls -g --depth=0 2>/dev/null | grep -i "<pkg>"; pnpm ls -g --depth=0 2>/dev/null | grep -i "<pkg>"   # native global listers (preferred)
# fallback — search the roots npm/pnpm actually report (covers Linux/Intel /usr/local,
# not just Apple Silicon Homebrew). path-aware so scoped @vendor/pkg is found; find ~
# below cannot see global roots outside $HOME.
for root in "$(npm root -g 2>/dev/null)" "$(pnpm root -g 2>/dev/null)" \
            /opt/homebrew/lib/node_modules /usr/local/lib/node_modules; do
  [ -d "$root" ] && find "$root" -type d -path "*/<pkg>" 2>/dev/null   # any depth: direct, scoped @vendor/pkg, or transitive under */node_modules/
done
find ~ . -maxdepth 10 -type d -path "*/node_modules/<pkg>" 2>/dev/null \
  | grep -v -E "(Library/Caches|\.Trash)"      # local copies (incl. current tree); -path matches scoped @vendor/pkg too
find ~/code ~/Desktop ~/Downloads . -maxdepth 8 -type f \
  \( -name "package.json" -o -name "package-lock.json" \
     -o -name "pnpm-lock.yaml" -o -name "yarn.lock" \) -print0 2>/dev/null \
  | xargs -0 grep -l "<pkg>" 2>/dev/null                           # direct + transitive; -print0/-0 survives spaces in paths

# --- Python ecosystem ---
which python3 pip pipx uv
pip list 2>/dev/null | grep -i "<pkg>"
pipx list 2>/dev/null | grep -i "<pkg>"        # pipx-managed CLI apps (own venvs, not in pip list)
uv tool list 2>/dev/null | grep -i "<pkg>"     # uv-managed tools (own venvs)
find ~/code -maxdepth 6 -type f \( -name "requirements*.txt" -o -name "pyproject.toml" \
  -o -name "poetry.lock" -o -name "uv.lock" \) -print0 2>/dev/null | xargs -0 grep -l "<pkg>" 2>/dev/null

# --- Homebrew / system binaries ---
brew list --versions <formula> 2>/dev/null
which <binary>; <binary> --version 2>/dev/null

# --- Running processes / listeners (RCE / network CVEs) ---
pgrep -lf "<binary>"
lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | grep "<port>"

# --- LaunchAgents / LaunchDaemons (persistence / autostart) ---
ls ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons 2>/dev/null \
  | grep -i "<vendor>"

# --- Env vars that change exposure (e.g. listening addr) ---
launchctl getenv <VAR>; grep -r "<VAR>" ~/.zshrc ~/.zprofile ~/.config 2>/dev/null

# --- VS Code / browser extensions (IDE-targeted advisories) ---
ls ~/.vscode/extensions 2>/dev/null | grep -i "<ext>"
```

For an ecosystem not listed (Rust cargo, Go modules, Ruby gems, Docker images, …), apply the same pattern: global install path + manifest grep + running processes.

## Report template

File: `~/security-audits/YYYY-MM-DD-<short-kebab-slug>.md`

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

**<Not affected. | Affected. | Partially affected.>**

- <Rationale bullet 1>
- <Rationale bullet 2>

## Action taken

None — diagnostic only, no files modified outside the report directory.

## Follow-ups

- <Actionable item, or "None">
```

## Verdict wording

The attack vector decides which check proves exposure — apply it before picking a verdict:

- **Supply-chain / malicious-package advisories** — a present vulnerable version is *itself* exposure (install-time and import-time payloads already executed); a process/listener check is irrelevant. Presence → **Affected**; only absence or a patched version is **Not affected**. Never downgrade to Partially/Not affected because "nothing is running".
- **Network / service (RCE) advisories** — exposure needs the vulnerable code to be *reachable* (running + listening), so the running/listener check applies.

- **Not affected.** — package/binary absent, or installed but patched; or (network/service advisories only) installed but not running and not exposed.
- **Affected.** — vulnerable version present *and* reachable by the attack vector — where for supply-chain/malicious-package advisories a present vulnerable version is reachable by definition.
- **Partially affected.** — installed and *running* but only partially reachable, e.g. the listener is bound to loopback only or exposed solely behind auth/a firewall. A fully stopped service with no exposure is **Not affected**, not partial. Never a valid downgrade for a supply-chain payload that already ran. Spell out the mitigation.

## When to break the read-only rule

Never on your own. If the verdict is "Affected", list the remediation command under **Follow-ups** and stop. The user runs it.
