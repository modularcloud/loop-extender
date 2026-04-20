#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
ADR_0001="$ROOT/adr/0001-adr-process.md"
ADR_0002="$ROOT/adr/0002-run-subcommand.md"
SPEC="$ROOT/SPEC.md"
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

# Build the prompt and save to file (too long for a single Telegram message)
cat <<PROMPT > "$PROMPT_FILE"
ADR 0002 has been accepted. The next step in the process is to update SPEC.md to incorporate the changes described in ADR 0002. Review the current SPEC.md against ADR 0002 and let me know if the SPEC updates look correct and complete, or if anything else in the SPEC needs to be changed.

adr/0002-run-subcommand.md (accepted — do not modify):
$(cat "$ADR_0002")

SPEC.md (target of updates):
$(cat "$SPEC")
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
