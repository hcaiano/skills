# hcaiano skills

Personal agent skills that are maintained locally and shared across Claude, Codex, and other agent runtimes.

This repo follows the same broad shape as `mattpocock/skills`: repo metadata at the root, distributable skills under `skills/`, and small scripts under `scripts/`.

## Skills

### Collaboration

- `herdr-coworkers` - pair Claude and Codex as collaborating peer agents inside herdr.

`herdr-coworkers` depends on the `herdr` CLI and the separate `herdr` skill for pane primitives. This repo intentionally does not vendor that upstream skill; install it separately before sharing `herdr-coworkers` with teammates.

### Engineering

- `debug-mode` - hypothesis-driven debugging with runtime evidence.

### Workflow

- `review-pr-comments` - fetch, triage, fix, reply to, and recheck PR review comments.
- `ship-it` - commit, push, open/update PRs, and keep checking CI/review feedback.

### Deprecated

- `cmux-pair-program` - older cmux-based Claude/Codex pair programming bootstrap, preserved for reference but not installed by default.

## Local linking

List active bundled skills:

```bash
./scripts/list-skills.sh
```

Link the skills into local agent skill directories:

```bash
./scripts/link-skills.sh
```

By default, the linker skips deprecated skills and any existing non-symlink skill directory. To include deprecated skills:

```bash
./scripts/link-skills.sh --include-deprecated
```

To migrate an existing real directory to a symlink after confirming the repo copy is correct:

```bash
./scripts/link-skills.sh --replace
```

`--replace` uses `trash`, not `rm`, for existing non-symlink directories.

## Publishing

For sharing, push this repo to GitHub and install it as a plugin from the repo. The manifests intentionally list only active skills; `skills/deprecated/*` is kept for history and recovery, not normal installs.
