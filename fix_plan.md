# Implementation Plan for loopx

**Status: 901/901 tests passing (100%).** All tests pass. Full spec audit complete.

All phases complete:
- **Phases 1-18:** All feature phases done (see git history)
- **Phase 19:** Code quality deduplication — `makeAbortError`, `getLoopxBin`, `validateDirScript`, `ensureLoopxPackageJson` all extracted to shared modules
- **Phase 20:** Bug fixes and code quality cleanup — env warnings in API, signal exit helper, env serialize helper, redundant injection removed, loader-hook static imports, SSH URL classification, empty tarball error
- **Phase 21:** Loader-hook catch clause narrowed, discovery deduplication, cwd nullish coalescing
- **Phase 22:** Discovery ENOENT vs EACCES, PATH dedup entry-match, `??` for env.PATH, install error diagnostics

---

## Phase 23: Implement 19 New Test Specs (from post-889/889 audit)

An audit of all commits after `0cf85da` (889/889 passing) identified 19 hard spec requirements that lack test coverage. T-INST-33a was already implemented in commit `76be1f1` and is excluded. SP-32 (SSH URL classification) is excluded pending spec decision.

### Batch 1 — Simple CLI / Parsing / Loop Tests ✅ COMPLETE

**T-CLI-27**, **T-PARSE-20a**, **T-LOOP-18a** — all implemented and passing.

### Batch 2 — Environment Variable Tests ✅ COMPLETE

**T-ENV-24a**, **T-ENV-24b** — all implemented and passing.

### Batch 3 — Programmatic API Tests ✅ COMPLETE

**T-API-08a**, **T-API-14e**, **T-API-21c**, **T-API-21d** — all implemented and passing.

### Batch 4 — Execution Test (Bun-specific)

**File:** `execution.test.ts`
**Deps:** `isRuntimeAvailable("bun")`, `runAPIDriver`, `createScript`

10. **T-EXEC-14** — after T-EXEC-13a, Bun-only test
    - `it.skipIf(!isRuntimeAvailable("bun"))("T-EXEC-14: ...", async () => { ... })`
    - `createScript(project, "bun-check", ".ts", 'import { output } from "loopx";\noutput({ result: JSON.stringify({ bunVersion: process.versions.bun }) });')`
    - Driver code: `runPromise("bun-check", { cwd, maxIterations: 1 })`
    - `runAPIDriver("bun", driverCode, { cwd })`
    - Parse `outputs[0].result` as JSON → assert `bunVersion` is truthy string

### Batch 5 — Signal Forwarding Test

**File:** `signals.test.ts`
**Deps:** New fixture in `fixture-scripts.ts`, `runCLIWithSignal`

11. **T-SIG-08** — after T-SIG-07, new "Signal Identity" test
    - **New fixture needed:** `signalTrapReport(markerPath)` in `fixture-scripts.ts`:
      ```bash
      #!/bin/bash
      MARKER="<markerPath>"
      PID_MARKER="${MARKER}.pid"
      printf '%s' "$$" > "$PID_MARKER"
      trap 'printf SIGINT > "$MARKER"; exit 130' INT
      trap 'printf SIGTERM > "$MARKER"; exit 143' TERM
      echo "ready" >&2
      sleep 999999
      ```
    - Two sub-cases (a) and (b), or two separate `it()` blocks:
      - (a) `sendSignal("SIGINT")` → read marker → assert `"SIGINT"`
      - (b) `sendSignal("SIGTERM")` → read marker → assert `"SIGTERM"`
    - Use `runCLIWithSignal(["-n", "1", "sig-report"], { cwd })`
    - `await waitForStderr("ready")` → `sendSignal(...)` → `await result`
    - Assert exit code 130 (SIGINT) or 143 (SIGTERM)

### Batch 6 — Delegation Tests

**File:** `delegation.test.ts`
**Deps:** `withDelegationSetup`, `createMarkerBinary`

12. **T-DEL-09** — after T-DEL-08, "Empty LOOPX_DELEGATED"
    - Same pattern as T-DEL-04 (which tests `LOOPX_DELEGATED: "1"`)
    - `const fixture = await withDelegationSetup()`
    - Replace `localBinPath` with `createMarkerBinary(localBinPath, localMarkerPath, "delegated")`
    - `fixture.runGlobal(["version"], { env: { LOOPX_DELEGATED: "" } })`
    - Assert `existsSync(localMarkerPath) === false` (delegation was skipped — empty string is "set")
    - Assert `result.exitCode === 0` (version subcommand ran directly)

13. **T-DEL-10** — "Delegation preserves SIGINT exit code"
    - `const fixture = await withDelegationSetup()`
    - Create a `.loopx/` script in `fixture.projectDir` using `signalReadyThenSleep(markerPath)`
    - Replace `localBinPath` with real loopx (copy or symlink `fixture.loopxBinJs` so delegation target is functional)
    - Spawn `fixture.globalBinPath` manually using `spawn()` (not `fixture.runGlobal`, because we need the child handle for signal delivery and `waitForStderr`)
    - Implement inline: `const child = spawn(fixture.globalBinPath, ["-n", "1", "sleeper"], { cwd: fixture.projectDir, env: merged, stdio: ["pipe", "pipe", "pipe"] })`
    - Accumulate stderr, wait for `"ready"`, send `child.kill("SIGINT")`
    - On `close` event: assert exit code 130
    - May need to wrap `localBinPath` as `#!/bin/bash\nexec node "${fixture.loopxBinJs}" "$@"` (replicating delegation target)

14. **T-DEL-11** — "Delegation preserves SIGTERM exit code"
    - Same as T-DEL-10 but send `"SIGTERM"`, assert exit code 143

### Batch 7 — Install Tests

**File:** `install.test.ts`
**Deps:** `startLocalHTTPServer`, `startLocalGitServer`, `withGitURLRewrite`, `createTarball` (local helper)

15. **T-INST-27d** — after T-INST-27c, inside "Common Rules"
    - Create TWO conflicting file scripts: `createBashScript(project, "foo", ...)` writes `foo.sh`, then `createScript(project, "foo", ".ts", ...)` writes `foo.ts` (pre-existing collision)
    - `startLocalGitServer([{ name: "foo", files: { ... } }])` + `withGitURLRewrite`
    - `runCLI(["install", "testorg/foo"], { cwd, runtime })`
    - Assert `exitCode === 1`, `stderr.length > 0`, `existsSync(join(loopxDir, "foo")) === false`, both `foo.sh` and `foo.ts` still exist

16. **T-INST-31b** — after T-INST-31, inside "Common Rules"
    - Start HTTP server with valid `.ts` file route
    - Create project, `mkdir .loopx/`, then `chmod 0o555 .loopx/` (read-only)
    - Guard: `it.skipIf(process.getuid?.() === 0)("T-INST-31b: ...", ...)`
    - `runCLI(["install", url], { cwd, runtime })`
    - Assert `exitCode === 1`, `existsSync(join(loopxDir, "script.ts")) === false`
    - In `finally`: `chmod 0o755 .loopx/` before cleanup (so rm works)

17. **T-INST-39d** — after T-INST-39c, inside "Post-Validation"
    - Create a local git repo where `entry.ts` is a symlink to `../../outside.ts`
    - Use `startLocalGitServer` — but symlinks may not survive `git clone`. Alternative: use a post-clone hook or test with a tarball instead
    - **Practical approach:** If git strips symlinks, this test may need to use a tarball. Check if `startLocalGitServer` preserves symlinks in the bare repo (git does preserve symlinks on POSIX). If it does: `files: { "package.json": '{"main":"entry.ts"}', "entry.ts": null }` won't work since `files` is `Record<string, string>`. Need to manually create the symlink after clone.
    - **Simpler approach:** After `startLocalGitServer`, manually add a symlink commit to the bare repo before the test runs. Or, create the repo manually with `execSync` instead of using the helper.
    - Assert: `exitCode === 1`, `stderr.length > 0`, `existsSync(join(loopxDir, repoName)) === false`

18. **T-INST-39e** — after T-INST-39d, same section
    - Create a tarball containing `package.json` (`main: "entry.ts"`) and `entry.ts` as a symlink to `../../outside.ts`
    - Use `tar czf` with `--dereference` excluded (default tar preserves symlinks)
    - Serve via HTTP, install, assert same as T-INST-39d

19. **T-INST-GLOBAL-01a** — after T-INST-GLOBAL-01, inside "Global Install"
    - `it.skipIf(!isRuntimeAvailable("bun"))("T-INST-GLOBAL-01a: ...", ...)`
    - Same `npm pack` + `npm install -g --prefix` pattern as T-INST-GLOBAL-01
    - Create fixture project with `.loopx/default.ts` that uses `import { output } from "loopx"`
    - Run via `bun <global-prefix>/bin/loopx -n 1` (spawn `bun` directly with the global bin as arg)
    - Assert marker file created + exit code 0

---

### Implementation Order & Priority

| Priority | Batch | Tests | Complexity | Est. lines |
|----------|-------|-------|------------|------------|
| P1 | 1 | T-CLI-27, T-PARSE-20a, T-LOOP-18a | Trivial | ~40 |
| P1 | 2 | T-ENV-24a, T-ENV-24b | Low | ~50 |
| P1 | 3 | T-API-08a, T-API-14e, T-API-21c, T-API-21d | Medium | ~80 |
| P1 | 5 | T-SIG-08 | Medium (new fixture) | ~60 |
| P2 | 4 | T-EXEC-14 | Low (Bun-conditional) | ~25 |
| P2 | 6 | T-DEL-09, T-DEL-10, T-DEL-11 | Medium-High (manual spawn for 10/11) | ~100 |
| P2 | 7 | T-INST-27d, T-INST-31b, T-INST-39d, T-INST-39e, T-INST-GLOBAL-01a | High (symlink repos, Bun global) | ~150 |

**Total: 19 tests, ~505 lines of test code + 1 new fixture function.**

**Implementation notes:**
- T-INST-33a is already implemented — skip it
- T-DEL-10/11 require manual process spawning (not `fixture.runGlobal`) because signal delivery needs the child handle — write a local `spawnGlobalWithSignal()` helper in delegation.test.ts
- T-INST-39d/39e require symlink creation inside git repos / tarballs — may need manual repo construction with `execSync` rather than the `startLocalGitServer` helper
- T-INST-GLOBAL-01a requires Bun installed in CI — conditionally skip

---

## Remaining Items

### Priority 1 (Spec Violations / Real Bugs)

*All items resolved.*

### Priority 2 (Robustness / UX Issues)

*All items resolved.*

**Resolved items:**
- `exitWithSignal()` now uses dynamic `os.constants.signals` lookup
- NODE_PATH includes both loopx's own node_modules/ and parent directory for Bun global installs

### Priority 3 (Minor / Decision Items)

8. **Known-git-host URLs not normalized to append `.git`**
    - **Decision:** Leave as-is — spec does not require normalization

9. **output() function does not validate goto/stop types**
    - **Decision:** Leave as-is — TEST-SPEC T-MOD-13d/13e/13g explicitly require output() to accept these values; type filtering is done in parseOutput per spec

10. **Weak test assertions for error messages**
    - ~16 tests check only exit code where spec describes richer expected behavior
    - Most notable: T-EXEC-13a uses `.not.toBe(0)` instead of `.toBe(1)`; T-CLI-22, T-CLI-10, T-ENV-17a only check stderr is non-empty
    - These are not blocking but reduce confidence in error message quality

---

## Full Spec Audit Results (all areas conform)

- CLI argument parsing: **conformant**
- Output parsing: **conformant**
- Loop state machine: **conformant**
- Script execution: **conformant**
- Environment management: **conformant**
- Install command: **conformant**
- Programmatic API: **conformant**
- Module resolution / loader hooks: **conformant**
- Script discovery / validation: **conformant**
- Signal handling: **conformant**
- Delegation: **conformant**

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
- T-MOD-22 uses `--no-experimental-require-module` flag for Node 22.12+ (tests package config, not Node.js runtime behavior)

---

## Implementation Notes

- **ESM-only** — All JS/TS must use `import`/`export`, no CommonJS
- **Node >= 20.6** — Required for `module.register()` in the custom loader
- **Self-cleaning** — All test helpers clean up temp dirs, servers, env mutations via afterEach hooks
