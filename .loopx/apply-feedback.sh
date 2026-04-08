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

PROMPT="I received the following feedback about TEST-SIGNING-SPEC.md. Incorporate this feedback to improve the specs. If there is any ambiguity about my intentions, ask me clarifying questions. Think critically about this feedback and push back if warranted. If needed, we can work to resolve ambiguities in the core spec SIGNING-SPEC.md too but be sure to be conservative in this respect. Do not modify the core spec in the test spec document as the core spec is the source of truth for the implementation. Keep SIGNING-SPEC-PROBLEMS.md (if it exists) up to date by removing resolved problems and adding new ones that you find, if any. If there are no remaining known problems, delete SIGNING-SPEC-PROBLEMS.md. After you finish, commit and push.

Feedback:
$FEEDBACK"

CLAUDE_OUTPUT=$(echo "$PROMPT" | claude --dangerously-skip-permissions -p 2>/dev/null)

rm -f "$FEEDBACK_FILE"
echo "$CLAUDE_OUTPUT" > "$CLAUDE_OUTPUT_FILE"

echo "" >&2
echo "=== Claude finished applying feedback ===" >&2

$LOOPX_BIN output --goto "check-question"
