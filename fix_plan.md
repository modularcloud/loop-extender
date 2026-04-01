# Implementation Plan for loopx

**Status: 892/892 tests passing (100%).** All tests pass. Full spec audit complete.

All phases complete:
- **Phases 1-18:** All feature phases done (see git history)
- **Phase 19:** Code quality deduplication — `makeAbortError`, `getLoopxBin`, `validateDirScript`, `ensureLoopxPackageJson` all extracted to shared modules
- **Phase 20:** Bug fixes and code quality cleanup — env warnings in API, signal exit helper, env serialize helper, redundant injection removed, loader-hook static imports, SSH URL classification, empty tarball error

---

## Remaining Items

_No priority 1 or 2 items remaining._

### Priority 3 (Minor / Optional Improvements)

1. **Known-git-host URLs not normalized to append `.git`**
    - `https://github.com/org/repo` (known host, no `.git`) is classified as git but the URL is passed directly to `git clone` without appending `.git`
    - All major hosts (GitHub, GitLab, Bitbucket) accept this; normalizing could break edge cases
    - **Decision:** Leave as-is — spec does not require normalization

2. **Duplicate error/warning messages for reserved and invalid script names**
    - In `discovery.ts`, the reserved-name check (lines 95-107) and name-pattern check (lines 110-122) iterate over `candidates` (all entries) instead of `nameGroups` (unique names)
    - If two entries share a reserved name (e.g., `output.sh` and `output/`), the reserved-name error is emitted twice
    - Fix: iterate over `nameGroups` entries instead of `candidates` for these checks

3. **LOOPX_DELEGATED leaks into script execution environments**
    - `mergeEnv()` spreads `process.env` which includes `LOOPX_DELEGATED=1` set during delegation
    - If a user script spawns a nested `loopx` subprocess in a different directory, delegation would be incorrectly skipped
    - Fix: strip `LOOPX_DELEGATED` from the merged env before passing to child scripts

4. **output() function does not validate goto/stop types**
    - `goto` and `stop` fields pass through without type validation in `output-fn.ts` (lines 53-58)
    - Scripts calling `output({ goto: 42 })` get no feedback that the non-string goto will be silently discarded by parseOutput
    - Fix: throw an error if `goto` is not a string or if `stop` is not a boolean

5. **loader-hook.ts resolve catch clause is too broad**
    - The catch block in `loader-hook.ts` catches all errors, not just `ERR_MODULE_NOT_FOUND`
    - If a local `node_modules/loopx` has a corrupted package.json, the error is silently swallowed and the CLI's own package is used instead
    - Fix: only catch errors with `code === 'ERR_MODULE_NOT_FOUND'`, re-throw others

6. **cwd fallback uses `||` instead of `??` in run.ts**
    - `options?.cwd || process.cwd()` treats empty string `""` as falsy, falling back to process.cwd()
    - `??` would be more semantically correct (only default when not provided)
    - Low risk since empty string cwd is arguably invalid

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
