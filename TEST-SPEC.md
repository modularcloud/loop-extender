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

### 1.3 Coverage Scope

This suite is the **implementation-driving** test suite — it defines the behavior that must pass before a feature is considered complete. Not all SPEC.md requirements are covered by automated tests in this suite:

- **Spec 3.1 (Global Install):** The global install workflow (`npm install -g loopx` → `loopx` available on `PATH`) is a **release-gate requirement**, not part of the regular automated suite. The E2E tests exercise the built binary directly, which covers all runtime behavior. A true global-install smoke test (`npm pack` → install into isolated global prefix → run against fixture project) should be run as part of the release process, not on every CI run.

- **Spec 7.3 (Signal Handling — between iterations):** The between-iterations signal case (signal arrives when no child process is running) is inherently timing-sensitive and difficult to test reliably in a black-box E2E harness. Coverage for this clause is **partial**: T-SIG-07a provides a supplementary unit-level test if the implementation exposes a testable code path, but is otherwise skipped. The active-child signal cases (T-SIG-01–06) are fully covered.

- **Spec 9.1 (Async Generator Cancellation):** Two cancellation modes exist: "break after yield" (T-API-06) and "return during pending next" (T-API-09a). The latter is partially blocked by SP-26 pending spec clarification of the precise cancellation contract.

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
    types.test.ts              Compile-time type surface verification
  helpers/
    cli.ts                     CLI spawning utilities (runCLI, runCLIWithSignal)
    api-driver.ts              Programmatic API driver (runAPIDriver)
    fixtures.ts                Temp dir, script, and project creation
    servers.ts                 Local HTTP & git servers, git URL rewriting
    env.ts                     Env file creation, global config, isolated home
    runtime.ts                 Runtime detection & matrix helpers
    delegation.ts              Delegation fixture setup (withDelegationSetup)
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

**Important:** The CLI never prints `result` to its own stdout (Spec 7.1). To observe parsed `Output` objects, use `runAPIDriver()` or the programmatic API. `runCLI` is for asserting exit codes, stderr output, filesystem side effects, and control flow.

#### `runAPIDriver(runtime, code, options?): Promise<{ stdout: string, stderr: string, exitCode: number }>`

Spawns a tiny driver script under the specified runtime (Node.js or Bun) that imports from the loopx package, runs the provided code string, and prints JSON results to stdout. This is the correct way to test programmatic API behavior under Bun — importing loopx directly inside a Node-hosted Vitest process does not exercise Bun's runtime.

**Import resolution:** The driver must import from the built loopx package as a real consumer would. The helper creates a temporary consumer directory with a `package.json` and a symlinked (or file-protocol-linked) `node_modules/loopx` pointing to the build output. This ensures that `import { run } from "loopx"` exercises the actual package exports, not test-internal paths.

Example:
```typescript
const result = await runAPIDriver("bun", `
  import { runPromise } from "loopx";
  const outputs = await runPromise("myscript", { cwd: "${project.dir}" });
  console.log(JSON.stringify(outputs));
`, { cwd: project.dir });
const outputs = JSON.parse(result.stdout);
```

#### `runCLIWithSignal(args, options): Promise<CLIResult>`

Like `runCLI`, but also returns a `sendSignal(signal)` function and a `waitForStderr(pattern)` function so the test can send SIGINT/SIGTERM at a controlled point during execution.

#### `createEnvFile(path, vars): void`

Writes a `.env` format file with the given key-value pairs. Produces well-formed `KEY=VALUE\n` lines. Suitable for tests that only need valid, simple env files.

#### `writeEnvFileRaw(path, content): void`

Writes raw text to a file at `path` with no transformation. This is the low-level helper for env parser tests that need to control exact file content — duplicate keys, malformed lines, unmatched quotes, comments, blank lines, missing trailing newlines, etc. `createEnvFile` cannot represent these cases.

#### `withGlobalEnv(vars, fn): Promise<void>`

Sets `XDG_CONFIG_HOME` to a temp directory, writes a global env file with the given vars, runs `fn`, then cleans up. This isolates global env tests from the user's real config.

#### `withIsolatedHome(fn): Promise<void>`

Sets `HOME` to a temp directory and optionally unsets `XDG_CONFIG_HOME`, then runs `fn`, then restores. This safely tests the `~/.config` default fallback path without touching the real home directory. Used for T-ENV-04 and related tests.

#### `withDelegationSetup(options): Promise<DelegationFixture>`

Provisions realistic delegation test fixtures: creates actual launcher files and symlinks in `node_modules/.bin/loopx` within a temp project. Returns paths and cleanup. This helper is used for T-DEL-* and LOOPX_BIN tests instead of `runCLI`, because `runCLI`'s `node /path/to/bin.js` invocation does not exercise delegation or realpath resolution.

```typescript
interface DelegationFixture {
  projectDir: string;
  globalBinPath: string;      // path to "global" loopx binary
  localBinPath: string;       // path to "local" loopx in node_modules/.bin/
  runGlobal(args: string[]): Promise<CLIResult>;  // spawns the global binary
  cleanup(): void;
}
```

#### `startLocalHTTPServer(routes): Promise<{ url: string, close: () => void }>`

Starts a local HTTP server serving the specified routes. Used for install tests (single-file downloads, tarball downloads).

#### `startLocalGitServer(repos): Promise<{ url: string, close: () => void }>`

Creates local bare git repositories and serves them over a local protocol. Used for `loopx install` git tests. Implementation: create bare repos with `git init --bare`, then clone/commit/push fixture content, and serve via `git daemon` or direct file:// URLs.

#### `withGitURLRewrite(rewrites, fn): Promise<void>`

Sets up an isolated git configuration (via `GIT_CONFIG_GLOBAL` and isolated `HOME`) with `url.<base>.insteadOf` rules so that known-host URLs (e.g., `https://github.com/org/repo.git`) are transparently rewritten to local `file://` bare repos. This allows T-INST-01 through T-INST-04 to test known-host source detection without network access.

```typescript
await withGitURLRewrite({
  "https://github.com/myorg/my-script.git": "/tmp/bare-repos/my-script.git"
}, async () => {
  const result = await runCLI(["install", "myorg/my-script"], { cwd: project.dir });
  // Verifies org/repo shorthand expands to github URL, which is rewritten to local repo
});
```

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
| `emit-result(value)` | bash | `printf '{"result":"%s"}' '<value>'` — uses `printf` (not `echo`) to avoid trailing newline ambiguity |
| `emit-goto(target)` | bash | `printf '{"goto":"%s"}' '<target>'` |
| `emit-stop()` | bash | `printf '{"stop":true}'` |
| `emit-result-goto(value, target)` | bash | `printf '{"result":"%s","goto":"%s"}' '<value>' '<target>'` |
| `emit-raw(text)` | bash | `printf '%s' '<text>'` — exact bytes, no trailing newline unless explicitly included |
| `emit-raw-ln(text)` | bash | `printf '%s\n' '<text>'` — with trailing newline, for tests that need to verify newline handling |
| `exit-code(n)` | bash | `exit <n>` |
| `cat-stdin()` | bash | Reads stdin, echoes it as result |
| `write-stderr(msg)` | bash | `echo '<msg>' >&2` then produces output |
| `sleep-then-exit(seconds)` | bash | Sleeps, then exits. For signal tests. |
| `write-env-to-file(varname, markerPath)` | bash | Writes `$VARNAME` to a marker file. Observation via filesystem, not CLI stdout. |
| `write-cwd-to-file(markerPath)` | bash | Writes `$PWD` to a marker file. |
| `write-value-to-file(value, markerPath)` | bash | Writes a literal value to a marker file. General-purpose observation helper. |
| `stdout-writer(payloadFile)` | ts | Reads `payloadFile` from disk and writes its contents to stdout via `process.stdout.write()`. Used for fuzz and exact-byte output tests. |
| `ts-output(fields)` | ts | Uses `import { output } from "loopx"` to emit structured output |
| `ts-input-echo()` | ts | Reads input(), outputs it as result |
| `ts-import-check()` | ts | Imports from "loopx", outputs success marker |
| `spawn-grandchild()` | bash | Spawns a background subprocess, then waits. For process group signal tests. |
| `counter(file)` | bash | Appends "1" to a counter file each invocation, outputs count as result |

**Fixture naming note:** The `emit-*` fixtures replace the previous `echo-*` fixtures. `printf` is used instead of `echo` to provide exact byte control — `echo` appends a trailing newline which can mangle exact byte expectations in parser tests. For tests that specifically need to verify trailing-newline handling, use `emit-raw-ln`. The `write-*-to-file` fixtures observe values via the filesystem rather than CLI stdout, since the CLI never prints `result` to its own stdout (Spec 7.1).

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
4. Maintain a small **allowlist** of test IDs that are expected to pass against the stub for legitimate reasons (e.g., `-n 0` exits 0 coincidentally). Review only passes outside this allowlist.
5. Inspect unexpected passes: they either have a weak assertion that should be strengthened, or represent a genuine test error.
6. Revise flagged tests to include assertions that would fail against the stub (e.g., check stderr for expected messages, verify specific stdout content, check file system side effects).

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

- **T-CLI-01**: `loopx version` prints a version string, exits 0. Assert trimmed stdout exactly matches the `version` field from loopx's own `package.json`. Does not require `.loopx/` to exist. **Depends on SP-23** — this test assumes the spec resolves to "bare version string followed by a newline, no additional text." If SP-23 resolves differently, adjust the assertion. *(Spec 4.3, 5.5)*
- **T-CLI-02**: `loopx -h` prints usage text containing "loopx" and "usage" (case-insensitive), exits 0. *(Spec 4.2)*
- **T-CLI-03**: `loopx --help` produces the same output as `-h`. *(Spec 4.2)*
- **T-CLI-04**: `loopx -h` with `.loopx/` containing scripts lists discovered script names in output. *(Spec 11)*
- **T-CLI-05**: `loopx -h` without `.loopx/` directory still prints help (no error), script list section is absent or empty. *(Spec 5.5, 11)*
- **T-CLI-06**: `loopx -h` with `.loopx/` containing name collisions prints help with warnings on stderr. *(Spec 11)*
- **T-CLI-07**: `loopx -h` with `.loopx/` containing reserved names prints help with warnings on stderr. *(Spec 11)*
- **T-CLI-07d**: `loopx -h` with `.loopx/` containing a script with an invalid name (e.g., `-startswithdash.sh`) prints help with a non-fatal warning on stderr about the invalid name. Help still exits 0. *(Spec 5.4, 11)*
- **T-CLI-07a**: `loopx -h` with `.loopx/` containing scripts lists script names and includes type information for each. Assert that each discovered script name appears in the output and that the output contains type-related text (e.g., "ts", "sh") near each name. Do not assert an exact rendering format. *(Spec 11)*
- **T-CLI-07b**: `loopx -n 5 -h` prints help and exits 0 (help flag takes precedence over other flags). *(Spec 4.2)*
- **T-CLI-07c**: `loopx myscript -h` prints help and exits 0 (help flag takes precedence over script name). *(Spec 4.2)*
- **T-CLI-07e**: `loopx -h version` prints help and exits 0 (help flag takes precedence over subcommand). The `version` subcommand does not execute. *(Spec 4.2)*
- **T-CLI-07f**: `loopx -h env set FOO bar` prints help and exits 0 (help flag takes precedence over `env` subcommand). *(Spec 4.2)*
- **T-CLI-07g**: `loopx -h --invalid-flag` prints help and exits 0 (help flag takes precedence over invalid flags). *(Spec 4.2)*

#### Default Script Invocation

- **T-CLI-08**: `loopx -n 1` (no script name) with a `default.ts` script in `.loopx/` runs the default script. Assert: script's output is observed (e.g., use a counter file fixture to prove it ran). *(Spec 4.1)*
- **T-CLI-09**: `loopx` (no script name) with no `default` script in `.loopx/` exits with code 1. Stderr contains a message mentioning "default" and suggesting script creation. *(Spec 4.1)*
- **T-CLI-10**: `loopx` with `.loopx/` directory missing entirely exits with code 1 and provides a helpful error message. *(Spec 7.2)*

#### Named Script Invocation

- **T-CLI-11**: `loopx -n 1 myscript` with `.loopx/myscript.sh` runs the script. Assert via counter file. *(Spec 4.1)*
- **T-CLI-12**: `loopx nonexistent` with `.loopx/` existing but no matching script exits with code 1. *(Spec 4.1)*
- **T-CLI-13**: `loopx -n 1 default` (explicitly naming the default script) runs the default script, same as `loopx -n 1` with no name. *(Spec 4.1)*

#### CLI `-n` Option

- **T-CLI-14**: `loopx -n 3 myscript` with a counter fixture runs exactly 3 iterations. Assert counter file contains 3 marks. *(Spec 4.2, 7.1)*
- **T-CLI-15**: `loopx -n 0 myscript` exits 0 without running the script. Assert counter file does not exist or is empty. *(Spec 4.2, 7.1)*
- **T-CLI-16**: `loopx -n -1 myscript` exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-17**: `loopx -n 1.5 myscript` exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-18**: `loopx -n abc myscript` exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-19**: `loopx -n 0` with a missing script still exits with code 1 (validation occurs before `-n 0` short-circuit). Stderr contains an error about the missing script. *(Spec 4.2, 7.1)*
- **T-CLI-19a**: `loopx -n 0` with `.loopx/` directory missing entirely → exits with code 1 (validation occurs before `-n 0` short-circuit). Stderr contains an error about the missing `.loopx/` directory. *(Spec 4.2, 7.1, 7.2)*
- **T-CLI-20**: `loopx -n 1 myscript` runs exactly 1 iteration even if the script produces no `stop`. *(Spec 4.2)*

#### Duplicate Flags

- **T-CLI-20a**: `loopx -n 3 -n 5 myscript` exits with code 1 (duplicate `-n` is a usage error). *(Spec 4.2)*
- **T-CLI-20b**: `loopx -e .env1 -e .env2 myscript` exits with code 1 (duplicate `-e` is a usage error). *(Spec 4.2)*

#### CLI `-e` Option

- **T-CLI-21**: `loopx -e .env -n 1 myscript` with a valid `.env` file makes its variables available in the script. Use `write-env-to-file` fixture: the script writes the env var value to a marker file. Assert the marker file contains the expected value. *(Spec 4.2)*
- **T-CLI-22**: `loopx -e nonexistent.env myscript` exits with code 1. Stderr mentions the missing file. *(Spec 4.2)*
- **T-CLI-22a**: `loopx -n 0 -e nonexistent.env myscript` exits with code 1 (env file validation happens before `-n 0` short-circuit). *(Spec 4.2, 7.1)*
- **T-CLI-22b**: `loopx -n 0` with `.loopx/` containing a name collision → exits with code 1 (validation occurs before `-n 0` short-circuit). *(Spec 4.2, 5.2, 7.1)*
- **T-CLI-22c**: `loopx -n 0` with `.loopx/` containing a reserved name → exits with code 1. *(Spec 4.2, 5.3, 7.1)*
- **T-CLI-22d**: `loopx -n 0` with `.loopx/` containing an invalid script name (e.g., `-bad.sh`) → exits with code 1. *(Spec 4.2, 5.4, 7.1)*

#### CLI Stdout Silence

- **T-CLI-23**: `loopx -n 1 myscript` where `myscript` outputs `{"result":"hello"}` and writes a marker file — the CLI's own stdout is empty (result is not printed), AND the marker file exists (proving the script actually ran). Both assertions are required to prevent vacuous passes. *(Spec 7.1)*

### 4.2 Subcommands

**Spec refs:** 4.3, 5.5

#### `loopx output`

- **T-SUB-01**: `loopx output --result "hello"` prints valid JSON to stdout, exits 0. Parse stdout as JSON and assert `result === "hello"`. Do not assert exact byte-for-byte text or field order. *(Spec 4.3)*
- **T-SUB-02**: `loopx output --goto "next"` prints valid JSON to stdout, exits 0. Parse stdout as JSON and assert `goto === "next"`. *(Spec 4.3)*
- **T-SUB-03**: `loopx output --stop` prints valid JSON to stdout, exits 0. Parse stdout as JSON and assert `stop === true`. *(Spec 4.3)*
- **T-SUB-04**: `loopx output --result "x" --goto "y" --stop` prints valid JSON to stdout. Parse as JSON and assert all three fields present with correct values. *(Spec 4.3)*
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
- **T-SUB-13**: `loopx env set FOO bar` in a directory with no `.loopx/` → exits 0 AND `loopx env list` subsequently shows `FOO=bar`. Assert both success and the actual side effect, not just exit code. Also assert stderr does not contain script-validation warnings. *(Spec 5.5)*
- **T-SUB-14**: `loopx env set` creates the config directory (`$XDG_CONFIG_HOME/loopx/`) if it doesn't exist. *(Spec 8.1)*
- **T-SUB-14a**: `loopx env set KEY "value with spaces"` → `loopx env list` shows `KEY=value with spaces`. Value round-trips correctly. *(Spec 4.3)*
- **T-SUB-14b**: `loopx env set KEY "value#hash"` → value preserved including `#`. *(Spec 4.3)*
- **T-SUB-14c**: `loopx env set KEY "val=ue"` → value with `=` round-trips correctly. *(Spec 4.3)*
- **T-SUB-14d**: `loopx env set KEY $'value\nwith newline'` → rejected (multiline values not supported). Exit code 1. *(Spec 4.3)*
- **T-SUB-14e**: `loopx env set KEY 'val"ue'` → `loopx env list` shows `KEY=val"ue`. Embedded double quotes round-trip correctly. *(Spec 4.3)*
- **T-SUB-14f**: `loopx env set KEY "value  "` → `loopx env list` shows `KEY=value  `. Trailing spaces in the value are preserved. *(Spec 4.3)*
- **T-SUB-14g**: `loopx env set KEY $'value\rwith cr'` → rejected (carriage return, like newline, is not supported). Exit code 1. *(Spec 4.3)*

#### `loopx env set` On-Disk Serialization

These tests verify the actual bytes written to the env file, not just round-tripping. The spec (4.3) defines the serialization as `KEY="<literal value>"` followed by a newline. Read the raw file content after `env set` and assert the exact serialized line.

- **T-SUB-14h**: `loopx env set FOO bar` → read the global env file. Assert it contains the line `FOO="bar"\n` (double-quoted, with a trailing newline). *(Spec 4.3)*
- **T-SUB-14i**: `loopx env set FOO "value with spaces"` → file contains `FOO="value with spaces"\n`. *(Spec 4.3)*
- **T-SUB-14j**: `loopx env set FOO 'val"ue'` → file contains `FOO="val"ue"\n` (no escaping — value is written literally within double quotes). *(Spec 4.3)*
- **T-SUB-14k**: `loopx env set FOO ""` (empty value) → file contains `FOO=""\n`. *(Spec 4.3)*

#### `loopx env remove`

- **T-SUB-15**: `loopx env set FOO bar` then `loopx env remove FOO` then `loopx env list` — `FOO` is absent. *(Spec 4.3)*
- **T-SUB-16**: `loopx env remove NONEXISTENT` exits with code 0 (silent no-op). *(Spec 4.3)*

#### `loopx env list`

- **T-SUB-17**: With no variables set, `loopx env list` produces no stdout output, exits 0. *(Spec 4.3)*
- **T-SUB-18**: With variables `ZEBRA=z`, `ALPHA=a`, `MIDDLE=m` set, `loopx env list` outputs them sorted: `ALPHA=a`, `MIDDLE=m`, `ZEBRA=z`. *(Spec 4.3)*
- **T-SUB-19**: `loopx env list` in a directory with no `.loopx/` → exits 0 and produces no stdout output (since no vars are set). Assert both the exit code and that stdout is empty. Also assert stderr does not contain script-validation warnings. *(Spec 5.5)*

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
- **T-DISC-11a**: `.loopx/mypipe/` with `package.json` (`"main": "src/index.ts"`) and `src/index.ts` → discoverable as `mypipe`. This verifies that `main` can point to a subpath within the directory, not just a top-level file. *(Spec 2.1, 5.1)*
- **T-DISC-12**: `.loopx/nopackage/` directory with no `package.json` → ignored. `loopx -n 1 nopackage` fails. *(Spec 2.1, 5.1)*
- **T-DISC-13**: `.loopx/nomain/` with `package.json` that has no `main` field → ignored. *(Spec 2.1, 5.1)*
- **T-DISC-14**: `.loopx/mypipe/` with `"main": "index.sh"` → discoverable (bash entry point). *(Spec 5.1)*
- **T-DISC-14a**: `.loopx/mypipe/` with `"main": "index.js"` → discoverable (JS entry point). *(Spec 5.1)*
- **T-DISC-14b**: `.loopx/mypipe/` with `"main": "index.jsx"` → discoverable (JSX entry point). *(Spec 5.1)*
- **T-DISC-14c**: `.loopx/mypipe/` with `"main": "index.tsx"` → discoverable (TSX entry point). *(Spec 5.1)*
- **T-DISC-15**: `.loopx/mypipe/` with `"main": "index.py"` → warning on stderr, directory ignored. *(Spec 5.1)*
- **T-DISC-16**: `.loopx/mypipe/` with `"main": "../escape.ts"` → warning on stderr, directory ignored. *(Spec 5.1)*
- **T-DISC-16a**: `.loopx/mypipe/` with `package.json` containing invalid JSON (e.g., `{invalid}`) → warning on stderr, directory ignored. `loopx -n 1 mypipe` fails. *(Spec 5.1)*
- **T-DISC-16b**: `.loopx/mypipe/` with unreadable `package.json` (e.g., no read permissions) → warning on stderr, directory ignored. **This test is conditional on `process.getuid() !== 0`** — root can read any file, so the test is skipped when running as root (e.g., in some CI containers). *(Spec 5.1)*
- **T-DISC-16c**: `.loopx/mypipe/` with `package.json` where `main` is not a string (e.g., `{"main": 42}`) → warning on stderr, directory ignored. *(Spec 5.1)*
- **T-DISC-16d**: `.loopx/mypipe/` with `package.json` where `main` points to a file that does not exist (e.g., `{"main": "missing.ts"}`) → warning on stderr, directory ignored. *(Spec 5.1)*
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
- **T-DISC-30a**: `.loopx/1start.sh` → valid (digits are allowed as the first character of a script name per `[a-zA-Z0-9_]`). `loopx -n 1 1start` runs it. *(Spec 5.4)*
- **T-DISC-30b**: `.loopx/42.sh` → valid (all-digit script name). *(Spec 5.4)*
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
- **T-DISC-40**: `loopx env set X Y` when `.loopx/` doesn't exist → exits 0, AND `loopx env list` subsequently shows `X=Y`. Assert stderr does not contain script-validation warnings. *(Spec 5.5)*
- **T-DISC-41**: `loopx output --result "x"` when `.loopx/` doesn't exist → exits 0, AND stdout contains valid JSON with `result: "x"`. Assert stderr does not contain script-validation warnings. *(Spec 5.5)*
- **T-DISC-42**: `loopx` (run mode) when `.loopx/` doesn't exist → error, exit 1. *(Spec 5.5)*
- **T-DISC-43**: `loopx version` when `.loopx/` exists and contains name collisions or reserved names → exits 0 with a version string on stdout. Assert stderr does not contain script-validation warnings (validation not performed). *(Spec 5.5)*
- **T-DISC-44**: `loopx env set X Y` when `.loopx/` exists and contains collisions → exits 0, AND `loopx env list` subsequently shows `X=Y`. Assert stderr does not contain script-validation warnings. *(Spec 5.5)*
- **T-DISC-45**: `loopx output --result "x"` when `.loopx/` exists and contains reserved names → exits 0, AND stdout contains valid JSON with `result: "x"`. Assert stderr does not contain script-validation warnings. *(Spec 5.5)*
- **T-DISC-46**: `loopx install <source>` when `.loopx/` exists and contains collisions → the install succeeds (exits 0, installed script present in `.loopx/`). Assert stderr does not contain script-validation warnings about existing scripts. *(Spec 5.5)*

#### Discovery Scope

- **T-DISC-47**: A parent directory has `.loopx/` with scripts, but the current working directory does not have `.loopx/`. `loopx myscript` in the child directory fails — parent `.loopx/` is not discovered. *(Spec 5.1)*
- **T-DISC-49**: `.loopx/subdir/nested.ts` (a `.ts` file nested inside a non-script subdirectory within `.loopx/`) is NOT discovered. `loopx -n 1 nested` fails. Discovery is top-level only — subdirectories without a valid `package.json` and their contents are ignored. *(Spec 5.1)*

#### Cached `package.json` `main`

- **T-DISC-48**: During a multi-iteration loop, change a discovered directory script's `package.json` `main` field between iterations. Assert the change is not picked up (the original entry point continues to run). *(Spec 5.1)*

### 4.4 Script Execution

**Spec refs:** 6.1–6.4

#### Working Directory

- **T-EXEC-01**: File script (`.loopx/check-cwd.sh`) writes `$PWD` to a marker file. Assert the marker file content equals the directory where loopx was invoked (the project root). *(Spec 6.1)*
- **T-EXEC-02**: Directory script (`.loopx/mypipe/`) writes `$PWD` to a marker file from its entry point. Assert marker content equals the absolute path of `.loopx/mypipe/`. *(Spec 6.1)*
- **T-EXEC-03**: File script writes `$LOOPX_PROJECT_ROOT` to a marker file. Assert marker content equals the invocation directory. *(Spec 6.1)*
- **T-EXEC-04**: Directory script writes `$LOOPX_PROJECT_ROOT` to a marker file. Assert marker content equals the invocation directory (not the script's own directory). *(Spec 6.1)*

#### Bash Scripts

- **T-EXEC-05**: A `.sh` script runs successfully and its stdout is captured as structured output. Observe via `runPromise({ maxIterations: 1 })`: the yielded Output contains the expected `result`. *(Spec 6.2)*
- **T-EXEC-06**: A `.sh` script's stderr appears on the CLI's stderr (pass-through). Assert by writing a known string to stderr and checking CLI stderr. *(Spec 6.2)*
- **T-EXEC-07**: A `.sh` script that lacks `#!/bin/bash` still runs (loopx invokes via `/bin/bash` explicitly, not via shebang). *(Spec 6.2)*

#### JS/TS Scripts

- **T-EXEC-08**: `.ts` script runs and produces structured output. Observe via `runPromise({ maxIterations: 1 })`: the yielded Output has the expected `result`. *(Spec 6.3)*
- **T-EXEC-09**: `.js` script runs and produces structured output. Observe via `runPromise({ maxIterations: 1 })`. *(Spec 6.3)*
- **T-EXEC-10**: `.tsx` script runs and produces structured output. Observe via `runPromise({ maxIterations: 1 })`. The fixture must be self-contained: use a trivial JSX expression that does not depend on React or any runtime (e.g., a script that assigns `const el = <string>` using a custom JSX pragma that returns a plain string, or simply verifies the extension is accepted by having the script output a result without actually using JSX syntax). The goal is to confirm tsx processes `.tsx` files. *(Spec 6.3)*
- **T-EXEC-11**: `.jsx` script runs and produces structured output. Observe via `runPromise({ maxIterations: 1 })`. Same self-contained fixture approach as T-EXEC-10 — verify the extension is accepted and the script executes. *(Spec 6.3)*
- **T-EXEC-12**: JS/TS script stderr passes through to CLI stderr. *(Spec 6.3)*
- **T-EXEC-13**: JS/TS script can use TypeScript type annotations (verifies tsx handles TS syntax under Node.js). `[Node]` *(Spec 6.3)*
- **T-EXEC-13b**: JS/TS script can use TypeScript type annotations under Bun (verifies Bun's native TS support). `[Bun]` *(Spec 6.3)*
- **T-EXEC-13a**: A `.js` script that uses `require()` (CJS) fails with an error. CJS is not supported. *(Spec 6.3)*

#### Directory Scripts

- **T-EXEC-15**: Directory script with `"main": "index.ts"` → `index.ts` is executed. Observe via `runPromise({ maxIterations: 1 })`: the yielded Output has the expected `result`. *(Spec 6.4)*
- **T-EXEC-16**: Directory script with `"main": "run.sh"` → `run.sh` is executed via bash. Observe via `runPromise({ maxIterations: 1 })`. *(Spec 6.4)*
- **T-EXEC-17**: Directory script can import from its own `node_modules/`. Setup: create a directory script with a local dependency (a simple `.js` file in `node_modules/`). Script writes a marker file confirming the import succeeded. *(Spec 2.1)*
- **T-EXEC-18**: Directory script CWD is its own directory. Script writes `process.cwd()` to a marker file. Assert marker content matches the script's directory. *(Spec 6.1)*
- **T-EXEC-18a**: Directory script that imports a package not present in its `node_modules/` (e.g., `import "nonexistent-pkg"`) — loopx does not auto-install dependencies. The script fails with a module resolution error from the active runtime, and loopx exits with code 1. *(Spec 2.1)*

### 4.5 Structured Output Parsing

**Spec refs:** 2.3

These tests use bash fixture scripts that echo specific strings to stdout. **Parsing correctness is asserted by examining the actual yielded `Output` object** via the programmatic API (`run()`, `runPromise()`, or `runAPIDriver()`), not by inferring from loop behavior alone. This is critical because distinct parsing outcomes (raw fallback, structured output with invalid fields, empty stdout) can produce identical control flow but different `Output` objects.

#### Valid Structured Output

- **T-PARSE-01**: Script outputs `{"result":"hello"}`. Assert via `runPromise({ maxIterations: 1 })`: yielded Output is `{ result: "hello" }` — no `goto` or `stop` properties present. *(Spec 2.3)*
- **T-PARSE-02**: Script outputs `{"goto":"next"}` → loopx transitions to script `next`. *(Spec 2.3)*
- **T-PARSE-03**: Script outputs `{"stop":true}` → loop halts, exit code 0. *(Spec 2.3)*
- **T-PARSE-04**: Script outputs `{"result":"x","goto":"next","stop":true}` → stop takes priority, loop halts. *(Spec 2.3)*
- **T-PARSE-05**: Script outputs `{"result":"x","extra":"ignored"}`. Assert via `runPromise({ maxIterations: 1 })`: yielded Output has `result: "x"` and no `extra` property. *(Spec 2.3)*

#### Fallback to Raw Result

- **T-PARSE-06**: Script outputs `{"unknown":"field"}` (valid JSON object, no known fields). Assert via `runPromise({ maxIterations: 1 })`: yielded Output is `{ result: '{"unknown":"field"}' }` — entire stdout becomes the raw result string, not an empty object. *(Spec 2.3)*
- **T-PARSE-07**: Script outputs `[1,2,3]` (JSON array). Assert via `runPromise({ maxIterations: 1 })`: yielded Output has `result: "[1,2,3]"`. *(Spec 2.3)*
- **T-PARSE-08**: Script outputs `"hello"` (JSON string). Assert via `runPromise({ maxIterations: 1 })`: yielded Output has `result: '"hello"'` (the raw stdout, including the quotes). *(Spec 2.3)*
- **T-PARSE-09**: Script outputs `42` (JSON number). Assert via `runPromise({ maxIterations: 1 })`: yielded Output has `result: "42"` (raw stdout string, not a parsed number). *(Spec 2.3)*
- **T-PARSE-10**: Script outputs `true` (JSON boolean). Assert via `runPromise({ maxIterations: 1 })`: yielded Output has `result: "true"` (raw stdout string). *(Spec 2.3)*
- **T-PARSE-11**: Script outputs `null` (JSON null). Assert via `runPromise({ maxIterations: 1 })`: yielded Output has `result: "null"` (raw stdout string). *(Spec 2.3)*
- **T-PARSE-12**: Script outputs `not json at all`. Assert via `runPromise({ maxIterations: 1 })`: yielded Output has `result: "not json at all"`. *(Spec 2.3)*
- **T-PARSE-13**: Script produces empty stdout (no output). Assert via `runPromise({ maxIterations: 1 })`: yielded Output is `{ result: "" }` — not an empty object `{}`. *(Spec 2.3)*

#### Type Coercion

- **T-PARSE-14**: `{"result": 42}`. Assert via `runPromise({ maxIterations: 1 })`: yielded Output has `result: "42"` (coerced via `String()`). *(Spec 2.3)*
- **T-PARSE-15**: `{"result": true}`. Assert via `runPromise({ maxIterations: 1 })`: yielded Output has `result: "true"`. *(Spec 2.3)*
- **T-PARSE-16**: `{"result": {"nested": "obj"}}`. Assert via `runPromise({ maxIterations: 1 })`: yielded Output has `result: "[object Object]"`. *(Spec 2.3)*
- **T-PARSE-17**: `{"result": null}`. Assert via `runPromise({ maxIterations: 1 })`: yielded Output has `result: "null"`. *(Spec 2.3)*
- **T-PARSE-18**: `{"goto": 42}` (goto is not a string). Assert via `runPromise({ maxIterations: 1 })`: yielded Output is exactly `{}` — an empty object with no `result`, `goto`, or `stop` properties. The output is parsed as structured (it is a JSON object with a known field), but the invalid-typed `goto` is discarded. This is distinct from raw fallback, which would yield `{ result: '{"goto":42}' }`. *(Spec 2.3)*
- **T-PARSE-19**: `{"goto": true}`. Assert via `runPromise({ maxIterations: 1 })`: yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-20**: `{"goto": null}`. Assert via `runPromise({ maxIterations: 1 })`: yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-21**: `{"stop": "true"}` (string, not boolean). Assert via `runPromise({ maxIterations: 1 })`: yielded Output is exactly `{}`. Loop continues (does not halt). *(Spec 2.3)*
- **T-PARSE-22**: `{"stop": 1}`. Assert via `runPromise({ maxIterations: 1 })`: yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-23**: `{"stop": false}`. Assert via `runPromise({ maxIterations: 1 })`: yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-24**: `{"stop": "false"}`. Assert via `runPromise({ maxIterations: 1 })`: yielded Output is exactly `{}`. *(Spec 2.3)*

#### Mixed Valid/Invalid Fields

- **T-PARSE-28**: `{"result":"x","goto":42}` (valid result + invalid goto). Assert via `runPromise({ maxIterations: 1 })`: yielded Output is exactly `{ result: "x" }` — the valid `result` is preserved, the invalid-typed `goto` is discarded. No `goto` or `stop` properties present. *(Spec 2.3)*
- **T-PARSE-29**: `{"result":"x","stop":"true"}` (valid result + invalid stop). Assert via `runPromise({ maxIterations: 1 })`: yielded Output is exactly `{ result: "x" }` — the valid `result` is preserved, the invalid-typed `stop` is discarded. Loop continues (does not halt). *(Spec 2.3)*

#### Whitespace & Formatting

- **T-PARSE-25**: Script outputs JSON with trailing newline `{"result":"x"}\n`. Assert via `runPromise({ maxIterations: 1 })`: yielded Output has `result: "x"` (parsed correctly, not raw fallback). *(Spec 2.3)*
- **T-PARSE-26**: Script outputs pretty-printed JSON (with newlines and indentation). Assert via `runPromise({ maxIterations: 1 })`: yielded Output has the expected fields (parsed correctly). *(Spec 2.3)*
- **T-PARSE-27**: Script outputs JSON with leading whitespace. Assert via `runPromise({ maxIterations: 1 })`: yielded Output has the expected fields (parsed correctly). *(Spec 2.3)*

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

- **T-LOOP-11**: A outputs `{"result":"payload","goto":"B"}`. B reads stdin (via `cat-stdin` fixture) and outputs the received value as its result. Observe via `runPromise({ maxIterations: 2 })`: the second yielded Output has `result: "payload"`. *(Spec 6.7)*
- **T-LOOP-12**: A outputs `{"goto":"B"}` (no result). B reads stdin and outputs it as result. Observe via `runPromise({ maxIterations: 2 })`: the second yielded Output has `result: ""` (empty string). *(Spec 2.3, 6.7)*
- **T-LOOP-13**: A outputs `{"result":"payload"}` (no goto). Loop resets to A. A reads stdin and outputs it as result. Observe via `runPromise({ maxIterations: 2 })`: the second yielded Output has `result: ""` (result not piped on reset). *(Spec 6.7)*
- **T-LOOP-14**: First iteration (starting target) receives empty stdin. Script reads stdin and outputs it as result. Observe via `runPromise({ maxIterations: 1 })`: yielded Output has `result: ""`. *(Spec 6.8)*
- **T-LOOP-15**: A → `goto:"B"` with result → B → `goto:"C"` with result → C reads stdin and outputs it as result. Observe via `runPromise({ maxIterations: 3 })`: the third yielded Output has `result` equal to B's result, not A's. *(Spec 6.7)*

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
- **T-LOOP-24**: Script's stdout on failure is NOT parsed as structured output. Use a script that prints `{"result":"should-not-appear","stop":true}` to stdout then exits 1. Observe via `run()`: the generator should throw on the failing iteration without yielding any `Output` for that iteration. If the JSON were parsed, it would yield a result and halt cleanly — the throw with no yield proves it was not parsed. *(Spec 7.2)*

#### Final Iteration Output

- **T-LOOP-25**: `-n 2` with script producing `{"result":"iter-N"}`. Both iterations' outputs are observable via programmatic API. Verify programmatic API yields both. *(Spec 7.1)*

### 4.7 Environment Variables

**Spec refs:** 8.1–8.3

All env tests use `withGlobalEnv` to isolate from the real user config.

#### Global Env File

- **T-ENV-01**: Variable set via `loopx env set` is available in a script. Use `write-env-to-file` fixture: the script writes `$VAR_NAME` to a marker file. Assert the marker file contains the expected value. *(Spec 8.1, 8.3)*
- **T-ENV-02**: Variable removed via `loopx env remove` is no longer available in scripts. Use `write-env-to-file` fixture: the script writes `$VAR_NAME` to a marker file. Assert the marker file is empty (variable unset). *(Spec 8.1)*
- **T-ENV-03**: `XDG_CONFIG_HOME` is respected. Set `XDG_CONFIG_HOME=/tmp/custom`, run `loopx env set X Y`, verify file exists at `/tmp/custom/loopx/env`. *(Spec 8.1)*
- **T-ENV-04**: When `XDG_CONFIG_HOME` is unset, default is `~/.config`. Use `withIsolatedHome` (not `withGlobalEnv`) to safely verify the fallback path without touching the real home directory. *(Spec 8.1)*
- **T-ENV-05**: Config directory created on first `env set`. Start with no directory, run `env set`, verify directory was created. *(Spec 8.1)*

#### Env File Parsing

All env file parsing tests below use `writeEnvFileRaw` to write exact file content, then a `write-env-to-file` fixture script to observe the parsed value via a marker file.

- **T-ENV-06**: `writeEnvFileRaw(path, "KEY=VALUE\n")`. Script writes `$KEY` to marker file. Assert marker contains `VALUE`. *(Spec 8.1)*
- **T-ENV-07**: `writeEnvFileRaw(path, "# comment\nKEY=val\n")`. Assert `KEY=val` is loaded, comment line produces no variable. *(Spec 8.1)*
- **T-ENV-08**: `writeEnvFileRaw(path, "\n\nKEY=val\n\n")`. Blank lines ignored, `KEY=val` loaded. *(Spec 8.1)*
- **T-ENV-09**: `writeEnvFileRaw(path, "X=first\nX=second\n")`. Duplicate keys: last occurrence wins. Script sees `X=second`. *(Spec 8.1)*
- **T-ENV-10**: `writeEnvFileRaw(path, 'KEY="hello world"\n')`. Double-quoted value → value is `hello world` (quotes stripped). *(Spec 8.1)*
- **T-ENV-11**: `writeEnvFileRaw(path, "KEY='hello world'\n")`. Single-quoted value → value is `hello world`. *(Spec 8.1)*
- **T-ENV-12**: `writeEnvFileRaw(path, 'KEY="hello\\nworld"\n')`. No escape sequences → value is literal `hello\nworld` (backslash + n, not newline). *(Spec 8.1)*
- **T-ENV-13**: `writeEnvFileRaw(path, "KEY=value#notcomment\n")`. Inline `#` is part of value → value is `value#notcomment`. *(Spec 8.1)*
- **T-ENV-14**: `writeEnvFileRaw(path, "KEY=value   \n")`. Trailing whitespace on value trimmed → value is `value`. *(Spec 8.1)*
- **T-ENV-15**: `writeEnvFileRaw(path, "KEY = value\n")`. No whitespace around `=`: the key is `KEY ` which contains a space. Test that this does NOT set `KEY` to `value`. Assert a warning on stderr about the invalid key. *(Spec 8.1)*
- **T-ENV-15f**: `writeEnvFileRaw(path, "KEY= value\n")`. The value is everything after the first `=` to end of line, trimmed of trailing whitespace. Script sees `KEY` with value ` value` (leading space preserved). *(Spec 8.1)*
- **T-ENV-15a**: `writeEnvFileRaw(path, "KEY=\n")`. Empty value. Script sees `KEY` with value `""`. *(Spec 8.1)*
- **T-ENV-15b**: `writeEnvFileRaw(path, "KEY=a=b=c\n")`. Multiple `=`. Script sees `KEY` with value `a=b=c` (split on first `=`). *(Spec 8.1)*
- **T-ENV-15c**: `writeEnvFileRaw(path, "1BAD=val\n")`. Invalid key (starts with digit). Line ignored with warning to stderr. Script does not see `1BAD`. *(Spec 8.1)*
- **T-ENV-15d**: `writeEnvFileRaw(path, "justtext\n")`. Malformed non-comment line without `=`. Line ignored with warning to stderr. *(Spec 8.1)*
- **T-ENV-15e**: `writeEnvFileRaw(path, 'KEY="hello\n')`. Unmatched quotes: opening double quote, no closing. The spec says quotes are stripped when values are "optionally wrapped" — an unmatched quote is not wrapping, so the literal `"hello` is the value. **Blocked by SP-15** — this test is not normative until the spec resolves unmatched quote behavior. *(Spec 8.1)*

#### Local Env Override (`-e`)

- **T-ENV-16**: `-e local.env` loads variables into script environment. Script writes the env var to a marker file. Assert marker file contains the expected value. *(Spec 8.2)*
- **T-ENV-17**: `-e nonexistent.env` → error, exit 1. *(Spec 8.2)*
- **T-ENV-18**: Global has `X=global`, local has `X=local`. Script writes `$X` to a marker file → marker contains `local`. *(Spec 8.2)*
- **T-ENV-19**: Global has `A=1`, local has `B=2`. Script writes both to marker files → `A=1` and `B=2` both present. *(Spec 8.2)*

#### Injection Precedence

- **T-ENV-20**: `LOOPX_BIN` is always set, even if the user sets `LOOPX_BIN=fake` in global/local env. Script writes `$LOOPX_BIN` to a marker file → marker contains the real binary path, not `"fake"`. *(Spec 8.3)*
- **T-ENV-20a**: `LOOPX_BIN` overrides inherited system environment. Spawn loopx with `LOOPX_BIN=fake` in the process environment (not via env files). Script writes `$LOOPX_BIN` to a marker file → marker contains the real binary path, not `"fake"`. *(Spec 8.3)*
- **T-ENV-21**: `LOOPX_PROJECT_ROOT` always set, overrides user-supplied value. Script writes `$LOOPX_PROJECT_ROOT` to a marker file → marker contains the real invocation directory. *(Spec 8.3)*
- **T-ENV-21a**: `LOOPX_PROJECT_ROOT` overrides inherited system environment. Spawn loopx with `LOOPX_PROJECT_ROOT=/fake/path` in the process environment. Script writes `$LOOPX_PROJECT_ROOT` to a marker file → marker contains the real invocation directory, not `"/fake/path"`. *(Spec 8.3)*
- **T-ENV-22**: System env has `SYS_VAR=sys`, global env has `SYS_VAR=global`. Script writes `$SYS_VAR` to a marker file → marker contains `global`. *(Spec 8.3)*
- **T-ENV-23**: System env has `SYS_VAR=sys`, no loopx override. Script writes `$SYS_VAR` to a marker file → marker contains `sys`. *(Spec 8.3)*
- **T-ENV-24**: Full precedence chain. Set `VAR` at system, global, and local levels. Script writes `$VAR` to a marker file. Assert local wins. Then remove from local → global wins. Then remove from global → system wins. *(Spec 8.3)*

#### Env Caching

- **T-ENV-25**: During a multi-iteration loop, modify the global env file between iterations (use a script that rewrites the env file as a side effect on iteration 1). On iteration 2, a different script writes `$VAR` to a marker file. Assert the marker contains the original value (env loaded once at start, not re-read). *(Spec 8.1)*

### 4.8 Module Resolution & Script Helpers

**Spec refs:** 3.3, 3.4, 6.5, 6.6

#### `import from "loopx"` Resolution

- **T-MOD-01**: A TS script with `import { output } from "loopx"` runs successfully under Node.js. `[Node]` *(Spec 3.3)*
- **T-MOD-02**: Same import works under Bun. `[Bun]` *(Spec 3.3)*
- **T-MOD-03**: A JS script with `import { output } from "loopx"` also works. *(Spec 3.3)*
- **T-MOD-03a**: A directory script that has its own `node_modules/loopx` (a fake/different version) still resolves `import from "loopx"` to the running CLI's package, not the local shadow. The shadow package must be **observably wrong** — it exports an `output()` function that writes a distinctive marker (e.g., `{"__shadow": true}`) to a marker file and then writes different JSON to stdout, instead of the real structured output behavior. The test asserts that the real `output()` behavior is observed (correct structured output via `runPromise`) AND that the shadow's marker file does not exist. This discriminates between "the real package resolved" and "any working `output()` was available." `[Node]` only — **Blocked by SP-24.** The spec's guarantee that `import "loopx"` resolves to the running CLI's package (Spec 3.3) is in tension with the advisory "must not" in section 2.1. For Bun, the `NODE_PATH` mechanism may not reliably override a local `node_modules/loopx`. This test is not normative until SP-24 is resolved. *(Spec 3.3, 2.1)*

#### `output()` Function

These tests observe `output()` behavior via the programmatic API (`run()` / `runPromise()`) or side-effect files — not by inspecting CLI stdout, because the CLI never prints `result` to its own stdout (Spec 7.1).

- **T-MOD-04**: Script uses `output({ result: "hello" })`. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "hello"`. *(Spec 6.5)*
- **T-MOD-05**: Script uses `output({ result: "x", goto: "y" })`. Observe via `run()`: yielded Output has both `result: "x"` and `goto: "y"`, and loopx transitions to script `y`. *(Spec 6.5)*
- **T-MOD-06**: Script uses `output({ stop: true })`. Observe via `runPromise()`: loop completes after one iteration, yielded Output has `stop: true`. *(Spec 6.5)*
- **T-MOD-07**: Script uses `output({})` (no known fields). Script crashes with non-zero exit code. `runPromise()` rejects. *(Spec 6.5)*
- **T-MOD-08**: Script uses `output(null)`. Script crashes with non-zero exit code. *(Spec 6.5)*
- **T-MOD-09**: Script uses `output(undefined)`. Script crashes with non-zero exit code. *(Spec 6.5)*
- **T-MOD-10**: Script uses `output("string")`. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "string"`. *(Spec 6.5)*
- **T-MOD-11**: Script uses `output(42)`. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "42"`. *(Spec 6.5)*
- **T-MOD-12**: Script uses `output(true)`. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "true"`. *(Spec 6.5)*
- **T-MOD-13**: Script uses `output({ result: "x", goto: undefined })`. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "x"` and no `goto` property. *(Spec 6.5)*
- **T-MOD-13a**: Script uses `output([1, 2, 3])` (array, no known fields). Script crashes with non-zero exit code. *(Spec 6.5)*
- **T-MOD-13c**: Script uses `output({ foo: "bar" })` (object with no known fields — `foo` is not `result`, `goto`, or `stop`). Script crashes with non-zero exit code. This is distinct from T-MOD-07 (`output({})`) — it verifies that an object must have at least one *known* field, not just any field. *(Spec 6.5)*
- **T-MOD-13b**: Script uses `output({ result: undefined, goto: undefined, stop: undefined })`. All known fields are `undefined`, which are omitted during JSON serialization — equivalent to `output({})`. Script crashes with non-zero exit code (no known fields with defined values). *(Spec 6.5)*
- **T-MOD-13d**: Script uses `output({ stop: false })`. The `stop` field has a defined value (`false`), which is a known field — so `output()` accepts the object (it has at least one known field with a defined value). The emitted JSON `{"stop":false}` is then parsed by the loop engine, where `stop` must be exactly `true` (boolean) to take effect. Observe via `runPromise({ maxIterations: 2 })`: the first yielded Output is `{}` (the `stop: false` is discarded during parsing), and the loop continues to a second iteration rather than halting. *(Spec 6.5, 2.3)*
- **T-MOD-13e**: Script uses `output({ goto: 42 })`. The `goto` field has a defined value (`42`), which is a known field — so `output()` accepts the object. The emitted JSON `{"goto":42}` is then parsed by the loop engine, where `goto` must be a string. Observe via `runPromise({ maxIterations: 2 })`: the first yielded Output is `{}` (the non-string `goto` is discarded during parsing), and the loop resets to the starting target rather than transitioning. *(Spec 6.5, 2.3)*
- **T-MOD-14**: Code after `output()` does not execute. Script: `output({ result: "a" }); writeFileSync("/tmp/marker", "ran")`. Assert marker file does not exist. *(Spec 6.5)*
- **T-MOD-14a**: Large-payload flush: Script uses `output({ result: "x".repeat(1_000_000) })` (1 MB result). Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has the full 1 MB string without truncation. This exercises the flush-before-exit guarantee in section 6.5. *(Spec 6.5)*

#### `input()` Function

- **T-MOD-15**: `input()` returns empty string on first iteration (no prior input). Script calls `input()` and outputs the result. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: ""`. *(Spec 6.6)*
- **T-MOD-16**: A → `output({ result: "payload", goto: "B" })` → B calls `input()` → receives `"payload"`. *(Spec 6.6)*
- **T-MOD-17**: `input()` called twice in the same script returns the same value (cached). *(Spec 6.6)*
- **T-MOD-18**: `input()` returns a Promise (test by awaiting it). *(Spec 6.6)*

#### ESM-Only Package Contract

- **T-MOD-22**: `[Node]` Attempting `require("loopx")` from a CommonJS consumer script fails with a module format error. Create a temporary consumer directory with `package.json` (no `"type": "module"`) and a `.js` file containing `const loopx = require("loopx")`. Run it under Node.js. Assert it exits non-zero with an error indicating the package is ESM-only (e.g., ERR_REQUIRE_ESM). This verifies the published package contract from Spec section 1. *(Spec 1)*

#### `LOOPX_BIN` in Bash Scripts

These tests verify `LOOPX_BIN` through loop behavior and side-effect files — not by inspecting CLI stdout. **These tests use `withDelegationSetup` (or the real executable path), not `runCLI`**, because `runCLI`'s `node /path/to/bin.js` invocation does not exercise realpath resolution of `LOOPX_BIN`.

- **T-MOD-19**: Bash script uses `$LOOPX_BIN output --result "payload" --goto "reader"` to produce structured output. A second script `reader` reads stdin and writes the received value to a marker file. Assert the marker file contains `"payload"`. *(Spec 3.4)*
- **T-MOD-20**: Bash script writes `$LOOPX_BIN` to a marker file. Assert the marker file contains a valid path to an executable file (file exists and is executable). *(Spec 3.4)*
- **T-MOD-21**: Bash script runs `$LOOPX_BIN version` and captures its stdout to a marker file. Assert the marker file content (trimmed) matches loopx's own `package.json` `version` field. **Depends on SP-23** — same assumption as T-CLI-01 regarding version output format. *(Spec 3.4)*

### 4.9 Programmatic API

**Spec refs:** 9.1–9.5

Tests import `run` and `runPromise` from the built loopx package and call them with `cwd` pointing to temp project directories.

#### `run()` (AsyncGenerator)

- **T-API-01**: `run("myscript")` returns an async generator. Calling `next()` yields an `Output` object. *(Spec 9.1)*
- **T-API-02**: Generator yields one `Output` per iteration. With `-n 3`, collect all yields → array of 3 outputs. *(Spec 9.1)*
- **T-API-03**: Generator completes (returns `{ done: true }`) when script outputs `stop: true`. *(Spec 9.1)*
- **T-API-04**: Generator completes when `maxIterations` is reached. *(Spec 9.1)*
- **T-API-05**: The output from the final iteration is yielded before the generator completes. *(Spec 9.1)*
- **T-API-06**: Breaking out of `for await` loop after the first yield prevents further iterations from starting. Setup: script produces a result (no `stop`) on each iteration, with `maxIterations: 10`. Break after receiving the first yield. Assert: no additional iterations execute (use a counter file — counter should be exactly 1). Note: a normal `break` from `for await` happens after a yield, when there is typically no active child process. The observable guarantee being tested is "no more iterations start after cancellation," not active child termination. See T-API-09a for the active-child case. *(Spec 9.1)*
- **T-API-07**: `run("myscript", { cwd: "/path/to/project" })` resolves scripts relative to the given cwd. *(Spec 9.5)*
- **T-API-08**: `run("myscript", { maxIterations: 0 })` → generator completes immediately with no yields. *(Spec 9.5)*
- **T-API-09**: `run()` with no script name runs the `default` script. *(Spec 9.1)*
- **T-API-09a**: Manual iterator cancellation during a pending `next()`. Use a long-running script (e.g., `sleep-then-exit(30)` fixture). Obtain the async iterator, call `iterator.next()` to start the first iteration, then immediately call `iterator.return()` while `next()` is still pending (the child process is actively running). Assert: (1) the child process / process group is terminated (the script writes its PID to a marker file on startup; after `return()` resolves, verify the PID is no longer running), and (2) the generator completes with no further yields. This tests the "actively running child" cancellation path, which is distinct from T-API-06's "break after yield" path. **Partially blocked by SP-26** — the spec does not precisely distinguish these two cancellation modes. *(Spec 9.1)*

#### `run()` with AbortSignal

- **T-API-10**: `run("myscript", { signal })` — aborting the signal terminates the loop and the generator throws an abort error. *(Spec 9.5)*

#### `runPromise()`

- **T-API-11**: `runPromise("myscript", { maxIterations: 3 })` resolves with an array of 3 `Output` objects. *(Spec 9.2)*
- **T-API-12**: `runPromise()` resolves when `stop: true` is output. *(Spec 9.2)*
- **T-API-13**: `runPromise()` rejects when a script exits non-zero. *(Spec 9.3)*
- **T-API-14**: `runPromise()` accepts the same options as `run()`. *(Spec 9.2)*
- **T-API-14a**: `runPromise()` with no script name runs the `default` script. *(Spec 9.2, 9.1)*
- **T-API-14b**: `runPromise("myscript", { maxIterations: 0 })` resolves with an empty array `[]`. *(Spec 9.2, 9.5)*

#### Error Behavior

- **T-API-15**: Programmatic API never prints `result` to stdout. Use `runAPIDriver()` to spawn a driver process that calls `run()` and collects outputs. Assert the driver's stdout contains only the driver's own JSON output — no `result` values from scripts leak to stdout. *(Spec 9.3)*
- **T-API-16**: Non-zero script exit causes `run()` generator to throw. *(Spec 9.3)*
- **T-API-17**: Invalid goto target causes `run()` generator to throw. *(Spec 9.3)*
- **T-API-18**: Script stderr is forwarded to the calling process's stderr. *(Spec 9.3)*
- **T-API-19**: When `run()` throws, previously yielded outputs are preserved (the caller already consumed them). Test: collect outputs in an array, handle the throw, verify array has the partial results. *(Spec 9.3)*
- ~~**T-API-20**~~: *Removed.* "Partial outputs are not available" from `runPromise()` rejection is not meaningfully observable beyond the promise rejecting. The relevant surface is already covered by T-API-13 (rejection on non-zero exit), T-API-15 (no stdout leakage), and T-API-19 (partial outputs preserved with `run()`). *(Spec 9.3)*
- **T-API-20a**: `run("nonexistent")` — errors before any child process is spawned because the script does not exist. The error may surface synchronously at `run()` call time or on the first `next()` — the test asserts only that an error occurs and no child was executed (use a counter file in `.loopx/` to verify no script ran). **Blocked by SP-22** — exact error timing is not normative until the spec resolves `run()` eagerness. *(Spec 9.3)*
- **T-API-20b**: `runPromise("nonexistent")` — rejects because the script does not exist. *(Spec 9.3)*
- **T-API-20c**: `run("myscript")` with `.loopx/` containing a name collision — errors before any child process is spawned (validation failure). Same timing caveat as T-API-20a. *(Spec 9.3)*
- **T-API-20d**: `run("myscript", { envFile: "nonexistent.env" })` — errors before any child process is spawned because the env file does not exist. Same timing caveat as T-API-20a. *(Spec 9.3, 9.5)*
- **T-API-20e**: `runPromise("myscript", { envFile: "nonexistent.env" })` — rejects because the env file does not exist. *(Spec 9.3, 9.5)*

#### `envFile` Option

- **T-API-21**: `run("myscript", { envFile: "local.env" })` loads the env file. Script sees the variables. *(Spec 9.5)*
- **T-API-21a**: `run("myscript", { envFile: "relative/path.env", cwd: "/some/dir" })` — relative envFile path is resolved against the provided `cwd`. *(Spec 9.5)*
- **T-API-21b**: `run("myscript", { envFile: "relative/path.env" })` with no `cwd` option — relative envFile path is resolved against `process.cwd()` at call time. Set up a temp project, place the env file at a relative path from `process.cwd()`, and verify the script sees the variables. *(Spec 9.5)*

#### `maxIterations` Validation

- **T-API-22**: `run("myscript", { maxIterations: -1 })` → errors before any child process is spawned (non-negative integer required). The error may surface synchronously at `run()` call time or on the first `next()`. Assert only that an error occurs and no script was executed. **Blocked by SP-22.** *(Spec 9.5)*
- **T-API-23**: `run("myscript", { maxIterations: 1.5 })` → errors before any child process is spawned. Same timing caveat as T-API-22. *(Spec 9.5)*
- **T-API-24**: `runPromise("myscript", { maxIterations: NaN })` → rejects before execution. *(Spec 9.5)*
- **T-API-24a**: `runPromise("myscript", { maxIterations: -1 })` → rejects before execution (negative values are invalid). *(Spec 9.5)*
- **T-API-24b**: `runPromise("myscript", { maxIterations: 1.5 })` → rejects before execution (non-integer values are invalid). *(Spec 9.5)*

#### `runPromise()` with AbortSignal

- **T-API-25**: `runPromise("myscript", { signal })` — aborting the signal terminates the loop and the promise rejects with an abort error. *(Spec 9.5)*

### 4.10 Install Command

**Spec refs:** 10.1–10.3

All install tests use local servers (HTTP, file:// git repos). No network access.

#### Source Detection

- **T-INST-01**: `loopx install myorg/my-script` is treated as a git source (github shorthand). Verify by using `withGitURLRewrite` to redirect the expected github URL to a local bare repo, and asserting that the repo is cloned into `.loopx/my-script/`. Do not assert the exact expanded URL string — assert only that it is treated as a git source and the resulting directory script is named `my-script`. **Blocked by SP-21** — the exact expansion rule is inconsistent across spec sections. *(Spec 10.1)*
- **T-INST-02**: `loopx install https://github.com/org/repo` → treated as git (known host). *(Spec 10.1)*
- **T-INST-03**: `loopx install https://gitlab.com/org/repo` → treated as git. *(Spec 10.1)*
- **T-INST-04**: `loopx install https://bitbucket.org/org/repo` → treated as git. *(Spec 10.1)*
- **T-INST-05**: `loopx install https://example.com/repo.git` → treated as git (.git suffix). *(Spec 10.1)*
- **T-INST-06**: `loopx install http://localhost:PORT/pkg.tar.gz` → treated as tarball. *(Spec 10.1)*
- **T-INST-07**: `loopx install http://localhost:PORT/pkg.tgz` → treated as tarball. *(Spec 10.1)*
- **T-INST-08**: `loopx install http://localhost:PORT/script.ts` → treated as single file. *(Spec 10.1)*
- **T-INST-08a**: `loopx install https://github.com/org/repo/archive/main.tar.gz` → treated as tarball (not git), because the pathname has more than two segments. *(Spec 10.1)*
- **T-INST-08b**: `loopx install https://github.com/org/repo/raw/main/script.ts` → treated as single file (not git), because the pathname has additional path segments. *(Spec 10.1)*
- **T-INST-08c**: `loopx install https://github.com/org/repo/` → treated as git (trailing slash allowed on known host). *(Spec 10.1)*
- **T-INST-08d**: `loopx install http://localhost:PORT/pkg.tar.gz?token=abc` → treated as tarball. Source detection should operate on the URL pathname (ignoring query string), so `pkg.tar.gz?token=abc` is still recognized as a tarball by its `.tar.gz` extension. **Blocked by SP-25** — the spec says tarballs are URLs "ending in `.tar.gz` or `.tgz`" without explicitly stating that source classification uses the parsed pathname. *(Spec 10.1)*

#### Single-File Install

- **T-INST-09**: Downloading a `.ts` file places it in `.loopx/` with the correct filename. *(Spec 10.2)*
- **T-INST-10**: URL with query string `?token=abc` → query stripped from filename. *(Spec 10.2)*
- **T-INST-11**: URL with fragment `#section` → fragment stripped from filename. *(Spec 10.2)*
- **T-INST-12**: URL ending in unsupported extension (e.g., `.py`) → error, nothing saved. *(Spec 10.2)*
- **T-INST-13**: Script name = base name of downloaded file (e.g., `script.ts` → name `script`). *(Spec 10.2)*
- **T-INST-14**: `.loopx/` directory created if it doesn't exist. *(Spec 10.3)*

#### Git Install

- **T-INST-15**: Cloning a git repo places it in `.loopx/<repo-name>/`. *(Spec 10.2)*
- **T-INST-16**: Shallow clone (`--depth 1`). The source bare repo must have more than one commit (to make the shallow assertion non-vacuous). Verify the clone has only 1 commit (`git -C .loopx/<name> rev-list --count HEAD` = 1). *(Spec 10.2)*
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
- **T-INST-26a**: Tarball URL with query string (e.g., `http://localhost:PORT/pkg.tar.gz?token=abc`) → query stripped from archive-name derivation. Installed directory is `.loopx/pkg/`, not `.loopx/pkg.tar.gz?token=abc/`. *(Spec 10.2)*
- **T-INST-26b**: Tarball URL with fragment (e.g., `http://localhost:PORT/pkg.tgz#v1`) → fragment stripped from archive-name. *(Spec 10.2)*

#### Common Rules

- **T-INST-27**: Installing when a script with the same name already exists → error, existing script untouched. *(Spec 10.3)*
- **T-INST-28**: Installing a script with a reserved name (e.g., `output.ts`) → error, nothing saved. *(Spec 10.3)*
- **T-INST-29**: Installing a script with invalid name (e.g., `-invalid.ts`) → error, nothing saved. *(Spec 10.3)*
- **T-INST-30**: No automatic `npm install` / `bun install` after clone/extract. Verify `node_modules/` does not appear in installed directory script. *(Spec 10.3)*
- **T-INST-31**: HTTP 404 during single-file download → error, exit code 1, no partial file left in `.loopx/`. *(Spec 10.3)*
- **T-INST-32**: Git clone failure (non-existent repo) → error, exit code 1, no partial directory left in `.loopx/`. *(Spec 10.3)*
- **T-INST-33**: Tarball extraction failure (corrupt archive) → error, exit code 1, no partial directory left in `.loopx/`. *(Spec 10.3)*

#### Install Post-Validation (Directory Scripts)

These tests verify that git/tarball installs apply the same validation as discovery (Spec 5.1) to the resulting directory. **Blocked by SP-17** — the spec does not explicitly require install to validate beyond "package.json with main pointing to supported extension." These tests assume SP-17 resolves to full parity with discovery validation.

- **T-INST-34**: Git install where cloned repo has invalid JSON in `package.json` → clone removed, error, exit code 1, no partial directory left in `.loopx/`. **Blocked by SP-17.** *(Spec 10.2, 5.1)*
- **T-INST-35**: Git install where cloned repo has `package.json` with non-string `main` (e.g., `{"main": 42}`) → clone removed, error, exit code 1. **Blocked by SP-17.** *(Spec 10.2, 5.1)*
- **T-INST-36**: Git install where cloned repo has `package.json` with `main` escaping the directory (e.g., `{"main": "../escape.ts"}`) → clone removed, error, exit code 1. **Blocked by SP-17.** *(Spec 10.2, 5.1)*
- **T-INST-37**: Git install where cloned repo has `package.json` with `main` pointing to a file that does not exist → clone removed, error, exit code 1. **Blocked by SP-17.** *(Spec 10.2, 5.1)*
- **T-INST-38**: Tarball install where extracted directory has invalid JSON in `package.json` → directory removed, error, exit code 1. **Blocked by SP-17.** *(Spec 10.2, 5.1)*
- **T-INST-39**: Tarball install where extracted directory has `package.json` with `main` pointing to a missing file → directory removed, error, exit code 1. **Blocked by SP-17.** *(Spec 10.2, 5.1)*

### 4.11 Signal Handling

**Spec refs:** 7.3

Signal tests use the `sleep-then-exit` fixture (a bash script that sleeps for a long time) and the `spawn-grandchild` fixture.

- **T-SIG-01**: Send SIGINT to loopx while a script is running. Assert loopx exits with code 130 (128 + 2). *(Spec 7.3)*
- **T-SIG-02**: Send SIGTERM to loopx while a script is running. Assert loopx exits with code 143 (128 + 15). *(Spec 7.3)*
- **T-SIG-03**: After SIGINT, the child script process is no longer running. Check by writing child PID to a file, then verifying the process is gone after loopx exits. *(Spec 7.3)*
- **T-SIG-04**: Grace period: child script traps SIGTERM and exits within 2 seconds. Assert loopx exits cleanly (no SIGKILL needed, exit code 128+15). *(Spec 7.3)*
- **T-SIG-05**: Grace period exceeded: child script traps SIGTERM and hangs (ignores it). Assert loopx sends SIGKILL after ~5 seconds and exits. *(Spec 7.3)*
- **T-SIG-06**: Process group signal: script spawns a grandchild process. Send SIGTERM to loopx. Assert both the script and grandchild are terminated. *(Spec 7.3)*
- ~~**T-SIG-07**~~: *Moved to robustness suite.* Signal between iterations is too timing-sensitive for reliable black-box E2E testing.
- **T-SIG-07a**: *(Supplementary / unit-level)* Between-iterations signal behavior: if the implementation exposes an internal hook or testable code path for the "no child running" signal case (Spec 7.3), verify that loopx exits immediately with the appropriate signal exit code when a signal arrives between iterations. If no such internal API exists, this test is skipped and coverage for this clause is marked as partial. *(Spec 7.3)*

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
- **T-DEL-06**: After delegation, `import from "loopx"` in scripts resolves to the **local (delegated-to) version's** package, not the global version. The local version must be **observably distinct** — e.g., it includes an additional non-standard export (like `__loopxVersion`) or writes a distinctive marker during module initialization. A TS script imports from `"loopx"` and checks for the local version's marker. Assert that the script observes the local version's marker, not the global's. This discrimination prevents the test from passing vacuously when any working `output()` is available. **Partially blocked by SP-24** — the mechanism for ensuring this resolution varies by runtime. *(Spec 3.2)*

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
1. Write a **JS/TS script** (not bash `echo`) that reads the test payload from a file and writes it to stdout using `process.stdout.write()`. This safely handles arbitrary strings including control characters and null bytes, which shell `echo` cannot represent reliably.
2. Set up a two-script chain: A (the writer script) → goto B (a stdin reader). Use a wrapper script that always outputs `goto:"reader"` regardless of what the inner writer produces. If the writer output overrides the goto (i.e., it's a valid structured output with its own goto or stop), the test observes that behavior instead.
3. Alternatively, use the programmatic API (`run()`) to observe the parsed output directly.
4. Assert the invariants above.

**Iterations:** The structured output fuzzer has two tiers:
- **Unit-level parser fuzzing:** At least 1000 random inputs per property. These call the parser function directly (no child process), so they are fast. This is where high-volume fuzzing lives.
- **E2E fuzzing:** At most 50–100 random inputs per property. Each input spawns a real child process, so high iteration counts are prohibitively slow. The E2E layer is a randomized smoke test to catch integration issues the unit fuzzer cannot.

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

**Iterations:** Same two-tier approach as section 5.1: at least 1000 inputs at the unit-parser level, 50–100 at the E2E level.

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

### 6.4 Compile-Time Type Tests

**File:** `tests/unit/types.test.ts`

These tests verify the public TypeScript type surface documented in Spec section 9.5. They use compile-time assertions (e.g., `expectTypeOf` from vitest, or `tsd`, or a `tsc --noEmit` check) to verify the exported types match the spec — not just that the runtime behavior is correct.

**Setup:** The test file imports from the built loopx package as a real consumer would (same symlink/link approach as `runAPIDriver`).

- **T-TYPE-01**: `import type { Output, RunOptions } from "loopx"` compiles without error. *(Spec 9.5)*
- **T-TYPE-02**: `Output` has optional `result?: string`, `goto?: string`, `stop?: boolean` fields — and no other required fields. Assert via `expectTypeOf<Output>()` or equivalent. *(Spec 9.5)*
- **T-TYPE-03**: `RunOptions` has optional `maxIterations?: number`, `envFile?: string`, `signal?: AbortSignal`, `cwd?: string` fields. *(Spec 9.5)*
- **T-TYPE-04**: `run()` returns `AsyncGenerator<Output>`. Assert that `import { run } from "loopx"` compiles and the return type is assignable to `AsyncGenerator<Output>`. *(Spec 9.1, 9.5)*
- **T-TYPE-05**: `runPromise()` returns `Promise<Output[]>`. Assert the return type is assignable to `Promise<Output[]>`. *(Spec 9.2, 9.5)*
- **T-TYPE-06**: `run()` and `runPromise()` accept an optional `RunOptions` second argument. *(Spec 9.1, 9.2, 9.5)*
- **T-TYPE-07**: `run()` and `runPromise()` accept an optional script name as the first argument (`string | undefined`). *(Spec 9.1, 9.2, 9.5)*

---

## 7. Edge Cases & Boundary Tests

These tests specifically target boundary conditions that could reveal implementation bugs.

- **T-EDGE-01**: Very long result string (~1 MB). Script outputs `{"result":"<1MB>"}`. Assert it is handled without truncation or hang. *(Spec 2.3)*
- **T-EDGE-02**: Result containing JSON-special characters (quotes, backslashes, newlines). Verify correct JSON serialization/deserialization. *(Spec 2.3)*
- **T-EDGE-03**: Script that writes stdout in multiple `write()` calls (partial writes). Assert the full output is captured and parsed as a unit. *(Spec 2.3)*
- **T-EDGE-04**: Script that writes to both stdout and stderr. Assert stdout captured as output, stderr passed through. No interleaving issues. *(Spec 6.2, 6.3)*
- **T-EDGE-05**: Unicode in result values and env values is preserved correctly. Unicode in script names (e.g., `.loopx/café.sh`) is rejected — script names are ASCII-only per the `[a-zA-Z0-9_][a-zA-Z0-9_-]*` pattern. Assert that a unicode-named script produces a validation error. *(Spec 2.3, 5.4, 8.1)*
- **T-EDGE-06**: Deeply nested goto chain (A → B → C → D → E → ... → Z). Assert correct execution order and iteration counting. *(Spec 7.1)*
- **T-EDGE-07**: Script that produces output on stdout but also reads from stdin when no input is available. Assert no deadlock. *(Spec 6.8)*
- ~~**T-EDGE-08**~~: *Moved to robustness suite.* Concurrent loopx invocations — not direct spec conformance.
- ~~**T-EDGE-09**~~: *Moved to robustness suite.* Large script count discovery performance — not direct spec conformance.
- ~~**T-EDGE-10**~~: *Moved to robustness suite.* Maximum-length script name — filesystem limit, not direct spec conformance.
- **T-EDGE-11**: `-n` with very large value (e.g., `999999`). Assert no integer overflow or similar. Script should `stop` after a few iterations. *(Spec 4.2)*
- **T-EDGE-12**: Empty `.loopx/` directory (exists but no scripts). `loopx` → error (no default script). `loopx myscript` → error (not found). *(Spec 4.1)*
- ~~**T-EDGE-13**~~: *Moved to robustness suite.* Long-running script patience — not direct spec conformance.
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
| 1 | Overview (ESM-only) | T-MOD-22 |
| 2.1 | Script (file & directory) | T-DISC-01–17, T-DISC-11a, T-DISC-14a–14c, T-DISC-16a–16d, T-MOD-03a, T-EXEC-18a |
| 2.2 | Loop (state machine) | T-LOOP-01–05, T-LOOP-16–17 |
| 2.3 | Structured Output | T-PARSE-01–29, F-PARSE-01–05 |
| 3.1 | Global Install | **Release-smoke / manual.** The E2E suite tests the built binary directly, not a `npm install -g` artifact. A true global-install test (`npm pack` → install into temp global prefix → run against fixture project) is a release-gate smoke test, not part of the regular E2E suite. Runtime behavior is covered by other sections. |
| 3.2 | CLI Delegation | T-DEL-01–06 (T-DEL-06 partially blocked by SP-24) |
| 3.3 | Module Resolution | T-MOD-01–03, T-MOD-03a (blocked by SP-24) |
| 3.4 | Bash Script Binary Access | T-MOD-19–21 |
| 4.1 | Running Scripts | T-CLI-08–13 |
| 4.2 | Options (-n, -e, -h) | T-CLI-02–07g, T-CLI-14–22d, T-CLI-19a, T-CLI-20a–20b |
| 4.3 | Subcommands | T-SUB-01–19, T-SUB-14a–14k |
| 5.1 | Discovery | T-DISC-01–17, T-DISC-11a, T-DISC-14a–14c, T-DISC-16a–16d, T-DISC-33–38, T-DISC-47–49 |
| 5.2 | Name Collision | T-DISC-18–21, T-CLI-22b |
| 5.3 | Reserved Names | T-DISC-22–26, T-CLI-22c |
| 5.4 | Name Restrictions | T-DISC-27–32, T-DISC-30a–30b, T-CLI-07d, T-CLI-22d, T-EDGE-05 |
| 5.5 | Validation Scope | T-DISC-39–46, T-SUB-06, T-SUB-13, T-SUB-19 |
| 6.1 | Working Directory | T-EXEC-01–04 |
| 6.2 | Bash Scripts | T-EXEC-05–07 |
| 6.3 | JS/TS Scripts | T-EXEC-08–13b |
| 6.4 | Directory Scripts | T-EXEC-15–18, T-EXEC-18a |
| 6.5 | output() Function | T-MOD-04–14a, T-MOD-13a–13e |
| 6.6 | input() Function | T-MOD-15–18 |
| 6.7 | Input Piping | T-LOOP-11–15 |
| 6.8 | Initial Input | T-LOOP-14 |
| 7.1 | Basic Loop | T-LOOP-01–10, T-LOOP-25 |
| 7.2 | Error Handling | T-LOOP-18–24 |
| 7.3 | Signal Handling | T-SIG-01–06, T-SIG-07a (partial — between-iterations case may require unit-level test or be skipped) |
| 8.1 | Global Env Storage | T-ENV-01–15f, T-ENV-25, F-ENV-01–05 |
| 8.2 | Local Env Override | T-ENV-16–19 |
| 8.3 | Env Injection Precedence | T-ENV-20–24, T-ENV-20a, T-ENV-21a |
| 9.1 | run() | T-API-01–09a (T-API-09a partially blocked by SP-26), T-API-10, T-TYPE-04, T-TYPE-06–07 |
| 9.2 | runPromise() | T-API-11–14b, T-TYPE-05–07 |
| 9.3 | API Error Behavior | T-API-15–19, T-API-20a–20e |
| 9.4 | output() and input() (script-side) | T-MOD-04–14a, T-MOD-13a–13e (output()), T-MOD-15–18 (input()) — these are the same tests listed under 6.5/6.6; 9.4 references them |
| 9.5 | Types / RunOptions | T-API-07–08, T-API-10, T-API-20d–20e, T-API-21–21b, T-API-22–25, T-API-24a–24b, T-TYPE-01–07 |
| 10.1 | Source Detection | T-INST-01–08d |
| 10.2 | Source Type Details | T-INST-09–26b, T-INST-34–39 (blocked by SP-17) |
| 10.3 | Common Install Rules | T-INST-27–33 |
| 11 | Help | T-CLI-02–07g |
| 12 | Exit Codes | T-EXIT-01–13 |
