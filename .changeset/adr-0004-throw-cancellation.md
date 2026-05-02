---
"loop-extender": patch
---

SPEC §9.1 / §7.4: `generator.throw()` on the `run()` async generator now matches the consumer-driven cancellation contract.

Previously `.throw()` delegated directly to the underlying generator, leaving the active child process group alive and propagating the consumer-supplied error through the promise chain. The wrapper now mirrors `.return()`:

1. Aborts the internal `AbortController`, which terminates the active child process group (SIGTERM, then SIGKILL after 5 seconds via SPEC §7.3 grace-period escalation).
2. Drives the generator to settlement via `gen.return(undefined)`, which triggers the `LOOPX_TMPDIR` cleanup `finally` block before settlement.
3. Resolves to `{ done: true, value: undefined }` — silent clean completion. The consumer-supplied error is not re-thrown.

This matches SPEC §9.1's "silent, clean completion" rule for consumer-driven cancellation when no child is active. For the active-child case, SPEC leaves the settlement form implementation-defined; we choose silent completion for symmetry with `.return()`.
