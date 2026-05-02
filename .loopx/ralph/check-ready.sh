#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
ITER_FILE="$ROOT/.loopx/ralph/.iteration.tmp"
FIX_PLAN_FILE="$ROOT/fix_plan.md"

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN env var is required}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID env var is required}"

TELEGRAM_API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

RALPH_OUTPUT=$(cat)

if [[ -f "$FIX_PLAN_FILE" ]]; then
  FIX_PLAN_CONTENT=$(cat "$FIX_PLAN_FILE")
else
  FIX_PLAN_CONTENT="(fix_plan.md does not exist)"
fi

REVIEW_PROMPT=$(printf 'The following is (1) the stdout of one iteration of an agent development loop and (2) the current contents of fix_plan.md. Judge whether BOTH of the following are true:\n  (a) the output itself states or clearly indicates that the work is production ready / complete / done; AND\n  (b) fix_plan.md has no remaining work to be done (no open tasks, unchecked items, or pending fixes — only completed/empty content, or the file does not exist).\nOnly answer READY if BOTH (a) and (b) hold. If either fails, answer NOT_READY. Reply with exactly one word: READY or NOT_READY.\n\n--- begin output ---\n%s\n--- end output ---\n\n--- begin fix_plan.md ---\n%s\n--- end fix_plan.md ---' "$RALPH_OUTPUT" "$FIX_PLAN_CONTENT")

VERDICT=$(echo "$REVIEW_PROMPT" | claude --effort max -p --dangerously-skip-permissions 2>/dev/null)

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
  echo "=== Production ready — halting loop ===" >&2
  $LOOPX_BIN output --result "Production ready after iteration ${ITER}." --stop
else
  echo "=== Not production ready — continuing loop ===" >&2
  $LOOPX_BIN output --result "continuing" --goto "index"
fi
