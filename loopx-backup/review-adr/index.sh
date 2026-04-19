#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
ADR_0001="$ROOT/adr/0001-adr-process.md"
ADR_0004="$ROOT/adr/0004-tmpdir-and-args.md"
SPEC="$ROOT/SPEC.md"
PROMPT_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.prompt.tmp"

if [[ ! -f "$ADR_0001" ]]; then
  echo "Error: adr/0001-adr-process.md not found" >&2
  exit 1
fi

if [[ ! -f "$ADR_0004" ]]; then
  echo "Error: adr/0004-tmpdir-and-args.md not found" >&2
  exit 1
fi

if [[ ! -f "$SPEC" ]]; then
  echo "Error: SPEC.md not found" >&2
  exit 1
fi

# Build the prompt and save to file (too long for a single Telegram message)
cat <<PROMPT > "$PROMPT_FILE"
Review ADR 0001, ADR 0004, and SPEC.md holistically and let me know if I can mark ADR 0004 as accepted or if I need to improve it further. Ask me clarifying questions if you have any doubts about my intentions for ADR 0004.

adr/0001-adr-process.md:
$(cat "$ADR_0001")

adr/0004-tmpdir-and-args.md:
$(cat "$ADR_0004")

SPEC.md:
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
  *)
    echo "Error: unknown LOOPX_REVIEWER='$MODE' (expected unset, 'telegram', 'codex', or 'api')" >&2
    exit 1
    ;;
esac
