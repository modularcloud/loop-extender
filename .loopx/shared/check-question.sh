#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./telegram-lib.sh
source "$SCRIPT_DIR/telegram-lib.sh"

ROOT="$LOOPX_PROJECT_ROOT"
CLAUDE_OUTPUT_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.claude-output.tmp"
ANSWER_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.answer.tmp"

if [[ ! -f "$CLAUDE_OUTPUT_FILE" ]]; then
  echo "Error: No Claude output file found at $CLAUDE_OUTPUT_FILE" >&2
  exit 1
fi

CLAUDE_OUTPUT=$(cat "$CLAUDE_OUTPUT_FILE")
CLAUDE_OUTPUT_HTML=$(printf '%s' "$CLAUDE_OUTPUT" | node "$SCRIPT_DIR/md-to-tg-html.mjs")

# Use Codex with output schema to deterministically classify the output
SCHEMA="$ROOT/.loopx/$LOOPX_WORKFLOW/check-question.schema.json"
VERDICT=$(codex exec --sandbox read-only --output-schema "$SCHEMA" "Does the following text contain a question or request for clarification directed at the user?

$CLAUDE_OUTPUT" 2>/dev/null)

HAS_QUESTION=$(echo "$VERDICT" | jq -r '.has_question')

TOPIC_NAME=$(tg_topic_name)
ALERT_LABEL=$(tg_alert_label)

if [[ "$HAS_QUESTION" == "true" ]]; then
  echo "=== Claude has a question — sending to Telegram topic '$TOPIC_NAME' ===" >&2

  THREAD_ID=$(tg_resolve_topic_id "$TOPIC_NAME")

  # Watermark BEFORE sending so a near-instant reply isn't filtered out. Use
  # negative offset to peek the tail without advancing the global confirmation
  # pointer — confirming would delete updates queued for parallel runs.
  SENTINEL=$(curl -s "${TELEGRAM_API}/getUpdates?offset=-1&limit=1" | jq -r '.result[-1].update_id // 0')

  # Telegram caps sendMessage text at 4096 chars; chunk at 4000 to leave headroom
  # for UTF-16 surrogate pairs (${#var} counts code points, not code units).
  send_question() {
    local thread="$1"
    local max=4000
    local remaining="$CLAUDE_OUTPUT_HTML"
    local response=""
    local first=1
    while (( ${#remaining} > 0 )); do
      local chunk
      if (( ${#remaining} <= max )); then
        chunk="$remaining"
        remaining=""
      else
        local window="${remaining:0:$max}"
        local trimmed="${window%$'\n'*}"
        if [[ "$trimmed" != "$window" && ${#trimmed} -gt $((max / 2)) ]]; then
          chunk="${trimmed}"$'\n'
        else
          chunk="$window"
        fi
        remaining="${remaining:${#chunk}}"
      fi
      response=$(curl -s -X POST "${TELEGRAM_API}/sendMessage" \
        -d chat_id="$TELEGRAM_CHAT_ID" \
        -d message_thread_id="$thread" \
        -d parse_mode=HTML \
        --data-urlencode "text=${chunk}")
      # Chunking can split inside an HTML tag; on a parse error fall back to
      # plain text for that chunk so the message still lands.
      if [[ "$(echo "$response" | jq -r '.ok')" != "true" ]]; then
        local desc
        desc=$(echo "$response" | jq -r '.description // ""')
        if [[ "$desc" == *"can't parse entities"* || "$desc" == *"Can't parse entities"* ]]; then
          response=$(curl -s -X POST "${TELEGRAM_API}/sendMessage" \
            -d chat_id="$TELEGRAM_CHAT_ID" \
            -d message_thread_id="$thread" \
            --data-urlencode "text=${chunk}")
        fi
      fi
      if [[ "$(echo "$response" | jq -r '.ok')" != "true" ]]; then
        # First-chunk failure bubbles up so the caller can retry on stale thread.
        # Later-chunk failures can't be undone, so warn and keep going.
        if (( first )); then
          echo "$response"
          return
        fi
        echo "Warning: failed to send follow-up chunk: $response" >&2
      fi
      first=0
    done
    echo "$response"
  }

  SEND_RESPONSE=$(send_question "$THREAD_ID")
  if [[ "$(echo "$SEND_RESPONSE" | jq -r '.ok')" != "true" ]]; then
    DESC=$(echo "$SEND_RESPONSE" | jq -r '.description // ""')
    if tg_is_stale_thread_error "$DESC"; then
      echo "Warning: cached topic $THREAD_ID no longer usable — recreating..." >&2
      tg_forget_topic "$TOPIC_NAME"
      THREAD_ID=$(tg_resolve_topic_id "$TOPIC_NAME")
      SEND_RESPONSE=$(send_question "$THREAD_ID")
    fi
  fi
  if [[ "$(echo "$SEND_RESPONSE" | jq -r '.ok')" != "true" ]]; then
    echo "Error: Failed to send question to Telegram: $SEND_RESPONSE" >&2
    exit 1
  fi

  echo "Waiting for answer in topic '$TOPIC_NAME' (thread $THREAD_ID)..." >&2

  COLLECTED=""
  DEADLINE=""

  while true; do
    # Negative offset + sentinel: read the tail without advancing the global
    # confirmation pointer, and filter per-run by thread_id so parallel review
    # cycles don't steal each other's answers.
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

  echo "$COLLECTED" > "$ANSWER_FILE"
  echo "=== Answer received from Telegram ===" >&2
  echo "--- Begin answer ---" >&2
  echo "$COLLECTED" >&2
  echo "--- End answer ---" >&2

  $LOOPX_BIN output --goto "apply-answer"
  exit 0
else
  # Terminal alert — route to General with the workflow label so it's clear
  # which run is speaking. Per-run topic stays focused on the review dialog.
  curl -s -X POST "${TELEGRAM_API}/sendMessage" \
    -d chat_id="$TELEGRAM_CHAT_ID" \
    --data-urlencode "text=[${ALERT_LABEL}] Feedback applied. Ready for next review cycle." > /dev/null

  rm -f "$CLAUDE_OUTPUT_FILE" "$ROOT/.loopx/$LOOPX_WORKFLOW/.caller.tmp" "$ROOT/.loopx/$LOOPX_WORKFLOW/.session.tmp"
  echo "=== No questions. Ready for next review cycle. ===" >&2
  $LOOPX_BIN output --result "Feedback applied. Ready for next review cycle."
fi
