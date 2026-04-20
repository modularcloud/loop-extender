#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
ADR_0001="$ROOT/adr/0001-adr-process.md"
ADR_0002="$ROOT/adr/0002-run-subcommand.md"
SPEC="$ROOT/SPEC.md"
TEST_SPEC="$ROOT/TEST-SPEC.md"
PROMPT_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.prompt.tmp"

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

if [[ ! -f "$TEST_SPEC" ]]; then
  echo "Error: TEST-SPEC.md not found" >&2
  exit 1
fi

# Build the prompt and save to file (too long for a single Telegram message)
cat <<PROMPT > "$PROMPT_FILE"
ADR 0002 has been accepted and SPEC.md has already been updated to incorporate its changes (ADR status: "Spec Updated"). Per the ADR process in ADR-0001, the next step is to update TEST-SPEC.md to cover the new and changed spec behavior introduced by ADR-0002. In this cycle, TEST-SPEC.md is the only file that should be modified — SPEC.md and ADR-0002 are read-only references.

Review the current TEST-SPEC.md against the updated SPEC.md and ADR-0002, and let me know whether TEST-SPEC.md already covers the ADR-0002 changes correctly and completely, or what needs to be added, changed, or removed. Do not suggest changes to SPEC.md or ADR-0002 — if something looks wrong in those, flag it but do not act on it.

adr/0002-run-subcommand.md (accepted — read-only reference):
$(cat "$ADR_0002")

SPEC.md (already updated for ADR-0002 — read-only reference):
$(cat "$SPEC")

TEST-SPEC.md (target of updates):
$(cat "$TEST_SPEC")
PROMPT

MODE="${LOOPX_REVIEWER:-telegram}"
case "$MODE" in
  telegram)
    exec ./lib/send-telegram.sh
    ;;
  codex)
    exec ./lib/send-codex.sh
    ;;
  api)
    if [[ ! -x ./node_modules/.bin/tsx ]]; then
      echo "Error: ./node_modules/.bin/tsx not found. Run 'npm install' in $(pwd) to enable LOOPX_REVIEWER=api." >&2
      exit 1
    fi
    exec ./node_modules/.bin/tsx ./lib/send-api.ts
    ;;
  batch)
    if [[ ! -x ./node_modules/.bin/tsx ]]; then
      echo "Error: ./node_modules/.bin/tsx not found. Run 'npm install' in $(pwd) to enable LOOPX_REVIEWER=batch." >&2
      exit 1
    fi
    exec ./node_modules/.bin/tsx ./lib/send-batch.ts
    ;;
  *)
    echo "Error: unknown LOOPX_REVIEWER='$MODE' (expected unset, 'telegram', 'codex', 'api', or 'batch')" >&2
    exit 1
    ;;
esac
