# Implementation Plan for loopx Test Harness

**Status: NOT spec-conformant. T-WFDIR-01..14 + T-TMP foundational subset implemented; remaining P1 gaps in ADR-0004 coverage remain.**

## P0 — RESOLVED previously

The following tests had been encoded against pre-ADR-0004 behavior (workflow-dir cwd) and were rewritten to assert the project-root-unified cwd from ADR-0004 §3 / SPEC §6.1 / §9.5. With these fixes, the tests now correctly **fail** against the existing pre-ADR-0004 implementation — that is the expected state until the implementation catches up to ADR-0004:

- T-EXEC-01, T-EXEC-02 — bash cwd assertions (project root, not workflow dir).
- T-EXEC-16 — JS/TS cwd assertion (project root, not workflow dir).
- T-EXEC-16b — cross-workflow goto preserves project-root cwd; LOOPX_WORKFLOW_DIR refreshes independently.
- T-API-07a — `RunOptions.cwd` controls script execution cwd (project-root-unified).
- T-API-47b — `runPromise` cwd sets LOOPX_PROJECT_ROOT AND script execution cwd; LOOPX_WORKFLOW_DIR independent.
- `writeCwdToFile` helper now uses `/bin/pwd -P` (per SPEC 6.1 — `$PWD` non-authoritative).
- §4.4 header comment in `execution.test.ts` rewritten to describe ADR-0004 cwd behavior.

## P1 — Entire ADR-0004 test suites — partial progress

- **T-WFDIR-01..14** — implemented in `apps/tests/tests/e2e/wfdir.test.ts`. 36/40 currently fail (pre-ADR-0004 impl lacks `LOOPX_WORKFLOW_DIR` injection and `RunOptions.env` support); the 4 passes are T-WFDIR-09b/09c × {node, bun} (existing $0-spelling behavior).
- **T-TMP-* foundational subset** — implemented in `apps/tests/tests/e2e/tmpdir.test.ts`. Covers Creation and Scope (T-TMP-01, 02, 02a, 03, 04, 05, 06, 07, 08, 08a, 08b, 08c, 09), Not-Created Cases (T-TMP-10, 11, 11a, 11b), and Cleanup on Normal Completion (T-TMP-13, 13a, 13b, 14, 14a, 15, 15a, 15b). 42/50 currently fail (pre-ADR-0004 impl lacks `LOOPX_TMPDIR` injection, cleanup, and `RunOptions.env`); the 8 passes are T-TMP-10/11/11a/11b × {node, bun} which correctly assert no tmpdir under -n 0 / maxIterations: 0. Helper `listLoopxEntries()` filters internal shim prefixes (`loopx-nodepath-shim-`, `loopx-bun-jsx-`, `loopx-install-`) — these are loopx-internal helpers, not `LOOPX_TMPDIR`. T-TMP-08a / T-TMP-08c each fail by exhausting the runAPIDriver 25s timeout because the script hangs on missing `RELEASE_SENTINEL` env var (RunOptions.env not yet honored). T-TMP-09 uses a try/catch + always-release pattern to avoid orphan CLI rejections; the same pattern should apply to other live-stat tests in subsequent iterations.

### T-TMP-* — REMAINING (other subsections)

- **Identity-Capture and Mode-Securing creation-failure paths** — T-TMP-12, T-TMP-12-cli (parameterized 26+10 sub-cases of pre-iteration failure modes that must not create a tmpdir), T-TMP-12-cli-usage, T-TMP-12d/12d2/12e/12e2/12e3 (LOOPX_TEST_TMPDIR_FAULT seam coverage), T-TMP-12a/12b/12c, T-TMP-12f..12f5/12g/12h.
- **Cleanup triggers** — T-TMP-16..16j (goto resolution failures across 3 surfaces), T-TMP-17/18/18a/18b (signal cleanup with escalation), T-TMP-19, T-TMP-20, T-TMP-21 (consumer-cancellation termination), T-TMP-22c/22d/22e/22f (final-yield-trigger × consumer-cancellation matrix).
- **Final-Yield-vs-Settlement carve-out** — T-TMP-23, T-TMP-24, T-TMP-24a..24g (abort-after-final-yield × settlement matrix), T-TMP-24b (external SIGKILL leaks).
- **Tmpdir Parent Snapshot Timing** — T-TMP-25, T-TMP-25a/25b, T-TMP-26..27a, T-TMP-26-temp/26-tmp/27-temp/27-tmp, T-TMP-28..29k (TMPDIR / TEMP / TMP precedence + snapshot-timing across env-file / RunOptions.env / inherited-env).
- **Renamed-Away and Mount-Point** — T-TMP-32, T-TMP-32a..32c, T-TMP-33.
- **Cleanup-Safety dispatch matrix** — T-TMP-34/34a/34b (renamed-away), T-TMP-35..35h (script-failure terminal cleanup-warning cardinality), T-TMP-36/36a/36b (mismatched-identity), T-TMP-37/37a..37e (recursive-removal walk semantics), T-TMP-38/39/38a/38a2/38b/38b-run/38b2/38b2-run/38c/38c2 (cleanup idempotence and at-most-one-warning under racing terminals), T-TMP-40 (lstat-fail), T-TMP-41 (symlink-unlink-fail), T-TMP-42/42a/42b/42c (recursive-remove-fail).

## P1 — Entire ADR-0004 test suites still missing

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
