#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
INCLUDE_DEPRECATED=false

if [ "${1:-}" = "--include-deprecated" ]; then
  INCLUDE_DEPRECATED=true
fi

cd "$REPO"
if [ "$INCLUDE_DEPRECATED" = true ]; then
  find skills -name SKILL.md -not -path '*/node_modules/*' | sort
else
  find skills -name SKILL.md -not -path '*/node_modules/*' -not -path 'skills/_deprecated/*' | sort
fi
