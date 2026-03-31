# Implementation Plan for loopx

Full implementation plan for the `loopx` CLI tool and library per SPEC.md and TEST-SPEC.md.

**Status: 661/719 tests passing.** Phases 1-9, 11 complete. Remaining work in Phases 10, 12-16.

---

## Priority Legend

- **P0** — Core functionality: loop state machine, structured output parsing, script execution
- **P1** — Essential user-facing: environment variables, CLI options, subcommands
- **P2** — Important but less frequent: install command, CLI delegation, signal handling
- **P3** — Defense in depth: edge cases, fuzz test compatibility

---

## Phase 1: Project Scaffolding — [x] COMPLETE

## Phase 2: Internal Parsers (P0) — [x] COMPLETE

All three parsers (`parseOutput`, `parseEnvFile`, `classifySource`) passing. Type exports and harness tests passing.

## Phase 3: Script Discovery & Validation (P0) — [x] COMPLETE

63/64 tests passing. Only T-DISC-46 (install-related) fails.

## Phase 4: Script Execution Engine (P0) — [x] COMPLETE

All execution tests pass.

## Phase 5: Module Resolution Hook (P0) — [x] COMPLETE

`loader-register.ts` + `loader-hook.ts` working. `output()` and `input()` functions working.

## Phase 6: Loop State Machine (P0) — [x] COMPLETE

50/50 loop-state tests pass.

## Phase 7: CLI Interface & Argument Parsing (P1) — [x] COMPLETE

80/80 cli-basics tests pass.

## Phase 8: Subcommands (P1) — [x] COMPLETE

32/32 subcommands tests pass. `version`, `output`, and `env` subcommands all working.

## Phase 9: Environment Variable Management (P1) — [x] COMPLETE

All env-vars tests pass.

## Phase 11: Help System (P1) — [x] COMPLETE

Help tests pass within cli-basics suite.

---

## Phase 10: Programmatic API (P1) — IN PROGRESS

*(Spec 9.1-9.5)*

### 10a. `run(scriptName?, options?): AsyncGenerator<Output>`

- [x] Returns generator that yields `Output` per iteration
- [x] Snapshots `cwd` and options at call time (mutations after call have no effect)
- [x] All errors surfaced lazily on first `next()` (validation, missing scripts, etc.)
- [x] `break`/`generator.return()`: terminate active child (SIGTERM -> SIGKILL after 5s), complete silently
- [ ] `AbortSignal`: terminate active child, generator throws abort error (even between iterations)
- [ ] Pre-aborted signal: throw immediately on first `next()`, no child spawned
- [x] `maxIterations: 0` -> complete immediately with no yields
- [x] Invalid `maxIterations` (negative, non-integer, NaN) -> throw on first `next()`

### 10b. `runPromise(scriptName?, options?): Promise<Output[]>`

- [x] Collects all outputs from `run()` into array
- [x] Rejects on any error; partial outputs not available
- [x] Same option semantics as `run()`

### 10c. Type exports

- [x] `Output { result?: string; goto?: string; stop?: boolean }`
- [x] `RunOptions { maxIterations?: number; envFile?: string; signal?: AbortSignal; cwd?: string }`

---

## Phase 12: Signal Handling (P2) — IN PROGRESS

*(Spec 7.3)*

- [ ] **SIGINT/SIGTERM** — Forward to active child process group (not just direct child)
- [ ] **Grace period** — Wait 5 seconds after forwarding; SIGKILL process group if still alive
- [ ] **Exit code** — `128 + signal number` (130 for SIGINT, 143 for SIGTERM)
- [ ] **Between iterations** — If no child running, exit immediately with signal code
- [ ] **Process group** — Spawn children with `detached: true` + negative PID for `process.kill(-pid, signal)` to reach grandchildren

Key failures: T-EXIT-12 (SIGINT -> 130), T-EXIT-13 (SIGTERM -> 143), T-SIG-01 through T-SIG-07.

---

## Phase 13: CLI Delegation (P2) — NOT STARTED

*(Spec 3.2)*

- [ ] **Search for local binary** — Walk from CWD upward looking for `node_modules/.bin/loopx`
- [ ] **Delegate** — Spawn the local binary with same args, inherit stdio; set `LOOPX_DELEGATED=1`
- [ ] **Recursion guard** — If `LOOPX_DELEGATED=1` is set, skip delegation
- [ ] **`LOOPX_BIN`** — Set to resolved realpath of effective binary (post-delegation)
- [ ] **Before command handling** — Delegation must occur before any subcommand/run dispatch
- [ ] **Tests:** T-DEL-01 through T-DEL-08 (8 tests)

---

## Phase 14: Install Command (P2) — NOT STARTED

*(Spec 10.1-10.3)*

- [ ] **Source detection** — Use `classifySource()` to determine type
- [ ] **Single-file** — Download file, derive name from URL (strip query/fragment), validate extension, place in `.loopx/`
- [ ] **Git** — `git clone --depth 1` into `.loopx/<repo-name>/`; validate directory script rules; remove on failure
- [ ] **Tarball** — Download, extract; single top-level dir -> unwrap; validate directory script rules; remove on failure
- [ ] **Create `.loopx/`** if it doesn't exist
- [ ] **Collision checks** — Destination path collision (any filesystem entry) -> error. Script name collision (across all discovered scripts) -> error
- [ ] **Name validation** — Reserved names and name restrictions checked before saving
- [ ] **No auto-install** — Don't run `npm install` / `bun install` after clone/extract
- [ ] **Failure cleanup** — Remove any partially created files/directories
- [ ] **Tests:** T-INST-01 through T-INST-GLOBAL-01 (47 tests), plus T-DISC-46

---

## Phase 15: Exit Codes (Cross-Cutting) — MOSTLY COMPLETE

*(Spec 12)*

- [x] `0` — Clean exit (stop, -n limit, -n 0, successful subcommand)
- [x] `1` — Error (script non-zero, validation failure, invalid goto, missing script/dir, usage error)
- [ ] `128+N` — Signal (130 SIGINT, 143 SIGTERM) — blocked on Phase 12

---

## Phase 16: Edge Cases & Hardening (P3) — IN PROGRESS

- [x] Very long result strings (~1 MB) without truncation *(T-EDGE-01)*
- [x] JSON-special characters round-trip correctly *(T-EDGE-02)*
- [x] Partial stdout writes captured as unit *(T-EDGE-03)*
- [ ] Stdout/stderr stream separation *(T-EDGE-04)* — stdout captured but test checks stdout field (may need API driver fix)
- [x] Unicode in values preserved; unicode in script names rejected *(T-EDGE-05)*
- [x] Deep goto chains (26+ scripts) *(T-EDGE-06)*
- [ ] No deadlock when script reads empty stdin *(T-EDGE-07)* — stdin deadlock prevention needed
- [x] Large `-n` values without overflow *(T-EDGE-11)*
- [x] Empty `.loopx/` directory errors *(T-EDGE-12)*
- [ ] Env file without trailing newline *(T-EDGE-14)* — edge case with observeEnv fixture
- [ ] Empty env file (0 bytes) *(T-EDGE-15)* — edge case with observeEnv fixture

---

## Remaining Failure Summary (58 tests)

| Area | Key Tests | Blocker |
|------|-----------|---------|
| Programmatic API (AbortSignal) | T-API abort tests | AbortSignal/early termination handling |
| Signal Handling | T-SIG-01 through T-SIG-07 | Process group signal forwarding |
| Signal Exit Codes | T-EXIT-12, T-EXIT-13 | 128+N exit codes |
| CLI Delegation | T-DEL-01 through T-DEL-08 | Not implemented |
| Install Command | T-INST-*, T-DISC-46 | Not implemented |
| Edge Cases | T-EDGE-04, T-EDGE-07, T-EDGE-14, T-EDGE-15 | Various fixes needed |

---

## Known Minor Test Harness Deviations (documented, not blocking)

These are cosmetic deviations in the test harness that do not affect correctness. They should not be "fixed" — the implementation should conform to SPEC.md, not to the test's deviation.

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
