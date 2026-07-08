#!/usr/bin/env bash
# Install the delegate roster (codex-worker, deep-reasoner, fast-worker,
# skeptic) into an agents directory so they load as named Agent types.
#
# Usage:
#   setup-roster.sh                    # install into ~/.claude/agents
#   setup-roster.sh .claude/agents     # scope to the current repo
#   setup-roster.sh --force            # overwrite existing files
#
# Plugin installs don't need this — the plugin manifest loads the same files
# automatically (namespaced, e.g. agent-workflows:codex-worker).
set -euo pipefail

SRC="$(cd "$(dirname "$0")/../agents" && pwd)"
TARGET="$HOME/.claude/agents"
FORCE=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    *) TARGET="$a" ;;
  esac
done

mkdir -p "$TARGET"
for f in "$SRC"/*.md; do
  b="$(basename "$f")"
  if [ -e "$TARGET/$b" ] && [ "$FORCE" -ne 1 ]; then
    echo "skip       $TARGET/$b (exists — rerun with --force to overwrite)"
  else
    cp "$f" "$TARGET/$b"
    echo "installed  $TARGET/$b"
  fi
done
echo "Done. Agents load at session start — restart Claude Code or run /agents."
