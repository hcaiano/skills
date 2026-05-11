#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
REPLACE=false
INCLUDE_DEPRECATED=false

for arg in "$@"; do
  case "$arg" in
    --replace)
      REPLACE=true
      ;;
    --include-deprecated)
      INCLUDE_DEPRECATED=true
      ;;
    *)
      echo "error: unknown argument $arg" >&2
      exit 1
      ;;
  esac
done

link_one() {
  local src="$1"
  local dest_dir="$2"
  local name
  local target

  name="$(basename "$src")"
  target="$dest_dir/$name"
  mkdir -p "$dest_dir"

  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ -L "$target" ]; then
      ln -sfn "$src" "$target"
    elif [ "$REPLACE" = true ]; then
      if ! command -v trash >/dev/null 2>&1; then
        echo "error: trash is required for --replace but was not found" >&2
        exit 1
      fi
      trash "$target"
      ln -sfn "$src" "$target"
    else
      echo "skipped $target (existing non-symlink; rerun with --replace to trash and link)"
      return
    fi
  else
    ln -sfn "$src" "$target"
  fi

  echo "linked $target -> $src"
}

find_args=("$REPO/skills" -name SKILL.md -not -path '*/node_modules/*')
if [ "$INCLUDE_DEPRECATED" != true ]; then
  find_args+=(-not -path "$REPO/skills/deprecated/*")
fi

find "${find_args[@]}" -print0 |
while IFS= read -r -d '' skill_md; do
  src="$(dirname "$skill_md")"
  link_one "$src" "$HOME/.agents/skills"
  link_one "$src" "$HOME/.claude/skills"
  link_one "$src" "$HOME/.codex/skills"
done
