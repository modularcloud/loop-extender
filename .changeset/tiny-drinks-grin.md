---
"loop-extender": patch
---

Forward SIGINT / SIGTERM to the active `npm install` child during `loopx install`'s post-commit auto-install pass (SPEC §10.10). The CLI signal handlers now propagate to the child's process group with a 5-second SIGKILL escalation, abort the auto-install pass without running further `.gitignore` synthesis or `npm install` invocations, suppress the aggregate failure report when terminated by a signal, and exit with `128 + signal-number` (e.g. 130 for SIGINT, 143 for SIGTERM).
