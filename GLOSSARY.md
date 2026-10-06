# Agent Skills

Henrique's custom agent workflow skills, installed into several coding agents
from this one repo.

## Language

### Installation

**Canonical copy**:
The single installed copy of a skill under `~/.agents/skills/<name>`, which
every agent reads.
_Avoid_: Global copy, master copy.

**Agent directory**:
An agent's own skills folder (`~/.claude/skills`, `~/.codex/skills`,
`~/.cursor/skills`, `~/.grok/skills`), holding symlinks to canonical copies.
_Avoid_: Skill folder (ambiguous with a skill's source folder).

**Active skill**:
A skill under `skills/`, installed by `--skill '*'`.

**Deprecated skill**:
A frozen, self-contained copy of a removed skill under the root `deprecated/`
folder, invisible to `--skill '*'` and installed only by its subpath.
_Avoid_: Archived skill, legacy skill.

### Naming

**Runtime-bound skill**:
A skill tied to one runtime, whose name carries that runtime (`t3-capacity`).

**Plain name**:
The name of a runtime-independent skill (`test-audit`, `cyber-audit`).
