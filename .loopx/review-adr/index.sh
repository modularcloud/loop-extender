#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
ADR_0001="$ROOT/adr/0001-adr-process.md"
ADR_0002="$ROOT/adr/0002-run-subcommand.md"
SPEC="$ROOT/SPEC.md"
FEEDBACK_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.feedback.tmp"
PROMPT_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.prompt.tmp"

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN env var is required}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID env var is required}"

TELEGRAM_API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

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
Review ADR 0001, ADR 0002, and SPEC.md holistically and let me know if I can mark ADR 0002 as accepted or if I need to improve it further. Ask me clarifying questions if you have any doubts about my intentions for ADR 0002.

adr/0001-adr-process.md:
$(cat "$ADR_0001")

adr/0002-run-subcommand.md:
$(cat "$ADR_0002")

SPEC.md:
$(cat "$SPEC")
PROMPT

# Flush old updates to get current offset
FLUSH_RESPONSE=$(curl -s "${TELEGRAM_API}/getUpdates?offset=-1")
LAST_UPDATE_ID=$(echo "$FLUSH_RESPONSE" | jq -r '.result[-1].update_id // empty')
if [[ -n "$LAST_UPDATE_ID" ]]; then
  OFFSET=$((LAST_UPDATE_ID + 1))
else
  OFFSET=0
fi

# Send the prompt as a document attachment
SEND_RESPONSE=$(curl -s -X POST "${TELEGRAM_API}/sendDocument" \
  -F chat_id="$TELEGRAM_CHAT_ID" \
  -F document=@"$PROMPT_FILE;filename=review-prompt.md" \
  -F caption="Review prompt — reply with your feedback")

SENT_OK=$(echo "$SEND_RESPONSE" | jq -r '.ok')
if [[ "$SENT_OK" != "true" ]]; then
  echo "Error: Failed to send Telegram message: $SEND_RESPONSE" >&2
  rm -f "$PROMPT_FILE"
  exit 1
fi

rm -f "$PROMPT_FILE"

echo "" >&2
echo "=== Prompt sent to Telegram ===" >&2
echo "Reply in the Telegram chat with your feedback." >&2
echo "Waiting for reply..." >&2

# Long-poll for a reply, collecting split messages over a 10s window
COLLECTED=""
DEADLINE=""

while true; do
  # After first message arrives, switch to short polls and enforce deadline
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

    # Start 10s collection window on first message
    if [[ -z "$DEADLINE" ]]; then
      DEADLINE=$(( $(date +%s) + 10 ))
      echo "=== First message received, collecting for 10s... ===" >&2
    fi
  fi

  # Advance offset past all updates
  NEW_LAST=$(echo "$UPDATES" | jq -r '.result[-1].update_id // empty')
  if [[ -n "$NEW_LAST" ]]; then
    OFFSET=$((NEW_LAST + 1))
  fi
done

# Acknowledge all collected updates
curl -s "${TELEGRAM_API}/getUpdates?offset=${OFFSET}" > /dev/null

echo "$COLLECTED" > "$FEEDBACK_FILE"
echo "=== Feedback received from Telegram ===" >&2
echo "--- Begin feedback ---" >&2
echo "$COLLECTED" >&2
echo "--- End feedback ---" >&2

$LOOPX_BIN output --goto "apply-feedback"
