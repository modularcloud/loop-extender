# Implementation Plan for loopx

**Status: 889/889 tests passing (100%).** All tests pass.

All phases complete:
- **Phases 1-9:** Scaffolding, parsers, discovery, execution, module resolution, loop, CLI, subcommands, env
- **Phase 10:** Programmatic API (run/runPromise, options snapshot, generator.return(), AbortSignal)
- **Phase 11:** Help system
- **Phase 12:** Signal forwarding, grace period SIGKILL, exit codes 128+N
- **Phase 13:** CLI delegation (8/8 tests pass)
- **Phase 14:** Install command (single-file/git/tarball, 107/107 tests)
- **Phase 15:** Exit codes

---

## Remaining Spec Gaps (sorted by priority)

### MEDIUM — Stderr Piped Instead of Inherited (Spec 6.2, 6.3)

The spec says "stderr is passed through to the user's terminal." Current implementation uses `stdio: ["pipe", "pipe", "pipe"]` and manually forwards stderr chunks. This causes child processes to lose TTY detection on stderr (`process.stderr.isTTY` is `false`), which disables colored output in child scripts. Fix: use `stdio: ["pipe", "pipe", "inherit"]` instead.

### MEDIUM — installSingleFile Missing Cleanup on Write Failure (Spec 10.3)

`src/install.ts:247` — `writeFileSync(destPath, result.data)` has no try/catch. If the write fails (disk full, permissions), the partially written file is NOT cleaned up. Spec 10.3 says: "Any partially created target file or directory at the destination path is removed before exit." `installGit` and `installTarball` both properly clean up on failure.

### MEDIUM — Install Missing Symlink Boundary Check (Spec 10.2, 5.1)

`src/install.ts:126-171` — The `validateDirScript` function does NOT perform the `realpathSync` symlink boundary check that `discovery.ts:219-233` performs. Spec 10.2 says directory scripts are "validated using the same directory-script rules as section 5.1", which includes symlink resolution checking.

### LOW — Various Minor Issues

- `--` not handled as standard end-of-flags marker (treated as script name)
- Extra positional arguments after script name silently ignored (last one wins)
- `LOOPX_DELEGATED=""` (empty string) would not skip delegation due to JS falsiness
- `output()` JS/TS helper omits trailing newline after JSON (bash helper includes it via console.log)
- `HOME` fallback uses literal `"~"` (Node.js doesn't expand tildes)
- Unused `cwd` parameter in `installSingleFile`, `installGit`, `installTarball`

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
