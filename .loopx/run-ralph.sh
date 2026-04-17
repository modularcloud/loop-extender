#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
PROMPT_FILE="$ROOT/PROMPT.md"
ITER_FILE="$ROOT/.loopx/.iteration.tmp"

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN env var is required}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID env var is required}"

TELEGRAM_API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Error: PROMPT.md not found at $PROMPT_FILE" >&2
  exit 1
fi

if [[ -f "$ITER_FILE" ]]; then
  ITER=$(($(cat "$ITER_FILE") + 1))
else
  ITER=1
fi
echo "$ITER" > "$ITER_FILE"

curl -s -X POST "${TELEGRAM_API}/sendMessage" \
  -d chat_id="$TELEGRAM_CHAT_ID" \
  --data-urlencode "text=Ralph loop: starting iteration ${ITER}" > /dev/null

echo "=== Ralph iteration ${ITER} ===" >&2

RALPH_OUTPUT=$(cat "$PROMPT_FILE" | claude -p --dangerously-skip-permissions 2>/dev/null)

$LOOPX_BIN output --result "$RALPH_OUTPUT" --goto "check-ready"
