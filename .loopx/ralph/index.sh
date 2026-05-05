#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
WF_DIR="$ROOT/.loopx/ralph"
PROMPTS_DIR="$WF_DIR/prompts"
TMP_DIR="$WF_DIR/.tmp"
ITER_FILE="$WF_DIR/.iteration.tmp"

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN env var is required}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID env var is required}"
: "${STAGE:?STAGE env var is required (must be 'core' or 'test')}"

if [[ "$STAGE" != "core" && "$STAGE" != "test" ]]; then
  echo "Error: STAGE must be 'core' or 'test' (got '$STAGE')" >&2
  exit 1
fi

ADR_NUM=""
if [[ -n "${ADR:-}" ]]; then
  if ! [[ "$ADR" =~ ^[0-9]+$ ]]; then
    echo "Error: ADR must be numeric (got '$ADR')" >&2
    exit 1
  fi
  ADR_NUM=$(printf '%04d' "$((10#$ADR))")
  shopt -s nullglob
  MATCHES=("$ROOT"/adr/"$ADR_NUM"-*.md)
  shopt -u nullglob
  if [[ ${#MATCHES[@]} -eq 0 ]]; then
    echo "Error: no ADR file found at adr/${ADR_NUM}-*.md under $ROOT" >&2
    exit 1
  fi
  if [[ ${#MATCHES[@]} -gt 1 ]]; then
    echo "Error: multiple ADR files match adr/${ADR_NUM}-*.md:" >&2
    printf '  %s\n' "${MATCHES[@]}" >&2
    exit 1
  fi
fi

PROMPT_TEMPLATE="$PROMPTS_DIR/$STAGE/PROMPT.md"
PLANNING_TEMPLATE="$PROMPTS_DIR/$STAGE/PLANNING-PROMPT.md"
if [[ -n "$ADR_NUM" ]]; then
  [[ -f "$PROMPTS_DIR/$STAGE/PROMPT.update.md"          ]] && PROMPT_TEMPLATE="$PROMPTS_DIR/$STAGE/PROMPT.update.md"
  [[ -f "$PROMPTS_DIR/$STAGE/PLANNING-PROMPT.update.md" ]] && PLANNING_TEMPLATE="$PROMPTS_DIR/$STAGE/PLANNING-PROMPT.update.md"
fi

if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  echo "Error: prompt template not found: $PROMPT_TEMPLATE" >&2
  exit 1
fi
if [[ ! -f "$PLANNING_TEMPLATE" ]]; then
  echo "Error: planning template not found: $PLANNING_TEMPLATE" >&2
  exit 1
fi

mkdir -p "$TMP_DIR"
sed "s|{{ADR_NUM}}|${ADR_NUM}|g" "$PROMPT_TEMPLATE" > "$TMP_DIR/PROMPT.md"
sed "s|{{ADR_NUM}}|${ADR_NUM}|g" "$PLANNING_TEMPLATE" > "$TMP_DIR/PLANNING-PROMPT.md"

if ! command -v codex >/dev/null 2>&1; then
  echo "Error: codex CLI not found on PATH" >&2
  exit 1
fi

if [[ -f "$ITER_FILE" ]]; then
  ITER=$(($(cat "$ITER_FILE") + 1))
else
  ITER=1
fi
echo "$ITER" > "$ITER_FILE"

JOB="$(basename "$ROOT") / ralph / $STAGE"
[[ -n "$ADR_NUM" ]] && JOB="$JOB / ADR-$ADR_NUM"

TELEGRAM_API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
curl -s -X POST "${TELEGRAM_API}/sendMessage" \
  -d chat_id="$TELEGRAM_CHAT_ID" \
  --data-urlencode "text=[${JOB}] starting iteration ${ITER}" > /dev/null

echo "=== Ralph iteration ${ITER} (stage=${STAGE}${ADR_NUM:+, ADR=${ADR_NUM}}) ===" >&2

RALPH_OUTPUT_FILE="$TMP_DIR/ralph-output.tmp"
RALPH_STDERR_FILE="$TMP_DIR/ralph-codex-stderr.tmp"
rm -f "$RALPH_OUTPUT_FILE" "$RALPH_STDERR_FILE"

set +e
codex exec - \
  --cd "$ROOT" \
  --skip-git-repo-check \
  --dangerously-bypass-approvals-and-sandbox \
  --color never \
  --output-last-message "$RALPH_OUTPUT_FILE" \
  < "$TMP_DIR/PROMPT.md" >/dev/null 2>"$RALPH_STDERR_FILE"
CODEX_STATUS=$?
set -e

if [[ $CODEX_STATUS -ne 0 || ! -s "$RALPH_OUTPUT_FILE" ]]; then
  echo "Error: codex exec failed (exit=$CODEX_STATUS) or produced no Ralph output" >&2
  if [[ -s "$RALPH_STDERR_FILE" ]]; then
    echo "--- codex stderr ---" >&2
    cat "$RALPH_STDERR_FILE" >&2
    echo "--- end codex stderr ---" >&2
  fi
  rm -f "$RALPH_OUTPUT_FILE" "$RALPH_STDERR_FILE"
  exit 1
fi

RALPH_OUTPUT=$(cat "$RALPH_OUTPUT_FILE")
rm -f "$RALPH_OUTPUT_FILE" "$RALPH_STDERR_FILE"

$LOOPX_BIN output --result "$RALPH_OUTPUT" --goto "check-ready"
