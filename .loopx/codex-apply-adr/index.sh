#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
ADR_0001="$ROOT/adr/0001-adr-process.md"
ADR_0002="$ROOT/adr/0002-run-subcommand.md"
SPEC="$ROOT/SPEC.md"
FEEDBACK_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.feedback.tmp"
PROMPT_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.prompt.tmp"

if ! command -v codex >/dev/null 2>&1; then
  echo "Error: codex CLI not found on PATH" >&2
  exit 1
fi

if [[ ! -f "$ADR_0001" ]]; then
  echo "Error: adr/0001-adr-process.md not found" >&2
  exit 1
fi

if [[ ! -f "$ADR_0002" ]]; then
  echo "Error: adr/0002-run-subcommand.md not found" >&2
  exit 1
fi

if [[ ! -f "$SPEC" ]]; then
  echo "Error: SPEC.md not found" >&2
  exit 1
fi

# Build the prompt and save to file
cat <<PROMPT > "$PROMPT_FILE"
ADR 0002 has been accepted. The next step in the process is to update SPEC.md to incorporate the changes described in ADR 0002. Review the current SPEC.md against ADR 0002 and let me know if the SPEC updates look correct and complete, or if anything else in the SPEC needs to be changed.

adr/0002-run-subcommand.md (accepted — do not modify):
$(cat "$ADR_0002")

SPEC.md (target of updates):
$(cat "$SPEC")
PROMPT

echo "" >&2
echo "=== Prompt built — invoking codex CLI ===" >&2

rm -f "$FEEDBACK_FILE"

codex exec - \
  --skip-git-repo-check \
  --sandbox read-only \
  --color never \
  --output-last-message "$FEEDBACK_FILE" \
  < "$PROMPT_FILE" >/dev/null

rm -f "$PROMPT_FILE"

if [[ ! -s "$FEEDBACK_FILE" ]]; then
  echo "Error: codex produced no feedback" >&2
  exit 1
fi

echo "=== Feedback received from codex ===" >&2
echo "--- Begin feedback ---" >&2
cat "$FEEDBACK_FILE" >&2
echo "" >&2
echo "--- End feedback ---" >&2

$LOOPX_BIN output --goto "apply-feedback"
