# Implementation Plan for loopx

Full implementation plan for the `loopx` CLI tool and library per SPEC.md and TEST-SPEC.md.

**Status: Phase 1 and Phase 2 complete.** The test harness (461 tests) is in place, project scaffolding is done, and all internal parsers are implemented and passing. Next up: Phase 3 (Script Discovery & Validation).

---

## Priority Legend

- **P0** — Core functionality: loop state machine, structured output parsing, script execution
- **P1** — Essential user-facing: environment variables, CLI options, subcommands
- **P2** — Important but less frequent: install command, CLI delegation, signal handling
- **P3** — Defense in depth: edge cases, fuzz test compatibility

---

## Phase 1: Project Scaffolding — COMPLETE

- [x] **Create the `loopx` package directory** — Set up `src/` directory for product code. Create `package.json` with `name: "loopx"`, `type: "module"`, `bin` field pointing to CLI entry point, `exports` field for public API (`"."` for `run`, `runPromise`, `output`, `input`, `Output`, `RunOptions`) and `"./internal"` for `parseOutput`, `parseEnvFile`, `classifySource`. *(Spec 1, TEST-SPEC 1.4)*
- [x] **Create `tsconfig.build.json` for product code** — ESM target, Node 20.6+ lib, strict mode. Emit `.d.ts` files for type exports. Builds `src/` to `dist/`. *(Spec 1)*
- [x] **Create CLI entry point** (`src/bin.ts`) — Minimal entry point (stub for now). *(Spec 4)*
- [x] **Build system** — `scripts/postbuild.mjs` generates `dist/package.json` and creates `node_modules/loopx` symlink. Build via `npm run build`. *(Spec 1)*
- [x] **Wire test harness** — Test helpers resolve the built `loopx` package via `node_modules/loopx` symlink. *(TEST-SPEC 2.3)*

---

## Phase 2: Internal Parsers (P0) — COMPLETE

These are pure functions with no I/O. They unblock unit tests, fuzz tests, and are used by all higher-level features.

### 2a. `parseOutput(stdout: string): Output` *(Spec 2.3, TEST-SPEC 1.4)* — 48/48 tests pass

- [x] Parse stdout as JSON; if not valid JSON or not an object, return `{ result: stdout }` (raw fallback)
- [x] If valid JSON object: extract `result`, `goto`, `stop` fields only
- [x] If no known fields have defined values after type filtering, return `{ result: stdout }` (raw fallback)
- [x] `result`: if present and not string, coerce via `String(value)` (including `null` -> `"null"`)
- [x] `goto`: if present and not a string, discard (treat as absent)
- [x] `stop`: if not exactly `true` (boolean), discard
- [x] Empty stdout (0 bytes) -> `{ result: "" }`
- [x] Extra fields silently ignored

### 2b. `parseEnvFile(content: string): { vars, warnings }` *(Spec 8.1, TEST-SPEC 1.4)* — 51/51 tests pass

- [x] One `KEY=VALUE` per line; split on first `=`
- [x] No whitespace allowed around `=` (key extends to first `=`)
- [x] Lines starting with `#` are comments; blank lines ignored
- [x] Duplicate keys: last wins
- [x] Optional double/single quote wrapping (matched pairs stripped, unmatched preserved literally)
- [x] No escape sequence interpretation
- [x] Trailing whitespace trimmed from unquoted values
- [x] Key validation: `[A-Za-z_][A-Za-z0-9_]*`; invalid keys produce warnings
- [x] Lines without `=` or with invalid keys produce warnings
- [x] Return `{ vars: Record<string, string>, warnings: string[] }`

### 2c. `classifySource(source: string): { type, url }` *(Spec 10.1, TEST-SPEC 1.4)* — 44/44 tests pass

- [x] `org/repo` shorthand -> `{ type: "git", url: "https://github.com/org/repo.git" }`; reject if repo ends in `.git`
- [x] Known hosts (github.com, gitlab.com, bitbucket.org) with pathname `/<owner>/<repo>[.git][/]` -> git
- [x] Known hosts with extra path segments -> continue to remaining rules
- [x] URL ending in `.git` -> git
- [x] URL pathname ending in `.tar.gz` or `.tgz` -> tarball
- [x] Everything else -> single-file

### 2d. Export barrel (`src/internal.ts`) *(TEST-SPEC 1.4)*

- [x] Export `parseOutput`, `parseEnvFile`, `classifySource` from `"loopx/internal"`
- [x] Configure `package.json` `exports["./internal"]` subpath

### 2e. Type exports and API stubs — 14/14 type tests pass

- [x] `Output { result?: string; goto?: string; stop?: boolean }`
- [x] `RunOptions { maxIterations?: number; envFile?: string; signal?: AbortSignal; cwd?: string }`
- [x] `run` and `runPromise` function signatures exported from `"loopx"`

### 2f. Harness tests — 15/15 pass

---

## Known Test Issues

1. **F-ENV-04 fuzz test** — The test's expected value does not account for trailing whitespace trimming. Counterexample: `A= ` expects `" "` but spec says trim trailing whitespace from unquoted values, so correct result is `""`. Unit test T-ENV-18 explicitly confirms trimming is correct. This is a test harness discrepancy, not an implementation bug.

2. **F-PARSE-04 e2e fuzz test** — This is an end-to-end fuzz test that requires the CLI loop engine implementation (Phase 4 + Phase 6) to pass. Expected failure at this stage of development.

---

## Phase 3: Script Discovery & Validation (P0) — NEXT PRIORITY

*(Spec 5.1-5.4)*

This phase is P0 and unblocks Phase 4+ (execution, loop). It should be implemented next.

- [ ] **Scan `.loopx/` directory** — Discover file scripts (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`) and directory scripts (`package.json` with `main` field)
- [ ] **File scripts** — Base name = script name (filename minus extension)
- [ ] **Directory scripts** — Validate `package.json`: readable valid JSON, `main` is string, supported extension, doesn't escape directory, target file exists. Emit warnings to stderr for invalid directories
- [ ] **Symlink support** — Follow symlinks during discovery; `main` must still resolve within directory boundary after resolution
- [ ] **Name collision detection** — Multiple entries with same script name -> refuse to start with error listing conflicts
- [ ] **Reserved name check** — `output`, `env`, `install`, `version` -> refuse to start
- [ ] **Name restriction check** — Must match `[a-zA-Z0-9_][a-zA-Z0-9_-]*`; in run mode: error; in help mode: warning + still listed
- [ ] **Cache discovery results** — Scripts discovered once at loop start; changes to `.loopx/` mid-loop not detected; file content changes take effect (re-read from disk each iteration)
- [ ] **Tests unlocked:** T-DISC-01 through T-DISC-50 (55 tests)

---

## Phase 4: Script Execution Engine (P0)

*(Spec 6.1-6.4)*

- [ ] **Working directory** — File scripts: CWD = invocation directory. Directory scripts: CWD = script's own directory
- [ ] **Inject `LOOPX_PROJECT_ROOT`** — Absolute path of invocation directory into every script's env
- [ ] **Inject `LOOPX_BIN`** — Resolved realpath of effective binary into every script's env
- [ ] **Bash scripts** — Execute via `/bin/bash <script>` (not shebang). Capture stdout, pass through stderr
- [ ] **JS/TS scripts (Node)** — Execute via `tsx` with `--import` flag for module resolution hook. Capture stdout, pass through stderr
- [ ] **JS/TS scripts (Bun)** — Execute via `bun` with `NODE_PATH` set. Capture stdout, pass through stderr
- [ ] **Directory scripts** — Read `main` from `package.json`, execute entry point using same rules as file scripts
- [ ] **Input piping** — Write `result` string to child's stdin when `goto` is present; empty stdin otherwise
- [ ] **Tests unlocked:** T-EXEC-01 through T-EXEC-18a (20 tests)

---

## Phase 5: Module Resolution Hook (P0)

*(Spec 3.3)*

- [ ] **Node.js `--import` hook** — Create a registration module (`src/loader.ts` or similar) that uses `module.register()` to install a custom resolve hook intercepting bare specifier `"loopx"` and resolving to the running CLI's package exports
- [ ] **Bun `NODE_PATH`** — Set `NODE_PATH` to include the loopx package directory when spawning scripts under Bun
- [ ] **Post-delegation resolution** — When delegation occurred, resolve to the local (delegated-to) version's package

### 5a. `output()` function *(Spec 6.5)*

- [ ] Writes structured JSON to stdout, flushes, calls `process.exit(0)`
- [ ] Non-object values: serialize as `{ result: String(value) }`
- [ ] Objects: must have at least one known field (`result`, `goto`, `stop`) with a defined value; else throw
- [ ] `null`/`undefined` arguments: throw
- [ ] Arrays with no known fields: throw
- [ ] `undefined` properties omitted from JSON serialization

### 5b. `input()` function *(Spec 6.6)*

- [ ] Returns `Promise<string>` reading from stdin
- [ ] Empty string on first iteration (no prior input)
- [ ] Cached: multiple calls return same value
- [ ] **Tests unlocked:** T-MOD-01 through T-MOD-22 (26 tests)

---

## Phase 6: Loop State Machine (P0)

*(Spec 2.2, 7.1, 7.2)*

- [ ] **Basic loop** — Execute starting target, parse output, increment counter, check stop/goto/reset
- [ ] **`goto` transitions** — Validate target exists in cached discovery; pipe `result` to next script's stdin
- [ ] **Loop reset** — When no `goto`, restart from starting target with empty stdin
- [ ] **Self-referencing goto** — `goto: "self"` is a normal transition counting as an iteration
- [ ] **`-n` / `maxIterations` counting** — Count every execution including goto hops; `-n 0` validates then exits
- [ ] **`stop: true`** — Takes priority over `goto`; halt loop, exit 0
- [ ] **Error handling** — Non-zero exit from script: stop immediately, exit 1; stdout not parsed on failure. Invalid goto target: error to stderr, exit 1
- [ ] **Final iteration output** — Always yielded/observed before termination
- [ ] **Tests unlocked:** T-LOOP-01 through T-LOOP-25 (25 tests)

---

## Phase 7: CLI Interface & Argument Parsing (P1)

*(Spec 4.1-4.2)*

- [ ] **Argument parsing** — Parse `-n <count>`, `-e <path>`, `-h`/`--help`, subcommands (`version`, `output`, `env`, `install`), and script name
- [ ] **Help flag precedence** — `-h`/`--help` takes precedence over everything (other flags, script names, subcommands); exits 0
- [ ] **Duplicate flag detection** — Repeating `-n` or `-e` is a usage error (exit 1)
- [ ] **`-n` validation** — Must be non-negative integer; negative, non-integer, non-numeric -> exit 1
- [ ] **`-e` validation** — File must exist and be readable; missing -> exit 1
- [ ] **Validation order** — Discovery validation and env file loading happen before `-n 0` short-circuit
- [ ] **CLI stdout silence** — Never print `result` to CLI's own stdout
- [ ] **Default script** — No script name + no `default` script -> exit 1 with suggestion to create one
- [ ] **Tests unlocked:** T-CLI-01 through T-CLI-23 (37 tests)

---

## Phase 8: Subcommands (P1)

### 8a. `loopx version` *(Spec 4.3)*

- [ ] Print bare version string from `package.json` + newline, exit 0
- [ ] No `.loopx/` required

### 8b. `loopx output` *(Spec 4.3)*

- [ ] Parse `--result`, `--goto`, `--stop` flags; at least one required
- [ ] Print valid JSON to stdout, exit 0
- [ ] Handle special characters (quotes, backslashes, newlines) correctly in JSON serialization
- [ ] No `.loopx/` required

### 8c. `loopx env set/remove/list` *(Spec 4.3, 8.1)*

- [ ] **`env set <name> <value>`** — Validate name matches `[A-Za-z_][A-Za-z0-9_]*]`; reject `\n`/`\r` in values; serialize as `KEY="<literal value>"\n`; create config dir if needed; read existing file first (to preserve other entries)
- [ ] **`env remove <name>`** — Remove key; silent no-op if not present; exit 0
- [ ] **`env list`** — Print all vars sorted lexicographically as `KEY=VALUE` per line; no output if empty
- [ ] Global config at `$XDG_CONFIG_HOME/loopx/env` (default `~/.config/loopx/env`)
- [ ] Unreadable env file -> exit 1 with error
- [ ] No `.loopx/` required for any env subcommand

### 8d. **Tests unlocked:** T-SUB-01 through T-SUB-19 (30 tests)

---

## Phase 9: Environment Variable Management (P1)

*(Spec 8.1-8.3)*

- [ ] **Load global env** — Parse `$XDG_CONFIG_HOME/loopx/env` using `parseEnvFile`; treat missing file/dir as empty
- [ ] **Load local env** — Parse `-e` file using same rules; merge with global (local wins)
- [ ] **Injection precedence** — (1) `LOOPX_BIN`, `LOOPX_PROJECT_ROOT` always override; (2) local env; (3) global env; (4) inherited system env
- [ ] **Cache at loop start** — Env loaded once and cached for duration of loop
- [ ] **Unreadable file handling** — Exit 1 with error message
- [ ] **Tests unlocked:** T-ENV-01 through T-ENV-25a (30 tests)

---

## Phase 10: Programmatic API (P1)

*(Spec 9.1-9.5)*

### 10a. `run(scriptName?, options?): AsyncGenerator<Output>`

- [ ] Returns generator that yields `Output` per iteration
- [ ] Snapshots `cwd` and options at call time (mutations after call have no effect)
- [ ] All errors surfaced lazily on first `next()` (validation, missing scripts, etc.)
- [ ] `break`/`generator.return()`: terminate active child (SIGTERM -> SIGKILL after 5s), complete silently
- [ ] `AbortSignal`: terminate active child, generator throws abort error (even between iterations)
- [ ] Pre-aborted signal: throw immediately on first `next()`, no child spawned
- [ ] `maxIterations: 0` -> complete immediately with no yields
- [ ] Invalid `maxIterations` (negative, non-integer, NaN) -> throw on first `next()`

### 10b. `runPromise(scriptName?, options?): Promise<Output[]>`

- [ ] Collects all outputs from `run()` into array
- [ ] Rejects on any error; partial outputs not available
- [ ] Same option semantics as `run()`

### 10c. Type exports

- [ ] `Output { result?: string; goto?: string; stop?: boolean }`
- [ ] `RunOptions { maxIterations?: number; envFile?: string; signal?: AbortSignal; cwd?: string }`
- [ ] **Tests unlocked:** T-API-01 through T-API-25b (~45 tests), T-TYPE-01 through T-TYPE-07

---

## Phase 11: Help System (P1)

*(Spec 11)*

- [ ] Print usage syntax, options, subcommands
- [ ] Dynamically list discovered scripts with name and file type
- [ ] Non-fatal discovery: if `.loopx/` missing, show help without script list; if validation errors, show warnings
- [ ] **Tests unlocked:** T-CLI-02 through T-CLI-07j (subset of CLI basics)

---

## Phase 12: Signal Handling (P2)

*(Spec 7.3)*

- [ ] **SIGINT/SIGTERM** — Forward to active child process group (not just direct child)
- [ ] **Grace period** — Wait 5 seconds after forwarding; SIGKILL process group if still alive
- [ ] **Exit code** — `128 + signal number` (130 for SIGINT, 143 for SIGTERM)
- [ ] **Between iterations** — If no child running, exit immediately with signal code
- [ ] **Process group** — Spawn children with `detached: true` + negative PID for `process.kill(-pid, signal)` to reach grandchildren
- [ ] **Tests unlocked:** T-SIG-01 through T-SIG-07 (7 tests), T-EXIT-12, T-EXIT-13

---

## Phase 13: CLI Delegation (P2)

*(Spec 3.2)*

- [ ] **Search for local binary** — Walk from CWD upward looking for `node_modules/.bin/loopx`
- [ ] **Delegate** — Spawn the local binary with same args, inherit stdio; set `LOOPX_DELEGATED=1`
- [ ] **Recursion guard** — If `LOOPX_DELEGATED=1` is set, skip delegation
- [ ] **`LOOPX_BIN`** — Set to resolved realpath of effective binary (post-delegation)
- [ ] **Before command handling** — Delegation must occur before any subcommand/run dispatch
- [ ] **Tests unlocked:** T-DEL-01 through T-DEL-08 (8 tests)

---

## Phase 14: Install Command (P2)

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
- [ ] **Tests unlocked:** T-INST-01 through T-INST-GLOBAL-01 (47 tests)

---

## Phase 15: Exit Codes (Cross-Cutting)

*(Spec 12)*

- [ ] `0` — Clean exit (stop, -n limit, -n 0, successful subcommand)
- [ ] `1` — Error (script non-zero, validation failure, invalid goto, missing script/dir, usage error)
- [ ] `128+N` — Signal (130 SIGINT, 143 SIGTERM)
- [ ] **Tests unlocked:** T-EXIT-01 through T-EXIT-13 (13 tests)

---

## Phase 16: Edge Cases & Hardening (P3)

- [ ] Very long result strings (~1 MB) without truncation *(T-EDGE-01)*
- [ ] JSON-special characters round-trip correctly *(T-EDGE-02)*
- [ ] Partial stdout writes captured as unit *(T-EDGE-03)*
- [ ] Stdout/stderr stream separation *(T-EDGE-04)*
- [ ] Unicode in values preserved; unicode in script names rejected *(T-EDGE-05)*
- [ ] Deep goto chains (26+ scripts) *(T-EDGE-06)*
- [ ] No deadlock when script reads empty stdin *(T-EDGE-07)*
- [ ] Large `-n` values without overflow *(T-EDGE-11)*
- [ ] Empty `.loopx/` directory errors *(T-EDGE-12)*
- [ ] Env file without trailing newline *(T-EDGE-14)*
- [ ] Empty env file (0 bytes) *(T-EDGE-15)*

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

- **Phase 1 & 2 complete** — Project scaffolding, build system, and all three internal parsers are implemented and passing
- **Next priority: Phase 3** — Script Discovery & Validation (P0), which unblocks Phase 4+ (execution, loop)
- **Internal seams** — Unit and fuzz tests depend on `parseOutput`, `parseEnvFile`, and `classifySource` being importable from `loopx/internal`
- **ESM-only** — All JS/TS must use `import`/`export`, no CommonJS
- **Node >= 20.6** — Required for `module.register()` in the custom loader
- **Self-cleaning** — All test helpers clean up temp dirs, servers, env mutations via afterEach hooks
- **~155 E2E tests pass coincidentally** against a stub binary (exit 0) because they only assert `exitCode === 1` against a binary-not-found error that also returns exit 1. These will work correctly once loopx is implemented. *(TEST-SPEC 3.2)*
