#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
SPEC="$ROOT/SPEC.md"
TEST_SPEC="$ROOT/TEST-SPEC.md"
SPEC_PROBLEMS="$ROOT/SPEC-PROBLEMS.md"
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

RESOLVED=$("$SHARED_DIR/resolve-adr.sh")
IFS=$'\t' read -r ADR_NUM ADR_FILE <<< "$RESOLVED"
ADR_REL="adr/$(basename "$ADR_FILE")"

echo "$LOOPX_WORKFLOW" > "$CALLER_FILE"

if [[ -f "$SPEC_PROBLEMS" ]]; then
  SPEC_PROBLEMS_BLOCK="$(printf 'SPEC-PROBLEMS.md (open SPEC ambiguities scoped to ADR-%s — please also work to resolve any problems listed here):\n%s\n\n' "$ADR_NUM" "$(cat "$SPEC_PROBLEMS")")"
else
  SPEC_PROBLEMS_BLOCK="SPEC-PROBLEMS.md is absent — there are no currently tracked open SPEC ambiguities scoped to ADR-${ADR_NUM}."$'\n\n'
fi

cat <<PROMPT > "$PROMPT_FILE"
Review TEST-SPEC.md against SPEC.md and let me know whether TEST-SPEC.md covers the behavior described in SPEC.md correctly and completely, or what needs to be added, changed, or removed.

This review is scoped to ADR-$ADR_NUM. SPEC.md changes are permitted **only** when they directly resolve a SPEC-PROBLEMS.md entry that is itself scoped to ADR-$ADR_NUM. Do **not** propose SPEC.md edits unrelated to ADR-$ADR_NUM, even if you notice gaps, ambiguities, or improvements in other sections of SPEC.md — those are out of scope for this cycle. Also work to resolve any problems in SPEC-PROBLEMS.md (if present) — call out which entries appear addressable in this cycle and which still require a SPEC change. If SPEC-PROBLEMS.md exists, you may propose specific SPEC.md edits that would resolve the listed ambiguities, but only when those edits are scoped to ADR-$ADR_NUM. If you find a SPEC ambiguity, gap, or under-specified clause that prevents TEST-SPEC.md from covering ADR-$ADR_NUM behavior cleanly, recommend adding it to SPEC-PROBLEMS.md; do not record problems unrelated to ADR-$ADR_NUM.

$ADR_REL (scope of this review — SPEC and SPEC-PROBLEMS changes must be related to this ADR):
$(cat "$ADR_FILE")

SPEC.md (authoritative reference; SPEC.md edits are permitted only to resolve SPEC-PROBLEMS.md entries scoped to ADR-$ADR_NUM):
$(cat "$SPEC")

${SPEC_PROBLEMS_BLOCK}TEST-SPEC.md (target of updates):
$(cat "$TEST_SPEC")
PROMPT

$LOOPX_BIN output --goto "shared:dispatch"
