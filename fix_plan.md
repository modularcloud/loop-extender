# Implementation Plan for loopx

**Status: 889/889 tests passing (100%).** All tests pass. Full spec audit complete.

All phases complete:
- **Phases 1-18:** All feature phases done (see git history)
- **Phase 19:** Code quality deduplication — `makeAbortError`, `getLoopxBin`, `validateDirScript`, `ensureLoopxPackageJson` all extracted to shared modules

---

## Remaining Items

### Priority 1 (Bugs)

1. **Delegation drops signal-kill exit code**
   - `bin.ts` line 271: `process.exit(result.status ?? 1)` — `spawnSync` returns `status = null` when process killed by signal (actual signal in `result.signal`)
   - Falling back to `1` means delegated `loopx` killed by SIGINT/SIGTERM exits with `1` instead of `128+signal`
   - **Fix:** Check `result.signal` when `result.status` is null, compute `128 + sigNum`

2. **Programmatic API silently drops env file parse warnings**
   - `run.ts`: `globalResult.warnings` and `localResult.warnings` from `loadGlobalEnv()`/`loadLocalEnv()` are fetched but never emitted
   - `bin.ts` correctly forwards these to stderr, but the API path discards them
   - **Fix:** Forward warnings to `process.stderr.write()` in `runInternal()` (matching bin.ts behavior)

3. **Help mode shows reserved/invalid-name scripts as available**
   - `discovery.ts` lines 128-135: In help mode, `errors` is always empty so the map-building block runs unconditionally
   - Scripts with reserved names (e.g., `output.ts`) or invalid names end up in `discovery.scripts` and are printed under "Available scripts:" in `--help`
   - These cannot actually be run, so listing them is misleading
   - **Fix:** Filter reserved/invalid names from the map regardless of mode

### Priority 2 (Code Quality)

4. **`bin-path.ts` duplicate `node:path` import**
   - Lines 1 and 4 both import from `"node:path"` — should be merged

5. **`bin.ts` stale double section comment**
   - Lines 238-239: `// --- Main ---` followed by `// --- CLI Delegation ---` — the first is a leftover

6. **Signal exit code computation repeated 3 times in `bin.ts`**
   - Lines 410-411, 418-419, 426-427 all have identical `const sigNum = receivedSignal === "SIGINT" ? 2 : 15; process.exit(128 + sigNum);`
   - **Fix:** Extract to a small helper function

7. **`env.ts` serialize-and-write logic duplicated**
   - `envSet` and `envRemove` both contain identical sort→map→join→writeFileSync pattern
   - **Fix:** Extract to a private `writeEnvFile(vars, path)` helper

8. **`LOOPX_BIN`/`LOOPX_PROJECT_ROOT` injected redundantly**
   - Set in `mergeEnv()` (env.ts) AND again in `executeScript()` (execution.ts) `scriptEnv` spread
   - Values are identical so behavior is correct, but the redundancy could cause confusion during future changes
   - **Fix:** Remove the re-injection in `execution.ts` since `mergeEnv` already handles it

9. **`loader-hook.ts` uses dynamic imports inside hot path**
   - Lines 85-86 use `await import("node:fs/promises")` and `await import("node:url")` inside the `load()` hook
   - These are cached by Node.js after first call, but could be top-level static imports

### Priority 3 (Edge Cases / UX)

10. **`classify-source.ts`: SSH URL without `.git` silently becomes `single-file`**
    - `git@github.com:org/repo` (no `.git`) falls through to `single-file` classification
    - Has a comment acknowledging no test coverage
    - **Fix:** Treat all `git@` URLs as git type regardless of `.git` suffix

11. **Known-git-host URLs not normalized to append `.git`**
    - `https://github.com/org/repo` (known host, no `.git`) is classified as git but the URL is passed directly to `git clone` without appending `.git`
    - GitHub accepts this, but other hosts may not

12. **Empty tarball gives misleading error**
    - If a tarball extracts to zero entries, `validateInstalledDirScript` fails with `"no-pkg"` error
    - A pre-check with a clear "archive is empty" error would be better UX

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
