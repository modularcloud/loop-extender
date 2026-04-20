#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
SHARED_DIR="$ROOT/.loopx/shared"
FEEDBACK_FILE="$SHARED_DIR/.feedback.tmp"
CLAUDE_OUTPUT_FILE="$SHARED_DIR/.claude-output.tmp"

if [[ ! -f "$FEEDBACK_FILE" ]]; then
  echo "Error: No feedback file found at $FEEDBACK_FILE" >&2
  exit 1
fi

FEEDBACK=$(cat "$FEEDBACK_FILE")

ADR_0002=$(cat "$ROOT/adr/0002-run-subcommand.md")
SPEC=$(cat "$ROOT/SPEC.md")

PROMPT="ADR-0002 has been accepted and I am now updating SPEC.md to incorporate its changes (per the ADR process in ADR-0001). I received the following feedback on the current state of SPEC.md. Apply this feedback by updating SPEC.md only. ADR-0002 is the authoritative reference for what should change — do not modify it. If there is any ambiguity about my intentions, ask me clarifying questions. Think critically about this feedback and push back if warranted. After you finish, commit and push.

adr/0002-run-subcommand.md (accepted — read-only reference):
$ADR_0002

Current SPEC.md:
$SPEC

Feedback:
$FEEDBACK"

CLAUDE_OUTPUT=$(echo "$PROMPT" | claude --dangerously-skip-permissions -p 2>/dev/null)

rm -f "$FEEDBACK_FILE"
echo "$CLAUDE_OUTPUT" > "$CLAUDE_OUTPUT_FILE"

echo "" >&2
echo "=== Claude finished applying feedback ===" >&2

$LOOPX_BIN output --goto "shared:check-question"
