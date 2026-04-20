#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
ADR_0001="$ROOT/adr/0001-adr-process.md"
ADR_0004="$ROOT/adr/0004-tmpdir-and-env.md"
SPEC="$ROOT/SPEC.md"
SHARED_DIR="$ROOT/.loopx/shared"
PROMPT_FILE="$SHARED_DIR/.prompt.tmp"
CALLER_FILE="$SHARED_DIR/.caller.tmp"

if [[ ! -d "$SHARED_DIR" ]]; then
  echo "Error: shared workflow not found at $SHARED_DIR — install it with: loopx install -w shared modularcloud/sdg-workflows" >&2
  exit 1
fi

if [[ ! -f "$ADR_0001" ]]; then
  echo "Error: adr/0001-adr-process.md not found" >&2
  exit 1
fi

if [[ ! -f "$ADR_0004" ]]; then
  echo "Error: adr/0004-tmpdir-and-env.md not found" >&2
  exit 1
fi

if [[ ! -f "$SPEC" ]]; then
  echo "Error: SPEC.md not found" >&2
  exit 1
fi

echo "$LOOPX_WORKFLOW" > "$CALLER_FILE"

cat <<PROMPT > "$PROMPT_FILE"
Review ADR 0001, ADR 0004, and SPEC.md holistically and let me know if I can mark ADR 0004 as accepted or if I need to improve it further. Ask me clarifying questions if you have any doubts about my intentions for ADR 0004.

adr/0001-adr-process.md:
$(cat "$ADR_0001")

adr/0004-tmpdir-and-env.md:
$(cat "$ADR_0004")

SPEC.md:
$(cat "$SPEC")
PROMPT

$LOOPX_BIN output --goto "shared:dispatch"
