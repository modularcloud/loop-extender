#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
ADR_0001="$ROOT/adr/0001-adr-process.md"
SPEC="$ROOT/SPEC.md"
TEST_SPEC="$ROOT/TEST-SPEC.md"
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

if [[ ! -f "$TEST_SPEC" ]]; then
  echo "Error: TEST-SPEC.md not found" >&2
  exit 1
fi

RESOLVED=$("$SHARED_DIR/resolve-adr.sh")
IFS=$'\t' read -r ADR_NUM ADR_FILE <<< "$RESOLVED"
ADR_REL="adr/$(basename "$ADR_FILE")"

echo "$LOOPX_WORKFLOW" > "$CALLER_FILE"

cat <<PROMPT > "$PROMPT_FILE"
ADR $ADR_NUM has been accepted and SPEC.md has already been updated to incorporate its changes (ADR status: "Spec Updated"). Per the ADR process in ADR-0001, the next step is to update TEST-SPEC.md to cover the new and changed spec behavior introduced by ADR-$ADR_NUM. In this cycle, TEST-SPEC.md is the only file that should be modified — SPEC.md and ADR-$ADR_NUM are read-only references.

Review the current TEST-SPEC.md against the updated SPEC.md and ADR-$ADR_NUM, and let me know whether TEST-SPEC.md already covers the ADR-$ADR_NUM changes correctly and completely, or what needs to be added, changed, or removed. Do not suggest changes to SPEC.md or ADR-$ADR_NUM — if something looks wrong in those, flag it but do not act on it.

$ADR_REL (accepted — read-only reference):
$(cat "$ADR_FILE")

SPEC.md (already updated for ADR-$ADR_NUM — read-only reference):
$(cat "$SPEC")

TEST-SPEC.md (target of updates):
$(cat "$TEST_SPEC")
PROMPT

$LOOPX_BIN output --goto "shared:dispatch"
