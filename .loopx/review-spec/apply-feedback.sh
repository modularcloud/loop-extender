#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
SHARED_DIR="$ROOT/.loopx/shared"
FEEDBACK_FILE="$SHARED_DIR/.feedback.tmp"
CLAUDE_OUTPUT_FILE="$SHARED_DIR/.claude-output.tmp"
SESSION_FILE="$SHARED_DIR/.session.tmp"

if [[ ! -f "$FEEDBACK_FILE" ]]; then
  echo "Error: No feedback file found at $FEEDBACK_FILE" >&2
  exit 1
fi

FEEDBACK=$(cat "$FEEDBACK_FILE")

PROMPT="I got this feedback from a review of @SPEC.md please incorporate this feedback. Use your judgement to make implementation decisions as long as they are aligned with my product vision. If there is any ambiguity about my intentions, ask me clarifying questions from a product perspective rather than an implementation perspective. When you ask questions, ask only one at a time and wait for my answer before asking the next — do not batch multiple questions together. I have not read the feedback, I only pasted it in, so phrase each question to stand on its own: include the relevant context or quote from the feedback so I can answer without having to go read it. Think critically and push back if needed. Only modify SPEC.md and after you are done, commit and push:

$FEEDBACK"

SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
echo "$SESSION_ID" > "$SESSION_FILE"

CLAUDE_OUTPUT=$(echo "$PROMPT" | claude --dangerously-skip-permissions --session-id "$SESSION_ID" -p 2>/dev/null)

rm -f "$FEEDBACK_FILE"
echo "$CLAUDE_OUTPUT" > "$CLAUDE_OUTPUT_FILE"

echo "" >&2
echo "=== Claude finished applying feedback ===" >&2

$LOOPX_BIN output --goto "shared:check-question"
