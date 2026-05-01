#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
ITER_FILE="$ROOT/.loopx/ralph/.iteration.tmp"

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN env var is required}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID env var is required}"

TELEGRAM_API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

RALPH_OUTPUT=$(cat)

REVIEW_PROMPT=$(printf 'The following is the stdout of one iteration of an agent development loop. Judge whether the output itself states or clearly indicates that the work is production ready / complete / done. Only answer READY if the output affirmatively claims production readiness. Reply with exactly one word: READY or NOT_READY.\n\n--- begin output ---\n%s\n--- end output ---' "$RALPH_OUTPUT")

VERDICT=$(echo "$REVIEW_PROMPT" | claude -p --dangerously-skip-permissions 2>/dev/null)

echo "=== Readiness verdict: ${VERDICT} ===" >&2

if echo "$VERDICT" | grep -qw "READY"; then
  ITER=$(cat "$ITER_FILE" 2>/dev/null || echo "?")
  JOB="$(basename "$ROOT") / ralph"
  [[ -n "${STAGE:-}" ]] && JOB="$JOB / $STAGE"
  if [[ -n "${ADR:-}" && "$ADR" =~ ^[0-9]+$ ]]; then
    JOB="$JOB / ADR-$(printf '%04d' "$((10#$ADR))")"
  fi

  curl -s -X POST "${TELEGRAM_API}/sendMessage" \
    -d chat_id="$TELEGRAM_CHAT_ID" \
    --data-urlencode "text=[${JOB}] production ready after iteration ${ITER}. Halting." > /dev/null

  rm -f "$ITER_FILE"
  echo "=== Response classified as READY ===" >&2
  echo "--- begin classified output ---" >&2
  printf '%s\n' "$RALPH_OUTPUT" >&2
  echo "--- end classified output ---" >&2
  echo "=== Production ready — halting loop ===" >&2
  $LOOPX_BIN output --result "Production ready after iteration ${ITER}." --stop
else
  echo "=== Not production ready — continuing loop ===" >&2
  $LOOPX_BIN output --result "continuing" --goto "index"
fi
