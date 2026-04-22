#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
PROMPT_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.prompt.tmp"
FEEDBACK_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.feedback.tmp"

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN env var is required}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID env var is required}"

if [[ ! -s "$PROMPT_FILE" ]]; then
  echo "Error: prompt file not found at $PROMPT_FILE" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TELEGRAM_API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

# Topic name: <cwd> / <workflow> [ / ADR-NNNN ]. One topic per (project,
# workflow, optional ADR) so parallel runs in different repos can't collide.
TOPIC_NAME="$(basename "$ROOT") / $LOOPX_WORKFLOW"
if [[ -n "${ADR:-}" ]]; then
  if ADR_RESOLVED=$("$SCRIPT_DIR/resolve-adr.sh" 2>/dev/null); then
    ADR_PADDED=$(printf '%s' "$ADR_RESOLVED" | cut -f1)
    TOPIC_NAME="$TOPIC_NAME / ADR-$ADR_PADDED"
  fi
fi

# Per-bot cache: {"<chat_id>|<topic_name>": message_thread_id}. Flocked so
# concurrent first-runs don't double-create the same topic.
TOKEN_HASH=$(printf '%s' "$TELEGRAM_BOT_TOKEN" | sha256sum | cut -c1-12)
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/loopx-telegram"
mkdir -p "$CACHE_DIR"
CACHE_FILE="$CACHE_DIR/topics-$TOKEN_HASH.json"
LOCK_FILE="$CACHE_DIR/topics-$TOKEN_HASH.lock"
CACHE_KEY="${TELEGRAM_CHAT_ID}|${TOPIC_NAME}"

resolve_topic_id() {
  (
    exec 9>"$LOCK_FILE"
    flock -x 9
    [[ -f "$CACHE_FILE" ]] || echo '{}' > "$CACHE_FILE"
    local id
    id=$(jq -r --arg k "$CACHE_KEY" '.[$k] // empty' "$CACHE_FILE")
    if [[ -z "$id" ]]; then
      local resp
      resp=$(curl -s -X POST "${TELEGRAM_API}/createForumTopic" \
        --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" \
        --data-urlencode "name=$TOPIC_NAME")
      if [[ "$(echo "$resp" | jq -r '.ok')" != "true" ]]; then
        echo "Error: failed to create Telegram topic '$TOPIC_NAME': $resp" >&2
        echo "Hint: TELEGRAM_CHAT_ID must point to a forum-enabled supergroup, and the bot must have 'Manage Topics' admin rights." >&2
        exit 1
      fi
      id=$(echo "$resp" | jq -r '.result.message_thread_id // empty')
      if [[ -z "$id" ]]; then
        echo "Error: createForumTopic returned ok but no message_thread_id: $resp" >&2
        exit 1
      fi
      jq --arg k "$CACHE_KEY" --argjson id "$id" '. + {($k): $id}' "$CACHE_FILE" > "$CACHE_FILE.tmp"
      mv "$CACHE_FILE.tmp" "$CACHE_FILE"
    fi
    printf '%s' "$id"
  )
}

forget_topic() {
  (
    exec 9>"$LOCK_FILE"
    flock -x 9
    [[ -f "$CACHE_FILE" ]] || exit 0
    jq --arg k "$CACHE_KEY" 'del(.[$k])' "$CACHE_FILE" > "$CACHE_FILE.tmp"
    mv "$CACHE_FILE.tmp" "$CACHE_FILE"
  )
}

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

THREAD_ID=$(resolve_topic_id)

SEND_RESPONSE=$(send_prompt "$THREAD_ID")
if [[ "$(echo "$SEND_RESPONSE" | jq -r '.ok')" != "true" ]]; then
  DESC=$(echo "$SEND_RESPONSE" | jq -r '.description // ""')
  # User may have closed or deleted the topic between runs — invalidate cache and recreate.
  if [[ "$DESC" == *"thread not found"* ]] || [[ "$DESC" == *"TOPIC_DELETED"* ]] || [[ "$DESC" == *"topic closed"* ]]; then
    echo "Warning: cached topic $THREAD_ID no longer usable — recreating..." >&2
    forget_topic
    THREAD_ID=$(resolve_topic_id)
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
