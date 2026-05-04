---
"loop-extender": minor
---

ADR-0004 §9.5: `RunOptions.env` is now supported as tier-2 environment injection in the programmatic API.

The `run()` and `runPromise()` options object now accepts an optional `env: Record<string, string>` field. Entries are snapshotted synchronously at call time (signal first per SPEC §9.1, then the remaining recognized fields), validated for shape (non-null/non-array/non-function object whose own enumerable string-keyed entries all have string values), and merged into the spawned script's environment at tier 2 — overriding values from `-e`/`envFile`, the global env file, and inherited `process.env`, but overridden by loopx-injected protocol variables (`LOOPX_BIN`, `LOOPX_PROJECT_ROOT`, `LOOPX_WORKFLOW`, `LOOPX_WORKFLOW_DIR`, `LOOPX_TMPDIR`).

The change also tightens option-snapshot semantics for all recognized fields: throwing getters and Proxy traps on `options.env`, `options.signal`, `options.cwd`, `options.envFile`, and `options.maxIterations` are now captured at the call site and surfaced via the standard pre-iteration error path on first `next()` (or as promise rejection from `runPromise`). The pre-first-`.return()` consumer-cancellation carve-out for `run()` continues to suppress these captured errors. SPEC §9.3 abort precedence is preserved: an already-aborted signal at call time displaces all other pre-iteration failures.
