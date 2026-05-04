---
"loop-extender": patch
---

SPEC §7.2 first-observed-wins on the CLI surface: when a script exits non-zero and a SIGINT/SIGTERM arrives during the post-observation window before loopx dispatches the iteration error, the iteration outcome (`Error: Script '...' exited with code N` + exit 1) is the surfaced terminal outcome — the late signal does NOT shift the exit code to 130/143.

Previously, the CLI catch block surfaced the most recently received signal's exit code regardless of whether an iteration error had already been observed first. This aligned the CLI with the API surfaces (`run()` / `runPromise()`), which already honored first-observed-wins via the shared `firstObservedRef` slot. Behavior in the inverse direction is unchanged: when a signal is observed first (even mid-iteration or during cleanup), exit with the signal's code (130 SIGINT / 143 SIGTERM). T-SIG-04 / T-SIG-07 / T-TMP-38 / T-TMP-38f all preserved.
