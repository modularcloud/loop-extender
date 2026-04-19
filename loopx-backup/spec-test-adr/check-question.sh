#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
CLAUDE_OUTPUT_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.claude-output.tmp"
ANSWER_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.answer.tmp"

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN env var is required}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID env var is required}"

TELEGRAM_API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

if [[ ! -f "$CLAUDE_OUTPUT_FILE" ]]; then
  echo "Error: No Claude output file found at $CLAUDE_OUTPUT_FILE" >&2
  exit 1
fi

CLAUDE_OUTPUT=$(cat "$CLAUDE_OUTPUT_FILE")

# Use Codex with output schema to deterministically classify the output
SCHEMA="$ROOT/.loopx/$LOOPX_WORKFLOW/check-question.schema.json"
VERDICT=$(codex exec --output-schema "$SCHEMA" "Does the following text contain a question or request for clarification directed at the user?

$CLAUDE_OUTPUT" 2>/dev/null)

HAS_QUESTION=$(echo "$VERDICT" | jq -r '.has_question')

if [[ "$HAS_QUESTION" == "true" ]]; then
  echo "=== Claude has a question — sending to Telegram ===" >&2

  # Send as document if too long for a message, otherwise as text
  if [[ ${#CLAUDE_OUTPUT} -gt 4000 ]]; then
    QUESTION_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.question.tmp"
    echo "$CLAUDE_OUTPUT" > "$QUESTION_FILE"
    curl -s -X POST "${TELEGRAM_API}/sendDocument" \
      -F chat_id="$TELEGRAM_CHAT_ID" \
      -F document=@"$QUESTION_FILE;filename=question.md" \
      -F caption="Claude has a question — reply with your answer" > /dev/null
    rm -f "$QUESTION_FILE"
  else
    curl -s -X POST "${TELEGRAM_API}/sendMessage" \
      -d chat_id="$TELEGRAM_CHAT_ID" \
      --data-urlencode "text=${CLAUDE_OUTPUT}" > /dev/null
  fi

  echo "Waiting for answer..." >&2

  # Flush old updates to get current offset
  FLUSH_RESPONSE=$(curl -s "${TELEGRAM_API}/getUpdates?offset=-1")
  LAST_UPDATE_ID=$(echo "$FLUSH_RESPONSE" | jq -r '.result[-1].update_id // empty')
  if [[ -n "$LAST_UPDATE_ID" ]]; then
    OFFSET=$((LAST_UPDATE_ID + 1))
  else
    OFFSET=0
  fi

  # Long-poll for a reply, collecting split messages over a 10s window
  COLLECTED=""
  DEADLINE=""

  while true; do
    if [[ -n "$DEADLINE" ]]; then
      NOW=$(date +%s)
      if [[ $NOW -ge $DEADLINE ]]; then
        break
      fi
      POLL_TIMEOUT=2
    else
      POLL_TIMEOUT=30
    fi

    UPDATES=$(curl -s "${TELEGRAM_API}/getUpdates?offset=${OFFSET}&timeout=${POLL_TIMEOUT}")

    MSG_COUNT=$(echo "$UPDATES" | jq --arg cid "$TELEGRAM_CHAT_ID" '
      [.result[] | select(.message.chat.id == ($cid | tonumber) and .message.text != null)] | length
    ')

    if [[ "$MSG_COUNT" -gt 0 ]]; then
      NEW_TEXTS=$(echo "$UPDATES" | jq -r --arg cid "$TELEGRAM_CHAT_ID" '
        [.result[] | select(.message.chat.id == ($cid | tonumber) and .message.text != null)]
        | .[].message.text
      ')
      if [[ -n "$COLLECTED" ]]; then
        COLLECTED="${COLLECTED}
${NEW_TEXTS}"
      else
        COLLECTED="$NEW_TEXTS"
      fi

      if [[ -z "$DEADLINE" ]]; then
        DEADLINE=$(( $(date +%s) + 10 ))
        echo "=== First message received, collecting for 10s... ===" >&2
      fi
    fi

    NEW_LAST=$(echo "$UPDATES" | jq -r '.result[-1].update_id // empty')
    if [[ -n "$NEW_LAST" ]]; then
      OFFSET=$((NEW_LAST + 1))
    fi
  done

  curl -s "${TELEGRAM_API}/getUpdates?offset=${OFFSET}" > /dev/null

  echo "$COLLECTED" > "$ANSWER_FILE"
  echo "=== Answer received from Telegram ===" >&2
  echo "--- Begin answer ---" >&2
  echo "$COLLECTED" >&2
  echo "--- End answer ---" >&2

  $LOOPX_BIN output --goto "apply-answer"
  exit 0
else
  # No question — notify and loop back to copy-prompt
  curl -s -X POST "${TELEGRAM_API}/sendMessage" \
    -d chat_id="$TELEGRAM_CHAT_ID" \
    -d text="Feedback applied. Ready for next review cycle." > /dev/null

  rm -f "$CLAUDE_OUTPUT_FILE"
  echo "=== No questions. Ready for next review cycle. ===" >&2
  $LOOPX_BIN output --result "Feedback applied. Ready for next review cycle."
fi
