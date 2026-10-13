# Agent rules

- Place a new active skill directly under `skills/`. Install and update the
  runtime copies only through the Skills CLI (see `README.md`); registering a
  new agent means adding it to `--agent`, never hand-linking its directory.
- Third-party skills stay managed by their upstream sources and lock files.
- Domain terms live in `GLOSSARY.md`.
- T3 Code stays as it is: skills work around its behavior. Spend no work on
  changes, issues or PRs for `pingdotgg/t3code` or the `hcaiano/t3code` fork
  unless the user asks for one.
