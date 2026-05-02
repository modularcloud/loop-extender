#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
SPEC="$ROOT/SPEC.md"
TEST_SPEC="$ROOT/TEST-SPEC.md"
SHARED_DIR="$ROOT/.loopx/shared"
PROMPT_FILE="$SHARED_DIR/.prompt.tmp"
CALLER_FILE="$SHARED_DIR/.caller.tmp"

if [[ ! -d "$SHARED_DIR" ]]; then
  echo "Error: shared workflow not found at $SHARED_DIR — install it with: loopx install -w shared modularcloud/sdg-workflows" >&2
  exit 1
fi

if [[ ! -f "$SPEC" ]]; then
  echo "Error: SPEC.md not found at $SPEC — review-test-spec requires SPEC.md to exist at the project root" >&2
  exit 1
fi

if [[ ! -f "$TEST_SPEC" ]]; then
  echo "Error: TEST-SPEC.md not found at $TEST_SPEC — review-test-spec requires TEST-SPEC.md to exist at the project root" >&2
  exit 1
fi

echo "$LOOPX_WORKFLOW" > "$CALLER_FILE"

cat <<PROMPT > "$PROMPT_FILE"
Review TEST-SPEC.md against SPEC.md and let me know whether TEST-SPEC.md covers the behavior described in SPEC.md correctly and completely, or what needs to be added, changed, or removed. In this cycle, TEST-SPEC.md is the only file that should be modified — SPEC.md is a read-only reference. Do not suggest changes to SPEC.md; if something looks wrong in it, flag it but do not act on it.

SPEC.md (read-only reference):
$(cat "$SPEC")

TEST-SPEC.md (target of updates):
$(cat "$TEST_SPEC")
PROMPT

$LOOPX_BIN output --goto "shared:dispatch"
