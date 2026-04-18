#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
FEEDBACK_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.feedback.tmp"
CLAUDE_OUTPUT_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.claude-output.tmp"

if [[ ! -f "$FEEDBACK_FILE" ]]; then
  echo "Error: No feedback file found at $FEEDBACK_FILE" >&2
  exit 1
fi

FEEDBACK=$(cat "$FEEDBACK_FILE")

PROMPT="I received the following feedback about ADR-0002 (run subcommand proposal) and its relationship to SPEC.md as defined by the the process laid out in ADR-0001. Incorporate this feedback to improve ADR-0002. If there is any ambiguity about my intentions, ask me clarifying questions. Think critically about this feedback and push back if warranted. Do not update any file other than ADR-0002 and do not mark it as accepted. After you finish, commit and push.

Feedback:
$FEEDBACK"

CLAUDE_OUTPUT=$(echo "$PROMPT" | claude --dangerously-skip-permissions -p 2>/dev/null)

rm -f "$FEEDBACK_FILE"
echo "$CLAUDE_OUTPUT" > "$CLAUDE_OUTPUT_FILE"

echo "" >&2
echo "=== Claude finished applying feedback ===" >&2

$LOOPX_BIN output --goto "check-question"
