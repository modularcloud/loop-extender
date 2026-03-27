# Test Specification for loopx

## 1. Philosophy & Goals

### 1.1 Core Principles

1. **E2E black-box testing is the primary strategy.** Tests exercise the `loopx` binary and programmatic API exactly as users would — by spawning processes, creating fixture scripts, and asserting observable behavior (exit codes, stdout, stderr, file system state). Internal implementation details are not tested directly.

2. **Contract-driven.** Every test traces to a specific SPEC.md requirement. The test suite serves as an executable specification.

3. **Runtime coverage.** Tests run against both Node.js (>= 20.6) and Bun (>= 1.0). Where a test exercises runtime-specific behavior (e.g., module resolution), it is tagged accordingly.

4. **Verification before implementation.** Since the implementation doesn't exist yet, the test suite includes a verification strategy (section 3) to ensure tests are correctly constructed before they can pass.

5. **Fuzz testing for parsers.** The structured output parser and `.env` file parser are exercised with property-based tests to catch edge cases.

### 1.2 Test Priorities

| Priority | Category | Rationale |
|----------|----------|-----------|
| P0 | Loop state machine, structured output parsing, script execution | Core functionality — if these break, nothing works |
| P1 | Environment variables, CLI options, subcommands | Essential user-facing features |
| P2 | Install command, CLI delegation, signal handling | Important but less frequently exercised |
| P3 | Edge cases, fuzz tests | Defense in depth |

---

## 2. Test Infrastructure

### 2.1 Framework & Tooling

| Tool | Purpose |
|------|---------|
| **Vitest** | Test runner and assertion library. Native ESM, TypeScript, fast. |
| **fast-check** | Property-based / fuzz testing for parsers. |
| **execa** (or `node:child_process`) | Spawning `loopx` CLI processes with fine-grained control over stdio, env, signals. |
| **get-port** | Acquiring free ports for local test servers. |
| **http** (Node built-in) | Local HTTP server for install tests (single-file + tarball). |
| **Local bare git repos** | Testing git clone install source (no network dependency). |

### 2.2 Directory Layout

```
tests/
  harness/
    smoke.test.ts              Phase 0 harness validation
  e2e/
    cli-basics.test.ts         CLI invocation, help, version
    subcommands.test.ts        output, env, install subcommands
    discovery.test.ts          Script discovery & validation
    execution.test.ts          Script execution (bash, JS/TS, directory)
    output-parsing.test.ts     Structured output parsing
    loop-state.test.ts         Loop state machine & control flow
    env-vars.test.ts           Environment variable management
    module-resolution.test.ts  import from "loopx", output(), input()
    programmatic-api.test.ts   run(), runPromise()
    install.test.ts            loopx install from various sources
    signals.test.ts            Signal handling (SIGINT, SIGTERM)
    delegation.test.ts         Global-to-local CLI delegation
  fuzz/
    output-parsing.fuzz.test.ts
    env-parsing.fuzz.test.ts
  unit/
    parse-output.test.ts       Output parsing logic (supplementary)
    parse-env.test.ts          Env file parsing logic (supplementary)
    source-detection.test.ts   Install source classification
  helpers/
    cli.ts                     CLI spawning utilities
    fixtures.ts                Temp dir, script, and project creation
    servers.ts                 Local HTTP & git servers
    env.ts                     Env file creation & global config helpers
    runtime.ts                 Runtime detection & matrix helpers
```

### 2.3 Helper Library

The helper library provides reusable utilities for all tests. Each helper is designed to be self-cleaning (via Vitest `afterEach` hooks or explicit cleanup functions).

#### `createTempProject(options?): TempProject`

Creates an isolated temporary directory with an optional `.loopx/` subdirectory. Returns an object with:
- `dir`: absolute path to the temp directory
- `loopxDir`: absolute path to `.loopx/` within it
- `cleanup()`: removes the temp directory

All tests use this to avoid cross-contamination.

#### `createScript(project, name, ext, content): string`

Creates a file script in the project's `.loopx/` directory. Returns the full path. Example:
```typescript
createScript(project, "myscript", ".ts", `
  import { output } from "loopx";
  output({ result: "hello" });
`);
```

#### `createDirScript(project, name, main, files): string`

Creates a directory script in `.loopx/` with a `package.json` containing the given `main` field, plus any additional files. Returns the directory path.

#### `createBashScript(project, name, body): string`

Shorthand for creating a `.sh` script with `#!/bin/bash` header and executable permission.

#### `runCLI(args, options?): Promise<CLIResult>`

Spawns the `loopx` binary as a child process. Options include:
- `cwd`: working directory (defaults to temp project)
- `env`: additional environment variables
- `runtime`: `"node"` | `"bun"` — controls how the binary is invoked
- `timeout`: max execution time (default 30s)
- `input`: string to pipe to stdin

Returns:
```typescript
interface CLIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: string | null;
}
```

For **Node.js**, the CLI is spawned as `node /path/to/loopx/bin.js [args]`.
For **Bun**, it is spawned as `bun /path/to/loopx/bin.js [args]`.

#### `runCLIWithSignal(args, options): Promise<CLIResult>`

Like `runCLI`, but also returns a `sendSignal(signal)` function and a `waitForStderr(pattern)` function so the test can send SIGINT/SIGTERM at a controlled point during execution.

#### `createEnvFile(path, vars): void`

Writes a `.env` format file with the given key-value pairs.

#### `withGlobalEnv(vars, fn): Promise<void>`

Sets `XDG_CONFIG_HOME` to a temp directory, writes a global env file with the given vars, runs `fn`, then cleans up. This isolates global env tests from the user's real config.

#### `startLocalHTTPServer(routes): Promise<{ url: string, close: () => void }>`

Starts a local HTTP server serving the specified routes. Used for install tests (single-file downloads, tarball downloads).

#### `startLocalGitServer(repos): Promise<{ url: string, close: () => void }>`

Creates local bare git repositories and serves them over a local protocol. Used for `loopx install` git tests. Implementation: create bare repos with `git init --bare`, then clone/commit/push fixture content, and serve via `git daemon` or direct file:// URLs.

#### `forEachRuntime(fn): void`

Test parameterization helper. Runs a test block once for each available runtime (Node.js, Bun). Skips a runtime if it's not installed. Example:
```typescript
forEachRuntime((runtime) => {
  it("runs a bash script", async () => {
    const result = await runCLI(["-n", "1", "myscript"], { cwd: project.dir, runtime });
    expect(result.exitCode).toBe(0);
  });
});
```

### 2.4 Fixture Scripts

A catalog of reusable fixture scripts used across tests. Each is a function that returns the script content.

| Fixture | Type | Behavior |
|---------|------|----------|
| `echo-result(value)` | bash | `echo '{"result":"<value>"}'` |
| `echo-goto(target)` | bash | `echo '{"goto":"<target>"}'` |
| `echo-stop()` | bash | `echo '{"stop":true}'` |
| `echo-result-goto(value, target)` | bash | `echo '{"result":"<value>","goto":"<target>"}'` |
| `echo-raw(text)` | bash | `echo '<text>'` (raw stdout, no JSON) |
| `exit-code(n)` | bash | `exit <n>` |
| `cat-stdin()` | bash | Reads stdin, echoes it as result |
| `write-stderr(msg)` | bash | `echo '<msg>' >&2` then produces output |
| `sleep-then-exit(seconds)` | bash | Sleeps, then exits. For signal tests. |
| `print-env(varname)` | bash | Echoes `$VARNAME` as result |
| `print-cwd()` | bash | Echoes `$PWD` as result |
| `ts-output(fields)` | ts | Uses `import { output } from "loopx"` to emit structured output |
| `ts-input-echo()` | ts | Reads input(), outputs it as result |
| `ts-import-check()` | ts | Imports from "loopx", outputs success marker |
| `spawn-grandchild()` | bash | Spawns a background subprocess, then waits. For process group signal tests. |
| `counter(file)` | bash | Appends "1" to a counter file each invocation, outputs count as result |

### 2.5 Runtime Matrix

Tests are parameterized over runtimes where applicable:

| Category | Node.js | Bun |
|----------|---------|-----|
| CLI basics, help, version | Yes | Yes |
| Subcommands (output, env) | Yes | Yes |
| Script discovery & validation | Yes | Yes |
| Bash script execution | Yes | Yes |
| JS/TS script execution | Yes | Yes |
| Module resolution (`import from "loopx"`) | Yes (--import hook) | Yes (NODE_PATH) |
| Programmatic API | Yes | Yes |
| Install command | Yes | Yes |
| Signal handling | Yes | Yes |
| CLI delegation | Yes | Yes |

A test should be skipped (not failed) if its required runtime is not available in the environment.

### 2.6 Local Test Servers

#### HTTP Server

A lightweight `http.createServer` instance serves fixture files for install tests:
- **Single-file routes:** Serve `.ts`, `.sh`, etc. files at predictable paths.
- **Tarball routes:** Serve `.tar.gz` archives created on-the-fly from fixture directories.
- **Query string routes:** Serve files at URLs with `?token=abc` to test query stripping.
- **Error routes:** Return 404, 500, etc. to test error handling.

The server starts in `beforeAll` and closes in `afterAll` for the install test suite.

#### Git Server

For git install tests, use `file://` protocol URLs pointing to local bare repos:
1. Create a temp directory with `git init --bare`.
2. Clone it to a working directory, add fixture files (package.json + main entry), commit, push.
3. Tests use `file:///path/to/bare/repo.git` as the install source.

This avoids any network dependency and is fast. The bare repos are created in `beforeAll` and cleaned up in `afterAll`.

---

## 3. Test Verification Strategy

The central challenge: tests are written before the implementation exists. We need confidence that when a test passes, it genuinely validates the spec requirement — not that it passes vacuously.

### 3.1 Phase 0: Harness Validation

**Purpose:** Verify the test infrastructure works correctly. These tests pass without any loopx implementation.

**Tests (`tests/harness/smoke.test.ts`):**

- **H-01: Temp project creation and cleanup.** `createTempProject()` creates a directory that exists, `cleanup()` removes it.
- **H-02: Script fixture creation.** `createScript()` writes a file to `.loopx/` with correct content and permissions.
- **H-03: Directory script fixture creation.** `createDirScript()` creates the expected directory structure with `package.json`.
- **H-04: Bash script is executable.** A created `.sh` fixture has the execute permission bit set.
- **H-05: Env file creation.** `createEnvFile()` writes a file that can be read back and contains the expected content.
- **H-06: Process spawning captures exit code.** Spawn `node -e "process.exit(42)"` and assert exit code is 42.
- **H-07: Process spawning captures stdout.** Spawn `echo hello` and assert stdout is `"hello\n"`.
- **H-08: Process spawning captures stderr.** Spawn `node -e "console.error('err')"` and assert stderr contains `"err"`.
- **H-09: Process spawning respects cwd.** Spawn `pwd` with a specific cwd and assert the output matches.
- **H-10: Process spawning respects env.** Spawn `echo $MY_VAR` with `MY_VAR=hello` and assert output.
- **H-11: Signal delivery works.** Spawn a sleeping process, send SIGTERM, assert it terminates.
- **H-12: Local HTTP server starts and serves content.** Start server, fetch a route, assert response body.
- **H-13: Local git repo is cloneable.** Create a bare repo with fixture content, clone it, verify files exist.
- **H-14: Runtime detection.** `forEachRuntime` correctly detects available runtimes.
- **H-15: Global env isolation.** `withGlobalEnv` uses a temp directory and doesn't touch the real `~/.config`.

**All Phase 0 tests must pass before any Phase 1 tests are run.** If Phase 0 fails, the test infrastructure is broken and Phase 1 results are meaningless. Vitest's `--bail` flag can enforce this.

### 3.2 Stub Validation

Before the real implementation exists, we create a **minimal stub** — a shell script that:
- Exits 0 for all invocations
- Produces no stdout
- Ignores all arguments

When the Phase 1 (spec) tests are run against this stub, **nearly all should fail.** Any spec test that passes against the stub is suspect — it may be testing nothing. This is a one-time validation step, not a permanent part of CI.

**Procedure:**
1. Create the stub binary:
   ```bash
   #!/bin/bash
   exit 0
   ```
2. Point `runCLI` at the stub.
3. Run the spec test suite.
4. Inspect the results: tests that pass are flagged for review. They either:
   - Are legitimate (e.g., `-n 0` exits 0, and the stub exits 0 — but for the wrong reason, so the test needs a stronger assertion like verifying validation actually ran), or
   - Have a weak or incorrect assertion that should be strengthened.
5. Revise flagged tests to include assertions that would fail against the stub (e.g., check stderr for expected messages, verify specific stdout content, check file system side effects).

### 3.3 Test Categorization

Each test file uses Vitest's `describe` blocks with category labels:

- **`describe("HARNESS: ...")`** — Phase 0 tests. Must pass without implementation.
- **`describe("SPEC: ...")`** — Spec requirement tests. Expected to fail until implemented.
- **`describe("FUZZ: ...")`** — Property-based tests. Expected to fail until implemented.

During implementation, as features are built, the corresponding SPEC tests should transition from failing to passing. A test that continues to fail after its feature is implemented indicates either a bug in the implementation or a bug in the test.

---

## 4. E2E Test Cases

Each test is identified by a unique ID (`T-<SECTION>-<NUMBER>`), references a SPEC.md section, and specifies its runtime scope. Unless marked `[Node]` or `[Bun]`, tests run on both runtimes.

### 4.1 CLI Basics

**Spec refs:** 4.1, 4.2, 11

#### Help & Version

- **T-CLI-01**: `loopx version` prints a version string matching semver pattern, exits 0. Does not require `.loopx/` to exist. *(Spec 4.3, 5.5)*
- **T-CLI-02**: `loopx -h` prints usage text containing "loopx" and "usage" (case-insensitive), exits 0. *(Spec 4.2)*
- **T-CLI-03**: `loopx --help` produces the same output as `-h`. *(Spec 4.2)*
- **T-CLI-04**: `loopx -h` with `.loopx/` containing scripts lists discovered script names in output. *(Spec 11)*
- **T-CLI-05**: `loopx -h` without `.loopx/` directory still prints help (no error), script list section is absent or empty. *(Spec 5.5, 11)*
- **T-CLI-06**: `loopx -h` with `.loopx/` containing name collisions prints help with warnings on stderr. *(Spec 11)*
- **T-CLI-07**: `loopx -h` with `.loopx/` containing reserved names prints help with warnings on stderr. *(Spec 11)*

#### Default Script Invocation

- **T-CLI-08**: `loopx` (no script name) with a `default.ts` script in `.loopx/` runs the default script. Assert: script's output is observed (e.g., use a counter file fixture to prove it ran). *(Spec 4.1)*
- **T-CLI-09**: `loopx` (no script name) with no `default` script in `.loopx/` exits with code 1. Stderr contains a message mentioning "default" and suggesting script creation. *(Spec 4.1)*
- **T-CLI-10**: `loopx` with `.loopx/` directory missing entirely exits with code 1 and provides a helpful error message. *(Spec 7.2)*

#### Named Script Invocation

- **T-CLI-11**: `loopx myscript` with `.loopx/myscript.sh` runs the script. Assert via counter file. *(Spec 4.1)*
- **T-CLI-12**: `loopx nonexistent` with `.loopx/` existing but no matching script exits with code 1. *(Spec 4.1)*
- **T-CLI-13**: `loopx default` (explicitly naming the default script) runs the default script, same as `loopx` with no name. *(Spec 4.1)*

#### CLI `-n` Option

- **T-CLI-14**: `loopx -n 3 myscript` with a counter fixture runs exactly 3 iterations. Assert counter file contains 3 marks. *(Spec 4.2, 7.1)*
- **T-CLI-15**: `loopx -n 0 myscript` exits 0 without running the script. Assert counter file does not exist or is empty. *(Spec 4.2, 7.1)*
- **T-CLI-16**: `loopx -n -1 myscript` exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-17**: `loopx -n 1.5 myscript` exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-18**: `loopx -n abc myscript` exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-19**: `loopx -n 0` with a missing script still exits with code 1 (validation occurs before `-n 0` short-circuit). Stderr contains an error about the missing script. *(Spec 4.2, 7.1)*
- **T-CLI-20**: `loopx -n 1 myscript` runs exactly 1 iteration even if the script produces no `stop`. *(Spec 4.2)*

#### CLI `-e` Option

- **T-CLI-21**: `loopx -e .env -n 1 myscript` with a valid `.env` file makes its variables available in the script. Use `print-env` fixture to verify. *(Spec 4.2)*
- **T-CLI-22**: `loopx -e nonexistent.env myscript` exits with code 1. Stderr mentions the missing file. *(Spec 4.2)*

#### CLI Stdout Silence

- **T-CLI-23**: `loopx -n 1 myscript` where `myscript` outputs `{"result":"hello"}` — the CLI's own stdout is empty. The result is not printed. *(Spec 7.1)*

### 4.2 Subcommands

**Spec refs:** 4.3, 5.5

#### `loopx output`

- **T-SUB-01**: `loopx output --result "hello"` prints `{"result":"hello"}` to stdout, exits 0. *(Spec 4.3)*
- **T-SUB-02**: `loopx output --goto "next"` prints `{"goto":"next"}` to stdout, exits 0. *(Spec 4.3)*
- **T-SUB-03**: `loopx output --stop` prints `{"stop":true}` to stdout, exits 0. *(Spec 4.3)*
- **T-SUB-04**: `loopx output --result "x" --goto "y" --stop` prints JSON containing all three fields. *(Spec 4.3)*
- **T-SUB-05**: `loopx output` with no flags exits with code 1 (error). *(Spec 4.3)*
- **T-SUB-06**: `loopx output --result "x"` works without `.loopx/` directory existing. *(Spec 5.5)*

#### `loopx env set`

- **T-SUB-07**: `loopx env set FOO bar` then `loopx env list` shows `FOO=bar`. *(Spec 4.3)*
- **T-SUB-08**: `loopx env set _UNDER score` succeeds (underscore-prefixed name valid). *(Spec 4.3)*
- **T-SUB-09**: `loopx env set A1 val` succeeds (alphanumeric name). *(Spec 4.3)*
- **T-SUB-10**: `loopx env set 1INVALID val` exits with code 1 (starts with digit — wait, `[A-Za-z_]` for first char means digits are NOT valid as first char). *(Spec 4.3)*

  **Correction to my earlier analysis:** The env set validation pattern is `[A-Za-z_][A-Za-z0-9_]*`. First character must be letter or underscore. Digits are only allowed after the first character. Test T-SUB-10 verifies that `1INVALID` is rejected.

- **T-SUB-11**: `loopx env set -DASH val` exits with code 1 (invalid name). *(Spec 4.3)*
- **T-SUB-12**: `loopx env set FOO bar` then `loopx env set FOO baz` then `loopx env list` shows `FOO=baz` (overwrite). *(Spec 4.3)*
- **T-SUB-13**: `loopx env set` does not require `.loopx/` to exist. *(Spec 5.5)*
- **T-SUB-14**: `loopx env set` creates the config directory (`$XDG_CONFIG_HOME/loopx/`) if it doesn't exist. *(Spec 8.1)*

#### `loopx env remove`

- **T-SUB-15**: `loopx env set FOO bar` then `loopx env remove FOO` then `loopx env list` — `FOO` is absent. *(Spec 4.3)*
- **T-SUB-16**: `loopx env remove NONEXISTENT` exits with code 0 (silent no-op). *(Spec 4.3)*

#### `loopx env list`

- **T-SUB-17**: With no variables set, `loopx env list` produces no stdout output, exits 0. *(Spec 4.3)*
- **T-SUB-18**: With variables `ZEBRA=z`, `ALPHA=a`, `MIDDLE=m` set, `loopx env list` outputs them sorted: `ALPHA=a`, `MIDDLE=m`, `ZEBRA=z`. *(Spec 4.3)*
- **T-SUB-19**: `loopx env list` does not require `.loopx/` to exist. *(Spec 5.5)*

### 4.3 Script Discovery & Validation

**Spec refs:** 5.1–5.5

#### File Script Discovery

- **T-DISC-01**: `.loopx/myscript.sh` is discoverable. `loopx -n 1 myscript` runs it. *(Spec 5.1)*
- **T-DISC-02**: `.loopx/myscript.js` is discoverable. *(Spec 5.1)*
- **T-DISC-03**: `.loopx/myscript.jsx` is discoverable. *(Spec 5.1)*
- **T-DISC-04**: `.loopx/myscript.ts` is discoverable. *(Spec 5.1)*
- **T-DISC-05**: `.loopx/myscript.tsx` is discoverable. *(Spec 5.1)*
- **T-DISC-06**: `.loopx/myscript.mjs` is NOT discoverable. `loopx -n 1 myscript` fails with "not found." *(Spec 2.1, 5.1)*
- **T-DISC-07**: `.loopx/myscript.cjs` is NOT discoverable. *(Spec 2.1, 5.1)*
- **T-DISC-08**: `.loopx/myscript.txt` is NOT discoverable. *(Spec 5.1)*
- **T-DISC-09**: `.loopx/myscript` (no extension) is NOT discoverable. *(Spec 5.1)*
- **T-DISC-10**: Script name is base name without extension. `.loopx/my-script.ts` → name is `my-script`. *(Spec 2.1)*

#### Directory Script Discovery

- **T-DISC-11**: `.loopx/mypipe/` with `package.json` (`"main": "index.ts"`) and `index.ts` → discoverable as `mypipe`. *(Spec 2.1, 5.1)*
- **T-DISC-12**: `.loopx/nopackage/` directory with no `package.json` → ignored. `loopx -n 1 nopackage` fails. *(Spec 2.1, 5.1)*
- **T-DISC-13**: `.loopx/nomain/` with `package.json` that has no `main` field → ignored. *(Spec 2.1, 5.1)*
- **T-DISC-14**: `.loopx/mypipe/` with `"main": "index.sh"` → discoverable (bash entry point). *(Spec 5.1)*
- **T-DISC-15**: `.loopx/mypipe/` with `"main": "index.py"` → warning on stderr, directory ignored. *(Spec 5.1)*
- **T-DISC-16**: `.loopx/mypipe/` with `"main": "../escape.ts"` → warning on stderr, directory ignored. *(Spec 5.1)*
- **T-DISC-17**: Script name is directory name. `.loopx/my-pipeline/` → name is `my-pipeline`. *(Spec 2.1)*

#### Name Collisions

- **T-DISC-18**: `.loopx/example.sh` and `.loopx/example.ts` both exist → loopx refuses to start with error listing the conflicting entries. Exit code 1. *(Spec 5.2)*
- **T-DISC-19**: `.loopx/example.ts` and `.loopx/example/` (valid directory script) → collision error. *(Spec 5.2)*
- **T-DISC-20**: Three-way collision (`.loopx/example.sh`, `.loopx/example.js`, `.loopx/example/`) → error lists all conflicting entries. *(Spec 5.2)*
- **T-DISC-21**: Non-conflicting scripts with different names → no error. `.loopx/alpha.sh` and `.loopx/beta.ts` coexist. *(Spec 5.2)*

#### Reserved Names

- **T-DISC-22**: `.loopx/output.sh` → loopx refuses to start with error mentioning "reserved." *(Spec 5.3)*
- **T-DISC-23**: `.loopx/env.ts` → same error. *(Spec 5.3)*
- **T-DISC-24**: `.loopx/install.js` → same error. *(Spec 5.3)*
- **T-DISC-25**: `.loopx/version.sh` → same error. *(Spec 5.3)*
- **T-DISC-26**: Reserved name as directory script (`.loopx/output/` with valid package.json) → same error. *(Spec 5.3)*

#### Name Restrictions

- **T-DISC-27**: `.loopx/-startswithdash.sh` → error. *(Spec 5.4)*
- **T-DISC-28**: `.loopx/my-script.sh` (hyphen in middle) → valid, no error. *(Spec 5.4)*
- **T-DISC-29**: `.loopx/_underscore.sh` → valid. *(Spec 5.4)*
- **T-DISC-30**: `.loopx/ABC123.sh` → valid. *(Spec 5.4)*
- **T-DISC-31**: `.loopx/has space.sh` → error (space not in allowed pattern). *(Spec 5.4)*
- **T-DISC-32**: `.loopx/has.dot.sh` — the base name is `has.dot` (everything before `.sh`). This contains a `.` which is not in `[a-zA-Z0-9_-]`. → error. *(Spec 5.4)*

#### Symlinks

- **T-DISC-33**: Symlink to a `.ts` file inside `.loopx/` → followed, script discoverable. *(Spec 5.1)*
- **T-DISC-34**: Symlinked directory in `.loopx/` with valid package.json → followed, discoverable. *(Spec 5.1)*
- **T-DISC-35**: Directory script whose `main` is a symlink to a file within the directory → valid. *(Spec 5.1)*
- **T-DISC-36**: Directory script whose `main` is a symlink that resolves outside the directory → warning, ignored. *(Spec 5.1)*

#### Discovery Caching

- **T-DISC-37**: During a loop (`-n 3`), create a new script in `.loopx/` between iteration 1 and 2 (using a script that creates a file). Then have iteration 2 `goto` the new script name → error (not in cached discovery). *(Spec 5.1)*
- **T-DISC-38**: During a loop, modify the content of an already-discovered script between iterations. Assert the new content takes effect on the next iteration (since the file is re-read from disk). *(Spec 5.1)*

#### Validation Scope

- **T-DISC-39**: `loopx version` works when `.loopx/` doesn't exist. *(Spec 5.5)*
- **T-DISC-40**: `loopx env set X Y` works when `.loopx/` doesn't exist. *(Spec 5.5)*
- **T-DISC-41**: `loopx output --result "x"` works when `.loopx/` doesn't exist. *(Spec 5.5)*
- **T-DISC-42**: `loopx` (run mode) when `.loopx/` doesn't exist → error, exit 1. *(Spec 5.5)*

### 4.4 Script Execution

**Spec refs:** 6.1–6.4

#### Working Directory

- **T-EXEC-01**: File script (`.loopx/check-cwd.sh` that prints `$PWD`) → CWD equals the directory where loopx was invoked (the project root). *(Spec 6.1)*
- **T-EXEC-02**: Directory script (`.loopx/mypipe/` that prints `$PWD` from its entry point) → CWD equals `.loopx/mypipe/`. *(Spec 6.1)*
- **T-EXEC-03**: File script reads `$LOOPX_PROJECT_ROOT` → equals the invocation directory. *(Spec 6.1)*
- **T-EXEC-04**: Directory script reads `$LOOPX_PROJECT_ROOT` → equals the invocation directory (not the script's own directory). *(Spec 6.1)*

#### Bash Scripts

- **T-EXEC-05**: A `.sh` script runs successfully and its stdout is captured as output. *(Spec 6.2)*
- **T-EXEC-06**: A `.sh` script's stderr appears on the CLI's stderr (pass-through). Assert by writing a known string to stderr and checking CLI stderr. *(Spec 6.2)*
- **T-EXEC-07**: A `.sh` script that lacks `#!/bin/bash` still runs (loopx invokes via `/bin/bash` explicitly, not via shebang). *(Spec 6.2)*

#### JS/TS Scripts

- **T-EXEC-08**: `.ts` script runs and produces structured output. *(Spec 6.3)*
- **T-EXEC-09**: `.js` script runs and produces structured output. *(Spec 6.3)*
- **T-EXEC-10**: `.tsx` script runs (tsx handles JSX). Use a script that uses JSX syntax to verify tsx processes it. *(Spec 6.3)*
- **T-EXEC-11**: `.jsx` script runs. *(Spec 6.3)*
- **T-EXEC-12**: JS/TS script stderr passes through to CLI stderr. *(Spec 6.3)*
- **T-EXEC-13**: JS/TS script can use TypeScript type annotations (proves tsx is being used, not raw node). `[Node]` *(Spec 6.3)*
- **T-EXEC-14**: Under Bun, TS script runs without tsx (Bun native TS support). `[Bun]` *(Spec 6.3)*

#### Directory Scripts

- **T-EXEC-15**: Directory script with `"main": "index.ts"` → `index.ts` is executed. *(Spec 6.4)*
- **T-EXEC-16**: Directory script with `"main": "run.sh"` → `run.sh` is executed via bash. *(Spec 6.4)*
- **T-EXEC-17**: Directory script can import from its own `node_modules/`. Setup: create a directory script with a local dependency (a simple `.js` file in `node_modules/`). *(Spec 2.1)*
- **T-EXEC-18**: Directory script CWD is its own directory. Verify by checking `process.cwd()` in the script. *(Spec 6.1)*

### 4.5 Structured Output Parsing

**Spec refs:** 2.3

These tests use bash fixture scripts that echo specific strings to stdout, then verify loop behavior based on the parsed output.

#### Valid Structured Output

- **T-PARSE-01**: Script outputs `{"result":"hello"}` → parsed as structured output with result `"hello"`. Verify by having a goto chain where the result is piped and read by the next script. *(Spec 2.3)*
- **T-PARSE-02**: Script outputs `{"goto":"next"}` → loopx transitions to script `next`. *(Spec 2.3)*
- **T-PARSE-03**: Script outputs `{"stop":true}` → loop halts, exit code 0. *(Spec 2.3)*
- **T-PARSE-04**: Script outputs `{"result":"x","goto":"next","stop":true}` → stop takes priority, loop halts. *(Spec 2.3)*
- **T-PARSE-05**: Script outputs `{"result":"x","extra":"ignored"}` → `extra` silently ignored, result is `"x"`. *(Spec 2.3)*

#### Fallback to Raw Result

- **T-PARSE-06**: Script outputs `{"unknown":"field"}` (valid JSON object, no known fields) → entire stdout is treated as raw result. *(Spec 2.3)*
- **T-PARSE-07**: Script outputs `[1,2,3]` (JSON array) → treated as raw result. *(Spec 2.3)*
- **T-PARSE-08**: Script outputs `"hello"` (JSON string) → treated as raw result. *(Spec 2.3)*
- **T-PARSE-09**: Script outputs `42` (JSON number) → treated as raw result. *(Spec 2.3)*
- **T-PARSE-10**: Script outputs `true` (JSON boolean) → treated as raw result. *(Spec 2.3)*
- **T-PARSE-11**: Script outputs `null` (JSON null) → treated as raw result. *(Spec 2.3)*
- **T-PARSE-12**: Script outputs `not json at all` → treated as raw result. *(Spec 2.3)*
- **T-PARSE-13**: Script produces empty stdout (no output) → treated as raw result with empty string. Loop resets (no goto, no stop). *(Spec 2.3)*

#### Type Coercion

- **T-PARSE-14**: `{"result": 42}` → result coerced to `"42"`. *(Spec 2.3)*
- **T-PARSE-15**: `{"result": true}` → result coerced to `"true"`. *(Spec 2.3)*
- **T-PARSE-16**: `{"result": {"nested": "obj"}}` → result coerced via `String()` to `"[object Object]"`. *(Spec 2.3)*
- **T-PARSE-17**: `{"result": null}` → result coerced to `"null"`. *(Spec 2.3)*
- **T-PARSE-18**: `{"goto": 42}` → goto treated as absent (not a string). Loop resets to starting target. *(Spec 2.3)*
- **T-PARSE-19**: `{"goto": true}` → goto treated as absent. *(Spec 2.3)*
- **T-PARSE-20**: `{"goto": null}` → goto treated as absent. *(Spec 2.3)*
- **T-PARSE-21**: `{"stop": "true"}` → stop treated as absent (not boolean `true`). Loop continues. *(Spec 2.3)*
- **T-PARSE-22**: `{"stop": 1}` → stop treated as absent. Loop continues. *(Spec 2.3)*
- **T-PARSE-23**: `{"stop": false}` → stop treated as absent. Loop continues. *(Spec 2.3)*
- **T-PARSE-24**: `{"stop": "false"}` → stop treated as absent. *(Spec 2.3)*

#### Whitespace & Formatting

- **T-PARSE-25**: Script outputs JSON with trailing newline `{"result":"x"}\n` → parsed correctly. *(Spec 2.3)*
- **T-PARSE-26**: Script outputs pretty-printed JSON (with newlines and indentation) → parsed correctly. *(Spec 2.3)*
- **T-PARSE-27**: Script outputs JSON with leading whitespace → parsed correctly. *(Spec 2.3)*

### 4.6 Loop State Machine

**Spec refs:** 2.2, 7.1, 7.2, 6.7, 6.8

#### Basic Loop Behavior

- **T-LOOP-01**: Script produces no output → loop resets, starting target runs again. Use counter fixture with `-n 3` and verify 3 runs. *(Spec 2.2, 7.1)*
- **T-LOOP-02**: Script A → `goto:"B"` → B produces no output → starting target A runs again. Use counter fixtures for both A and B with `-n 4`. Assert A ran twice, B ran twice (A, B, A, B). *(Spec 2.2)*
- **T-LOOP-03**: A → `goto:"B"` → B → `goto:"C"` → C → no goto → A (back to start). With `-n 4`, assert execution order A, B, C, A. *(Spec 2.2)*
- **T-LOOP-04**: Script outputs `{"stop":true}` on first iteration → loop runs once, exits 0. *(Spec 2.2)*
- **T-LOOP-05**: A runs 3 times (no goto/stop), then outputs `{"stop":true}` on 4th. Assert exactly 4 iterations. Use a counter-based script. *(Spec 2.2)*

#### `-n` Counting

- **T-LOOP-06**: `-n 1` → exactly 1 iteration. *(Spec 7.1)*
- **T-LOOP-07**: `-n 3` with script that never stops → exactly 3 iterations. *(Spec 7.1)*
- **T-LOOP-08**: `-n 3` with A → `goto:"B"` → B → no goto. Execution: A, B, A. That's 3 iterations. Verify with counter fixtures. *(Spec 7.1)*
- **T-LOOP-09**: `-n 2` with A → `goto:"B"`. Execution: A (1), B (2). Verify B ran but A didn't run again. *(Spec 7.1)*
- **T-LOOP-10**: `-n 0` → no iterations, script never runs. *(Spec 7.1)*

#### Input Piping

- **T-LOOP-11**: A outputs `{"result":"payload","goto":"B"}`. B reads stdin (via `cat-stdin` fixture) and outputs it as result. Assert B received `"payload"`. *(Spec 6.7)*
- **T-LOOP-12**: A outputs `{"goto":"B"}` (no result). B reads stdin → empty string. *(Spec 2.3, 6.7)*
- **T-LOOP-13**: A outputs `{"result":"payload"}` (no goto). Loop resets to A. A reads stdin → empty string (result not piped on reset). *(Spec 6.7)*
- **T-LOOP-14**: First iteration (starting target) receives empty stdin. Use `cat-stdin` fixture, verify empty. *(Spec 6.8)*
- **T-LOOP-15**: A → `goto:"B"` with result → B → `goto:"C"` with result → C reads stdin. Assert C receives B's result, not A's. *(Spec 6.7)*

#### Goto Behavior

- **T-LOOP-16**: Goto is a transition, not permanent. A → `goto:"B"` → B → no goto → A runs again (not B). *(Spec 2.2)*
- **T-LOOP-17**: A → `goto:"A"` (self-referencing goto). Verify it works: A runs, then A runs again (2 iterations with -n 2). *(Spec 2.2)*
- **T-LOOP-18**: Goto target that doesn't exist → error, exit code 1. Stderr mentions the invalid target name. *(Spec 7.2)*
- **T-LOOP-19**: Goto to a script that was not discovered (e.g., a `.mjs` file) → error. *(Spec 7.2)*

#### Error Handling

- **T-LOOP-20**: Script exits with code 1 → loop stops immediately. loopx exits with code 1. *(Spec 7.2)*
- **T-LOOP-21**: Script exits with code 2 → same behavior (any non-zero is an error). *(Spec 7.2)*
- **T-LOOP-22**: Script fails on iteration 3 of 5 (`-n 5`). Assert exactly 3 iterations ran (loop stopped at failure). *(Spec 7.2)*
- **T-LOOP-23**: Script's stderr output on failure is visible on CLI stderr. *(Spec 7.2)*
- **T-LOOP-24**: Script's stdout on failure is NOT parsed as structured output. Use a script that prints valid JSON to stdout then exits 1 — the JSON should not be treated as output. *(Spec 7.2)*

#### Final Iteration Output

- **T-LOOP-25**: `-n 2` with script producing `{"result":"iter-N"}`. Both iterations' outputs are observable via programmatic API. Verify programmatic API yields both. *(Spec 7.1)*

### 4.7 Environment Variables

**Spec refs:** 8.1–8.3

All env tests use `withGlobalEnv` to isolate from the real user config.

#### Global Env File

- **T-ENV-01**: Variable set via `loopx env set` is available in a script via `$VAR_NAME` (bash) or `process.env.VAR_NAME` (TS). *(Spec 8.1, 8.3)*
- **T-ENV-02**: Variable removed via `loopx env remove` is no longer available in scripts. *(Spec 8.1)*
- **T-ENV-03**: `XDG_CONFIG_HOME` is respected. Set `XDG_CONFIG_HOME=/tmp/custom`, run `loopx env set X Y`, verify file exists at `/tmp/custom/loopx/env`. *(Spec 8.1)*
- **T-ENV-04**: When `XDG_CONFIG_HOME` is unset, default is `~/.config`. Use `withGlobalEnv` and verify path. *(Spec 8.1)*
- **T-ENV-05**: Config directory created on first `env set`. Start with no directory, run `env set`, verify directory was created. *(Spec 8.1)*

#### Env File Parsing

- **T-ENV-06**: `KEY=VALUE` parsed correctly. *(Spec 8.1)*
- **T-ENV-07**: Lines starting with `#` are comments, ignored. *(Spec 8.1)*
- **T-ENV-08**: Blank lines ignored. *(Spec 8.1)*
- **T-ENV-09**: Duplicate keys: last occurrence wins. File: `X=first\nX=second`. Script sees `X=second`. *(Spec 8.1)*
- **T-ENV-10**: Double-quoted value: `KEY="hello world"` → value is `hello world` (quotes stripped). *(Spec 8.1)*
- **T-ENV-11**: Single-quoted value: `KEY='hello world'` → value is `hello world`. *(Spec 8.1)*
- **T-ENV-12**: No escape sequences: `KEY="hello\nworld"` → value is literal `hello\nworld` (backslash + n, not newline). *(Spec 8.1)*
- **T-ENV-13**: Inline `#` is part of value: `KEY=value#notcomment` → value is `value#notcomment`. *(Spec 8.1)*
- **T-ENV-14**: Trailing whitespace on value trimmed: `KEY=value   ` → value is `value`. *(Spec 8.1)*
- **T-ENV-15**: No whitespace around `=`: `KEY = value` — the key is `KEY ` which contains a space. Test that this does NOT set `KEY` to `value`. *(Spec 8.1)*

#### Local Env Override (`-e`)

- **T-ENV-16**: `-e local.env` loads variables into script environment. *(Spec 8.2)*
- **T-ENV-17**: `-e nonexistent.env` → error, exit 1. *(Spec 8.2)*
- **T-ENV-18**: Global has `X=global`, local has `X=local` → script sees `X=local`. *(Spec 8.2)*
- **T-ENV-19**: Global has `A=1`, local has `B=2` → script sees both `A=1` and `B=2`. *(Spec 8.2)*

#### Injection Precedence

- **T-ENV-20**: `LOOPX_BIN` is always set, even if the user sets `LOOPX_BIN=fake` in global/local env. Script sees the real binary path, not `"fake"`. *(Spec 8.3)*
- **T-ENV-21**: `LOOPX_PROJECT_ROOT` always set, overrides user-supplied value. *(Spec 8.3)*
- **T-ENV-22**: System env has `SYS_VAR=sys`, global env has `SYS_VAR=global` → script sees `global`. *(Spec 8.3)*
- **T-ENV-23**: System env has `SYS_VAR=sys`, no loopx override → script sees `sys`. *(Spec 8.3)*
- **T-ENV-24**: Full precedence chain. Set `VAR` at system, global, and local levels. Assert local wins. Then remove from local → global wins. Then remove from global → system wins. *(Spec 8.3)*

#### Env Caching

- **T-ENV-25**: During a multi-iteration loop, modify the global env file between iterations. Assert the script continues to see the original values (env loaded once at start). *(Spec 8.1)*

### 4.8 Module Resolution & Script Helpers

**Spec refs:** 3.3, 3.4, 6.5, 6.6

#### `import from "loopx"` Resolution

- **T-MOD-01**: A TS script with `import { output } from "loopx"` runs successfully under Node.js. `[Node]` *(Spec 3.3)*
- **T-MOD-02**: Same import works under Bun. `[Bun]` *(Spec 3.3)*
- **T-MOD-03**: A JS script with `import { output } from "loopx"` also works. *(Spec 3.3)*

#### `output()` Function

- **T-MOD-04**: `output({ result: "hello" })` → script stdout is `{"result":"hello"}`, exit code 0. *(Spec 6.5)*
- **T-MOD-05**: `output({ result: "x", goto: "y" })` → stdout contains both fields. *(Spec 6.5)*
- **T-MOD-06**: `output({ stop: true })` → stdout contains `"stop":true`. *(Spec 6.5)*
- **T-MOD-07**: `output({})` → script throws/crashes (no known fields). Exit code non-zero. *(Spec 6.5)*
- **T-MOD-08**: `output(null)` → error thrown. *(Spec 6.5)*
- **T-MOD-09**: `output(undefined)` → error thrown. *(Spec 6.5)*
- **T-MOD-10**: `output("string")` → stdout is `{"result":"string"}`. *(Spec 6.5)*
- **T-MOD-11**: `output(42)` → stdout is `{"result":"42"}`. *(Spec 6.5)*
- **T-MOD-12**: `output(true)` → stdout is `{"result":"true"}`. *(Spec 6.5)*
- **T-MOD-13**: `output({ result: "x", goto: undefined })` → goto is absent from JSON output. *(Spec 6.5)*
- **T-MOD-14**: Code after `output()` does not execute. Script: `output({ result: "a" }); writeFileSync("/tmp/marker", "ran")`. Assert marker file does not exist. *(Spec 6.5)*

#### `input()` Function

- **T-MOD-15**: `input()` returns empty string on first iteration (no prior input). *(Spec 6.6)*
- **T-MOD-16**: A → `output({ result: "payload", goto: "B" })` → B calls `input()` → receives `"payload"`. *(Spec 6.6)*
- **T-MOD-17**: `input()` called twice in the same script returns the same value (cached). *(Spec 6.6)*
- **T-MOD-18**: `input()` returns a Promise (test by awaiting it). *(Spec 6.6)*

#### `LOOPX_BIN` in Bash Scripts

- **T-MOD-19**: Bash script can use `$LOOPX_BIN output --result "hello"` to produce structured output. The loop processes this output correctly. *(Spec 3.4)*
- **T-MOD-20**: `$LOOPX_BIN` is a valid path to an executable file. *(Spec 3.4)*
- **T-MOD-21**: `$LOOPX_BIN version` prints the loopx version string. *(Spec 3.4)*

### 4.9 Programmatic API

**Spec refs:** 9.1–9.5

Tests import `run` and `runPromise` from the built loopx package and call them with `cwd` pointing to temp project directories.

#### `run()` (AsyncGenerator)

- **T-API-01**: `run("myscript")` returns an async generator. Calling `next()` yields an `Output` object. *(Spec 9.1)*
- **T-API-02**: Generator yields one `Output` per iteration. With `-n 3`, collect all yields → array of 3 outputs. *(Spec 9.1)*
- **T-API-03**: Generator completes (returns `{ done: true }`) when script outputs `stop: true`. *(Spec 9.1)*
- **T-API-04**: Generator completes when `maxIterations` is reached. *(Spec 9.1)*
- **T-API-05**: The output from the final iteration is yielded before the generator completes. *(Spec 9.1)*
- **T-API-06**: Breaking out of `for await` loop terminates the child process. Assert the child is no longer running after break. *(Spec 9.1)*
- **T-API-07**: `run("myscript", { cwd: "/path/to/project" })` resolves scripts relative to the given cwd. *(Spec 9.5)*
- **T-API-08**: `run("myscript", { maxIterations: 0 })` → generator completes immediately with no yields. *(Spec 9.5)*
- **T-API-09**: `run()` with no script name runs the `default` script. *(Spec 9.1)*

#### `run()` with AbortSignal

- **T-API-10**: `run("myscript", { signal })` — aborting the signal terminates the loop and the generator throws an abort error. *(Spec 9.5)*

#### `runPromise()`

- **T-API-11**: `runPromise("myscript", { maxIterations: 3 })` resolves with an array of 3 `Output` objects. *(Spec 9.2)*
- **T-API-12**: `runPromise()` resolves when `stop: true` is output. *(Spec 9.2)*
- **T-API-13**: `runPromise()` rejects when a script exits non-zero. *(Spec 9.3)*
- **T-API-14**: `runPromise()` accepts the same options as `run()`. *(Spec 9.2)*

#### Error Behavior

- **T-API-15**: Programmatic API never prints `result` to stdout. Run `run()` and capture `process.stdout` — no result values appear. *(Spec 9.3)*
- **T-API-16**: Non-zero script exit causes `run()` generator to throw. *(Spec 9.3)*
- **T-API-17**: Invalid goto target causes `run()` generator to throw. *(Spec 9.3)*
- **T-API-18**: Script stderr is forwarded to the calling process's stderr. *(Spec 9.3)*
- **T-API-19**: When `run()` throws, previously yielded outputs are preserved (the caller already consumed them). Test: collect outputs in an array, handle the throw, verify array has the partial results. *(Spec 9.3)*
- **T-API-20**: When `runPromise()` rejects, partial outputs are NOT available. *(Spec 9.3)*

#### `envFile` Option

- **T-API-21**: `run("myscript", { envFile: "local.env" })` loads the env file. Script sees the variables. *(Spec 9.5)*

### 4.10 Install Command

**Spec refs:** 10.1–10.3

All install tests use local servers (HTTP, file:// git repos). No network access.

#### Source Detection

- **T-INST-01**: `loopx install myorg/my-script` is treated as github git URL (`https://github.com/myorg/my-script.git`). Verify by having a local git server that the test redirects to (or by intercepting and verifying the expanded URL via error messages). *(Spec 10.1)*
- **T-INST-02**: `loopx install https://github.com/org/repo` → treated as git (known host). *(Spec 10.1)*
- **T-INST-03**: `loopx install https://gitlab.com/org/repo` → treated as git. *(Spec 10.1)*
- **T-INST-04**: `loopx install https://bitbucket.org/org/repo` → treated as git. *(Spec 10.1)*
- **T-INST-05**: `loopx install https://example.com/repo.git` → treated as git (.git suffix). *(Spec 10.1)*
- **T-INST-06**: `loopx install http://localhost:PORT/pkg.tar.gz` → treated as tarball. *(Spec 10.1)*
- **T-INST-07**: `loopx install http://localhost:PORT/pkg.tgz` → treated as tarball. *(Spec 10.1)*
- **T-INST-08**: `loopx install http://localhost:PORT/script.ts` → treated as single file. *(Spec 10.1)*

#### Single-File Install

- **T-INST-09**: Downloading a `.ts` file places it in `.loopx/` with the correct filename. *(Spec 10.2)*
- **T-INST-10**: URL with query string `?token=abc` → query stripped from filename. *(Spec 10.2)*
- **T-INST-11**: URL with fragment `#section` → fragment stripped from filename. *(Spec 10.2)*
- **T-INST-12**: URL ending in unsupported extension (e.g., `.py`) → error, nothing saved. *(Spec 10.2)*
- **T-INST-13**: Script name = base name of downloaded file (e.g., `script.ts` → name `script`). *(Spec 10.2)*
- **T-INST-14**: `.loopx/` directory created if it doesn't exist. *(Spec 10.3)*

#### Git Install

- **T-INST-15**: Cloning a git repo places it in `.loopx/<repo-name>/`. *(Spec 10.2)*
- **T-INST-16**: Shallow clone (`--depth 1`). Verify the clone has only 1 commit (`git -C .loopx/<name> rev-list --count HEAD` = 1). *(Spec 10.2)*
- **T-INST-17**: Repo name derived from URL minus `.git` suffix. *(Spec 10.2)*
- **T-INST-18**: Repo name derived from URL without `.git` suffix (e.g., github.com known host). *(Spec 10.2)*
- **T-INST-19**: Cloned repo must have `package.json` with `main`. If missing → clone removed, error displayed. *(Spec 10.2)*
- **T-INST-20**: Cloned repo has `package.json` with `main` pointing to unsupported extension → clone removed, error. *(Spec 10.2)*
- **T-INST-21**: Successful git install → directory script is runnable via `loopx -n 1 <name>`. *(Spec 10.2)*

#### Tarball Install

- **T-INST-22**: Downloading and extracting a `.tar.gz` file places contents in `.loopx/<archive-name>/`. *(Spec 10.2)*
- **T-INST-23**: Single top-level directory in archive → that directory becomes the package root (unwrapped). *(Spec 10.2)*
- **T-INST-24**: Multiple top-level entries in archive → placed directly in `.loopx/<archive-name>/`. *(Spec 10.2)*
- **T-INST-25**: `.tgz` extension handled identically. *(Spec 10.2)*
- **T-INST-26**: Extracted directory must have `package.json` with `main`. If not → directory removed, error. *(Spec 10.2)*

#### Common Rules

- **T-INST-27**: Installing when a script with the same name already exists → error, existing script untouched. *(Spec 10.3)*
- **T-INST-28**: Installing a script with a reserved name (e.g., `output.ts`) → error, nothing saved. *(Spec 10.3)*
- **T-INST-29**: Installing a script with invalid name (e.g., `-invalid.ts`) → error, nothing saved. *(Spec 10.3)*
- **T-INST-30**: No automatic `npm install` / `bun install` after clone/extract. Verify `node_modules/` does not appear in installed directory script. *(Spec 10.3)*

### 4.11 Signal Handling

**Spec refs:** 7.3

Signal tests use the `sleep-then-exit` fixture (a bash script that sleeps for a long time) and the `spawn-grandchild` fixture.

- **T-SIG-01**: Send SIGINT to loopx while a script is running. Assert loopx exits with code 130 (128 + 2). *(Spec 7.3)*
- **T-SIG-02**: Send SIGTERM to loopx while a script is running. Assert loopx exits with code 143 (128 + 15). *(Spec 7.3)*
- **T-SIG-03**: After SIGINT, the child script process is no longer running. Check by writing child PID to a file, then verifying the process is gone after loopx exits. *(Spec 7.3)*
- **T-SIG-04**: Grace period: child script traps SIGTERM and exits within 2 seconds. Assert loopx exits cleanly (no SIGKILL needed, exit code 128+15). *(Spec 7.3)*
- **T-SIG-05**: Grace period exceeded: child script traps SIGTERM and hangs (ignores it). Assert loopx sends SIGKILL after ~5 seconds and exits. *(Spec 7.3)*
- **T-SIG-06**: Process group signal: script spawns a grandchild process. Send SIGTERM to loopx. Assert both the script and grandchild are terminated. *(Spec 7.3)*
- **T-SIG-07**: Signal between iterations: loopx is between iterations (just finished one script, about to start next). Send SIGINT. Assert loopx exits immediately with code 130. *(Spec 7.3)*

### 4.12 CLI Delegation

**Spec refs:** 3.2

#### Setup

Delegation tests create the following structure:
```
/tmp/test-project/
  node_modules/
    .bin/
      loopx → symlink or wrapper script pointing to a "local" build
  .loopx/
    marker.sh → script that writes LOOPX_BIN to a file
```

The "global" binary is the primary build. The "local" binary is a separate build or a wrapper that sets a marker.

#### Tests

- **T-DEL-01**: When `node_modules/.bin/loopx` exists in CWD, the global binary delegates to it. Verify by having the local binary write a marker file. *(Spec 3.2)*
- **T-DEL-02**: When `node_modules/.bin/loopx` exists in an ancestor directory (e.g., `../node_modules/.bin/loopx`), delegation finds it. *(Spec 3.2)*
- **T-DEL-03**: Nearest ancestor wins. Create local installs at both CWD and parent. Assert CWD's version is used. *(Spec 3.2)*
- **T-DEL-04**: `LOOPX_DELEGATED=1` in environment prevents delegation. Even if `node_modules/.bin/loopx` exists, the global binary runs. *(Spec 3.2)*
- **T-DEL-05**: After delegation, `LOOPX_BIN` contains the resolved realpath of the local binary (not the global one, not a symlink). *(Spec 3.2)*
- **T-DEL-06**: After delegation, `import from "loopx"` in scripts resolves to the local version's package. *(Spec 3.2)*

### 4.13 Exit Codes (Cross-Cutting)

**Spec refs:** 12

These tests consolidate exit code assertions. Many are also verified in other sections, but this section ensures completeness.

- **T-EXIT-01**: Clean exit via `stop: true` → code 0. *(Spec 12)*
- **T-EXIT-02**: Clean exit via `-n` limit reached → code 0. *(Spec 12)*
- **T-EXIT-03**: Clean exit via `-n 0` → code 0. *(Spec 12)*
- **T-EXIT-04**: Successful subcommand (`loopx version`) → code 0. *(Spec 12)*
- **T-EXIT-05**: Script exits non-zero → code 1. *(Spec 12)*
- **T-EXIT-06**: Validation failure (name collision) → code 1. *(Spec 12)*
- **T-EXIT-07**: Invalid goto target → code 1. *(Spec 12)*
- **T-EXIT-08**: Missing script → code 1. *(Spec 12)*
- **T-EXIT-09**: Missing `.loopx/` directory → code 1. *(Spec 12)*
- **T-EXIT-10**: Usage error (invalid `-n`) → code 1. *(Spec 12)*
- **T-EXIT-11**: Missing `-e` file → code 1. *(Spec 12)*
- **T-EXIT-12**: SIGINT → code 130. *(Spec 12)*
- **T-EXIT-13**: SIGTERM → code 143. *(Spec 12)*

---

## 5. Fuzz Testing

Fuzz tests use `fast-check` for property-based testing. They are designed to find edge cases that manual test enumeration misses.

### 5.1 Structured Output Fuzzer

**File:** `tests/fuzz/output-parsing.fuzz.test.ts`

**Approach:** Generate random strings and feed them as the stdout of a bash script. Verify invariants hold for all inputs.

#### Generators

| Generator | Description |
|-----------|-------------|
| `arbitraryJSON` | Random valid JSON values (objects, arrays, strings, numbers, booleans, null) |
| `arbitraryString` | Random strings including unicode, control characters, empty, very long |
| `arbitraryOutputObject` | Random objects with `result`, `goto`, `stop` fields of various types |
| `arbitraryMalformedJSON` | Strings that look like JSON but are malformed (truncated, extra commas, etc.) |

#### Properties

- **F-PARSE-01: No crashes.** For any string written to stdout, loopx does not crash with an uncaught exception. It exits with code 0 (loop resets or stops) or code 1 (script error). Never any other exit code for non-signal cases.

- **F-PARSE-02: Deterministic parsing.** The same stdout content always produces the same behavior (same exit code, same next script, same piped input). Run the same fixture twice and compare results.

- **F-PARSE-03: Type safety of parsed output.** If the output is parsed as structured output (i.e., a valid JSON object with known fields), then:
  - `result`, if present, is always a string (coercion applied).
  - `goto`, if present, is always a string (invalid types discarded).
  - `stop`, if present, is always `true` (other values discarded).

- **F-PARSE-04: Raw fallback consistency.** If the stdout is not a valid JSON object containing at least one known field, the entire stdout is treated as the `result` value. Verify by piping through a goto chain and checking the received value.

- **F-PARSE-05: Binary-safe.** Stdout containing null bytes, high-unicode, or other binary content does not cause crashes or hangs.

#### Methodology

For each generated input:
1. Write a bash script that `echo`s the input to stdout.
2. Set up a two-script chain: A (the echo script) → goto B (a stdin reader). Use a wrapper script that always outputs `goto:"reader"` regardless of what the inner echo produces. If the echo output overrides the goto (i.e., it's a valid structured output with its own goto or stop), the test observes that behavior instead.
3. Alternatively, use the programmatic API (`run()`) to observe the parsed output directly.
4. Assert the invariants above.

**Iterations:** At least 1000 random inputs per property. Increase for CI.

### 5.2 Env File Fuzzer

**File:** `tests/fuzz/env-parsing.fuzz.test.ts`

**Approach:** Generate random `.env` file contents and load them via `-e`. Verify invariants.

#### Generators

| Generator | Description |
|-----------|-------------|
| `arbitraryEnvFile` | Random multi-line strings with valid/invalid KEY=VALUE pairs |
| `arbitraryEnvLine` | Single lines: valid pairs, comments, blank, malformed |
| `arbitraryEnvValue` | Values with special characters: quotes, `#`, `=`, spaces, unicode |

#### Properties

- **F-ENV-01: No crashes.** For any string as `.env` file content, loopx does not crash. It either loads successfully or reports an error gracefully.

- **F-ENV-02: Deterministic parsing.** Same file content → same variables loaded. Run twice, compare.

- **F-ENV-03: Keys and values are strings.** All loaded environment variables have string keys and string values (no type confusion).

- **F-ENV-04: Last-wins for duplicates.** If a key appears multiple times, the last value is always the one seen by scripts.

- **F-ENV-05: Comment lines never produce variables.** Lines starting with `#` never result in environment variables being set.

**Iterations:** At least 1000 random inputs per property.

---

## 6. Supplementary Unit Tests

Unit tests provide fast feedback on isolated parsing/logic functions. They are NOT the primary validation strategy but add confidence.

### 6.1 Output Parsing Unit Tests

**File:** `tests/unit/parse-output.test.ts`

If the output parsing logic is exposed as an internal function (e.g., `parseOutput(stdout: string): Output`), test it directly:

- Valid JSON objects with various field combinations
- Type coercion cases (result as number, goto as boolean, stop as string)
- Edge cases: empty string, whitespace-only, very large strings
- Non-object JSON values (arrays, primitives, null)
- Malformed JSON

### 6.2 Env Parsing Unit Tests

**File:** `tests/unit/parse-env.test.ts`

If the env parser is exposed as an internal function:

- Standard KEY=VALUE pairs
- Comments, blank lines
- Quoted values (single, double)
- Escape sequences (literal, not interpreted)
- Duplicate keys
- Inline `#` characters
- Edge cases: `=` in values, empty values, very long values

### 6.3 Source Detection Unit Tests

**File:** `tests/unit/source-detection.test.ts`

Test the source classification logic (section 10.1) in isolation:

- `org/repo` → git (github)
- Various URLs → correct source type
- Edge cases: URLs with ports, auth, paths, query strings

---

## 7. Edge Cases & Boundary Tests

These tests specifically target boundary conditions that could reveal implementation bugs.

- **T-EDGE-01**: Very long result string (~1 MB). Script outputs `{"result":"<1MB>"}`. Assert it is handled without truncation or hang. *(Spec 2.3)*
- **T-EDGE-02**: Result containing JSON-special characters (quotes, backslashes, newlines). Verify correct JSON serialization/deserialization. *(Spec 2.3)*
- **T-EDGE-03**: Script that writes stdout in multiple `write()` calls (partial writes). Assert the full output is captured and parsed as a unit. *(Spec 2.3)*
- **T-EDGE-04**: Script that writes to both stdout and stderr. Assert stdout captured as output, stderr passed through. No interleaving issues. *(Spec 6.2, 6.3)*
- **T-EDGE-05**: Unicode in result values, script names (if allowed by name pattern), and env values. *(Spec 2.3, 8.1)*
- **T-EDGE-06**: Deeply nested goto chain (A → B → C → D → E → ... → Z). Assert correct execution order and iteration counting. *(Spec 7.1)*
- **T-EDGE-07**: Script that produces output on stdout but also reads from stdin when no input is available. Assert no deadlock. *(Spec 6.8)*
- **T-EDGE-08**: Two concurrent loopx invocations in the same project directory. Assert no interference (they should be independent processes). *(General)*
- **T-EDGE-09**: `.loopx/` directory with many scripts (100+). Assert discovery completes in reasonable time. *(Spec 5.1)*
- **T-EDGE-10**: Script name that is the maximum allowed length (e.g., 255 characters, filesystem limit). *(Spec 5.4)*
- **T-EDGE-11**: `-n` with very large value (e.g., `999999`). Assert no integer overflow or similar. Script should `stop` after a few iterations. *(Spec 4.2)*
- **T-EDGE-12**: Empty `.loopx/` directory (exists but no scripts). `loopx` → error (no default script). `loopx myscript` → error (not found). *(Spec 4.1)*
- **T-EDGE-13**: Script that takes a long time (10+ seconds). Assert loopx waits for it (no premature timeout). *(General)*
- **T-EDGE-14**: Env file with no newline at end of file. Assert last line is still parsed. *(Spec 8.1)*
- **T-EDGE-15**: Env file that is completely empty (0 bytes). Assert no error, no variables loaded. *(Spec 8.1)*

---

## 8. CI Configuration

### 8.1 Runtime Matrix

CI should test against:

| Runtime | Versions |
|---------|----------|
| Node.js | 20.6 (minimum), latest LTS, latest current |
| Bun | 1.0 (minimum), latest |

### 8.2 Pipeline Stages

1. **Build**: Compile/bundle loopx.
2. **Phase 0 (Harness)**: Run `tests/harness/`. Fail the pipeline if any fail.
3. **Unit Tests**: Run `tests/unit/`.
4. **E2E Tests**: Run `tests/e2e/`. Parameterized over runtime matrix.
5. **Fuzz Tests**: Run `tests/fuzz/` with a CI-appropriate iteration count (e.g., 5000).
6. **Stub Validation** (optional, periodic): Run spec tests against stub binary and verify failure count hasn't decreased (tests haven't become vacuous).

### 8.3 Timeouts

| Suite | Timeout per test |
|-------|-----------------|
| Harness | 10s |
| Unit | 5s |
| E2E | 30s |
| E2E (signals) | 60s |
| Fuzz | 120s |

### 8.4 Parallelism

- Vitest runs test files in parallel by default. Each test file uses isolated temp directories, so this is safe.
- Signal tests should run serially within their file (signal timing is sensitive).
- Install tests that start local servers should share a single server instance per file.

---

## Appendix: Spec Requirement Traceability Matrix

Maps each SPEC.md section to the test IDs that verify it.

| Spec Section | Description | Test IDs |
|-------------|-------------|----------|
| 2.1 | Script (file & directory) | T-DISC-01–17 |
| 2.2 | Loop (state machine) | T-LOOP-01–05, T-LOOP-16–17 |
| 2.3 | Structured Output | T-PARSE-01–27, F-PARSE-01–05 |
| 3.2 | CLI Delegation | T-DEL-01–06 |
| 3.3 | Module Resolution | T-MOD-01–03 |
| 3.4 | Bash Script Binary Access | T-MOD-19–21 |
| 4.1 | Running Scripts | T-CLI-08–13 |
| 4.2 | Options (-n, -e, -h) | T-CLI-02–07, T-CLI-14–22 |
| 4.3 | Subcommands | T-SUB-01–19 |
| 5.1 | Discovery | T-DISC-01–17, T-DISC-33–38 |
| 5.2 | Name Collision | T-DISC-18–21 |
| 5.3 | Reserved Names | T-DISC-22–26 |
| 5.4 | Name Restrictions | T-DISC-27–32 |
| 5.5 | Validation Scope | T-DISC-39–42, T-SUB-06, T-SUB-13, T-SUB-19 |
| 6.1 | Working Directory | T-EXEC-01–04 |
| 6.2 | Bash Scripts | T-EXEC-05–07 |
| 6.3 | JS/TS Scripts | T-EXEC-08–14 |
| 6.4 | Directory Scripts | T-EXEC-15–18 |
| 6.5 | output() Function | T-MOD-04–14 |
| 6.6 | input() Function | T-MOD-15–18 |
| 6.7 | Input Piping | T-LOOP-11–15 |
| 6.8 | Initial Input | T-LOOP-14 |
| 7.1 | Basic Loop | T-LOOP-01–10, T-LOOP-25 |
| 7.2 | Error Handling | T-LOOP-18–24 |
| 7.3 | Signal Handling | T-SIG-01–07 |
| 8.1 | Global Env Storage | T-ENV-01–15, T-ENV-25, F-ENV-01–05 |
| 8.2 | Local Env Override | T-ENV-16–19 |
| 8.3 | Env Injection Precedence | T-ENV-20–24 |
| 9.1 | run() | T-API-01–10 |
| 9.2 | runPromise() | T-API-11–14 |
| 9.3 | API Error Behavior | T-API-15–20 |
| 9.5 | Types / RunOptions | T-API-07–08, T-API-10, T-API-21 |
| 10.1 | Source Detection | T-INST-01–08 |
| 10.2 | Source Type Details | T-INST-09–26 |
| 10.3 | Common Install Rules | T-INST-27–30 |
| 11 | Help | T-CLI-02–07 |
| 12 | Exit Codes | T-EXIT-01–13 |
