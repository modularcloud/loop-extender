# Implementation Plan for loopx Test Harness

**Status: NOT spec-conformant. P0 backwards assertions resolved this iteration; large P1 gaps in ADR-0004 coverage remain.**

## P0 — RESOLVED this iteration

The following tests had been encoded against pre-ADR-0004 behavior (workflow-dir cwd) and were rewritten to assert the project-root-unified cwd from ADR-0004 §3 / SPEC §6.1 / §9.5. With these fixes, the tests now correctly **fail** against the existing pre-ADR-0004 implementation — that is the expected state until the implementation catches up to ADR-0004:

- T-EXEC-01, T-EXEC-02 — bash cwd assertions (project root, not workflow dir).
- T-EXEC-16 — JS/TS cwd assertion (project root, not workflow dir).
- T-EXEC-16b — cross-workflow goto preserves project-root cwd; LOOPX_WORKFLOW_DIR refreshes independently.
- T-API-07a — `RunOptions.cwd` controls script execution cwd (project-root-unified).
- T-API-47b — `runPromise` cwd sets LOOPX_PROJECT_ROOT AND script execution cwd; LOOPX_WORKFLOW_DIR independent.
- `writeCwdToFile` helper now uses `/bin/pwd -P` (per SPEC 6.1 — `$PWD` non-authoritative).
- §4.4 header comment in `execution.test.ts` rewritten to describe ADR-0004 cwd behavior.

## P1 — Entire ADR-0004 test suites missing

- **T-WFDIR-01..14** — implemented in `apps/tests/tests/e2e/wfdir.test.ts`. 36/40 currently fail (pre-ADR-0004 impl lacks `LOOPX_WORKFLOW_DIR` injection and `RunOptions.env` support); the 4 passes are T-WFDIR-09b/09c × {node, bun} (existing $0-spelling behavior).
- **T-TMP-\*** — full `LOOPX_TMPDIR` suite: creation; identity-fingerprint cleanup; cleanup triggers; cleanup safety under symlink/non-directory replacement; mode 0700; parent selection; naming; isolation across concurrent runs; settlement-based cleanup on `run()`; signal handling; abort handling; idempotence; cleanup-warning cardinality.
- **T-API-50..57i** — `RunOptions.env` block (~80 IDs): shape validation, lifetime/snapshot semantics, merge-position precedence, protocol-variable override, NUL-byte rejection through `RunOptions.env`.
- **T-API-58..59i** — Inherited-env snapshot timing (lazy under `run()`, eager under `runPromise()`).
- **T-API-60..62i4** — Pre-iteration ordering and options-snapshot tests (~60 tests).
- **T-API-63..69u** — Abort precedence, generator lifecycle, promise rejection (~150 tests).
- **T-API-70..74c** — 15 remaining programmatic API tests.
- **T-INST-110..120e** — Auto-install ADR-0004 (~100 tests): `npm install`, `--no-install`, `.gitignore` safeguard, malformed `package.json` skip, npm-install failure handling, signals during npm install, no-rollback semantics, `-y` interaction, environment isolation, streaming passthrough, npm-only manager selection.
- **T-INST-55f..55zj** — symlink source validation (~40 tests).
- **T-INST-40f, T-INST-44a..44f** — `--no-install` CLI parsing (duplicate rejection, help interaction, no short alias).
- **T-INST-DASHDASH-01..04** — `--` rejection on install.
- **T-INST-42m, 42n** — install help-text content pins.

## P2 — Supplementary tests for established sections

- **Loop state**: T-LOOP-13a, 15b, 24a, 44, 45, 46.
- **Discovery**: T-DISC-07a, 07c, 09a, 09b, 24a, 24b, 42d-42g, 49a-49k, 40j-40w (project-root `.loopx` entry failures and symlink edges).
- **Output parsing**: T-PARSE-04a, 13a, 17a; T-MOD-13q.
- **Execution edge cases**: T-EXEC-03b, 03c, 07a, 07b, 13c-13m (CJS/`require` rejection), 15a/15b/15c (no auto-install at run time), 16c, 16d.
- **Signals**: T-SIG-04a, 05a, 06a, 07a (SIGINT parity); T-SIG-20..31 (full pre-iteration signal-wins precedence).
- **Types**: T-TYPE-08 (compile-time check for `output()`/`input()`).
- **Env**: T-ENV-05f, 08a, 15g..15n; T-ENV-21e..21h; T-ENV-24a2..24a6; T-ENV-26..26g (NUL bytes); T-ENV-27..27e (`RunOptions.env` tier interaction); T-ENV-28..29a.
- **Exit codes**: T-EXIT-17 (invalid target string).
- **Source detection**: T-INST-05a, 08g..08m.
- **Other install**: T-INST-56f..56i, 60t/60u, 63f/63g, 64e, 70e, 76b, 79a, 80c2, 80f2, 83b, 92a..92c, 97a2, 97c.

## Notes

- `.loopx/.iteration.tmp` and `.loopx/ralph/.tmp/` appear in `git status` — left by prior loopx runs, not part of this work. Not tracked.
