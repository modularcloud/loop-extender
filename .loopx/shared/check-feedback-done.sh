#!/bin/bash
set -euo pipefail

ROOT="$LOOPX_PROJECT_ROOT"
FEEDBACK_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.feedback.tmp"
SCHEMA="$ROOT/.loopx/$LOOPX_WORKFLOW/check-feedback-done.schema.json"
CALLER_FILE="$ROOT/.loopx/$LOOPX_WORKFLOW/.caller.tmp"

if [[ ! -f "$FEEDBACK_FILE" ]]; then
  echo "Error: No feedback file found at $FEEDBACK_FILE" >&2
  exit 1
fi

if [[ ! -f "$SCHEMA" ]]; then
  echo "Error: schema not found at $SCHEMA" >&2
  exit 1
fi

if [[ ! -f "$CALLER_FILE" ]]; then
  echo "Error: caller sentinel not found at $CALLER_FILE — shared workflow must be invoked via a variant's index.sh" >&2
  exit 1
fi

CALLER=$(cat "$CALLER_FILE")

FEEDBACK=$(cat "$FEEDBACK_FILE")

VERDICT=$(codex exec --output-schema "$SCHEMA" "I received this feedback for my specs. Is it requiring that I continue making improvements before calling this stage of feedback done? Ignore optional feedback. Return done=true only if the response says we can be done explicitly and/or there are no further non-optional pieces of feedback. Note: if it says 'make this important change and then you are done', that does NOT count as done — return done=false.

Feedback:
$FEEDBACK" 2>/dev/null)

DONE=$(echo "$VERDICT" | jq -r '.done')

if [[ "$DONE" == "true" ]]; then
  echo "=== Feedback indicates no further non-optional improvements — halting ===" >&2
  rm -f "$FEEDBACK_FILE" "$CALLER_FILE"
  $LOOPX_BIN output --result "Feedback indicates no further non-optional improvements. Halting." --stop
else
  echo "=== Feedback requires further improvements — applying ===" >&2
  $LOOPX_BIN output --goto "${CALLER}:apply-feedback"
fi
