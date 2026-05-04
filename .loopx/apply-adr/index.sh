#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
ADR_0001="$ROOT/adr/0001-adr-process.md"
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

if [[ ! -f "$SPEC" ]]; then
  echo "Error: SPEC.md not found" >&2
  exit 1
fi

RESOLVED=$("$SHARED_DIR/resolve-adr.sh")
IFS=$'\t' read -r ADR_NUM ADR_FILE <<< "$RESOLVED"
ADR_REL="adr/$(basename "$ADR_FILE")"

echo "$LOOPX_WORKFLOW" > "$CALLER_FILE"

cat <<PROMPT > "$PROMPT_FILE"
ADR $ADR_NUM has been accepted. The next step in the process is to update SPEC.md to incorporate the changes described in ADR $ADR_NUM. Review the current SPEC.md against ADR $ADR_NUM and let me know if the SPEC updates look correct and complete, or if anything else in the SPEC needs to be changed.

$ADR_REL (accepted — do not modify):
$(cat "$ADR_FILE")

SPEC.md (target of updates):
$(cat "$SPEC")
PROMPT

$LOOPX_BIN output --goto "shared:dispatch"
