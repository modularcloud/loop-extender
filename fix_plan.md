# Implementation Plan for loopx Test Harness

**Status: ADR-0004 §6.1 (project-root cwd + LOOPX_WORKFLOW_DIR injection), §7.4 (LOOPX_TMPDIR creation/injection/cleanup + parent-snapshot timing across all four injection tiers), §9.5 (RunOptions.env tier-2 env merging), §9.3 (abort-after-final-yield carve-out), §9.2 (LOOPX_TMPDIR async creation under runPromise()), AND §9.2 (process.env eager snapshot under runPromise()) are now IMPLEMENTED. Recent (this iteration): `runPromise()` now eagerly captures `process.env` and the global env-file path (`getGlobalEnvPath` resolved against the snapshot) before the `await Promise.resolve()` microtask boundary, threaded through `runWithInternal` → `runInternal` as `inheritedEnv` / `globalEnvPath`. `mergeEnv` now spreads the inherited snapshot when provided instead of reading live `process.env`. `run()` retains lazy semantics (no snapshot threaded → reads live `process.env` inside `runLoop`). tmpdir.test.ts 389/389 still passes; programmatic-api: 370 (was 358, +12 new env-snapshot-timing tests T-API-71/71a/71b/72/72a/72b × 2 runtimes); env-vars 96; wfdir 40. Full e2e suite: 2249/2250 passing; the single remaining failure is T-INST-GLOBAL-01a [Bun] (pre-existing, unrelated to this work).**

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

### ADR-0004 §9.5 (RunOptions.env tier-2 env merging) — RESOLVED

Implemented in `packages/loop-extender/src/types.ts` and `packages/loop-extender/src/run.ts`:

1. **Public type** — added `env?: Record<string, string>` to `RunOptions` (types.ts).
2. **Option-snapshot machinery** (run.ts):
   - `snapshotOptions(options)` reads recognized fields once each via `[[Get]]` (signal first per SPEC §9.1, then cwd, envFile, env, maxIterations).
   - `snapshotEnv(envRaw)` validates shape (rejects null / array / function / non-object), enumerates own-enumerable string-keyed entries via `Object.keys` (which invokes Proxy `ownKeys` and `getOwnPropertyDescriptor` traps and propagates throws naturally), and reads each included value once via `[[Get]]` (which invokes accessor getters or Proxy `get` traps and propagates throws naturally).
   - `isAbortSignalCompatible(signal)` enforces SPEC §9.5 signal contract: `aborted` must be readable boolean, `addEventListener` must be callable.
3. **Eager cwd snapshot** — `cwd` snapshotted at call time (defaults to `process.cwd()` per SPEC §9.5); relative `cwd` resolved against `process.cwd()` once at call time.
4. **Signal wiring** — User signal → internal AbortController abort propagation now wired via `addEventListener` (replaces `AbortSignal.any` to support duck-typed signals); a throwing `addEventListener` is captured as a snapshot error.
5. **Lazy error surfacing** — Captured snapshot errors surface lazily via the standard pre-iteration error path on first `next()` (or as promise rejection from `runPromise`). Pre-first-`.return()` consumer-cancellation carve-out preserved (errors not thrown when consumer's first interaction is `.return()` / `.throw()`).
6. **Abort precedence** — SPEC §9.3 preserved: signal-aborted-at-call-time wins over snapshot errors.
7. **Merge order** (run.ts `runInternal`): `mergeEnv(globalEnv, localEnv)` (tiers 5→4→3) overlaid with `snap.env` (tier 2). Protocol-tier vars (LOOPX_*, tier 1) continue to overlay last in `executeScript` at execution.ts.

Now-passing tests (this iteration):
- **tmpdir.test.ts: 282/282 PASS** — T-TMP-12 throwing-env-entry-getter, throwing-env-proxy-ownKeys, throwing-env-proxy-get sub-cases × 2 surfaces × 2 runtimes (16 tests); T-TMP-08a (concurrent runPromise) and T-TMP-08c (concurrent run generator) × 2 runtimes (4 tests); T-TMP-12 invalid-env-shape, invalid-env-value sub-cases (8 tests).
- **wfdir.test.ts T-WFDIR-08** — now passes for the right reason (user-supplied `LOOPX_WORKFLOW_DIR` plumbed via `RunOptions.env` and overridden by protocol-injected real workflow dir).
- Adjacent suites: zero regressions across programmatic-api (346), env-vars (96), execution (85), loop-state (96), wfdir (40), unit (143), harness (15).

### ADR-0004 §9.1 (.throw() consumer cancellation contract) — RESOLVED

The `.throw()` wrapper at `packages/loop-extender/src/run.ts` previously delegated directly to `gen.throw(err)`, leaving the active child unkilled and propagating the consumer-supplied error. SPEC §9.1 requires consumer-driven cancellation (including `.throw()`) to:
1. Terminate the active child process group (SIGTERM, then SIGKILL after 5s).
2. Ensure no further iterations start.
3. Produce silent clean completion (the consumer-supplied error is not surfaced) when no child is active.

The wrapper now mirrors `.return()`: calls `internalAc.abort()` to terminate the active child, then `gen.return(undefined)` to settle silently, swallowing any error so the caller sees `{ done: true, value: undefined }`. This is the no-active-child silent-completion contract from SPEC §9.1; for the active-child case the spec leaves the settlement form implementation-defined and we choose silent completion for symmetry with `.return()`.

Now-passing tests (this iteration):
- **tmpdir.test.ts: 310/310 PASS** — added T-TMP-17..22f (28 new tests × 2 runtimes covering CLI signal cleanup, escalation × cleanup, programmatic abort cleanup, consumer cancellation × {.return(), .throw(), break} × {active-child, no-active-child, post-final-yield, stop:true-final-yield} matrix). The two escalation tests (T-TMP-18a/18b) carry `retry: 3` due to the 5-second grace-period wait, mirroring T-SIG-05 / T-SIG-05a.
- Adjacent suites: zero regressions across programmatic-api (346), env-vars (96), execution (85), loop-state (96), wfdir (40), signals (9), unit (143), harness (15). The `.throw()` change does not affect existing behavior because no prior test exercised `.throw()` on the wrapper.

### ADR-0004 §9.3 (abort-after-final-yield carve-out) — RESOLVED

The `run()` wrapper at `packages/loop-extender/src/run.ts` previously had no notion of post-final-yield state: after `yield output; return;` (or `yield output;` on the maxIterations boundary) the inner gen would return cleanly on the next interaction regardless of abort-signal state. SPEC §9.3 requires that an abort observed in the post-final-yield / pre-settlement window produces an abort error on the next interaction (`.next()` / `.return()` / `.throw()`), with first-observed-wins precedence so a prior consumer cancellation's silent-completion outcome is not displaced.

Implementation:
1. Wrapper now tracks `yieldCount`, `postFinalYield`, `settled` state across `.next()` / `.return()` / `.throw()`.
2. On each yield, if `output.stop === true` OR `yieldCount === snap.maxIterations`, set `postFinalYield = true`.
3. Before delegating to the inner gen, each method checks `postFinalYield && internalAc.signal.aborted && !returnCalled` — if true, drives `gen.return(undefined)` to run the inner `finally` (tmpdir cleanup), then throws `makeAbortError(snap.signal ?? internalAc.signal)`.
4. The `!returnCalled` guard implements SPEC §9.3 first-observed-wins: a prior consumer `.return()` / `.throw()` (which already set `returnCalled=true`) keeps its silent-completion outcome.
5. For `.throw()` post-final-yield-abort, the abort error displaces the consumer-supplied error (per SPEC §9.3).
6. `if (settled)` early-return added to each wrapper method for idempotent multi-call behavior.

Now-passing tests (this iteration):
- **tmpdir.test.ts: 327/327 PASS** — added 17 new tests covering the §9.3 matrix:
  - **T-TMP-23**: post-final-yield → settlement (no abort) cleanup is single-shot and idempotent.
  - **T-TMP-24**: cleanup via full `for await` completion.
  - **T-TMP-24a/24c/24d**: abort after maxIterations-driven final yield + `.next()` / `.return()` / `.throw(consumerErr)` → cleanup runs before abort error (which displaces consumerErr in 24d).
  - **T-TMP-24e/24f/24g**: abort after stop:true-driven final yield + `.next()` / `.return()` / `.throw(consumerErr)` → same contract.
  - **T-TMP-24b**: external SIGKILL of loopx itself does NOT run tmpdir cleanup; tmpdir survives loopx death (CLI surface only, node only — Bun excluded because the harness's `runCLIWithSignal` plumbing relies on node spawn semantics). T-TMP-24b also surfaced a test-plumbing detail: when loopx is SIGKILLed its detached child shell holds an inherited stderr write-end, so `'close'` won't fire until the child also dies; the test now SIGKILLs the orphan child after observing the tmpdir-survival post-condition, then awaits result.
- Adjacent suites: zero regressions across programmatic-api (346), env-vars (96), execution (85), loop-state (96), wfdir (40), signals (9), unit (143), harness (15).

### ADR-0004 §9.2 (LOOPX_TMPDIR async creation under runPromise) — RESOLVED

The `runPromise()` body at `packages/loop-extender/src/run.ts` previously created `LOOPX_TMPDIR` synchronously at the call site, violating SPEC §9.2: "LOOPX_TMPDIR itself is created asynchronously after return, during the same pre-iteration sequence used by the CLI and run()." Authoring T-TMP-27a (which snapshots the parent directory's `loopx-*` entries synchronously between `runPromise()` returning and `await p`) caught this: `betweenSync` contained a freshly-created `loopx-*` entry that should not have existed yet.

Root cause: the `for await (const output of gen)` statement synchronously evaluates `gen[Symbol.asyncIterator]()` and the wrapper's `next()`, which synchronously calls the inner generator's `next()`, which synchronously runs `runInternal` + `runLoop` bodies up to the first internal `await` — invoking `createTmpdir` before `runPromise()` returned.

Fix: insert `await Promise.resolve()` between the sync option/parent capture and the `for await` loop. The synchronous `runWithInternal()` call is preserved before the microtask boundary so `snapshotOptions()` and the cwd default stay eager (T-API-14c, T-API-14d still pass). After the microtask, the for-await body runs and triggers the deferred `createTmpdir`.

Now-passing tests (this iteration):
- **tmpdir.test.ts: 389/389 PASS** — added 62 tests covering "Tmpdir Parent Snapshot Timing" (T-TMP-25/25a/25b/26/26-temp/26-tmp/27/27-temp/27-tmp/27a/28/28a/28b/28c/28d/28e/28f/28g/28h/29/29a/29b/29c/29d/29e/29f/29g/29h/29i/29j/29k × 2 runtimes). T-TMP-27a specifically verifies the SPEC §9.2 async-creation contract; T-TMP-27/27-temp/27-tmp verify eager-parent capture; T-TMP-26/26-temp/26-tmp verify lazy-parent capture under `run()`; T-TMP-28/28a-h verify global-env-file-tier × {TMPDIR,TEMP,TMP} × {CLI, runPromise, run} contract; T-TMP-29/29b/29c verify `RunOptions.env` tier × {TMPDIR,TEMP,TMP}; T-TMP-29a/29d/29e verify CLI `-e` tier; T-TMP-29f-h verify `runPromise({envFile})` tier; T-TMP-29i-k verify `run({envFile})` tier.
- **Test infrastructure added**:
  - `getRuntimeOsTmpdir(runtime, envOverrides)` — spawns a child Node/Bun process with the given env and returns its `os.tmpdir()` value, used by all `TEMP` / `TMP` variant tests for the runtime-aware expected-parent assertion (since on POSIX runtimes only `TMPDIR` is consulted).
  - `withInheritedTmpdirEnv(overrides, body)` — snapshots and restores `process.env.TMPDIR/TEMP/TMP` around a test body.
  - `makeTestParent(label)` — creates a writable test-isolated parent directory under the system tmpdir, registered for cleanup.
  - `buildEnvObserveScript(observe[])` — bash fixture template that observes `LOOPX_TMPDIR` plus `TMPDIR`/`TEMP`/`TMP` into separate marker files via uniquely-named `OBS_*_PATH` env vars to avoid shadowing the variable being observed.
- Adjacent suites: zero regressions across programmatic-api (346), env-vars (96), execution (85), loop-state (96), wfdir (40), signals (9), unit (143), harness (15).

### ADR-0004 §9.2 (process.env eager snapshot under runPromise) — RESOLVED

The `runPromise()` body at `packages/loop-extender/src/run.ts` previously snapshotted only the tmpdir parent eagerly; the inherited `process.env` and global env-file path (`XDG_CONFIG_HOME` / `HOME`-derived) were still read lazily inside `runInternal` after the microtask boundary, violating SPEC §9.2: "Under runPromise(), the inherited process.env snapshot is eager — captured synchronously at the runPromise() call site, before runPromise() returns. Mutations to process.env after runPromise() returns are not observed."

Implementation:
1. **`packages/loop-extender/src/env.ts`**:
   - `getGlobalEnvPath(envSnapshot?)` accepts optional snapshot; when provided, reads `XDG_CONFIG_HOME` / `HOME` from snapshot rather than live `process.env`.
   - `loadGlobalEnv(envPath?)` accepts optional pre-resolved path verbatim.
   - `mergeEnv(globalEnv, localEnv, inheritedEnv?)` spreads the inherited snapshot when provided, falling back to `process.env` for backward compatibility (preserves `run()` lazy semantics).
2. **`packages/loop-extender/src/run.ts`**: `InternalRunOptions` extended with `inheritedEnv?` and `globalEnvPath?`, threaded through `runWithInternal()` / `runInternal()`. `runPromise()` now captures three eager snapshots before the `await Promise.resolve()`: `eagerTmpdirParent` (existing), `eagerInheritedEnv = { ...process.env }` (new), `eagerGlobalEnvPath = getGlobalEnvPath(eagerInheritedEnv)` (new).

Now-passing tests (this iteration):
- **programmatic-api: 370 PASS** (was 358; +12 new tests under "SPEC: Inherited Env Snapshot Timing" — T-API-71/71a/71b/72/72a/72b × 2 runtimes). T-API-71/71a/71b verify `run()` lazy semantics (mutation between call and first `next()` observed; mid-run mutation frozen at first `next()`; XDG_CONFIG_HOME mutation redirects global env file lookup). T-API-72/72a/72b verify `runPromise()` eager semantics (mutation after return not observed; mid-run mutation not observed across iterations; XDG_CONFIG_HOME mutation does not redirect global env file lookup).
- Adjacent suites: zero regressions (tmpdir 389, env-vars 96, wfdir 40).

## P1 — REMAINING T-TMP-* subsections

These T-TMP IDs are not yet implemented as test cases or are blocked by missing infrastructure:

- **Renamed-Away and Mount-Point** — T-TMP-32, T-TMP-32a..32c, T-TMP-33.
- **Cleanup-Safety dispatch matrix** — T-TMP-34/34a/34b (renamed-away), T-TMP-35..35h (script-failure terminal cleanup-warning cardinality), T-TMP-36/36a/36b (mismatched-identity), T-TMP-37/37a..37e (recursive-removal walk semantics), T-TMP-38/39/38a/38a2/38b/38b-run/38b2/38b2-run/38c/38c2 (cleanup idempotence and at-most-one-warning under racing terminals), T-TMP-40 (lstat-fail), T-TMP-41 (symlink-unlink-fail), T-TMP-42/42a/42b/42c (recursive-remove-fail).

## P1 — Discovered open issues

(none currently open)

## P1 — Other ADR-0004 test suites still missing

- **T-API-50..59i** — `RunOptions.env` block (~80 IDs); the inherited-env snapshot-timing subset (T-API-71/71a/71b/72/72a/72b — lazy under `run()`, eager under `runPromise()`) is now in place. Remaining `RunOptions.env` shape / merge / precedence tests still need authoring.
- **T-API-60..62i4** — Pre-iteration ordering and options-snapshot tests (~60 tests).
- **T-API-63..69u** — Abort precedence, generator lifecycle, promise rejection (~150 tests). Note: T-API-66/66a/66b/66c/66d/66e (the API-surface counterparts to T-TMP-23/24a/24c/24d/24e/24f/24g — abort-after-final-yield × `.next()`/`.return()`/`.throw()` × maxIterations / stop:true matrix) are covered by the SPEC §9.3 wrapper implementation already in place; needs test authoring.
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
- **Bun-under-full-parallelism failures** — Running the entire `npm run test` matrix in full parallelism surfaces ~32 additional `[Bun]`-runtime failures across module-resolution / wfdir / execution / install test files. Confirmed pre-existing via `git stash`: the same 32 failures reproduce with this iteration's changes stashed, and they do NOT reproduce when running the e2e suites alone (e2e-only run shows 1 failure: T-INST-GLOBAL-01a above). Likely a parallelism / isolation issue in the test harness or Bun's loader behavior under concurrent test workers; unrelated to ADR-0004 and out of scope for this work.

## Notes

- `.loopx/.iteration.tmp` and `.loopx/ralph/.tmp/` appear in `git status` — left by prior loopx runs, not part of this work. Not tracked.
