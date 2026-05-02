---
"loop-extender": minor
---

ADR-0004: scripts now run with `LOOPX_PROJECT_ROOT` as their working directory (not the workflow directory), and a new `LOOPX_WORKFLOW_DIR` protocol-injected env variable exposes the workflow directory.

This is the foundational ADR-0004 §6.1 change. Previously, every spawned script's cwd was the workflow directory (e.g., `.loopx/ralph/`). Per SPEC §6.1, that contract is now project-root-unified — every script (starting target, intra- and cross-workflow `goto`, loop reset) spawns with cwd = `LOOPX_PROJECT_ROOT`. Scripts that need the workflow directory should read `LOOPX_WORKFLOW_DIR`, which is injected into every spawn's environment alongside `LOOPX_BIN`, `LOOPX_PROJECT_ROOT`, and `LOOPX_WORKFLOW`. Bash scripts can rely on the normative `dirname "$0" == LOOPX_WORKFLOW_DIR` equality (SPEC §6.2).

**Migration:** any workflow script that did `cat ./helper.sh` (relying on cwd = workflow dir) must use `cat "$LOOPX_WORKFLOW_DIR/helper.sh"` instead.
