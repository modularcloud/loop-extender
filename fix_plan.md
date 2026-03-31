# Test Harness Fix Plan

Tracks active issues and recent fix batches for the test harness (not the loopx product).

---

## Active Issues

1. **~155 E2E tests pass coincidentally** — Tests that only assert `exitCode === 1` pass because the binary-not-found error also returns exit 1. Expected per TEST-SPEC §3.2 (stub allowlist). These tests will work correctly once loopx is implemented. No action needed beyond documenting the allowlist.

---

## Known Minor Deviations (documented, not actionable)

- T-CLI-08 uses .sh instead of .ts for default script — counter fixture is bash-specific, functionally equivalent.
- T-SIG-04 uses 1-second delay instead of 2-second — functionally equivalent.
- T-LOOP-23 tests stderr pass-through but writeStderr fixture exits 0; spec says "on failure".
- T-INST-31a is an extra test (HTTP 500) not in spec but useful.
- T-DEL-02, T-DEL-03, T-DEL-06 manually construct fixtures instead of using withDelegationSetup (needed for non-standard directory layouts).
- T-EDGE-05 split into T-EDGE-05a/b/c sub-tests; T-EDGE-12 split into T-EDGE-12a/12b — all spec aspects covered.
- T-API-20j/k/l are extra tests not in spec (renamed from old IDs).
- T-ENV-25/25a use a single counter-based script instead of spec's suggestion of "a different script" for iteration 2 — functionally equivalent.

---

## Recent Fixes (2026-03-31, batch 2)

### Vitest config fix
- **vitest.config.ts**: Excluded `tests/e2e/signals.test.ts` from the `e2e` project to prevent signals tests from running twice (once in `e2e` with 30s timeout, once in `signals` with 60s timeout and serial execution).

### T-ENV-15 test input corrected
- **env-vars.test.ts**: T-ENV-15 now uses spec-exact input `KEY = value\n` (key with trailing space before `=`) instead of `BAD KEY =value\n`. Also added explicit assertion that `KEY` is NOT set.

### Missing stderr assertions added
- **env-vars.test.ts**: T-ENV-05a, T-ENV-05c, T-ENV-05d, T-ENV-05e now assert stderr contains an error message about the unreadable file (spec requires "exits with code 1 and an error message").
- **edge-cases.test.ts**: T-EDGE-12b now asserts stderr is non-empty (script not found error).

### T-EDGE-11 strengthened
- **edge-cases.test.ts**: T-EDGE-11 now runs 4 iterations before stopping (was 1). Uses a counter script that stops on the 4th iteration, better exercising the large `-n` value with actual iteration counting.

### Comment fix
- **edge-cases.test.ts**: T-EDGE-05b comment corrected — was incorrectly describing decomposed form (`cafe\u0301`) when the code uses precomposed form (`caf\u00e9`).

---

## Recent Fixes (2026-03-31, batch 1)

### Test ID realignment

- **programmatic-api.test.ts**: Realigned T-API-20 series test IDs to match spec (T-API-20 -> T-API-20a, T-API-20a -> T-API-20c, etc.). Added missing T-API-20g and T-API-20i tests per spec. Renamed extra tests to T-API-20j/k/l.
- **programmatic-api.test.ts**: Realigned T-API-22 through T-API-24b maxIterations validation IDs to match spec (T-API-22a -> T-API-23, T-API-22b -> T-API-23a, T-API-23 -> T-API-24a, T-API-23a -> T-API-24b, T-API-24b -> T-API-24).

### Assertion and coverage fixes

- **cli-basics.test.ts**: T-CLI-09 now asserts stderr suggests script creation (added `/create|\.loopx/` pattern match).
- **module-resolution.test.ts**: T-MOD-19/20/21 now use `withDelegationSetup` instead of `runCLI`, per spec requirement for LOOPX_BIN realpath testing.
- **edge-cases.test.ts**: Added T-EDGE-05c sub-test for unicode in env values preservation (was only testing unicode in result values and script names).

---

## Previously Resolved

- **Delegation tests** — Restructured to use the real loopx binary via `withDelegationSetup`. Fixed `runGlobal()` to spawn the actual global binary. All 8 delegation tests now correctly fail without the loopx implementation.
- **Types tests** — Added `not.toBeAny()` guards. Configured vitest typecheck project with `typecheck.include`. Added `ignoreSourceErrors: true`. All 7 type tests now correctly fail in typecheck mode without the loopx package.

---

## Implementation Notes

- **No product code** — this plan covers only the test harness.
- **Internal seams** — unit and fuzz tests depend on `parseOutput`, `parseEnvFile`, and `classifySource` being importable from `loopx/internal`.
- **Self-cleaning** — all helpers clean up temp dirs, servers, env mutations via afterEach hooks or explicit cleanup.
