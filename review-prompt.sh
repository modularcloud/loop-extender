#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SPEC="$SCRIPT_DIR/SPEC.md"
TEST_SPEC="$SCRIPT_DIR/TEST-SPEC.md"
SPEC_PROBLEMS="$SCRIPT_DIR/SPEC-PROBLEMS.md"

if [[ ! -f "$SPEC" ]]; then
  echo "Error: SPEC.md not found" >&2
  exit 1
fi

if [[ ! -f "$TEST_SPEC" ]]; then
  echo "Error: TEST-SPEC.md not found" >&2
  exit 1
fi

if [[ -f "$SPEC_PROBLEMS" ]]; then
  SPEC_PROBLEMS_CONTENT="$(cat "$SPEC_PROBLEMS")"
else
  SPEC_PROBLEMS_CONTENT="No known spec problems have been identified so far."
fi

cat <<PROMPT | pbcopy
Review SPEC.md and TEST-SPEC.md holistically and let me know if I can start implementing the tests or if I need to modify the test spec. My goal is to be able to comprehensively tests all requirements in the signing spec prior to implementation. Additionally, if there are any known problems in the spec that need to be resolved, they will be included in SPEC-PROBLEMS.md (we want to holistically think about how to resolve these problems too - our primary goal is to get the prepare the plan for tests, however, it is not possible to do so if there is a critical problem in the underlying spec). Be careful when suggesting changes to SPEC.md, ask me clarifying questions to be sure to capture my intent.

SPEC.md:
$(cat "$SPEC")

TEST-SPEC.md:
$(cat "$TEST_SPEC")

SPEC-PROBLEMS.md:
$SPEC_PROBLEMS_CONTENT
PROMPT

echo "Prompt copied to clipboard."
