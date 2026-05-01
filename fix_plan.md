# Implementation Plan for loopx Test Harness

**Status: ADR-0004 §6.1 (project-root cwd + LOOPX_WORKFLOW_DIR injection) AND §7.4 (LOOPX_TMPDIR creation/injection/cleanup) are now IMPLEMENTED. The `tmpdir.ts` module performs SPEC §7.4 three-step creation (mkdtemp → identity capture → mode 0700 secure), idempotent cleanup-safety dispatch (5 cases: ENOENT/symlink/non-dir/identity-match-recursive-remove/identity-mismatch), and honors the LOOPX_TEST_TMPDIR_FAULT and LOOPX_TEST_CLEANUP_FAULT seams under NODE_ENV=test. `loop.ts` creates the tmpdir between SPEC §7.1 step 5 (version check) and step 6 (first child spawn) and runs cleanup in a try/finally so every terminal outcome (normal completion, script error, invalid goto, abort, consumer .return()/.throw()) triggers cleanup. The shim dir is now lazy (was module-load-time mkdir) so unwritable TMPDIR no longer crashes loopx. The `LOOPX_TMPDIR` env var is injected into every spawned script via execution.ts. tmpdir.test.ts: 254/282 PASS (was 8/282 before this iteration). Remaining 28 failures are all RunOptions.env-related (T-TMP-12 throwing-env-* sub-cases × 2 surfaces × 2 runtimes = 24, plus T-TMP-08a/08c × 2 runtimes = 4) — out of scope for this iteration. T-WFDIR-01..14 (40/40), T-EXEC-01/02/16, T-EXEC-16b, T-API-07a, T-API-47b ALL PASS. Adjacent test suites (programmatic-api, execution, loop-state) confirm zero regressions: 487/487 PASS.**

## P0/P1 — RESOLVED

### ADR-0004 §6.1 (project-root cwd + LOOPX_WORKFLOW_DIR injection)

Implemented in `packages/loop-extender/src/execution.ts`:
1. Script execution cwd changed from `workflowDir` → `projectRoot` (SPEC §6.1 / ADR-0004 §3).
2. `LOOPX_WORKFLOW_DIR` is now injected into every spawned script's environment (SPEC §6.1 / §8.3 / §13).

Passing test groups:
- **T-WFDIR-01..14 (LOOPX_WORKFLOW_DIR injection)** — ALL 40/40 pass.
- **T-EXEC-01, T-EXEC-02, T-EXEC-16, T-EXEC-16b** — project-root cwd assertions.
- **T-API-07a, T-API-47b** — RunOptions.cwd controls script execution cwd.

### ADR-0004 §7.4 (LOOPX_TMPDIR creation / injection / cleanup)

Implemented in `packages/loop-extender/src/tmpdir.ts` and integrated via `loop.ts`, `execution.ts`, `run.ts`:

1. **Three-step creation** (SPEC §7.4): `mkdtemp(<parent>/loopx-)` → identity capture (`lstat` dev/inode) → mode 0700 secure (`chmodSync`).
2. **Five-case cleanup-safety dispatch** (SPEC §7.4): ENOENT no-op; symlink unlink (no-follow); non-directory leave-with-warning; identity-match recursive remove; identity-mismatch leave-with-warning.
3. **Cleanup idempotence** — `CleanupState { attempted, warned }` guarantees at most one cleanup attempt and at most one stderr warning per resource.
4. **Per-creation-failure handling** (SPEC §7.4 "does not mask the original creation error"): identity-capture-fail triggers single non-recursive `rmdir`; mode-secure-fail triggers full cleanup-safety routine; both throw the original creation error after cleanup.
5. **Test seams** (TEST-SPEC §1.4, NODE_ENV=test only): `LOOPX_TEST_TMPDIR_FAULT={identity-capture-fail, identity-capture-fail-rmdir-fail, mode-secure-fail}` and `LOOPX_TEST_CLEANUP_FAULT={lstat-fail, symlink-unlink-fail, recursive-remove-fail}`.
6. **Structured warning marker** — emitted under NODE_ENV=test as `LOOPX_TEST_CLEANUP_WARNING\t<payload>` for test-side detection.
7. **Integration**:
   - `runLoop` creates the tmpdir between SPEC §7.1 step 5 (version check) and step 6 (first child spawn). Wraps the loop body in `try/finally` so every terminal outcome triggers cleanup.
   - `executeScript` accepts `tmpdir: string` in ExecOptions, injects `LOOPX_TMPDIR` as a protocol-tier env var (overrides any user-supplied value).
   - `runPromise` captures `os.tmpdir()` eagerly at the call site (SPEC §9.2); `run()` and CLI use lazy capture inside `runLoop`.
8. **Lazy NODE_PATH shim** — `getLoopxShimDir()` is now invoked inside `executeScript` (was module-load). Prevents loopx from crashing when TMPDIR points at an unwritable parent before tmpdir-creation has had a chance to surface its own EACCES.

Passing test groups (tmpdir.test.ts):
- **T-TMP-01..09** (creation, scope, sharing across iterations / intra-workflow goto / cross-workflow goto / loop reset / persistence within run / concurrent runs across projects + same project CLI).
- **T-TMP-10/11/11a/11b** (no tmpdir under -n 0 / maxIterations: 0).
- **T-TMP-12** programmatic 26 sub-cases × 2 surfaces × 2 runtimes — pre-iteration failure modes ALL pass except the 6 RunOptions.env shape sub-cases (out of scope).
- **T-TMP-12-cli, T-TMP-12-cli-usage** (16 sub-cases × 2 runtimes).
- **T-TMP-12a/12b/12c** — unwritable-parent mkdtemp failure across CLI / run / runPromise × node + bun.
- **T-TMP-12d/12d2/12e/12e2/12e3** — 5 sub-cases × 3 surfaces × 2 runtimes (= 30 invocations) — LOOPX_TEST_TMPDIR_FAULT + LOOPX_TEST_CLEANUP_FAULT seam coverage. ALL PASS.
- **T-TMP-12f/12f2/12f3/12f4/12f5 + T-TMP-12g/12h** — 5 pkg-json variants × 3 surfaces × 2 runtimes (= 30 invocations) — version-check-before-tmpdir-creation ordering. ALL PASS.
- **T-TMP-13/13a/13b/14/14a/15/15a/15b** — cleanup on normal completion (stop / maxIterations / loop reset).
- **T-TMP-16/16a/16b/16c/16d/16e/16f/16g/16h/16i/16j** — goto-resolution-failure cleanup, mixed surfaces (= 30 invocations). ALL PASS.

Test-file cleanups previously landed:
- `writeCwdToFile` helper now uses `/bin/pwd -P` (per SPEC 6.1 — `$PWD` non-authoritative).
- §4.4 header comment in `execution.test.ts` rewritten to describe ADR-0004 cwd behavior.

### Test harness improvement (api-driver.ts)

`apps/tests/tests/helpers/api-driver.ts` now strips caller-supplied `extraEnv.TMPDIR` from the spawned child's env and bakes a `process.env.TMPDIR = <orig>` prefix into the driver code. This decouples tsx's eager `${TMPDIR}/tsx-${UID}` IPC dir from the loopx-perceived TMPDIR — tests can pass an unwritable TMPDIR without crashing tsx at module-load. loopx still observes the test's intended TMPDIR because every `os.tmpdir()` read in loopx is lazy (inside `runLoop`, `runPromise`'s eager-snapshot call, or pre-iteration in the CLI), all of which execute after the prefix.

## P1 — TOP PRIORITY: RunOptions.env tier-2 env merging

**Single highest-leverage gap remaining.** Currently the `RunOptions.env` shape is silently ignored in `run.ts`; programmatic-API callers cannot inject env via this option. This blocks:

- **T-API-50..57i** — `RunOptions.env` block (~80 IDs): shape validation, lifetime/snapshot semantics, merge-position precedence, protocol-variable override, NUL-byte rejection through `RunOptions.env`.
- **T-TMP-12 throwing-env-* sub-cases (24 tests)** — the option-snapshot validation tests for `env` shape / proxy / getter exceptions can't reject because env is ignored entirely.
- **T-TMP-08a / T-TMP-08c (4 tests)** — concurrent-runs tests time out because they pass the release-sentinel path via `RunOptions.env` and the script can't find it.
- The proper "for the right reason" pass of T-WFDIR-08 (currently passes only because the override target is the protocol-injected value, not the suppressed RunOptions.env value).

Required implementation:
1. Add `env?: Record<string, string>` to the public `RunOptions` type (types.ts).
2. Validate env shape at option-snapshot time (SPEC §9.1 "Option-snapshot timing"): rejects non-object, non-string keys/values, throwing getters, throwing Proxy ownKeys / get traps, NUL bytes in keys/values.
3. Merge order in execution.ts (SPEC §8.3): inherited process.env → global env file → `-e`/`envFile` → `RunOptions.env` → protocol vars (highest).
4. Snapshot timing: capture `RunOptions.env` synchronously at run() / runPromise() call site (signal first, then env per SPEC §9.1).
5. Protocol vars (LOOPX_*) always override RunOptions.env (T-WFDIR-08 right-reason).

## P1 — REMAINING T-TMP-* subsections

These T-TMP IDs are not yet implemented as test cases or are blocked by missing infrastructure:

- **Cleanup triggers** — T-TMP-17/18/18a/18b (signal cleanup with escalation), T-TMP-19, T-TMP-20, T-TMP-21 (consumer-cancellation termination), T-TMP-22c/22d/22e/22f (final-yield-trigger × consumer-cancellation matrix).
- **Final-Yield-vs-Settlement carve-out** — T-TMP-23, T-TMP-24, T-TMP-24a..24g (abort-after-final-yield × settlement matrix), T-TMP-24b (external SIGKILL leaks).
- **Tmpdir Parent Snapshot Timing** — T-TMP-25, T-TMP-25a/25b, T-TMP-26..27a, T-TMP-26-temp/26-tmp/27-temp/27-tmp, T-TMP-28..29k (TMPDIR / TEMP / TMP precedence + snapshot-timing across env-file / RunOptions.env / inherited-env). NOTE: depends on RunOptions.env tier-2.
- **Renamed-Away and Mount-Point** — T-TMP-32, T-TMP-32a..32c, T-TMP-33.
- **Cleanup-Safety dispatch matrix** — T-TMP-34/34a/34b (renamed-away), T-TMP-35..35h (script-failure terminal cleanup-warning cardinality), T-TMP-36/36a/36b (mismatched-identity), T-TMP-37/37a..37e (recursive-removal walk semantics), T-TMP-38/39/38a/38a2/38b/38b-run/38b2/38b2-run/38c/38c2 (cleanup idempotence and at-most-one-warning under racing terminals), T-TMP-40 (lstat-fail), T-TMP-41 (symlink-unlink-fail), T-TMP-42/42a/42b/42c (recursive-remove-fail).

## P1 — Other ADR-0004 test suites still missing

- **T-API-50..57i** — `RunOptions.env` block (~80 IDs): blocked by RunOptions.env tier-2 above.
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

## Pre-existing failures (not ADR-0004)

- **T-INST-GLOBAL-01a** — `[Bun] full global install lifecycle with import 'loopx'` fails with "Module not found … /loop-extender/bin.js". Pre-existing issue with Bun's resolution at the global-install layout. Unrelated to ADR-0004; confirmed by reproducing the failure on baseline (pre-change) source. Should be triaged separately.

## Notes

- `.loopx/.iteration.tmp` and `.loopx/ralph/.tmp/` appear in `git status` — left by prior loopx runs, not part of this work. Not tracked.
