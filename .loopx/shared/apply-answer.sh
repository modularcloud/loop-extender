#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
CLAUDE_OUTPUT_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.claude-output.tmp"
ANSWER_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.answer.tmp"
SESSION_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.session.tmp"
CALLER_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.caller.tmp"

if [[ ! -f "$ANSWER_FILE" ]]; then
  echo "Error: No answer file found at $ANSWER_FILE" >&2
  exit 1
fi

if [[ ! -f "$SESSION_FILE" ]]; then
  echo "Error: No session file found at $SESSION_FILE — apply-feedback must run first" >&2
  exit 1
fi

if [[ ! -f "$CALLER_FILE" ]]; then
  echo "Error: No caller file found at $CALLER_FILE" >&2
  exit 1
fi

ANSWER=$(cat "$ANSWER_FILE")
SESSION_ID=$(cat "$SESSION_FILE")
CALLER=$(cat "$CALLER_FILE")
CALLER_DIR="$ROOT/.loopx/$CALLER"

# Resume the session started by the caller's apply-feedback. Claude Code
# stores session files per-cwd, so we must cd into the caller's workflow
# directory before --resume can locate the session.
CLAUDE_OUTPUT=$(cd "$CALLER_DIR" && echo "$ANSWER" | claude --effort max --dangerously-skip-permissions --resume "$SESSION_ID" -p 2>/dev/null)

echo "$CLAUDE_OUTPUT" > "$CLAUDE_OUTPUT_FILE"
rm -f "$ANSWER_FILE"

echo "=== Claude processed the answer ===" >&2

$LOOPX_BIN output --goto "check-question"
