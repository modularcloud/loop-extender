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

RESOLVED=$("$SHARED_DIR/resolve-adr.sh")
IFS=$'\t' read -r ADR_NUM ADR_FILE <<< "$RESOLVED"
ADR_REL="adr/$(basename "$ADR_FILE")"

PROMPT="I received the following feedback about ADR-$ADR_NUM ($ADR_REL) and its relationship to SPEC.md as defined by the process laid out in ADR-0001. Incorporate this feedback to improve ADR-$ADR_NUM. Use your judgement on the best implementation details to achieve the product goals; if there is any ambiguity about my intentions, ask me clarifying questions from a product perspective rather than an implementation perspective. Think critically about this feedback and push back if warranted. Don't include migration details for existing users. Only include what is necessary to thoroughly update SPEC.md — keep additional information (such as testing considerations) to a minimum, because the primary purpose of this ADR is to be used to update SPEC.md. Do not update any file other than ADR-$ADR_NUM and do not mark it as accepted. After you finish, commit and push.

Feedback:
$FEEDBACK"

SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
echo "$SESSION_ID" > "$SESSION_FILE"

CLAUDE_OUTPUT=$(echo "$PROMPT" | claude --dangerously-skip-permissions --session-id "$SESSION_ID" -p 2>/dev/null)

rm -f "$FEEDBACK_FILE"
echo "$CLAUDE_OUTPUT" > "$CLAUDE_OUTPUT_FILE"

echo "" >&2
echo "=== Claude finished applying feedback ===" >&2

$LOOPX_BIN output --goto "shared:check-question"
