---
"loop-extender": patch
---

CLI now honors SPEC §7.3 pre-iteration signal-wins precedence: SIGINT/SIGTERM observed by loopx during the pre-iteration window (target validation, `.loopx/` discovery, env-file loading, target resolution, tmpdir creation) wins over any non-signal pre-iteration failure that would otherwise have surfaced. loopx exits with `128 + N` and suppresses the displaced failure error rather than printing it as the fatal-exit reason.

Previously, signal handlers were installed only after all pre-iteration steps completed, so a SIGINT delivered during pre-iteration would either be uncaught (default POSIX termination) or, if it raced past pre-iteration, lose the precedence contest with the failure. Now SIGINT/SIGTERM during a missing env file, missing workflow, invalid target, missing script, missing default `index`, missing `.loopx/`, or tmpdir creation failure all surface the signal exit code (130 / 143) per spec.
