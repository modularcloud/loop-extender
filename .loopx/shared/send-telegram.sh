#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./telegram-lib.sh
source "$SCRIPT_DIR/telegram-lib.sh"

ROOT="$LOOPX_PROJECT_ROOT"
PROMPT_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.prompt.tmp"
FEEDBACK_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.feedback.tmp"

if [[ ! -s "$PROMPT_FILE" ]]; then
  echo "Error: prompt file not found at $PROMPT_FILE" >&2
  exit 1
fi

TOPIC_NAME=$(tg_topic_name)

send_prompt() {
  curl -s -X POST "${TELEGRAM_API}/sendDocument" \
    -F chat_id="$TELEGRAM_CHAT_ID" \
    -F message_thread_id="$1" \
    -F document=@"$PROMPT_FILE;filename=review-prompt.md" \
    -F caption="Review prompt — reply with your feedback"
}

# Watermark: highest update_id currently in the queue. Set BEFORE sending so a
# near-instant reply (update_id arriving during the sendDocument roundtrip) is
# still newer than SENTINEL and isn't filtered out. offset=-1 peeks the tail
# without advancing the global confirmation pointer — confirming via a positive
# offset would delete updates queued for other parallel runs of this bot.
SENTINEL=$(curl -s "${TELEGRAM_API}/getUpdates?offset=-1&limit=1" | jq -r '.result[-1].update_id // 0')

THREAD_ID=$(tg_resolve_topic_id "$TOPIC_NAME")

SEND_RESPONSE=$(send_prompt "$THREAD_ID")
if [[ "$(echo "$SEND_RESPONSE" | jq -r '.ok')" != "true" ]]; then
  DESC=$(echo "$SEND_RESPONSE" | jq -r '.description // ""')
  # User may have closed or deleted the topic between runs — invalidate cache and recreate.
  if tg_is_stale_thread_error "$DESC"; then
    echo "Warning: cached topic $THREAD_ID no longer usable — recreating..." >&2
    tg_forget_topic "$TOPIC_NAME"
    THREAD_ID=$(tg_resolve_topic_id "$TOPIC_NAME")
    SEND_RESPONSE=$(send_prompt "$THREAD_ID")
  fi
fi
if [[ "$(echo "$SEND_RESPONSE" | jq -r '.ok')" != "true" ]]; then
  echo "Error: Failed to send Telegram message: $SEND_RESPONSE" >&2
  rm -f "$PROMPT_FILE"
  exit 1
fi
rm -f "$PROMPT_FILE"

echo "" >&2
echo "=== Prompt sent to Telegram topic '$TOPIC_NAME' (thread $THREAD_ID) ===" >&2
echo "Reply in that topic with your feedback." >&2
echo "Waiting for reply..." >&2

COLLECTED=""
DEADLINE=""

while true; do
  # Negative offset = read tail without advancing the global confirmation
  # pointer. Every parallel run sees the same updates and each filters for its
  # own thread_id. We always poll once per iteration, then check the deadline,
  # so the final poll covers the full 10s window (checking before polling
  # would drop messages arriving in the last sleep interval).
  UPDATES=$(curl -s "${TELEGRAM_API}/getUpdates?offset=-100&limit=100")
  if [[ "$(echo "$UPDATES" | jq -r '.ok // false')" != "true" ]]; then
    sleep 2
    continue
  fi

  BATCH=$(echo "$UPDATES" | jq -r \
    --arg cid "$TELEGRAM_CHAT_ID" \
    --argjson thread "$THREAD_ID" \
    --argjson sentinel "$SENTINEL" '
    [.result[]
      | select(.message.chat.id == ($cid|tonumber)
               and .message.text != null
               and (.message.message_thread_id // 0) == $thread
               and .update_id > $sentinel)]
    | map(.message.text) | join("\n")
  ')
  MAX_ID=$(echo "$UPDATES" | jq -r \
    --arg cid "$TELEGRAM_CHAT_ID" \
    --argjson thread "$THREAD_ID" \
    --argjson sentinel "$SENTINEL" '
    [.result[]
      | select(.message.chat.id == ($cid|tonumber)
               and .message.text != null
               and (.message.message_thread_id // 0) == $thread
               and .update_id > $sentinel)
      | .update_id]
    | max // 0
  ')

  if [[ -n "$BATCH" ]]; then
    if [[ -n "$COLLECTED" ]]; then
      COLLECTED="${COLLECTED}
${BATCH}"
    else
      COLLECTED="$BATCH"
    fi
    if (( MAX_ID > SENTINEL )); then
      SENTINEL=$MAX_ID
    fi
    if [[ -z "$DEADLINE" ]]; then
      DEADLINE=$(( $(date +%s) + 10 ))
      echo "=== First message received, collecting for 10s... ===" >&2
    fi
  fi

  if [[ -n "$DEADLINE" ]]; then
    NOW=$(date +%s)
    (( NOW >= DEADLINE )) && break
  fi

  sleep 2
done

echo "$COLLECTED" > "$FEEDBACK_FILE"
echo "=== Feedback received from Telegram ===" >&2
echo "--- Begin feedback ---" >&2
echo "$COLLECTED" >&2
echo "--- End feedback ---" >&2

$LOOPX_BIN output --goto "check-feedback-done"
