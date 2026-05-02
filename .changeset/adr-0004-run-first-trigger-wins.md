---
"loop-extender": patch
---

`run()` / `runPromise()` consumer-cancellation methods (`.return()`, `.throw()`, `[Symbol.asyncDispose]`) now honor SPEC §7.2 first-observed-wins for the abort-vs-consumer-cancellation race. When the run's `AbortSignal` is already aborted at the time `.return()` / `.throw()` is called, the in-flight iteration's abort error surfaces to the consumer (via the for-await loop or `gen.next()` rejection) instead of being silenced by the consumer-cancellation contract. When `.return()` / `.throw()` is observed first (no prior abort), the previous silent-clean-completion behavior is preserved.

This affects the rare case where an external abort and a consumer cancellation race for the same run; everyday `.return()` / `.throw()` cancellation flows are unchanged. SPEC §9.3 post-final-yield-abort handling is also unchanged.
