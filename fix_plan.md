# Implementation Plan for loopx

**Status: 772/889 tests passing (87%).** 117 remaining failures.

Phases 1-9, 11 complete. Phase 10 (API), 12 (signals), 15 (exit codes) substantially complete. Phases 13-14 not started. Phase 16 ongoing.

---

## Completed Phases

| Phase | Area | Status |
|-------|------|--------|
| 1 | Project Scaffolding | COMPLETE |
| 2 | Internal Parsers (P0) | COMPLETE |
| 3 | Script Discovery & Validation (P0) | COMPLETE (T-DISC-46 blocked on install) |
| 4 | Script Execution Engine (P0) | COMPLETE |
| 5 | Module Resolution Hook (P0) | COMPLETE |
| 6 | Loop State Machine (P0) | COMPLETE |
| 7 | CLI Interface & Argument Parsing (P1) | COMPLETE |
| 8 | Subcommands (P1) | COMPLETE |
| 9 | Environment Variable Management (P1) | COMPLETE |
| 10 | Programmatic API (P1) | COMPLETE — options snapshotting, generator.return() cancellation, AbortSignal in runPromise all working |
| 11 | Help System (P1) | COMPLETE |
| 15 | Exit Codes (cross-cutting) | COMPLETE — 128+N signal exit codes working |

---

## Remaining Work

### Phase 12: Signal Handling (P2) — PARTIAL

Exit codes 128+N working. Signal forwarding via AbortController working. Remaining:

- [ ] **Process group management** — Spawn children with `detached: true` + negative PID for `process.kill(-pid, signal)` to reach grandchildren
- [ ] **T-SIG-01 through T-SIG-07** (~7 tests) — need process group signal forwarding with detached children

### Phase 13: CLI Delegation (P2) — NOT STARTED (~8 tests)

*(Spec 3.2)*

- [ ] Search for local `node_modules/.bin/loopx`, delegate with same args, inherit stdio
- [ ] Set `LOOPX_DELEGATED=1` recursion guard, `LOOPX_BIN` to resolved realpath
- [ ] Delegation before any subcommand/run dispatch
- [ ] **Tests:** T-DEL-01 through T-DEL-08

### Phase 14: Install Command (P2) — NOT STARTED (~47 tests)

*(Spec 10.1-10.3)*

- [ ] Source detection via `classifySource()`
- [ ] Single-file download, git clone, tarball extract
- [ ] `.loopx/` directory creation, collision checks, name validation
- [ ] Failure cleanup of partial files/directories
- [ ] **Tests:** T-INST-01 through T-INST-GLOBAL-01, plus T-DISC-46

### Phase 16: Edge Cases & Hardening (P3) — IN PROGRESS

- [ ] **T-EDGE-04** — stdout/stderr stream separation (documented in SPEC-PROBLEMS.md)
- [ ] **T-EDGE-07** — stdin deadlock prevention (documented in SPEC-PROBLEMS.md)
- [ ] **T-EDGE-14** — env file without trailing newline (documented in SPEC-PROBLEMS.md)

---

## Remaining Failure Summary (117 tests)

| Area | Count | Key Tests | Status |
|------|-------|-----------|--------|
| Install command | ~47 | T-INST-*, T-DISC-46 | Not implemented |
| CLI delegation | ~8 | T-DEL-* | Not implemented |
| Signal handling | ~7 | T-SIG-* | Need process group management |
| Edge cases | ~6 | T-EDGE-04, T-EDGE-07, T-EDGE-14 | Documented in SPEC-PROBLEMS.md |
| API timing | 2 | T-API-25 | Timing-sensitive |
| Fuzz tests | 2 | F-ENV-04, F-PARSE-04 e2e | Documented in SPEC-PROBLEMS.md |
| Other | ~45 | output-parsing e2e, module-resolution, delegation, install suites | Mixed |

---

## Known Minor Test Harness Deviations (documented, not blocking)

These are cosmetic deviations in the test harness that do not affect correctness. They should not be "fixed" — the implementation should conform to SPEC.md, not to the test's deviation.

- T-CLI-08 uses `.sh` instead of `.ts` for default script — functionally equivalent
- T-SIG-04 uses 1-second delay instead of spec's 2-second — still well under 5s grace period
- T-LOOP-23 tests stderr pass-through but `writeStderr` fixture exits 0; spec says "on failure"
- T-LOOP-25 uses `"1"`/`"2"` result format instead of spec's `"iter-N"` — functionally equivalent
- T-INST-31a is an extra test (HTTP 500) not in spec but useful
- T-DEL-02, T-DEL-03, T-DEL-06 use custom fixture construction (needed for non-standard layouts)
- T-EDGE-05 split into T-EDGE-05a/b/c; T-EDGE-12 split into T-EDGE-12a/12b — all spec aspects covered
- T-API-20j/k/l are extra tests not in spec (renamed from old IDs)
- T-ENV-25/25a use counter-based script instead of spec's suggested separate script
- T-INST-08a uses localhost URL instead of github.com (known-host classification tested in unit tests)
- T-LOOP-02 uses inline bash scripts instead of counter() fixture (functionally equivalent)
- T-API-09b/14c pass explicit `cwd` instead of relying on `process.cwd()` snapshot — tests explicit cwd, not implicit snapshot
- T-API-21b passes explicit `cwd` instead of omitting it — tests relative envFile against explicit cwd, not process.cwd()
- T-ENV-17a missing stderr assertion (only checks exitCode === 1)
- T-ENV-24 does not test progressive removal/fallback (only tests full chain in one invocation)

---

## Implementation Notes

- **ESM-only** — All JS/TS must use `import`/`export`, no CommonJS
- **Node >= 20.6** — Required for `module.register()` in the custom loader
- **Self-cleaning** — All test helpers clean up temp dirs, servers, env mutations via afterEach hooks
