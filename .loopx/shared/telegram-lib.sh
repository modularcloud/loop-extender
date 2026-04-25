# Shared telegram helpers. Source (don't exec) this file from shared/ scripts
# that need to resolve per-run forum topics, post into them, or emit workflow-
# labeled alerts to General.
#
# Required env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LOOPX_PROJECT_ROOT, LOOPX_WORKFLOW.
# Exports: TELEGRAM_API plus the tg_* functions below.

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN env var is required}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID env var is required}"
: "${LOOPX_PROJECT_ROOT:?LOOPX_PROJECT_ROOT env var is required}"
: "${LOOPX_WORKFLOW:?LOOPX_WORKFLOW env var is required}"

TELEGRAM_API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

_TG_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The caller workflow that owns this review cycle. When shared/ scripts run as
# LOOPX_WORKFLOW=shared (via shared:dispatch/check-question/apply-answer), the
# caller's name lives in .caller.tmp, written by the caller's index.sh. When
# running directly under a caller workflow, LOOPX_WORKFLOW is already the
# caller.
tg_caller_workflow() {
  local caller_file="$LOOPX_PROJECT_ROOT/.loopx/$LOOPX_WORKFLOW/.caller.tmp"
  if [[ -s "$caller_file" ]]; then
    tr -d '\n' < "$caller_file"
  else
    printf '%s' "$LOOPX_WORKFLOW"
  fi
}

# Forum topic name: "<repo> / <caller> [ / ADR-NNNN ]". One topic per (repo,
# caller, optional ADR) so parallel runs in different repos or on different
# ADRs don't collide.
tg_topic_name() {
  local owner name padded resolved
  owner=$(tg_caller_workflow)
  name="$(basename "$LOOPX_PROJECT_ROOT") / $owner"
  if [[ -n "${ADR:-}" ]]; then
    if resolved=$("$_TG_LIB_DIR/resolve-adr.sh" 2>/dev/null); then
      padded=$(printf '%s' "$resolved" | cut -f1)
      name="$name / ADR-$padded"
    fi
  fi
  printf '%s' "$name"
}

# Short label for alerts routed to General so it's obvious which run is
# speaking: "<repo> / <caller>[ / ADR-NNNN]".
tg_alert_label() {
  tg_topic_name
}

_TG_TOKEN_HASH=$(printf '%s' "$TELEGRAM_BOT_TOKEN" | sha256sum | cut -c1-12)
_TG_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/loopx-telegram"
mkdir -p "$_TG_CACHE_DIR"
_TG_CACHE_FILE="$_TG_CACHE_DIR/topics-$_TG_TOKEN_HASH.json"
_TG_LOCK_FILE="$_TG_CACHE_DIR/topics-$_TG_TOKEN_HASH.lock"

# Resolve (and if needed create) the message_thread_id for a topic name. Echoes
# the numeric id on stdout. Flocked so concurrent first-runs don't double-create
# the same topic.
tg_resolve_topic_id() {
  local topic="$1"
  local cache_key="${TELEGRAM_CHAT_ID}|${topic}"
  (
    exec 9>"$_TG_LOCK_FILE"
    flock -x 9
    [[ -f "$_TG_CACHE_FILE" ]] || echo '{}' > "$_TG_CACHE_FILE"
    local id resp
    id=$(jq -r --arg k "$cache_key" '.[$k] // empty' "$_TG_CACHE_FILE")
    if [[ -z "$id" ]]; then
      resp=$(curl -s -X POST "${TELEGRAM_API}/createForumTopic" \
        --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" \
        --data-urlencode "name=$topic")
      if [[ "$(echo "$resp" | jq -r '.ok')" != "true" ]]; then
        echo "Error: failed to create Telegram topic '$topic': $resp" >&2
        echo "Hint: TELEGRAM_CHAT_ID must point to a forum-enabled supergroup, and the bot must have 'Manage Topics' admin rights." >&2
        exit 1
      fi
      id=$(echo "$resp" | jq -r '.result.message_thread_id // empty')
      if [[ -z "$id" ]]; then
        echo "Error: createForumTopic returned ok but no message_thread_id: $resp" >&2
        exit 1
      fi
      jq --arg k "$cache_key" --argjson id "$id" '. + {($k): $id}' "$_TG_CACHE_FILE" > "$_TG_CACHE_FILE.tmp"
      mv "$_TG_CACHE_FILE.tmp" "$_TG_CACHE_FILE"
    fi
    printf '%s' "$id"
  )
}

# Drop a topic from the cache so the next tg_resolve_topic_id recreates it.
# Call this when a send fails with "thread not found" / closed / deleted.
tg_forget_topic() {
  local topic="$1"
  local cache_key="${TELEGRAM_CHAT_ID}|${topic}"
  (
    exec 9>"$_TG_LOCK_FILE"
    flock -x 9
    [[ -f "$_TG_CACHE_FILE" ]] || exit 0
    jq --arg k "$cache_key" 'del(.[$k])' "$_TG_CACHE_FILE" > "$_TG_CACHE_FILE.tmp"
    mv "$_TG_CACHE_FILE.tmp" "$_TG_CACHE_FILE"
  )
}

# True if a sendMessage/sendDocument error description indicates the cached
# thread_id is no longer usable and should be recreated.
tg_is_stale_thread_error() {
  local desc="$1"
  [[ "$desc" == *"thread not found"* ]] \
    || [[ "$desc" == *"TOPIC_DELETED"* ]] \
    || [[ "$desc" == *"topic closed"* ]]
}
