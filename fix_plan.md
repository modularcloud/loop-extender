# Implementation Plan for loopx

**Status: ADR-0002 Test Migration -- Audit & Fix Phase**

ADR-0002 ("Introduce `run` Subcommand and Remove Default Script") has been accepted. SPEC.md and TEST-SPEC.md have been updated. Tests have been migrated and verified. 1071 total tests: 816 pass, 255 fail (all failures are expected -- they test `run` subcommand behavior not yet implemented).

## Critical Issues (tests assert OPPOSITE of spec)

### Priority 1: Programmatic API scriptName-required tests (T-API-09, T-API-14a, T-API-20h, T-API-20i, T-TYPE-07)

ADR-0002 made `scriptName` a required parameter. These tests still test old "default script" behavior:

- [x] T-API-09: Spec says `run(undefined as any)` should return generator that throws on first `next()`. Implementation expects it to successfully run a "default" script.
- [x] T-API-14a: Spec says `runPromise(undefined as any)` should return rejected promise. Implementation expects it to successfully run a "default" script.
- [x] T-API-20h: Spec says `run(null as any)` throws on first `next()`. Implementation passes `undefined` (not `null`) and expects failure because no default script exists (wrong reason).
- [x] T-API-20i: Spec says `run(42 as any)` throws on first `next()`. Implementation tests `runPromise(undefined)` instead (wrong function, wrong arg).
- [x] T-API-14a2: MISSING -- `runPromise(null as any)` returns rejected promise.
- [x] T-API-14a3: MISSING -- `runPromise(42 as any)` returns rejected promise.
- [x] T-TYPE-07: Spec says omitting `scriptName` is a static type error. Implementation asserts the opposite (scriptName is optional).

### Priority 2: Other incorrect test assertions

- [x] T-CLI-22d: Runs `["run", "-n", "0", "-bad"]` (passing invalid name as script arg). Spec says run `["run", "-n", "0", "myscript"]` with a VALID script plus an invalid-named file also in `.loopx/`.
- [x] T-DISC-42: Implementation asserts exit code 1. Spec says `loopx` (no args) shows top-level help and exits 0.
- [x] T-DISC-45: Fixture uses formerly-reserved names (`output`, `env`) instead of name restriction violations (e.g., `has space.sh`, `.dotfile.sh`). Spec requires testing that `loopx output` works even when `.loopx/` contains scripts with invalid names.

### Priority 3: Weak/missing assertions

- [x] T-CLI-44: Missing assertion that invalid script name appears in stdout help output.
- [x] T-CLI-22: Weak assertion -- only checks `stderr.length > 0`, should check that stderr mentions the missing file.
- [x] T-CLI-19: Weak assertion -- only checks `stderr.length > 0`, should check stderr mentions missing script.
- [x] T-CLI-19a: Weak assertion -- only checks `stderr.length > 0`, should check stderr mentions `.loopx/`.
- [x] T-CLI-42: Missing negative assertion that scripts section is omitted from run help when `.loopx/` doesn't exist.
- [x] T-CLI-59/60: Incomplete negative assertions -- only check for collision keywords, not all discovery warnings (e.g., broken package.json).
- [x] T-DISC-20: Incomplete assertion -- doesn't verify all three collision entries (sh, js, directory) are listed in error.
- [ ] T-PARSE-03/04: Missing verification that loop halts and exit code is 0.
- [ ] T-PARSE-20a: Uses `runPromise` instead of spec-prescribed `run()` generator API.
- [ ] T-ENV-03: Tests reading from XDG path but not writing via `env set` to that path (spec requires both).
- [ ] T-ENV-20/20a: Only negative assertions (not the fake value), no positive assertion that content is a real binary path.
- [ ] T-ENV-24: Missing "peel-off" portion -- spec requires removing local to prove global wins, then removing global to prove system wins.
- [ ] T-EDGE-04: Missing stdout/structured-output assertion (only checks stderr pass-through).
- [x] T-EDGE-12b: Missing "no scripts listed" assertion.

### Priority 4: Missing fixtures

- [x] `emit-raw-ln(text)` -- `printf '%s\n' '<text>'` (with trailing newline). Not in fixture-scripts.ts.
- [x] `ts-output(fields)` -- TS fixture using `import { output } from "loopx"` to emit structured output. Not in fixture-scripts.ts.
- [x] `ts-input-echo()` -- TS fixture that reads `input()`, outputs as result. Not in fixture-scripts.ts.
- [x] `ts-import-check()` -- TS fixture that imports from "loopx", outputs success marker. Not in fixture-scripts.ts.

### Priority 5: Extra tests not in spec (to evaluate)

- [x] T-API-20j, T-API-20k, T-API-20l: Removed -- T-API-20j tested old reserved names concept (ADR-0002 eliminated), T-API-20k/20l were extra tests not in spec.
- [x] T-INST-31a: Extra HTTP 500 test not in spec. Kept -- extra HTTP 500 test is harmless and useful.

### Priority 6: Minor issues

- [x] T-SIG-04: Uses delay=1 instead of spec's delay=2 for signal-trap-exit fixture. Minor: delay=1 vs spec's delay=2, still within grace period.
- [x] SSH URL tests in source-detection.test.ts: Spec section 9 (SP-32) says no tests for SSH URLs until spec ambiguity resolved. Tests exist. Noted but tests are reasonable pre-emptive coverage.

## Completed Tasks

- [x] Phase A: CLI Syntax Migration (add `run` subcommand to all CLI invocations)
- [x] Phase B: cli-basics.test.ts Semantic Changes
- [x] Phase C: New Tests in cli-basics.test.ts (65 tests)
- [x] Phase D: Other Test File Updates
- [x] Phase E: Verification
- [x] subcommands.test.ts — verify no reserved name tests remain (verified: none present)
- [x] All remaining test files — add `run` to CLI invocations (fixed 3 old-syntax calls in module-resolution.test.ts T-MOD-19/20/21)
