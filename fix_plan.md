# Implementation Plan for loopx

**Status: 846/889 tests passing (95.2%).** 43 remaining failures.

Phases 1-12, 15 complete. Phase 14 (install command) complete. Phase 13 (CLI delegation) not started. Phase 16 ongoing.

---

## Remaining Failures (43 tests)

| Area | Count | Details |
|------|-------|---------|
| CLI delegation | 7 | Not implemented (Phase 13) |
| Execution (no `-n`) | 10 | Scripts run without `-n`, produce no structured output → infinite loop. Tests expect one-shot execution. |
| Output parsing E2E | 7 | T-PARSE-18–24 — unit/E2E disagree on whether "known field with invalid type" triggers raw fallback. Documented in SPEC-PROBLEMS.md. |
| Edge cases | 6 | T-EDGE-04/07/14 — documented spec discrepancies |
| Module resolution | 8 | T-MOD-03a (shadow), T-MOD-13d/e/g (output with invalid fields), T-MOD-14 (code after output), T-MOD-15/16/17 (input function), T-MOD-22 (CJS require) |
| Timing | 3 | T-SIG-07 + T-API-25 × 2 |
| Fuzz | 1 | F-ENV-04 — documented spec discrepancy |

---

## Remaining Work

### Phase 13: CLI Delegation (P2) — NOT STARTED (7 tests)

- [ ] Search for local `node_modules/.bin/loopx`, delegate with same args, inherit stdio
- [ ] Set `LOOPX_DELEGATED=1` recursion guard, `LOOPX_BIN` to resolved realpath
- [ ] Delegation before any subcommand/run dispatch

### Phase 16: Edge Cases & Hardening (P3) — IN PROGRESS

- [ ] **T-EDGE-04** — stdout/stderr stream separation (documented in SPEC-PROBLEMS.md)
- [ ] **T-EDGE-07** — stdin deadlock prevention (documented in SPEC-PROBLEMS.md)
- [ ] **T-EDGE-14** — env file without trailing newline (documented in SPEC-PROBLEMS.md)

---

## Known Minor Test Harness Deviations (documented, not blocking)

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
