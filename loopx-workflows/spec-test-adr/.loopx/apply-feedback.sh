#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
FEEDBACK_FILE="$ROOT/.loopx/.feedback.tmp"
CLAUDE_OUTPUT_FILE="$ROOT/.loopx/.claude-output.tmp"

if [[ ! -f "$FEEDBACK_FILE" ]]; then
  echo "Error: No feedback file found at $FEEDBACK_FILE" >&2
  exit 1
fi

FEEDBACK=$(cat "$FEEDBACK_FILE")

PROMPT="ADR-0003 has been accepted and SPEC.md has already been updated to incorporate its changes (per the ADR process in ADR-0001). I am now updating TEST-SPEC.md to cover the new and changed spec behavior introduced by ADR-0003. I received the following feedback on the current state of TEST-SPEC.md. Apply this feedback by updating TEST-SPEC.md only — do not modify SPEC.md or ADR-0003, they are read-only references in this cycle. ADR-0003 and the updated SPEC.md are the authoritative sources for what TEST-SPEC.md should cover. If there is any ambiguity about my intentions, ask me clarifying questions. Think critically about this feedback and push back if warranted. After you finish, commit and push.

Reference files (read these yourself — do not modify):
- adr/0003-workflows.md
- SPEC.md

Target file (apply feedback here):
- TEST-SPEC.md

Feedback:
$FEEDBACK"

CLAUDE_OUTPUT=$(echo "$PROMPT" | claude --dangerously-skip-permissions -p 2>/dev/null)

rm -f "$FEEDBACK_FILE"
echo "$CLAUDE_OUTPUT" > "$CLAUDE_OUTPUT_FILE"

echo "" >&2
echo "=== Claude finished applying feedback ===" >&2

$LOOPX_BIN output --goto "check-question"
