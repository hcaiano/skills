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
A skill tied to one runtime, whose name includes that runtime.

**Bare verb**:
The name of a skill that detects its own runtime or is runtime-independent
(`pair`, `orchestrate`, `ship-it`).

### Pairing

**Caller pane proof**:
The evidence of which pane the calling agent runs in. Owned by `pair`; the one
caller-identity contract that `pair`'s Herdr backend and `review-it`'s visible
transport share.
_Avoid_: Caller detection.

**Pair backend**:
How `pair` runs its partner agent: **headless** (the default, needing only the
partner CLI) or **Herdr** (an explicit `--backend herdr` choice, needing the
`herdr` CLI and skill).
