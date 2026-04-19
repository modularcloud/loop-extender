#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
CLAUDE_OUTPUT_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.claude-output.tmp"
ANSWER_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.answer.tmp"

if [[ ! -f "$ANSWER_FILE" ]]; then
  echo "Error: No answer file found at $ANSWER_FILE" >&2
  exit 1
fi

ANSWER=$(cat "$ANSWER_FILE")

# Continue the existing conversation started by apply-feedback
CLAUDE_OUTPUT=$(echo "$ANSWER" | claude --dangerously-skip-permissions -c -p 2>/dev/null)

echo "$CLAUDE_OUTPUT" > "$CLAUDE_OUTPUT_FILE"
rm -f "$ANSWER_FILE"

echo "=== Claude processed the answer ===" >&2

$LOOPX_BIN output --goto "check-question"
