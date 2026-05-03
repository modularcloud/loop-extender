---
"loop-extender": patch
---

SPEC §9.1: implement the pre-first-`next()` consumer-cancellation carve-out for `run()`.

When the consumer cancels the iterator BEFORE invoking `.next()` for the first time — by calling `.return(value)`, `.throw(err)`, or via `await using` (Symbol.asyncDispose) — the wrapper now follows standard ES async-generator semantics: `.return(value)` settles with `{ value, done: true }`, `.throw(err)` rejects with the consumer-supplied error. The loop body is never entered, no pre-iteration step runs, no captured signal is consulted (even an already-aborted signal does not surface an abort error), and every captured pre-iteration error (option-snapshot, target validation, `.loopx/` discovery, env-file loading, target resolution, tmpdir creation, version-check warnings) is suppressed.

Previously, `.throw()` as a first interaction silently swallowed the consumer-supplied error by routing through `gen.return(undefined)`. The fix introduces a `bodyEntered` flag set inside `wrapper.next()` before awaiting the inner generator, so subsequent `.return()` / `.throw()` calls correctly distinguish pre-first-`next()` (carve-out) from post-first-`next()` (silent completion) cancellation.
