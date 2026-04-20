#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
ADR_0001="$ROOT/adr/0001-adr-process.md"
ADR_0002="$ROOT/adr/0002-run-subcommand.md"
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

if [[ ! -f "$ADR_0002" ]]; then
  echo "Error: adr/0002-run-subcommand.md not found" >&2
  exit 1
fi

if [[ ! -f "$SPEC" ]]; then
  echo "Error: SPEC.md not found" >&2
  exit 1
fi

echo "$LOOPX_WORKFLOW" > "$CALLER_FILE"

cat <<PROMPT > "$PROMPT_FILE"
ADR 0002 has been accepted. The next step in the process is to update SPEC.md to incorporate the changes described in ADR 0002. Review the current SPEC.md against ADR 0002 and let me know if the SPEC updates look correct and complete, or if anything else in the SPEC needs to be changed.

adr/0002-run-subcommand.md (accepted — do not modify):
$(cat "$ADR_0002")

SPEC.md (target of updates):
$(cat "$SPEC")
PROMPT

$LOOPX_BIN output --goto "shared:dispatch"
