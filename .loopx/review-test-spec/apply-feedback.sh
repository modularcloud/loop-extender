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

RESOLVED=$("$SHARED_DIR/resolve-adr.sh")
IFS=$'\t' read -r ADR_NUM ADR_FILE <<< "$RESOLVED"

FEEDBACK=$(cat "$FEEDBACK_FILE")

PROMPT="I received the following feedback on TEST-SPEC.md with respect to SPEC.md. Apply this feedback by updating TEST-SPEC.md. SPEC.md is the authoritative source for what TEST-SPEC.md should cover.

This review and any feedback you apply is scoped to ADR-$ADR_NUM. You are allowed to modify SPEC.md only when the feedback proposes a specific SPEC change that resolves a SPEC-PROBLEMS.md entry scoped to ADR-$ADR_NUM, and you MUST verify any proposed SPEC.md edits with me before applying them — show me the exact diff and wait for explicit approval. Do **not** apply SPEC.md changes that are unrelated to ADR-$ADR_NUM, even if the feedback proposes them — push back and explain that those changes are out of scope for this cycle. If you find a problem in the spec (an ambiguity, gap, or under-specified clause that prevents TEST-SPEC.md from covering the behavior cleanly) and that problem is scoped to ADR-$ADR_NUM, add it to SPEC-PROBLEMS.md so we can work to resolve it in a follow-up cycle; do not record problems unrelated to ADR-$ADR_NUM. If there are no remaining problems in the spec scoped to ADR-$ADR_NUM, delete SPEC-PROBLEMS.md. If there is any ambiguity about my intentions, ask me clarifying questions. When you ask questions, ask only one at a time and wait for my answer before asking the next — do not batch multiple questions together. I have not read the feedback, I only pasted it in, so phrase each question to stand on its own: include the relevant context or quote from the feedback so I can answer without having to go read it. Think critically about this feedback and push back if warranted. After you finish, commit and push.

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
