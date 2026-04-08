#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
SPEC="$ROOT/SIGNING-SPEC.md"
TEST_SPEC="$ROOT/TEST-SIGNING-SPEC.md"
SPEC_PROBLEMS="$ROOT/SIGNING-SPEC-PROBLEMS.md"
FEEDBACK_FILE="$ROOT/.loopx/.feedback.tmp"
PROMPT_FILE="$ROOT/.loopx/.prompt.tmp"

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN env var is required}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID env var is required}"

TELEGRAM_API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

if [[ ! -f "$SPEC" ]]; then
  echo "Error: SIGNING-SPEC.md not found" >&2
  exit 1
fi

if [[ ! -f "$TEST_SPEC" ]]; then
  echo "Error: TEST-SIGNING-SPEC.md not found" >&2
  exit 1
fi

if [[ -f "$SPEC_PROBLEMS" ]]; then
  SPEC_PROBLEMS_CONTENT="$(cat "$SPEC_PROBLEMS")"
else
  SPEC_PROBLEMS_CONTENT="No known spec problems have been identified so far."
fi

# Build the prompt and save to file (too long for a single Telegram message)
cat <<PROMPT > "$PROMPT_FILE"
Review SIGNING-SPEC.md and TEST-SIGNING-SPEC.md holistically and let me know if I can start implementing the tests or if I need to modify the test spec. My goal is to be able to comprehensively tests all requirements in the signing spec prior to implementation. Additionally, if there are any known problems in the spec that need to be resolved, they will be included in SIGNING-SPEC-PROBLEMS.md. As part of your holistic plan, help me resolve these and any new issues while keeping in mind my main goal is to only make conservative changes to SIGNING-SPEC.md at this point because I am mainly focused on TEST-SIGNING-SPEC.md.

SIGNING-SPEC.md:
$(cat "$SPEC")

TEST-SIGNING-SPEC.md:
$(cat "$TEST_SPEC")

SIGNING-SPEC-PROBLEMS.md:
$SPEC_PROBLEMS_CONTENT
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
