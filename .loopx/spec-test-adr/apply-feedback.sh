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

PROMPT="ADR-$ADR_NUM ($ADR_REL) has been accepted and SPEC.md has already been updated to incorporate its changes (per the ADR process in adr/0001-adr-process.md). I am now updating TEST-SPEC.md to cover the new and changed spec behavior introduced by ADR-$ADR_NUM. I received the following feedback on the current state of TEST-SPEC.md. Apply this feedback by updating TEST-SPEC.md only — do not modify SPEC.md or ADR-$ADR_NUM, they are read-only references in this cycle. ADR-$ADR_NUM and the updated SPEC.md are the authoritative sources for what TEST-SPEC.md should cover. If there is any ambiguity about my intentions, ask me clarifying questions. When you ask questions, ask only one at a time and wait for my answer before asking the next — do not batch multiple questions together. I have not read the feedback, I only pasted it in, so phrase each question to stand on its own: include the relevant context or quote from the feedback so I can answer without having to go read it. Think critically about this feedback and push back if warranted. After you finish, commit and push.

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
