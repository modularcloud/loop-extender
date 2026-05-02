---
"loop-extender": patch
---

CLI signal handler now honors SPEC §7.2 first-observed-wins: when a second signal arrives after the first (e.g., SIGTERM during cleanup of a prior SIGINT), the surfaced exit code stays anchored at the first signal's `128 + N` value rather than being overwritten by the second. Previously a SIGTERM during the cleanup of a SIGINT-driven termination would shift the exit code from 130 to 143; now it correctly stays at 130.

This affects the rare case where two close-together signals reach loopx during a single run; everyday SIGINT/SIGTERM handling is unchanged.
