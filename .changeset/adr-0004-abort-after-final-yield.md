---
"loop-extender": patch
---

SPEC §9.3: `run()` now honors the abort-after-final-yield carve-out. An `AbortSignal` that aborts after the final `Output` has been yielded (via `stop: true` or `maxIterations` reached) but before the generator settles via `{ done: true }` now produces the abort error on the next generator interaction (`.next()`, `.return()`, or `.throw()`), with `LOOPX_TMPDIR` cleanup running before the abort error surfaces.

Previously, the wrapper returned by `run()` would silently complete in this window, ignoring the abort. The wrapper now tracks the post-final-yield state and dispatches abort cleanup-then-throw on the next consumer interaction. First-observed-wins precedence is preserved: a prior consumer `.return()` / `.throw()` retains its silent-completion outcome and is not displaced by a later abort. For `.throw(consumerErr)` in this window, the abort error displaces the consumer-supplied error (per SPEC §9.3).
