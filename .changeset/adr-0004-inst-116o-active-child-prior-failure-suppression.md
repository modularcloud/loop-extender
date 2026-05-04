---
"loop-extender": patch
---

SPEC §10.10 / §7.3: SIGINT/SIGTERM arriving during an active `npm install` child for a workflow processed AFTER a prior workflow's auto-install failure now correctly suppresses the not-yet-emitted aggregate failure report (resolving P-0004-05's active-child × prior-failure-suppression sentence).

Previously, the auto-install pause-seam dispatch for the `child-active-after-failure` window was declared but had no dispatch site — when SIGINT/SIGTERM arrived during the second-processed workflow's npm child window with a prior-workflow failure already recorded into the aggregate accumulator, the surfaced behavior was undefined relative to the SPEC contract.

The `runAutoInstall` spawn-and-wait flow in `install.ts` is now split across two awaits: spawn synchronously + register exit handlers, optionally pause for the `child-active-after-failure` seam (TEST-SPEC §1.4), then await the child-exit promise. When a signal arrives during the pause, the existing CLI signal handler forwards the signal to the child's process group, the child dies, the exit promise rejects with NPM_SIGNAL, the catch branch's signal-suppression guard suppresses the per-workflow failure entry, and the end-of-pass signal-suppression guard returns 0 BEFORE the aggregate report is emitted.

A noop `.catch(() => {})` is attached to the spawn-exit promise immediately after construction to suppress Node 25's fatal-unhandled-rejection behavior when the child exits during the seam pause (rejection lands before the await attaches its handler). The await still throws normally; only the fatal warning is suppressed.

Closes the LAST gap in the SPEC §10.10 / §7.3 T-INST-116 cluster — the entire signal × auto-install matrix (active-child × {no-prior-failure, prior-failure}, no-active-child × seven ordinal windows, SIGKILL escalation, process-group forwarding, multi-workflow no-further-processing) is now in place.
