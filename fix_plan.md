# Implementation Plan for loopx

**Status: ADR-0002 Test Migration In Progress**

ADR-0002 ("Introduce `run` Subcommand and Remove Default Script") has been accepted. SPEC.md and TEST-SPEC.md have been updated. Tests must now be migrated to match the new spec.

## ADR-0002 Test Migration Tasks

### Phase A: CLI Syntax Migration (add `run` subcommand to all CLI invocations)
Every test that invokes `loopx` to run a script needs `run` inserted as the first argument.
Affected files:
- [x] tests/e2e/cli-basics.test.ts — ~22 tests need `run` added + 9 removed + 65 new tests
- [x] tests/e2e/discovery.test.ts — all script execution calls need `run`
- [x] tests/e2e/execution.test.ts — all script execution calls need `run`
- [x] tests/e2e/output-parsing.test.ts — no changes needed - uses runAPIDriver only
- [x] tests/e2e/loop-state.test.ts — all script execution calls need `run`
- [x] tests/e2e/env-vars.test.ts — all script execution calls need `run`
- [x] tests/e2e/module-resolution.test.ts — all script execution calls need `run`
- [x] tests/e2e/programmatic-api.test.ts — no changes needed - uses API driver
- [x] tests/e2e/install.test.ts — install + run verification calls need `run`
- [x] tests/e2e/signals.test.ts — signal tests need `run`
- [x] tests/e2e/delegation.test.ts — delegation tests need `run`
- [x] tests/e2e/subcommands.test.ts — no changes needed - all subcommand calls
- [x] tests/e2e/exit-codes.test.ts — exit code tests need `run` + new tests T-EXIT-14/15/16
- [x] tests/e2e/edge-cases.test.ts — edge case tests need `run`

### Phase B: cli-basics.test.ts Semantic Changes
- [x] Remove T-CLI-07 (reserved names in help — concept eliminated)
- [x] Remove T-CLI-07a (script listing in top-level help — moved to run help)
- [x] Remove T-CLI-07d (invalid name warning in top-level help — moved to run help)
- [x] Remove T-CLI-07h (bad package.json warning in top-level help — moved to run help)
- [x] Remove T-CLI-07i (escaping main warning in top-level help — moved to run help)
- [x] Remove T-CLI-08 (default script invocation — concept eliminated)
- [x] Remove T-CLI-09 (no default script fallback — concept eliminated)
- [x] Remove T-CLI-10 (.loopx/ missing for bare invocation — changed to show help)
- [x] Remove T-CLI-22c (reserved name with -n 0 — concept eliminated)
- [x] Update T-CLI-02 (add subcommand listing assertions, negative assertions for old syntax)
- [x] Update T-CLI-03 (run in fixture with collision + invalid dir script, compare -h vs --help)
- [x] Update T-CLI-04 (INVERT: assert scripts NOT listed in top-level help)
- [x] Update T-CLI-05 (add no-warnings assertion)
- [x] Update T-CLI-06 (INVERT: assert NO collision warnings on stderr)
- [x] Update T-CLI-07b (CHANGE: now a usage error, exit 1, not help display)
- [x] Update T-CLI-07c (CHANGE: now a usage error, exit 1, not help display)
- [x] Update T-CLI-11 (use `run` syntax, test stop:true self-termination)
- [x] Update T-CLI-12 (use `run nonexistent`)
- [x] Update T-CLI-13 (use `run -n 1 default`)
- [x] Update T-CLI-19 (use `run -n 0 nonexistent` with explicit script name)
- [x] Update T-CLI-19a (use `run -n 0 myscript` with .loopx/ missing)
- [x] Update T-CLI-22b (use `run -n 0 myscript` with name collision)
- [x] Update T-CLI-22d (use `run -n 0 myscript` with invalid script name)
- [x] Update T-CLI-27 (use `run script1 script2`)

### Phase C: New Tests in cli-basics.test.ts (65 tests)
- [x] T-CLI-28: bare `loopx` shows top-level help
- [x] T-CLI-29: `loopx run` no script name → exit 1
- [x] T-CLI-30: `loopx run -n 1 myscript` runs script (marker file)
- [x] T-CLI-31: `loopx run -n 1 version` runs script not built-in
- [x] T-CLI-32: `loopx run -n 1 run` runs script named "run"
- [x] T-CLI-33: `loopx myscript` is usage error + marker file
- [x] T-CLI-34: `loopx --unknown` is usage error
- [x] T-CLI-35: `loopx run --unknown myscript` exits 1
- [x] T-CLI-36: `loopx -n 5 myscript` is usage error
- [x] T-CLI-37: `loopx -e .env myscript` is usage error
- [x] T-CLI-38: `loopx foo -h` is usage error
- [x] T-CLI-39 through T-CLI-100: See TEST-SPEC.md section 4.1
  - Run help tests (T-CLI-40–47, T-CLI-55–55d, T-CLI-62)
  - Run help short-circuit (T-CLI-48–54, T-CLI-63, T-CLI-67–70, T-CLI-92–95)
  - Late-help short-circuit (T-CLI-73–78, T-CLI-84)
  - Option order (T-CLI-57, T-CLI-58, T-CLI-83)
  - Unrecognized run flags (T-CLI-72, T-CLI-86–89)
  - Missing flag operands (T-CLI-97–100)
  - Script/subcommand disambiguation (T-CLI-64–66, T-CLI-80–82, T-CLI-85)
  - Top-level help variants (T-CLI-39, T-CLI-61, T-CLI-71, T-CLI-79, T-CLI-90, T-CLI-91)

### Phase D: Other Test File Updates
- [x] discovery.test.ts — update for removed reserved names, add T-DISC-22–26, T-DISC-51–53
- [ ] subcommands.test.ts — verify no reserved name tests remain
- [x] exit-codes.test.ts — add T-EXIT-14, T-EXIT-15, T-EXIT-16
- [ ] All remaining test files — add `run` to CLI invocations

### Phase E: Verification
- [ ] Build and run full test suite
- [ ] Verify tests that should pass (given implementation not yet updated for ADR-0002) do pass
- [ ] Verify tests that should fail (testing new ADR-0002 behavior) do fail
- [ ] Advance ADR-0002 status to "Tested"
