# Implementation Plan for loopx Test Harness

**Status: NOT spec-conformant. T-WFDIR-01..14 + T-TMP foundational subset + T-TMP-12 (26 sub-cases × 2 surfaces) + T-TMP-12-cli (10 sub-cases) + T-TMP-12-cli-usage (6 sub-cases) + T-TMP-12a/12b/12c (3 sub-cases) + T-TMP-12d/12d2/12e/12e2/12e3 (5 sub-cases × 3 surfaces, LOOPX_TEST_TMPDIR_FAULT seam coverage) implemented; remaining P1 gaps in ADR-0004 coverage remain.**

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
- **T-TMP-12 (programmatic, 26 sub-cases × 2 surfaces)** — implemented in `apps/tests/tests/e2e/tmpdir.test.ts`. Covers all 26 pre-iteration-failure sub-cases (env-loading: env-file, env-file-unreadable, global-env-unreadable; target-resolution: missing-workflow, missing-script, missing-default-index, target-validation, target-name-invalid; option-snapshot value: invalid-maxIterations, invalid-options-shape, invalid-env-shape, invalid-env-value, invalid-signal, invalid-target, invalid-cwd, invalid-envFile; option-snapshot throws: throwing-options-getter, throwing-signal-getter, throwing-cwd-getter, throwing-envFile-getter, throwing-maxIterations-getter, throwing-env-entry-getter, throwing-env-proxy-ownKeys, throwing-env-proxy-get; discovery: programmatic-discovery-missing-loopx, programmatic-discovery-validation), each parameterized over `runPromise` and `run` surfaces and over node + bun runtimes (= 26 × 2 × 2 = 104 test invocations). 80 currently pass and 24 currently fail. The 24 failures cluster around `RunOptions.env`-shape validation (invalid-env-shape, invalid-env-value, throwing-options-getter, throwing-env-entry-getter, throwing-env-proxy-ownKeys, throwing-env-proxy-get — 6 sub-cases × 2 surfaces × 2 runtimes = 24): pre-ADR-0004 impl ignores the `env` field, so these calls succeed silently rather than rejecting with an option-snapshot error. The two helper functions `noTmpdirDriver` and `assertNoTmpdirCreated` (defined at module scope) provide a reusable harness for the snapshot-before / call / snapshot-after assertion shape across both surfaces.
- **T-TMP-12-cli (10 sub-cases)** — implemented in `apps/tests/tests/e2e/tmpdir.test.ts`. Covers the CLI counterpart to T-TMP-12 over the 10 CLI-observable pre-iteration failure modes (env-loading: env-file, env-file-unreadable, global-env-unreadable; target-resolution: missing-workflow, missing-script, missing-default-index; target-syntax/name validation: target-validation, target-name-invalid; discovery: discovery, missing-loopx), parameterized over node + bun runtimes (= 10 × 2 = 20 test invocations). All 20 currently pass against the pre-ADR-0004 impl: the impl trivially does not create a `LOOPX_TMPDIR` for any pre-iteration failure (it doesn't create one at all yet), and the failure exit codes are already enforced by the existing CLI parser/validation. The new helper `assertCLINoTmpdirCreated` (defined at module scope, sibling to `assertNoTmpdirCreated`) provides the snapshot-before / runCLI / snapshot-after harness shape.
- **T-TMP-12-cli-usage (6 sub-cases)** — implemented in `apps/tests/tests/e2e/tmpdir.test.ts`. Covers the parser-layer and run-help short-circuit boundaries: no-target, unknown-flag, duplicate-n, duplicate-e, help-with-unknown (-h ignored unknown flag, exit 0), help-with-dashdash (--help -- target, exit 0). Parameterized over node + bun runtimes (= 6 × 2 = 12 test invocations). All 12 currently pass.
- **T-TMP-12a/12b/12c (3 sub-cases)** — implemented in `apps/tests/tests/e2e/tmpdir.test.ts`. Covers the mkdtemp-fails-on-unwritable-parent ordering across the three surfaces (CLI / `runPromise` / `run`), parameterized over node + bun runtimes (= 3 × 2 = 6 test invocations). 2 currently pass and 4 currently fail. T-TMP-12a × {node, bun} pass because the CLI process crash on the eager `loopx-nodepath-shim-<pid>` mkdirSync at module-load time produces the same observable outcomes the test asserts: exit 1, stderr non-empty, no marker file written, no `loopx-*` directory under the unwritable parent, zero `LOOPX_TEST_CLEANUP_WARNING\t…` lines. T-TMP-12b/12c × {node, bun} fail because the api-driver subprocess imports `loopx`, which triggers the eager shim mkdirSync; the unwritable TMPDIR causes the import to throw before the driver can call `run()` / `runPromise()` and print its JSON envelope, so `result.exitCode` is non-zero. The failures are an ordering issue: pre-ADR-0004 has eager TMPDIR-dependent module-load work (`loopx-nodepath-shim-<pid>` mkdirSync) that crashes when TMPDIR points at an unwritable parent; ADR-0004 implementation must decouple shim location from `LOOPX_TMPDIR` parent or make shim creation lazy / failure-tolerant.
- **T-TMP-12d/12d2/12e/12e2/12e3 (5 sub-cases × 3 surfaces)** — implemented in `apps/tests/tests/e2e/tmpdir.test.ts`. Covers the SPEC §7.4 creation-order sub-step coverage for sub-steps 2 (identity-capture) and 3 (mode-securing), each on its success-cleanup branch (12d / 12e) and on its cleanup-failure branch (12d2 / 12e2 / 12e3). Uses the `LOOPX_TEST_TMPDIR_FAULT` seam (TEST-SPEC §1.4) and, for the cleanup-failure compositions, `LOOPX_TEST_CLEANUP_FAULT`. Parameterized over three execution surfaces (CLI / `run()` / `runPromise()`) and over node + bun runtimes (= 5 × 3 × 2 = 30 test invocations). All 30 currently fail against the pre-ADR-0004 implementation: the impl does not honor `LOOPX_TEST_TMPDIR_FAULT` or `LOOPX_TEST_CLEANUP_FAULT`, so `mkdtemp` succeeds normally and the loop runs to completion (CLI exits 0 instead of 1; programmatic surfaces resolve/yield instead of throwing/rejecting). Implementation work required: (1) honor `LOOPX_TEST_TMPDIR_FAULT={identity-capture-fail,identity-capture-fail-rmdir-fail,mode-secure-fail}` under `NODE_ENV=test` per TEST-SPEC §1.4; (2) honor `LOOPX_TEST_CLEANUP_FAULT={lstat-fail,recursive-remove-fail}` under `NODE_ENV=test`; (3) emit the `LOOPX_TEST_CLEANUP_WARNING\t<payload>` structured marker line on every cleanup-warning emission under `NODE_ENV=test` (TEST-SPEC §1.4 "Cleanup-warning structured marker"); (4) implement the SPEC §7.4 creation-order behaviors themselves (single non-recursive `rmdir` after identity-capture failure; full identity-fingerprint cleanup-safety routine after mode-secure failure; single warning + leave-in-place on cleanup failure; "does not mask the original creation error"). Helper `runTmpdirFaultTest` (defined at module scope below `assertNoTmpdirCreated`) provides the snapshot-before / drive / snapshot-after harness shape across all three surfaces; new constant `TMPDIR_FAULT_SURFACES` parameterizes over CLI / run / runPromise.

### T-TMP-* — REMAINING (other subsections)

- **Tmpdir-creation failure paths** — T-TMP-12f..12f5/12g/12h (version-check-vs-tmpdir-creation ordering across CLI + 5 SPEC 3.2 warning branches, plus run() and runPromise() counterparts over the same 5 branches).
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
