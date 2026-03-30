# Test Harness Implementation Plan

Items sorted by priority and dependency order. The goal is to implement the **test harness only** (not the loopx product), as defined in TEST-SPEC.md.

Status legend: `[ ]` = not started, `[x]` = complete

---

## P0 — Project Scaffolding

These must be done first; everything else depends on them.

- [ ] **Initialize `package.json`** — name, version, type: "module", devDependencies (vitest, fast-check, execa, get-port, tsx, typescript), scripts (`test`, `test:harness`, `test:unit`, `test:e2e`, `test:fuzz`, `test:typecheck`)
- [ ] **Create `tsconfig.json`** — strict mode, ESM, target ES2022+, paths alias for `loopx/internal` if needed, include `tests/`
- [ ] **Create `vitest.config.ts`** — configure test file patterns, timeouts per suite (harness 10s, unit 5s, e2e 30s, signals 60s, fuzz 120s), serial execution for signal tests, setupFiles if needed
- [ ] **Create `.gitignore`** — node_modules, dist, coverage, .vitest, tmp/test artifacts
- [ ] **Create directory structure** per TEST-SPEC §2.2:
  ```
  tests/
    harness/
    e2e/
    fuzz/
    unit/
    helpers/
  ```

---

## P0 — Helper Library (`tests/helpers/`)

The helper library is the foundation for all tests. Must be built before any test file.

### `tests/helpers/fixtures.ts` (TEST-SPEC §2.3, §2.4)

- [ ] **`createTempProject(options?): TempProject`** — creates isolated temp dir with optional `.loopx/` subdir; returns `{ dir, loopxDir, cleanup() }`; self-cleaning via afterEach or explicit cleanup
- [ ] **`createScript(project, name, ext, content): string`** — writes a file script to `.loopx/` with correct content; returns full path; sets executable bit for `.sh`
- [ ] **`createDirScript(project, name, main, files): string`** — creates directory script in `.loopx/` with `package.json` containing `main` field plus additional files; returns directory path
- [ ] **`createBashScript(project, name, body): string`** — shorthand for `.sh` with `#!/bin/bash` header and executable permission

### `tests/helpers/cli.ts` (TEST-SPEC §2.3)

- [ ] **`runCLI(args, options?): Promise<CLIResult>`** — spawns the `loopx` binary as child process; supports `cwd`, `env`, `runtime` ("node"|"bun"), `timeout` (default 30s), `input`; returns `{ exitCode, stdout, stderr, signal }`; for Node spawns `node /path/to/bin.js`, for Bun spawns `bun /path/to/bin.js`
- [ ] **`runCLIWithSignal(args, options): Promise<CLIResult>`** — like `runCLI` but returns `sendSignal(signal)` and `waitForStderr(pattern)` for signal synchronization

### `tests/helpers/api-driver.ts` (TEST-SPEC §2.3)

- [ ] **`runAPIDriver(runtime, code, options?): Promise<{ stdout, stderr, exitCode }>`** — spawns a driver script under specified runtime that imports from the loopx package; creates a temporary consumer directory with `package.json` and symlinked `node_modules/loopx`; exercises real package exports

### `tests/helpers/env.ts` (TEST-SPEC §2.3)

- [ ] **`createEnvFile(path, vars): void`** — writes well-formed `.env` file with `KEY=VALUE\n` lines
- [ ] **`writeEnvFileRaw(path, content): void`** — writes raw text to file with no transformation; for testing malformed env content
- [ ] **`withGlobalEnv(vars, fn): Promise<void>`** — sets `XDG_CONFIG_HOME` to temp dir, writes global env file, runs fn, cleans up
- [ ] **`withIsolatedHome(fn): Promise<void>`** — sets `HOME` to temp dir, optionally unsets `XDG_CONFIG_HOME`, runs fn, restores

### `tests/helpers/servers.ts` (TEST-SPEC §2.3, §2.6)

- [ ] **`startLocalHTTPServer(routes): Promise<{ url, close }>`** — lightweight `http.createServer` serving fixture files; supports single-file routes, tarball routes, query string routes, error routes (404, 500)
- [ ] **`startLocalGitServer(repos): Promise<{ url, close }>`** — creates local bare git repos, serves via `file://` URLs; creates bare repos with `git init --bare`, clone/commit/push fixture content
- [ ] **`withGitURLRewrite(rewrites, fn): Promise<void>`** — sets up isolated git config via `GIT_CONFIG_GLOBAL` with `url.<base>.insteadOf` rules for known-host URL rewriting to local `file://` repos

### `tests/helpers/runtime.ts` (TEST-SPEC §2.3, §2.5)

- [ ] **`forEachRuntime(fn): void`** — test parameterization helper; runs test block once per available runtime (Node.js, Bun); skips if runtime not installed
- [ ] **Runtime detection** — detect availability of Node.js (>= 20.6) and Bun (>= 1.0)

### `tests/helpers/delegation.ts` (TEST-SPEC §2.3)

- [ ] **`withDelegationSetup(options): Promise<DelegationFixture>`** — provisions realistic delegation fixtures: creates launcher files and symlinks in `node_modules/.bin/loopx`; returns `{ projectDir, globalBinPath, localBinPath, runGlobal(args), cleanup() }`

### Fixture Scripts (TEST-SPEC §2.4)

All fixture script factory functions — each returns script content string:

- [ ] **`emit-result(value)`** — bash: `printf '{"result":"%s"}' '<value>'`
- [ ] **`emit-goto(target)`** — bash: `printf '{"goto":"%s"}' '<target>'`
- [ ] **`emit-stop()`** — bash: `printf '{"stop":true}'`
- [ ] **`emit-result-goto(value, target)`** — bash: `printf '{"result":"%s","goto":"%s"}' '<value>' '<target>'`
- [ ] **`emit-raw(text)`** — bash: `printf '%s' '<text>'`
- [ ] **`emit-raw-ln(text)`** — bash: `printf '%s\n' '<text>'`
- [ ] **`exit-code(n)`** — bash: `exit <n>`
- [ ] **`cat-stdin()`** — bash: reads stdin, echoes as result
- [ ] **`write-stderr(msg)`** — bash: `echo '<msg>' >&2` then produces output
- [ ] **`sleep-then-exit(seconds)`** — bash: sleeps then exits 0
- [ ] **`write-env-to-file(varname, markerPath)`** — bash: `printf '%s' "$VARNAME"` to marker file
- [ ] **`observe-env(varname, markerPath)`** — ts: writes JSON `{ present, value? }` to marker file via `fs.writeFileSync`
- [ ] **`write-cwd-to-file(markerPath)`** — bash: `printf '%s' "$PWD"` to marker file
- [ ] **`write-value-to-file(value, markerPath)`** — bash: `printf '%s' '<value>'` to marker file
- [ ] **`stdout-writer(payloadFile)`** — ts: reads file, writes to stdout via `process.stdout.write()`
- [ ] **`ts-output(fields)`** — ts: uses `import { output } from "loopx"` to emit structured output
- [ ] **`ts-input-echo()`** — ts: reads `input()`, outputs as result
- [ ] **`ts-import-check()`** — ts: imports from "loopx", outputs success marker
- [ ] **`signal-ready-then-sleep(markerPath)`** — bash: writes PID to marker, "ready" to stderr, sleeps
- [ ] **`signal-trap-exit(markerPath, delay)`** — bash: traps SIGTERM with delay handler, writes PID, "ready" to stderr
- [ ] **`signal-trap-ignore(markerPath)`** — bash: traps SIGTERM (no-op handler), writes PID, "ready" to stderr
- [ ] **`spawn-grandchild(markerPath)`** — bash: spawns background process, writes both PIDs to marker, "ready" to stderr
- [ ] **`write-pid-to-file(markerPath)`** — ts: writes `process.pid` to marker, "ready" to stderr, blocks
- [ ] **`counter(file)`** — bash: appends "1" to counter file, outputs count as result

---

## P0 — Phase 0 Harness Validation (`tests/harness/smoke.test.ts`)

Must pass without any loopx implementation. Validates the test infrastructure itself. (TEST-SPEC §3.1)

- [ ] **H-01**: Temp project creation and cleanup — `createTempProject()` creates dir, `cleanup()` removes it
- [ ] **H-02**: Script fixture creation — `createScript()` writes file to `.loopx/` with correct content/permissions
- [ ] **H-03**: Directory script fixture creation — `createDirScript()` creates expected structure with `package.json`
- [ ] **H-04**: Bash script is executable — created `.sh` has execute permission bit
- [ ] **H-05**: Env file creation — `createEnvFile()` writes readable file with expected content
- [ ] **H-06**: Process spawning captures exit code — spawn `node -e "process.exit(42)"`, assert exit code 42
- [ ] **H-07**: Process spawning captures stdout — spawn `echo hello`, assert stdout `"hello\n"`
- [ ] **H-08**: Process spawning captures stderr — spawn `node -e "console.error('err')"`, assert stderr contains `"err"`
- [ ] **H-09**: Process spawning respects cwd — spawn `pwd` with specific cwd, assert matches
- [ ] **H-10**: Process spawning respects env — spawn `echo $MY_VAR` with `MY_VAR=hello`, assert output
- [ ] **H-11**: Signal delivery works — spawn sleeping process, send SIGTERM, assert termination
- [ ] **H-12**: Local HTTP server starts and serves content — start server, fetch route, assert response
- [ ] **H-13**: Local git repo is cloneable — create bare repo, clone, verify files exist
- [ ] **H-14**: Runtime detection — `forEachRuntime` correctly detects available runtimes
- [ ] **H-15**: Global env isolation — `withGlobalEnv` uses temp dir, doesn't touch real `~/.config`

---

## P0 — E2E Test Files (Core Functionality)

### `tests/e2e/cli-basics.test.ts` (TEST-SPEC §4.1)

- [ ] **T-CLI-01**: `loopx version` prints bare version string + newline, exits 0
- [ ] **T-CLI-02**: `loopx -h` prints usage text containing "loopx" and "usage", exits 0
- [ ] **T-CLI-03**: `loopx --help` same output as `-h`
- [ ] **T-CLI-04**: `loopx -h` with scripts lists discovered script names
- [ ] **T-CLI-05**: `loopx -h` without `.loopx/` still prints help, no error
- [ ] **T-CLI-06**: `loopx -h` with name collisions prints help with warnings on stderr
- [ ] **T-CLI-07**: `loopx -h` with reserved names prints help with warnings on stderr
- [ ] **T-CLI-07a**: `-h` lists script names with type information
- [ ] **T-CLI-07b**: `-n 5 -h` prints help (help takes precedence)
- [ ] **T-CLI-07c**: `myscript -h` prints help (help takes precedence)
- [ ] **T-CLI-07d**: `-h` with invalid script name prints warning, still exits 0
- [ ] **T-CLI-07e**: `-h version` prints help (takes precedence over subcommand)
- [ ] **T-CLI-07f**: `-h env set FOO bar` prints help
- [ ] **T-CLI-07g**: `-h --invalid-flag` prints help
- [ ] **T-CLI-07h**: `-h` with bad `package.json` dir script prints warning, exits 0
- [ ] **T-CLI-07i**: `-h` with `main` escaping directory prints warning, exits 0
- [ ] **T-CLI-07j**: `-h -e nonexistent.env` prints help (env file not validated)
- [ ] **T-CLI-08**: No script name with `default.ts` runs default script
- [ ] **T-CLI-09**: No script name, no default script → exit 1 with helpful message
- [ ] **T-CLI-10**: `.loopx/` missing → exit 1 with error
- [ ] **T-CLI-11**: Named script invocation runs the script
- [ ] **T-CLI-12**: Nonexistent script → exit 1
- [ ] **T-CLI-13**: Explicit `default` name runs default script
- [ ] **T-CLI-14**: `-n 3` runs exactly 3 iterations
- [ ] **T-CLI-15**: `-n 0` exits 0 without running script
- [ ] **T-CLI-16**: `-n -1` → exit 1 (usage error)
- [ ] **T-CLI-17**: `-n 1.5` → exit 1 (usage error)
- [ ] **T-CLI-18**: `-n abc` → exit 1 (usage error)
- [ ] **T-CLI-19**: `-n 0` with missing script → exit 1 (validation first)
- [ ] **T-CLI-19a**: `-n 0` with `.loopx/` missing → exit 1
- [ ] **T-CLI-20**: `-n 1` runs exactly 1 iteration
- [ ] **T-CLI-20a**: Duplicate `-n` → exit 1
- [ ] **T-CLI-20b**: Duplicate `-e` → exit 1
- [ ] **T-CLI-21**: `-e .env -n 1` makes env vars available in script
- [ ] **T-CLI-22**: `-e nonexistent.env` → exit 1
- [ ] **T-CLI-22a**: `-n 0 -e nonexistent.env` → exit 1 (env validated before -n 0)
- [ ] **T-CLI-22b**: `-n 0` with name collision → exit 1
- [ ] **T-CLI-22c**: `-n 0` with reserved name → exit 1
- [ ] **T-CLI-22d**: `-n 0` with invalid script name → exit 1
- [ ] **T-CLI-23**: CLI stdout is empty when script outputs result (result not printed)

### `tests/e2e/subcommands.test.ts` (TEST-SPEC §4.2)

- [ ] **T-SUB-01 through T-SUB-06b**: `loopx output` subcommand tests (result, goto, stop, combined, no-flags error, no .loopx required, special chars, newlines)
- [ ] **T-SUB-07 through T-SUB-14g**: `loopx env set` tests (basic set, underscore prefix, alphanumeric, invalid names, overwrite, no .loopx required, config dir creation, special values, newline/CR rejection)
- [ ] **T-SUB-14h through T-SUB-14k**: `loopx env set` on-disk serialization tests (exact bytes written)
- [ ] **T-SUB-15 through T-SUB-16**: `loopx env remove` tests
- [ ] **T-SUB-17 through T-SUB-19**: `loopx env list` tests (empty, sorted, no .loopx required)

### `tests/e2e/discovery.test.ts` (TEST-SPEC §4.3)

- [ ] **T-DISC-01 through T-DISC-10**: File script discovery (all extensions, unsupported rejected, base name)
- [ ] **T-DISC-11 through T-DISC-17**: Directory script discovery (valid, no package.json, no main, various entry points, invalid main, subpath main)
- [ ] **T-DISC-11a, T-DISC-14a–14c, T-DISC-16a–16d**: Additional directory script edge cases (subpath main, invalid JSON, unreadable, non-string main, missing main file)
- [ ] **T-DISC-18 through T-DISC-21**: Name collision tests
- [ ] **T-DISC-22 through T-DISC-26**: Reserved name tests
- [ ] **T-DISC-27 through T-DISC-32**: Name restriction tests (dash prefix, valid names, spaces, dots)
- [ ] **T-DISC-30a, T-DISC-30b**: Digit-starting and all-digit script names
- [ ] **T-DISC-33 through T-DISC-36**: Symlink tests
- [ ] **T-DISC-37 through T-DISC-38b**: Discovery caching tests (new script not found, content changes take effect, removed/renamed script fails at spawn)
- [ ] **T-DISC-39 through T-DISC-46b**: Validation scope tests (version, env, output, install, help bypass validation)
- [ ] **T-DISC-47, T-DISC-49**: Discovery scope (parent dir not searched, nested files ignored)
- [ ] **T-DISC-48**: Cached `package.json` `main` not re-read
- [ ] **T-DISC-50**: Run-mode discovery warnings emitted

### `tests/e2e/execution.test.ts` (TEST-SPEC §4.4)

- [ ] **T-EXEC-01 through T-EXEC-04**: Working directory tests (file script CWD, dir script CWD, LOOPX_PROJECT_ROOT)
- [ ] **T-EXEC-05 through T-EXEC-07**: Bash script execution (stdout captured, stderr pass-through, no shebang still works)
- [ ] **T-EXEC-08 through T-EXEC-13b**: JS/TS script execution (all extensions, stderr, TypeScript annotations, CJS rejection)
- [ ] **T-EXEC-15 through T-EXEC-18a**: Directory script execution (TS entry, bash entry, own node_modules, CWD, missing dependency error)

### `tests/e2e/output-parsing.test.ts` (TEST-SPEC §4.5)

- [ ] **T-PARSE-01 through T-PARSE-05**: Valid structured output
- [ ] **T-PARSE-06 through T-PARSE-13**: Fallback to raw result (unknown fields, array, string, number, boolean, null, non-JSON, trailing newline, empty stdout)
- [ ] **T-PARSE-12a**: Raw fallback preserves trailing newline
- [ ] **T-PARSE-14 through T-PARSE-24**: Type coercion (result as number/bool/object/null, goto as non-string, stop as non-boolean)
- [ ] **T-PARSE-25 through T-PARSE-27**: Whitespace & formatting
- [ ] **T-PARSE-28 through T-PARSE-29**: Mixed valid/invalid fields

### `tests/e2e/loop-state.test.ts` (TEST-SPEC §4.6)

- [ ] **T-LOOP-01 through T-LOOP-05**: Basic loop behavior (reset, goto chains, stop)
- [ ] **T-LOOP-06 through T-LOOP-10**: `-n` counting semantics
- [ ] **T-LOOP-11 through T-LOOP-15**: Input piping (result piped with goto, empty on no result, not piped on reset, first iteration empty, chain piping)
- [ ] **T-LOOP-16 through T-LOOP-19**: Goto behavior (transition not permanent, self-goto, invalid target)
- [ ] **T-LOOP-20 through T-LOOP-24**: Error handling (non-zero exit, failure stops loop, stderr visible, stdout not parsed on failure)
- [ ] **T-LOOP-25**: Final iteration output observable

### `tests/e2e/env-vars.test.ts` (TEST-SPEC §4.7)

- [ ] **T-ENV-01 through T-ENV-05e**: Global env file tests (available in scripts, remove, XDG_CONFIG_HOME, fallback to ~/.config, dir creation, unreadable file)
- [ ] **T-ENV-06 through T-ENV-15f**: Env file parsing (KEY=VALUE, comments, blanks, duplicates, quoted values, no escape sequences, inline #, trailing whitespace, whitespace around =, empty value, multiple =, invalid keys, malformed lines, unmatched quotes, leading space in value)
- [ ] **T-ENV-16 through T-ENV-19**: Local env override (-e loads vars, missing file error, unreadable file error, precedence)
- [ ] **T-ENV-17a**: Unreadable local env file
- [ ] **T-ENV-20 through T-ENV-24**: Injection precedence (LOOPX_BIN, LOOPX_PROJECT_ROOT, global overrides system, system visible, full chain)
- [ ] **T-ENV-20a, T-ENV-21a**: Injected vars override inherited system environment
- [ ] **T-ENV-25, T-ENV-25a**: Env caching (global and local env loaded once, not re-read during loop)

### `tests/e2e/module-resolution.test.ts` (TEST-SPEC §4.8)

- [ ] **T-MOD-01 through T-MOD-03a**: `import from "loopx"` resolution (Node, Bun, JS, shadow package)
- [ ] **T-MOD-04 through T-MOD-14a**: `output()` function tests (all field combos, error cases, undefined fields, non-object values, arrays, empty object, no-known-fields, code-after-output, large payload flush, stop:false, goto:42, result:null, goto:null)
- [ ] **T-MOD-15 through T-MOD-18**: `input()` function tests (empty first, piped value, cached, returns Promise)
- [ ] **T-MOD-19 through T-MOD-21**: `LOOPX_BIN` in bash scripts (output subcommand, path validity, version check)
- [ ] **T-MOD-22**: ESM-only package contract (`require("loopx")` fails)

### `tests/e2e/programmatic-api.test.ts` (TEST-SPEC §4.9)

- [ ] **T-API-01 through T-API-09c**: `run()` async generator tests (yields Output, count, stop, maxIterations, final yield, break cancellation, cwd, maxIterations 0, default script, cwd snapshot, manual return cancellation, options snapshot)
- [ ] **T-API-10 through T-API-10c**: `run()` with AbortSignal (abort terminates, abort during active child, pre-aborted, abort between iterations)
- [ ] **T-API-11 through T-API-14d**: `runPromise()` tests (resolves array, stop, rejection, all options, default script, maxIterations 0, cwd snapshot, options snapshot)
- [ ] **T-API-15 through T-API-20i**: Error behavior (no stdout leakage, non-zero throws, invalid goto throws, stderr forwarded, partial outputs preserved, nonexistent script, name collision, missing env file, missing .loopx, no default)
- [ ] **T-API-21 through T-API-21b**: envFile option (loads vars, relative path with cwd, relative path without cwd)
- [ ] **T-API-22 through T-API-24b**: maxIterations validation (negative, float, NaN for both run and runPromise)
- [ ] **T-API-25 through T-API-25b**: `runPromise()` with AbortSignal (abort rejects, pre-aborted, abort between iterations)

### `tests/e2e/install.test.ts` (TEST-SPEC §4.10)

- [ ] **T-INST-01 through T-INST-08d**: Source detection tests (org/repo shorthand, known hosts, .git suffix, tarball URLs, single-file URLs, pathname-based detection, query strings)
- [ ] **T-INST-09 through T-INST-14**: Single-file install (correct filename, query stripped, fragment stripped, unsupported ext rejected, script name, .loopx created)
- [ ] **T-INST-15 through T-INST-21**: Git install (repo placement, shallow clone, name derivation, package.json validation, runnable after install)
- [ ] **T-INST-22 through T-INST-26b**: Tarball install (extraction, single top-level unwrap, multiple top-level, .tgz, package.json validation, query/fragment stripping)
- [ ] **T-INST-27 through T-INST-33**: Common rules (destination collision, name collision across types, reserved names, invalid names, no auto-install, HTTP errors, git failures, corrupt archives)
- [ ] **T-INST-34 through T-INST-39c**: Install post-validation for directory scripts (invalid JSON, non-string main, escaping main, missing main file — for both git and tarball)
- [ ] **T-INST-GLOBAL-01**: Global install smoke test (npm pack → install → run fixture)

### `tests/e2e/signals.test.ts` (TEST-SPEC §4.11)

- [ ] **T-SIG-01**: SIGINT → exit 130
- [ ] **T-SIG-02**: SIGTERM → exit 143
- [ ] **T-SIG-03**: After SIGINT, child process is gone
- [ ] **T-SIG-04**: Grace period — child traps SIGTERM, exits within 2s → clean exit
- [ ] **T-SIG-05**: Grace period exceeded — child ignores SIGTERM → SIGKILL after ~5s
- [ ] **T-SIG-06**: Process group signal — grandchild also killed
- [ ] **T-SIG-07**: Between-iterations signal → immediate exit 143 (`@flaky-retry(3)`)

### `tests/e2e/delegation.test.ts` (TEST-SPEC §4.12)

- [ ] **T-DEL-01**: Global delegates to local `node_modules/.bin/loopx`
- [ ] **T-DEL-02**: Ancestor directory delegation
- [ ] **T-DEL-03**: Nearest ancestor wins
- [ ] **T-DEL-04**: `LOOPX_DELEGATED=1` prevents delegation
- [ ] **T-DEL-05**: `LOOPX_BIN` contains resolved realpath of local binary
- [ ] **T-DEL-06**: `import from "loopx"` resolves to local version after delegation
- [ ] **T-DEL-07**: `LOOPX_DELEGATED=1` set in delegated process
- [ ] **T-DEL-08**: Delegation happens before command handling

---

## P1 — E2E Cross-Cutting & Edge Cases

### `tests/e2e/exit-codes.test.ts` (TEST-SPEC §4.13) — may be folded into other files

- [ ] **T-EXIT-01 through T-EXIT-04**: Redundant smoke checks (stop, -n limit, -n 0, version)
- [ ] **T-EXIT-05 through T-EXIT-11**: Error exit codes (script non-zero, validation failure, invalid goto, missing script, missing .loopx, invalid -n, missing -e file)
- [ ] **T-EXIT-12 through T-EXIT-13**: Signal exit codes (SIGINT → 130, SIGTERM → 143)

### Edge Cases (TEST-SPEC §7) — may be placed in relevant test files or standalone

- [ ] **T-EDGE-01**: Very long result (~1 MB) handled without truncation
- [ ] **T-EDGE-02**: JSON-special characters in result
- [ ] **T-EDGE-03**: Partial stdout writes captured as a unit
- [ ] **T-EDGE-04**: Stdout captured, stderr passed through, no interleaving
- [ ] **T-EDGE-05**: Unicode in result preserved; unicode in script names rejected
- [ ] **T-EDGE-06**: Deeply nested goto chain (A→B→...→Z) correct order and counting
- [ ] **T-EDGE-07**: Script reads stdin when no input available, no deadlock
- [ ] **T-EDGE-11**: Very large `-n` value, no overflow
- [ ] **T-EDGE-12**: Empty `.loopx/` dir — no default, named not found
- [ ] **T-EDGE-14**: Env file with no trailing newline still parsed
- [ ] **T-EDGE-15**: Empty env file (0 bytes) — no error, no variables

---

## P2 — Fuzz Tests

### `tests/fuzz/output-parsing.fuzz.test.ts` (TEST-SPEC §5.1)

- [ ] **Generators**: `arbitraryJSON`, `arbitraryString`, `arbitraryOutputObject`, `arbitraryMalformedJSON`
- [ ] **F-PARSE-01**: No crashes — any stdout string, no uncaught exception
- [ ] **F-PARSE-02**: Deterministic parsing — same input, same behavior
- [ ] **F-PARSE-03**: Type safety — result is string, goto is string, stop is true
- [ ] **F-PARSE-04**: Raw fallback consistency — non-structured stdout becomes result
- [ ] **F-PARSE-05**: Non-ASCII safe — UTF-8, NUL, control chars, emoji, CJK, no crashes
- [ ] Two tiers: unit-level (1000+ inputs via `parseOutput` seam) + E2E (50–100 inputs via child process)

### `tests/fuzz/env-parsing.fuzz.test.ts` (TEST-SPEC §5.2)

- [ ] **Generators**: `arbitraryEnvFile`, `arbitraryEnvLine`, `arbitraryEnvValue`
- [ ] **F-ENV-01**: No crashes — any string as .env content
- [ ] **F-ENV-02**: Deterministic parsing — same content, same variables
- [ ] **F-ENV-03**: Keys and values are strings
- [ ] **F-ENV-04**: Last-wins for duplicates
- [ ] **F-ENV-05**: Comment lines never produce variables
- [ ] Two tiers: unit-level (1000+ inputs via `parseEnvFile` seam) + E2E (50–100)

---

## P2 — Unit Tests

### `tests/unit/parse-output.test.ts` (TEST-SPEC §6.1)

- [ ] Uses `parseOutput` internal seam (§1.4)
- [ ] Valid JSON objects with various field combinations
- [ ] Type coercion cases
- [ ] Edge cases: empty string, whitespace-only, very large strings
- [ ] Non-object JSON values
- [ ] Malformed JSON

### `tests/unit/parse-env.test.ts` (TEST-SPEC §6.2)

- [ ] Uses `parseEnvFile` internal seam (§1.4)
- [ ] Standard KEY=VALUE pairs
- [ ] Comments, blank lines
- [ ] Quoted values (single, double)
- [ ] Escape sequences (literal, not interpreted)
- [ ] Duplicate keys, inline #, edge cases

### `tests/unit/source-detection.test.ts` (TEST-SPEC §6.3)

- [ ] Uses `classifySource` internal seam (§1.4)
- [ ] `org/repo` → git (github)
- [ ] Various URLs → correct source type
- [ ] Edge cases: ports, auth, paths, query strings

### `tests/unit/types.test.ts` (TEST-SPEC §6.4)

- [ ] **T-TYPE-01**: `import type { Output, RunOptions } from "loopx"` compiles
- [ ] **T-TYPE-02**: `Output` has correct optional fields
- [ ] **T-TYPE-03**: `RunOptions` has correct optional fields
- [ ] **T-TYPE-04**: `run()` returns `AsyncGenerator<Output>`
- [ ] **T-TYPE-05**: `runPromise()` returns `Promise<Output[]>`
- [ ] **T-TYPE-06**: Both accept optional `RunOptions`
- [ ] **T-TYPE-07**: Both accept optional script name
- [ ] Must use vitest typecheck mode or `tsc --noEmit`, not just runtime vitest

---

## P3 — Stub Validation (TEST-SPEC §3.2)

- [ ] **Create minimal stub binary** — shell script that exits 0, no stdout, ignores args
- [ ] **Stub allowlist** — small set of test IDs expected to pass against stub (e.g., `-n 0` exits 0)
- [ ] **Validation procedure** — point `runCLI` at stub, run spec tests, verify nearly all fail; inspect unexpected passes

---

## P3 — CI Configuration (TEST-SPEC §8)

- [ ] **Runtime matrix** — Node.js (20.6, latest LTS, latest current), Bun (1.0, latest)
- [ ] **Pipeline stages** — Build → Phase 0 → Typecheck → Unit → E2E → Fuzz → (optional stub validation)
- [ ] **Timeouts** — harness 10s, unit 5s, e2e 30s, signals 60s, fuzz 120s
- [ ] **Parallelism config** — signal tests serial within file, install tests share server per file
- [ ] **`--bail` for Phase 0** — fail pipeline if harness tests fail

---

## Implementation Notes

- **No product code** — this plan covers only the test harness. The loopx implementation does not exist yet.
- **Internal seams** — unit and fuzz tests depend on `parseOutput`, `parseEnvFile`, and `classifySource` being importable from `loopx/internal`. These are implementation requirements that must be fulfilled by the product code before unit/fuzz tests can pass against real logic.
- **Test categorization** — use `describe("HARNESS: ...")`, `describe("SPEC: ...")`, and `describe("FUZZ: ...")` blocks per §3.3.
- **Self-cleaning** — all helpers must clean up temp dirs, servers, env mutations via afterEach hooks or explicit cleanup.
- **`runAPIDriver` import resolution** — driver must create a temp consumer dir with `node_modules/loopx` symlinked to build output, exercising real package exports.
