#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
SPEC="$ROOT/SPEC.md"
SHARED_DIR="$ROOT/.loopx/shared"
PROMPT_FILE="$SHARED_DIR/.prompt.tmp"
CALLER_FILE="$SHARED_DIR/.caller.tmp"

if [[ ! -d "$SHARED_DIR" ]]; then
  echo "Error: shared workflow not found at $SHARED_DIR — install it with: loopx install -w shared modularcloud/sdg-workflows" >&2
  exit 1
fi

if [[ ! -f "$SPEC" ]]; then
  echo "Error: SPEC.md not found at $SPEC — review-spec requires SPEC.md to exist at the project root" >&2
  exit 1
fi

echo "$LOOPX_WORKFLOW" > "$CALLER_FILE"

cat <<PROMPT > "$PROMPT_FILE"
Review my specification and let me know if this is implementation-ready or if you have feedback. To refine your feedback, feel free to ask questions.

SPEC.md:
$(cat "$SPEC")
PROMPT

$LOOPX_BIN output --goto "shared:dispatch"
