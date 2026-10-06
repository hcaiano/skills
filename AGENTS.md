# Agent rules

- Place a new active skill directly under `skills/`. Install and update the
  runtime copies only through the Skills CLI (see `README.md`); registering a
  new agent means adding it to `--agent`, never hand-linking its directory.
- Third-party skills stay managed by their upstream sources and lock files.
- `pair` depends on the `herdr` CLI and skill for its Herdr backend. Document
  the dependency rather than copying Herdr primitives into this repo.
- Domain terms live in `GLOSSARY.md`.
