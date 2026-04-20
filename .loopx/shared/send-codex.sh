#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
PROMPT_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.prompt.tmp"
FEEDBACK_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.feedback.tmp"

if ! command -v codex >/dev/null 2>&1; then
  echo "Error: codex CLI not found on PATH" >&2
  exit 1
fi

if [[ ! -s "$PROMPT_FILE" ]]; then
  echo "Error: prompt file not found at $PROMPT_FILE" >&2
  exit 1
fi

echo "" >&2
echo "=== Invoking codex CLI ===" >&2

rm -f "$FEEDBACK_FILE"

codex exec - \
  --skip-git-repo-check \
  --sandbox read-only \
  --color never \
  --output-last-message "$FEEDBACK_FILE" \
  < "$PROMPT_FILE" >/dev/null

rm -f "$PROMPT_FILE"

if [[ ! -s "$FEEDBACK_FILE" ]]; then
  echo "Error: codex produced no feedback" >&2
  exit 1
fi

echo "=== Feedback received from codex ===" >&2
echo "--- Begin feedback ---" >&2
cat "$FEEDBACK_FILE" >&2
echo "" >&2
echo "--- End feedback ---" >&2

$LOOPX_BIN output --goto "check-feedback-done"
