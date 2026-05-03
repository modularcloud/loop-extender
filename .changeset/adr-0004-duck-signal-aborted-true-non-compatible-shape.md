---
"loop-extender": patch
---

ADR-0004 §9.3 / §9.5: a duck-typed `options.signal` whose `addEventListener` registration throws is now correctly surfaced as an option-snapshot error, even when the signal also reports `aborted: true`.

Previously, `runWithInternal` short-circuited on `snap.signal.aborted === true` and skipped the `addEventListener` registration entirely — meaning a duck signal of the form `{ aborted: true, addEventListener() { throw } }` would route through the abort-precedence pathway and surface an `AbortError`, mis-categorizing the contract violation as an abort outcome.

Two coupled changes restore SPEC §9.3 / §9.5 conformance:

- Always invoke `signal.addEventListener("abort", listener, { once: true })` at call-site capture, regardless of `aborted` value, so the registration-throws case is detected. This honors SPEC §9.5's "must be callable and returns without throwing when loopx invokes it" wording — loopx must invoke `addEventListener` to verify the contract, and per the `aborted: true` × non-compatible-shape carve-out, that verification must happen even when `aborted: true`.
- When registration throws, clear the captured `snap.signal` so the downstream abort-precedence check in `runInternal` does not mistake `aborted: true` on a non-compatible signal as grounds to surface an abort error. The captured `snap.error` then surfaces as an ordinary option-snapshot error via the standard pre-iteration error path.

Behavior for valid duck signals is unchanged: the `addEventListener` is now invoked unconditionally during snapshot capture (instead of only when `aborted: false`), but real `AbortSignal` instances and well-formed duck signals do not observe a difference because `addEventListener` succeeds and the `aborted: true` branch then enters the abort-precedence pathway as before.
