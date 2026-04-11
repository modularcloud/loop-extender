# Test Specification for loopx

## 1. Philosophy & Goals

### 1.1 Core Principles

1. **E2E black-box testing is the primary strategy.** Tests exercise the `loopx` binary and programmatic API exactly as users would — by spawning processes, creating fixture scripts, and asserting observable behavior (exit codes, stdout, stderr, file system state). Internal implementation details are not tested directly.

2. **Contract-driven.** Every test traces to a specific SPEC.md requirement. The test suite serves as an executable specification.

3. **Runtime coverage.** Tests run against both Node.js (>= 20.6) and Bun (>= 1.0). Where a test exercises runtime-specific behavior (e.g., module resolution), it is tagged accordingly.

4. **Verification before implementation.** Since the implementation doesn't exist yet, the test suite includes a verification strategy (section 3) to ensure tests are correctly constructed before they can pass.

5. **Fuzz testing for parsers.** The structured output parser and `.env` file parser are exercised with property-based tests to catch edge cases.

6. **Explicit internal test seams.** The implementation must expose certain pure functions as package-private imports for unit and fuzz testing. This is a deliberate design decision — without these seams, high-volume fuzz testing is limited to E2E (50–100 inputs) instead of direct function calls (1000+ inputs). See section 1.4 for details.

### 1.2 Test Priorities

| Priority | Category | Rationale |
|----------|----------|-----------|
| P0 | Loop state machine, structured output parsing, script execution | Core functionality — if these break, nothing works |
| P1 | Environment variables, CLI options, subcommands | Essential user-facing features |
| P2 | Install command, CLI delegation, signal handling | Important but less frequently exercised |
| P3 | Edge cases, fuzz tests | Defense in depth |

### 1.3 Coverage Scope

This suite is the **implementation-driving** test suite — it defines the behavior that must pass before a feature is considered complete. All SPEC.md requirements are covered by automated tests in this suite, including:

- **Spec 3.1 (Global Install):** Covered by T-INST-GLOBAL-01, which exercises the full `npm pack` → install into isolated global prefix → run against fixture project workflow. This runs in CI on every build.

- **Spec 7.3 (Signal Handling — between iterations):** Covered by T-SIG-07, which sends a signal between iterations by coordinating via marker files. Tagged `@flaky-retry(3)` due to inherent timing sensitivity. The active-child signal cases (T-SIG-01–06) are fully covered without retry.

- **Spec 9.1 (Async Generator Cancellation):** Multiple cancellation scenarios are tested: "break after yield" (T-API-06), "return during pending next" (T-API-09a), "abort signal during active child" (T-API-10a), "pre-aborted signal" (T-API-10b), and "abort between iterations" (T-API-10c).

### 1.4 Internal Test Seams

The implementation **must** expose the following pure functions as package-private imports for unit and fuzz testing. These are not part of the public API and are not documented in SPEC.md — they exist solely to enable high-volume testing.

**Required exports (via a subpath like `loopx/internal` or a `src/internal.ts` barrel):**

| Function | Signature | Purpose |
|----------|-----------|---------|
| `parseOutput` | `(stdout: string) => Output` | Parses raw stdout into structured Output per Spec 2.3 rules |
| `parseEnvFile` | `(content: string) => { vars: Record<string, string>, warnings: string[] }` | Parses `.env` file content per Spec 8.1 rules. Returns parsed variables and any warning messages for invalid lines |
| `classifySource` | `(source: string) => { type: "git" \| "tarball" \| "single-file", url: string }` | Classifies an install source per Spec 10.1 rules |

**Design constraints:**

- These functions must be **pure** — no I/O, no process spawning, no side effects. They take a string and return a value.
- The `warnings` field in `parseEnvFile` returns the warning messages that would be printed to stderr during normal operation. This allows unit tests to assert on warning behavior without capturing stderr from a child process.
- The exact module path and export mechanism is an implementation detail, but the test suite must be able to `import { parseOutput } from "loopx/internal"` (or equivalent). The implementation may use TypeScript `paths` aliases, a `package.json` `exports` subpath, or a direct relative import from the test files.
- These exports are **not** part of the public semver contract. They may change shape between minor versions.

**These seams are a hard implementation requirement.** Unit tests (section 6.1, 6.2) and high-volume fuzz tests (section 5.1, 5.2) depend on them. The implementation is not considered complete until these exports are available and importable by the test suite.

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
  "https://github.com/myorg/my-script.git": "file:///tmp/bare-repos/my-script.git"
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
    const result = await runCLI(["run", "-n", "1", "myscript"], { cwd: project.dir, runtime });
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
| `sleep-then-exit(seconds)` | bash | Sleeps for `<seconds>`, then exits 0. General-purpose long-running script. For signal tests, prefer the dedicated `signal-*` fixtures which follow the ready-protocol. |
| `write-env-to-file(varname, markerPath)` | bash | `printf '%s' "$VARNAME"` to a marker file. Uses `printf '%s'` (not `echo`) to avoid trailing newline and backslash interpretation. Observation via filesystem, not CLI stdout. |
| `observe-env(varname, markerPath)` | ts | Writes JSON `{ "present": true, "value": "..." }` or `{ "present": false }` to a marker file using `fs.writeFileSync`. Distinguishes unset from empty string. Use instead of `write-env-to-file` when the test must differentiate between a variable being absent vs set to `""`. |
| `write-cwd-to-file(markerPath)` | bash | `printf '%s' "$PWD"` to a marker file. Uses `printf '%s'` (not `echo`) for exact-byte safety. |
| `write-value-to-file(value, markerPath)` | bash | `printf '%s' '<value>'` to a marker file. Uses `printf '%s'` (not `echo`) for exact-byte safety — avoids trailing newlines, backslash interpretation, and issues with values starting with `-`. General-purpose observation helper. |
| `stdout-writer(payloadFile)` | ts | Reads `payloadFile` from disk and writes its contents to stdout via `process.stdout.write()`. Used for fuzz and exact-byte output tests. |
| `ts-output(fields)` | ts | Uses `import { output } from "loopx"` to emit structured output |
| `ts-input-echo()` | ts | Reads input(), outputs it as result |
| `ts-import-check()` | ts | Imports from "loopx", outputs success marker |
| `signal-ready-then-sleep(markerPath)` | bash | Writes `$$` (the script's PID) to a marker file using `printf '%s'`, then writes `"ready"` to stderr, then sleeps indefinitely. The stderr marker allows the test harness to `waitForStderr("ready")` before sending a signal, ensuring the child is alive. |
| `signal-trap-exit(markerPath, delay)` | bash | Traps SIGTERM with a handler that sleeps for `<delay>` seconds then exits 0. On startup, writes `$$` to a marker file using `printf '%s'` and writes `"ready"` to stderr. Used for grace-period tests — delay < 5s tests clean exit, delay > 5s tests SIGKILL escalation. |
| `signal-trap-ignore(markerPath)` | bash | Traps SIGTERM and ignores it (handler is a no-op). On startup, writes `$$` to a marker file using `printf '%s'` and writes `"ready"` to stderr, then sleeps indefinitely. Used for SIGKILL-after-grace-period tests (T-SIG-05). |
| `spawn-grandchild(markerPath)` | bash | Spawns a background subprocess (e.g., `sleep 3600 &`), writes both `$$` (script PID) and `$!` (grandchild PID) to a marker file (one per line) using `printf '%s\n'`, writes `"ready"` to stderr, then `wait`s. For process group signal tests (T-SIG-06). |
| `write-pid-to-file(markerPath)` | ts | Writes `process.pid` to a marker file using `fs.writeFileSync`, writes `"ready"` to stderr, then runs a long-running operation (e.g., `setTimeout(() => {}, 999999)`). Used for API cancellation tests (T-API-09a, T-API-10a) where a JS/TS script is needed. |
| `counter(file)` | bash | Appends "1" to a counter file each invocation, outputs count as result |

**Fixture naming note:** The `emit-*` fixtures replace the previous `echo-*` fixtures. `printf` is used instead of `echo` to provide exact byte control — `echo` appends a trailing newline which can mangle exact byte expectations in parser tests. For tests that specifically need to verify trailing-newline handling, use `emit-raw-ln`. The `write-*-to-file` fixtures observe values via the filesystem rather than CLI stdout, since the CLI never prints `result` to its own stdout (Spec 7.1). All bash `write-*-to-file` fixtures use `printf '%s'` (not `echo`) to write values, ensuring exact-byte safety for trailing spaces, backslashes, and values starting with `-`. The `observe-env` fixture is a TS-based alternative to `write-env-to-file` that writes structured JSON (`{ "present": boolean, "value"?: string }`) to a marker file using `fs.writeFileSync` for exact-byte safety. Use `observe-env` when a test must distinguish between a variable being unset vs set to an empty string — `write-env-to-file` (bash `printf '%s' "$VAR"`) produces identical output for both cases.

**Signal/cancellation fixtures:** The `signal-ready-then-sleep`, `signal-trap-exit`, `signal-trap-ignore`, `spawn-grandchild`, and `write-pid-to-file` fixtures are purpose-built for signal and cancellation tests. They all follow a common protocol: (1) write PID(s) to a marker file on startup, (2) write `"ready"` to stderr, (3) block. The stderr marker allows `waitForStderr("ready")` to synchronize the test harness before sending signals, preventing races. The marker file PIDs allow post-test verification that processes were actually killed.

**Bash JSON safety warning:** The `emit-result`, `emit-goto`, and `emit-result-goto` fixtures use `printf` with `%s` substitution to produce JSON. This is only safe for simple string values that do not contain double quotes (`"`), backslashes (`\`), newlines, or other JSON-special characters — these would produce malformed JSON. For tests that require exact-byte control, JSON-special characters in values, or arbitrary binary content, use the `stdout-writer` TS fixture (which reads a pre-written payload from disk) or `emit-raw`/`emit-raw-ln` (which output exact bytes without JSON framing).

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

**Spec refs:** 4.1, 4.2, 4.3, 11.1, 11.2

#### Help & Version

- **T-CLI-01**: `loopx version` prints the bare package version string followed by a newline, exits 0. Assert exact stdout is `${version}\n` — the spec requires a trailing newline, so assert against the untrimmed stdout, not a trimmed comparison. No additional text or labels. Does not require `.loopx/` to exist. *(Spec 4.3, 5.4)*

#### Top-Level Help

- **T-CLI-02**: `loopx -h` prints usage text containing "loopx" and "usage" (case-insensitive), exits 0. Assert that the output lists the available subcommands: `run`, `version`, `output`, `env`, and `install` must all appear in the help text. Does not list scripts — top-level help performs no script discovery. *(Spec 4.2, 11.1)*
- **T-CLI-03**: `loopx --help` produces the same output as `-h`. *(Spec 4.2, 11.1)*
- **T-CLI-04**: `loopx -h` with `.loopx/` containing scripts does NOT list discovered script names in output. Top-level help performs no discovery. Assert that stdout does not contain any of the script names. *(Spec 4.2, 11.1)*
- **T-CLI-05**: `loopx -h` without `.loopx/` directory still prints help (no error). No script list, no warnings. *(Spec 4.2, 11.1)*
- **T-CLI-06**: `loopx -h` with `.loopx/` containing name collisions does NOT print warnings on stderr. Top-level help performs no validation. *(Spec 4.2, 11.1)*
- **T-CLI-07e**: `loopx -h version` prints top-level help and exits 0 (top-level `-h` takes precedence over everything that follows). The `version` subcommand does not execute. *(Spec 4.2)*
- **T-CLI-07f**: `loopx -h env set FOO bar` prints top-level help and exits 0 (top-level `-h` takes precedence over `env` subcommand). *(Spec 4.2)*
- **T-CLI-07g**: `loopx -h --invalid-flag` prints top-level help and exits 0 (top-level `-h` takes precedence over invalid flags). *(Spec 4.2)*
- **T-CLI-07j**: `loopx -h -e nonexistent.env` prints top-level help and exits 0 (top-level `-h` takes precedence over `-e`). The nonexistent env file is not read or validated. *(Spec 4.2)*
- **T-CLI-39**: `loopx -h run foo` shows top-level help (not run help) and exits 0. Top-level `-h` takes precedence over everything that follows, including `run` subcommand dispatch. *(Spec 4.2)*
- **T-CLI-61**: `loopx --help run foo` shows top-level help (not run help) and exits 0. Same behavior as `loopx -h run foo` — verifies that the `--help` long form has identical precedence semantics to `-h` when followed by additional arguments. *(Spec 4.2)*

#### Run Help

- **T-CLI-40**: `loopx run -h` with `.loopx/` containing scripts prints run-specific help that includes: (a) run syntax, (b) the `-n` and `-e` options with descriptions, and (c) a list of discovered script names. Assert that all three are present in the output. Exits 0. *(Spec 4.2, 11.2)*
- **T-CLI-41**: `loopx run --help` produces the same output as `loopx run -h`. *(Spec 4.2, 11.2)*
- **T-CLI-42**: `loopx run -h` without `.loopx/` directory still prints run help with a warning that the directory was not found. The discovered-scripts section is omitted. Exits 0. *(Spec 11.2)*
- **T-CLI-43**: `loopx run -h` with `.loopx/` containing name collisions prints run help with warnings on stderr about the conflicting entries. Exits 0. *(Spec 5.2, 11.2)*
- **T-CLI-44**: `loopx run -h` with `.loopx/` containing a script with an invalid name (e.g., `-startswithdash.sh`) prints run help with a non-fatal warning on stderr about the invalid name. The invalid script is still listed in the help output (section 5.3 says invalid-name scripts are listed with a warning in help mode). Help still exits 0. *(Spec 5.3, 11.2)*
- **T-CLI-45**: `loopx run -h` with `.loopx/` containing scripts lists script names and includes type information for each. Assert that each discovered script name appears in the output and that the output contains the file type (e.g., "ts", "sh") somewhere in the help text. Do not assert proximity between the name and type text, and do not assert an exact rendering format — only that both the name and its type are present. *(Spec 11.2)*
- **T-CLI-46**: `loopx run -h` with `.loopx/` containing a directory script with a bad `package.json` (invalid JSON) prints run help with a non-fatal warning on stderr about the invalid directory script. Help still exits 0. The invalid directory script is not listed in the script listing. *(Spec 5.1, 11.2)*
- **T-CLI-47**: `loopx run -h` with `.loopx/` containing a directory script whose `main` escapes the directory (e.g., `"main": "../escape.ts"`) prints run help with a non-fatal warning on stderr. Help still exits 0. *(Spec 5.1, 11.2)*
- **T-CLI-62**: `loopx run myscript --help` shows run help and exits 0. Same behavior as `loopx run myscript -h` — verifies that the `--help` long form triggers the run-help short-circuit identically to `-h` when appearing after a script name. *(Spec 4.2, 11.2)*

#### Run Help Short-Circuit

Within `run`, `-h` / `--help` is a full short-circuit: when present, loopx shows run help, exits 0, and ignores all other run-level arguments unconditionally.

- **T-CLI-48**: `loopx run -h foo` shows run help and exits 0 (script name ignored). *(Spec 4.2)*
- **T-CLI-49**: `loopx run myscript -h` shows run help and exits 0 (`-h` after script name still triggers help short-circuit). *(Spec 4.2)*
- **T-CLI-50**: `loopx run -h -e missing.env` shows run help and exits 0 (env file not validated). *(Spec 4.2)*
- **T-CLI-51**: `loopx run -h -n bad` shows run help and exits 0 (`-n` not validated). *(Spec 4.2)*
- **T-CLI-52**: `loopx run -h -n 5 -n 10` shows run help and exits 0 (duplicate `-n` not rejected under help). *(Spec 4.2)*
- **T-CLI-53**: `loopx run -h foo bar` shows run help and exits 0 (extra positional not rejected under help). *(Spec 4.2)*
- **T-CLI-54**: `loopx run -h --unknown` shows run help and exits 0 (unknown flag not rejected under help). *(Spec 4.2)*
- **T-CLI-63**: `loopx run -h -e a.env -e b.env` shows run help and exits 0 (duplicate `-e` not rejected under help). *(Spec 4.2)*
- **T-CLI-55**: `loopx run -h` with `.loopx/` containing a directory script with an unreadable `package.json` (e.g., `chmod 000`) prints run help with a non-fatal warning on stderr about the unreadable file. Help still exits 0. **This test is conditional on `process.getuid() !== 0`.** *(Spec 5.1, 11.2)*
- **T-CLI-55a**: `loopx run -h` with `.loopx/` containing a directory script whose `package.json` has no `main` field (e.g., `{"name": "foo"}`) prints run help with a non-fatal warning on stderr about the missing `main`. Help still exits 0. *(Spec 5.1, 11.2)*
- **T-CLI-55b**: `loopx run -h` with `.loopx/` containing a directory script whose `package.json` has a non-string `main` (e.g., `{"main": 42}`) prints run help with a non-fatal warning on stderr about the invalid `main` type. Help still exits 0. *(Spec 5.1, 11.2)*
- **T-CLI-55c**: `loopx run -h` with `.loopx/` containing a directory script whose `main` points to an unsupported extension (e.g., `{"main": "index.py"}`) prints run help with a non-fatal warning on stderr about the unsupported extension. Help still exits 0. *(Spec 5.1, 11.2)*
- **T-CLI-55d**: `loopx run -h` with `.loopx/` containing a directory script whose `main` points to a file that does not exist (e.g., `{"main": "missing.ts"}`) prints run help with a non-fatal warning on stderr about the nonexistent file. Help still exits 0. *(Spec 5.1, 11.2)*

#### Bare Invocation & Top-Level Parsing Errors

- **T-CLI-28**: `loopx` with no arguments shows top-level help (equivalent to `loopx -h`). Exits 0. Assert that stdout is identical to `loopx -h` output and that no script discovery is performed — when `.loopx/` contains scripts, assert stdout does not contain any script names and stderr does not contain discovery warnings. *(Spec 4.1, 4.2)*
- **T-CLI-33**: `loopx myscript` is a usage error (unrecognized subcommand, no implicit fallback to `run`). Exit code 1. *(Spec 4.1)*
- **T-CLI-34**: `loopx --unknown` is a usage error (unrecognized top-level flag). Exit code 1. *(Spec 4.2)*
- **T-CLI-36**: `loopx -n 5 myscript` is a usage error (top-level `-n` rejected — only `-h` is recognized at top level). Exit code 1. *(Spec 4.2)*
- **T-CLI-37**: `loopx -e .env myscript` is a usage error (top-level `-e` rejected). Exit code 1. *(Spec 4.2)*
- **T-CLI-07b**: `loopx -n 5 -h` is a usage error (exit code 1). The first argument is `-n`, which is not `-h` and not a recognized subcommand, so top-level parsing fails before `-h` is reached. The top-level `-h` short-circuit only applies when `-h` is the first argument. *(Spec 4.2)*
- **T-CLI-07c**: `loopx myscript -h` is a usage error (exit code 1). `myscript` is an unrecognized token in the subcommand position — error regardless of what follows. *(Spec 4.2)*
- **T-CLI-38**: `loopx foo -h` is a usage error (unrecognized subcommand, exit code 1 — not top-level help). The top-level `-h` short-circuit only applies when `-h` appears before subcommand dispatch. *(Spec 4.2)*

#### Script Invocation via `run`

- **T-CLI-30**: `loopx run -n 1 myscript` with `.loopx/myscript.sh` runs the script. Assert via marker file: the script writes a known value to a marker file, confirming execution. *(Spec 4.1)*
- **T-CLI-11**: `loopx run -n 1 myscript` with `.loopx/myscript.sh` runs the script. Assert via counter file. *(Spec 4.1)*
- **T-CLI-12**: `loopx run nonexistent` with `.loopx/` existing but no matching script exits with code 1. *(Spec 4.1)*
- **T-CLI-13**: `loopx run default` runs a script named `default` as an ordinary script — `default` has no special behavior. Assert via marker file. *(Spec 4.1)*
- **T-CLI-29**: `loopx run` with no script name is a usage error (exit code 1). This does not inspect `.loopx/` or perform discovery. *(Spec 4.1)*
- **T-CLI-59**: `loopx run -n 5` (options present but no script name) is a usage error (exit code 1). ADR-0002 explicitly calls out this form as an error — zero positional arguments after options is not valid. *(Spec 4.1)*
- **T-CLI-60**: `loopx run` with `.loopx/` containing a name collision and an invalid directory script (broken `package.json`) — still exits with code 1 as a usage error (missing script name), AND stderr does not contain any discovery or validation warnings. This proves that the no-script-name error is raised before `.loopx/` is inspected. *(Spec 4.1, 5.1)*
- **T-CLI-31**: `loopx run version` with `.loopx/version.sh` runs the script named `version`, not the built-in subcommand. Assert via marker file that the script executed and the output is the script's, not the version string. *(Spec 4.1)*
- **T-CLI-32**: `loopx run run` with `.loopx/run.sh` runs the script named `run`. Assert via marker file. *(Spec 4.1)*

#### Option Order

Within `run`, options and `<script-name>` may appear in any order. The following tests verify normal execution (not just help) with non-standard option placement.

- **T-CLI-57**: `loopx run myscript -n 1` (script name before `-n`) runs the script for exactly 1 iteration. Assert via counter file that the script ran exactly once. This proves that options after the script name are accepted during normal execution, not just under the `-h` short-circuit. *(Spec 4.2)*
- **T-CLI-58**: `loopx run myscript -e local.env -n 1` (script name before both `-e` and `-n`) runs the script with the env file loaded. Assert via marker file that the env variable from `local.env` is visible to the script. *(Spec 4.2)*

#### CLI `-n` Option

- **T-CLI-14**: `loopx run -n 3 myscript` with a counter fixture runs exactly 3 iterations. Assert counter file contains 3 marks. *(Spec 4.2, 7.1)*
- **T-CLI-15**: `loopx run -n 0 myscript` exits 0 without running the script. Assert counter file does not exist or is empty. *(Spec 4.2, 7.1)*
- **T-CLI-16**: `loopx run -n -1 myscript` exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-17**: `loopx run -n 1.5 myscript` exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-18**: `loopx run -n abc myscript` exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-19**: `loopx run -n 0 nonexistent` with `.loopx/` existing but no script named `nonexistent` — exits with code 1 (validation occurs before `-n 0` short-circuit). Stderr contains an error about the missing script. *(Spec 4.2, 7.1)*
- **T-CLI-19a**: `loopx run -n 0 myscript` with `.loopx/` directory missing entirely → exits with code 1 (validation occurs before `-n 0` short-circuit). Stderr contains an error about the missing `.loopx/` directory. *(Spec 4.2, 7.1, 7.2)*
- **T-CLI-20**: `loopx run -n 1 myscript` runs exactly 1 iteration even if the script produces no `stop`. *(Spec 4.2)*
- **T-CLI-56**: `loopx run -n 0 myscript` with a valid script performs discovery and validation (script must exist), then executes zero iterations, and exits 0. Assert the counter file does not exist or is empty (script never ran). *(Spec 4.2, 7.1)*

#### Duplicate Flags

- **T-CLI-20a**: `loopx run -n 3 -n 5 myscript` exits with code 1 (duplicate `-n` is a usage error). *(Spec 4.2)*
- **T-CLI-20b**: `loopx run -e .env1 -e .env2 myscript` exits with code 1 (duplicate `-e` is a usage error). *(Spec 4.2)*

#### Unrecognized Run Flags

- **T-CLI-35**: `loopx run --unknown myscript` exits with code 1 (unrecognized flag within `run` is a usage error). *(Spec 4.2)*

#### CLI `-e` Option

- **T-CLI-21**: `loopx run -e .env -n 1 myscript` with a valid `.env` file makes its variables available in the script. Use `write-env-to-file` fixture: the script writes the env var value to a marker file. Assert the marker file contains the expected value. *(Spec 4.2)*
- **T-CLI-22**: `loopx run -e nonexistent.env myscript` exits with code 1. Stderr mentions the missing file. *(Spec 4.2)*
- **T-CLI-22a**: `loopx run -n 0 -e nonexistent.env myscript` exits with code 1 (env file validation happens before `-n 0` short-circuit). *(Spec 4.2, 7.1)*
- **T-CLI-22b**: `loopx run -n 0 myscript` with `.loopx/` containing a name collision → exits with code 1 (validation occurs before `-n 0` short-circuit). *(Spec 4.2, 5.2, 7.1)*
- **T-CLI-22d**: `loopx run -n 0 myscript` with `.loopx/` containing an invalid script name (e.g., `-bad.sh`) → exits with code 1. *(Spec 4.2, 5.3, 7.1)*

#### CLI Stdout Silence

- **T-CLI-23**: `loopx run -n 1 myscript` where `myscript` outputs `{"result":"hello"}` and writes a marker file — the CLI's own stdout is empty (result is not printed), AND the marker file exists (proving the script actually ran). Both assertions are required to prevent vacuous passes. *(Spec 7.1)*
- **T-CLI-27**: `loopx run script1 script2` (two positional arguments within `run`) exits with code 1. Stderr contains an error about unexpected arguments. `run` accepts exactly one positional argument. *(Spec 4.1)*

### 4.2 Subcommands

**Spec refs:** 4.3, 5.4

#### `loopx output`

- **T-SUB-01**: `loopx output --result "hello"` prints valid JSON to stdout, exits 0. Parse stdout as JSON and assert `result === "hello"`. Do not assert exact byte-for-byte text or field order. *(Spec 4.3)*
- **T-SUB-02**: `loopx output --goto "next"` prints valid JSON to stdout, exits 0. Parse stdout as JSON and assert `goto === "next"`. *(Spec 4.3)*
- **T-SUB-03**: `loopx output --stop` prints valid JSON to stdout, exits 0. Parse stdout as JSON and assert `stop === true`. *(Spec 4.3)*
- **T-SUB-04**: `loopx output --result "x" --goto "y" --stop` prints valid JSON to stdout. Parse as JSON and assert all three fields present with correct values. *(Spec 4.3)*
- **T-SUB-05**: `loopx output` with no flags exits with code 1 (error). *(Spec 4.3)*
- **T-SUB-06**: `loopx output --result "x"` works without `.loopx/` directory existing. *(Spec 5.4)*
- **T-SUB-06a**: `loopx output --result 'value with "quotes" and \\backslashes'` → stdout is valid JSON with the value correctly escaped. Parse stdout as JSON and assert `result` equals the literal string `value with "quotes" and \backslashes`. *(Spec 4.3)*
- **T-SUB-06b**: `loopx output --result $'line1\nline2'` (value containing a literal newline byte, passed as an array element to the process) → stdout is valid JSON with the newline correctly escaped as `\n` in the JSON string. Parse stdout as JSON and assert `result` equals `"line1\nline2"` (two-line string). *(Spec 4.3)*

#### `loopx env set`

- **T-SUB-07**: `loopx env set FOO bar` then `loopx env list` shows `FOO=bar`. *(Spec 4.3)*
- **T-SUB-08**: `loopx env set _UNDER score` succeeds (underscore-prefixed name valid). Follow with `loopx env list` and assert `_UNDER=score` is present in the output. *(Spec 4.3)*
- **T-SUB-09**: `loopx env set A1 val` succeeds (alphanumeric name). Follow with `loopx env list` and assert `A1=val` is present in the output. *(Spec 4.3)*
- **T-SUB-10**: `loopx env set 1INVALID val` exits with code 1 (starts with digit — wait, `[A-Za-z_]` for first char means digits are NOT valid as first char). *(Spec 4.3)*

  **Correction to my earlier analysis:** The env set validation pattern is `[A-Za-z_][A-Za-z0-9_]*`. First character must be letter or underscore. Digits are only allowed after the first character. Test T-SUB-10 verifies that `1INVALID` is rejected.

- **T-SUB-11**: `loopx env set -DASH val` exits with code 1 (invalid name). *(Spec 4.3)*
- **T-SUB-12**: `loopx env set FOO bar` then `loopx env set FOO baz` then `loopx env list` shows `FOO=baz` (overwrite). *(Spec 4.3)*
- **T-SUB-13**: `loopx env set FOO bar` in a directory with no `.loopx/` → exits 0 AND `loopx env list` subsequently shows `FOO=bar`. Assert both success and the actual side effect, not just exit code. Also assert stderr does not contain script-validation warnings. *(Spec 5.4)*
- **T-SUB-14**: `loopx env set` creates the config directory (`$XDG_CONFIG_HOME/loopx/`) if it doesn't exist. *(Spec 8.1)*
- **T-SUB-14a**: `loopx env set KEY "value with spaces"` → `loopx env list` shows `KEY=value with spaces`. Value round-trips correctly. *(Spec 4.3)*
- **T-SUB-14b**: `loopx env set KEY "value#hash"` → value preserved including `#`. *(Spec 4.3)*
- **T-SUB-14c**: `loopx env set KEY "val=ue"` → value with `=` round-trips correctly. *(Spec 4.3)*
- **T-SUB-14d**: `loopx env set KEY <value containing an actual newline byte>` → rejected (multiline values not supported). Exit code 1. The test helper passes the argument as an array element containing a literal newline (e.g., `"value\nwith newline"`), not via shell evaluation. *(Spec 4.3)*
- **T-SUB-14e**: `loopx env set KEY 'val"ue'` → `loopx env list` shows `KEY=val"ue`. Embedded double quotes round-trip correctly. *(Spec 4.3)*
- **T-SUB-14f**: `loopx env set KEY "value  "` → `loopx env list` shows `KEY=value  `. Trailing spaces in the value are preserved. *(Spec 4.3)*
- **T-SUB-14g**: `loopx env set KEY <value containing an actual CR byte>` → rejected (carriage return, like newline, is not supported). Exit code 1. The test helper passes the argument as an array element containing a literal carriage return (e.g., `"value\rwith cr"`), not via shell evaluation. *(Spec 4.3)*

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
- **T-SUB-19**: `loopx env list` in a directory with no `.loopx/` → exits 0 and produces no stdout output (since no vars are set). Assert both the exit code and that stdout is empty. Also assert stderr does not contain script-validation warnings. *(Spec 5.4)*

### 4.3 Script Discovery & Validation

**Spec refs:** 5.1–5.4

#### File Script Discovery

- **T-DISC-01**: `.loopx/myscript.sh` is discoverable. `loopx run -n 1 myscript` runs it. Assert via marker file (use `write-value-to-file` fixture): the script writes a known value to a marker file, and the marker file exists with the expected content after execution. Exit code 0 alone is not sufficient. *(Spec 5.1)*
- **T-DISC-02**: `.loopx/myscript.js` is discoverable. `loopx run -n 1 myscript` runs it. Assert via marker file: the script writes a known value to a marker file, confirming execution. *(Spec 5.1)*
- **T-DISC-03**: `.loopx/myscript.jsx` is discoverable. `loopx run -n 1 myscript` runs it. Assert via marker file: the script writes a known value to a marker file, confirming execution. *(Spec 5.1)*
- **T-DISC-04**: `.loopx/myscript.ts` is discoverable. `loopx run -n 1 myscript` runs it. Assert via marker file: the script writes a known value to a marker file, confirming execution. *(Spec 5.1)*
- **T-DISC-05**: `.loopx/myscript.tsx` is discoverable. `loopx run -n 1 myscript` runs it. Assert via marker file: the script writes a known value to a marker file, confirming execution. *(Spec 5.1)*
- **T-DISC-06**: `.loopx/myscript.mjs` is NOT discoverable. `loopx run -n 1 myscript` fails with "not found." *(Spec 2.1, 5.1)*
- **T-DISC-07**: `.loopx/myscript.cjs` is NOT discoverable. *(Spec 2.1, 5.1)*
- **T-DISC-08**: `.loopx/myscript.txt` is NOT discoverable. *(Spec 5.1)*
- **T-DISC-09**: `.loopx/myscript` (no extension) is NOT discoverable. *(Spec 5.1)*
- **T-DISC-10**: Script name is base name without extension. `.loopx/my-script.ts` → name is `my-script`. *(Spec 2.1)*

#### Directory Script Discovery

- **T-DISC-11**: `.loopx/mypipe/` with `package.json` (`"main": "index.ts"`) and `index.ts` → discoverable as `mypipe`. `loopx run -n 1 mypipe` runs it. Assert via marker file or `runPromise("mypipe", { maxIterations: 1 })`: the entry point executes and produces an observable output. *(Spec 2.1, 5.1)*
- **T-DISC-11a**: `.loopx/mypipe/` with `package.json` (`"main": "src/index.ts"`) and `src/index.ts` → discoverable as `mypipe`. This verifies that `main` can point to a subpath within the directory, not just a top-level file. *(Spec 2.1, 5.1)*
- **T-DISC-12**: `.loopx/nopackage/` directory with no `package.json` → ignored. `loopx run -n 1 nopackage` fails. *(Spec 2.1, 5.1)*
- **T-DISC-13**: `.loopx/nomain/` with `package.json` that has no `main` field → ignored. *(Spec 2.1, 5.1)*
- **T-DISC-14**: `.loopx/mypipe/` with `"main": "index.sh"` → discoverable (bash entry point). `loopx run -n 1 mypipe` runs it. Assert via marker file: the entry point executes and writes a known value to a marker file. *(Spec 5.1)*
- **T-DISC-14a**: `.loopx/mypipe/` with `"main": "index.js"` → discoverable (JS entry point). `loopx run -n 1 mypipe` runs it. Assert via marker file: the entry point executes and writes a known value. *(Spec 5.1)*
- **T-DISC-14b**: `.loopx/mypipe/` with `"main": "index.jsx"` → discoverable (JSX entry point). `loopx run -n 1 mypipe` runs it. Assert via marker file: the entry point executes and writes a known value. *(Spec 5.1)*
- **T-DISC-14c**: `.loopx/mypipe/` with `"main": "index.tsx"` → discoverable (TSX entry point). `loopx run -n 1 mypipe` runs it. Assert via marker file: the entry point executes and writes a known value. *(Spec 5.1)*
- **T-DISC-15**: `.loopx/mypipe/` with `"main": "index.py"` → warning on stderr, directory ignored. *(Spec 5.1)*
- **T-DISC-16**: `.loopx/mypipe/` with `"main": "../escape.ts"` → warning on stderr, directory ignored. *(Spec 5.1)*
- **T-DISC-16a**: `.loopx/mypipe/` with `package.json` containing invalid JSON (e.g., `{invalid}`) → warning on stderr, directory ignored. `loopx run -n 1 mypipe` fails. *(Spec 5.1)*
- **T-DISC-16b**: `.loopx/mypipe/` with unreadable `package.json` (e.g., no read permissions) → warning on stderr, directory ignored. **This test is conditional on `process.getuid() !== 0`** — root can read any file, so the test is skipped when running as root (e.g., in some CI containers). *(Spec 5.1)*
- **T-DISC-16c**: `.loopx/mypipe/` with `package.json` where `main` is not a string (e.g., `{"main": 42}`) → warning on stderr, directory ignored. *(Spec 5.1)*
- **T-DISC-16d**: `.loopx/mypipe/` with `package.json` where `main` points to a file that does not exist (e.g., `{"main": "missing.ts"}`) → warning on stderr, directory ignored. *(Spec 5.1)*
- **T-DISC-17**: Script name is directory name. `.loopx/my-pipeline/` → name is `my-pipeline`. *(Spec 2.1)*

#### Name Collisions

- **T-DISC-18**: `.loopx/example.sh` and `.loopx/example.ts` both exist → `loopx run -n 1 example` refuses to start with error listing the conflicting entries. Exit code 1. *(Spec 5.2)*
- **T-DISC-19**: `.loopx/example.ts` and `.loopx/example/` (valid directory script) → collision error. *(Spec 5.2)*
- **T-DISC-20**: Three-way collision (`.loopx/example.sh`, `.loopx/example.js`, `.loopx/example/`) → error lists all conflicting entries. *(Spec 5.2)*
- **T-DISC-21**: Non-conflicting scripts with different names → no error. `.loopx/alpha.sh` and `.loopx/beta.ts` coexist. Run `loopx run -n 1 alpha` and assert via marker file that `alpha` executed successfully. *(Spec 5.2)*

#### Previously Reserved Names (Now Allowed)

Scripts may now use any name that passes name restriction rules (section 5.3). The reserved names list (`output`, `env`, `install`, `version`) was eliminated by ADR-0002 — scripts are always invoked via `loopx run <name>`, so there is no ambiguity with built-in subcommands.

- **T-DISC-22**: `.loopx/output.sh` is discoverable. `loopx run -n 1 output` runs the script (not the built-in `output` subcommand). Assert via marker file. *(Spec 4.1, 5.1)*
- **T-DISC-23**: `.loopx/env.ts` is discoverable. `loopx run -n 1 env` runs the script. Assert via marker file. *(Spec 5.1)*
- **T-DISC-24**: `.loopx/install.js` is discoverable. `loopx run -n 1 install` runs the script. Assert via marker file. *(Spec 5.1)*
- **T-DISC-25**: `.loopx/version.sh` is discoverable. `loopx run -n 1 version` runs the script (not the built-in `version` subcommand). Assert via marker file. *(Spec 4.1, 5.1)*
- **T-DISC-26**: `.loopx/run.sh` is discoverable. `loopx run -n 1 run` runs the script named `run`. Assert via marker file. *(Spec 4.1, 5.1)*

#### Name Restrictions

- **T-DISC-27**: `.loopx/-startswithdash.sh` → error. *(Spec 5.3)*
- **T-DISC-28**: `.loopx/my-script.sh` (hyphen in middle) → valid. Run `loopx run -n 1 my-script` and assert via marker file that the script executed. *(Spec 5.3)*
- **T-DISC-29**: `.loopx/_underscore.sh` → valid. Run `loopx run -n 1 _underscore` and assert via marker file that the script executed. *(Spec 5.3)*
- **T-DISC-30**: `.loopx/ABC123.sh` → valid. Run `loopx run -n 1 ABC123` and assert via marker file that the script executed. *(Spec 5.3)*
- **T-DISC-30a**: `.loopx/1start.sh` → valid (digits are allowed as the first character of a script name per `[a-zA-Z0-9_]`). `loopx run -n 1 1start` runs it. Assert via marker file: the script writes a known value to a marker file, confirming execution. *(Spec 5.3)*
- **T-DISC-30b**: `.loopx/42.sh` → valid (all-digit script name). `loopx run -n 1 42` runs it. Assert via marker file: the script writes a known value to a marker file, confirming execution. *(Spec 5.3)*
- **T-DISC-31**: `.loopx/has space.sh` → error (space not in allowed pattern). *(Spec 5.3)*
- **T-DISC-32**: `.loopx/has.dot.sh` — the base name is `has.dot` (everything before `.sh`). This contains a `.` which is not in `[a-zA-Z0-9_-]`. → error. *(Spec 5.3)*

#### Symlinks

- **T-DISC-33**: Symlink to a `.ts` file inside `.loopx/` → followed, script discoverable. *(Spec 5.1)*
- **T-DISC-34**: Symlinked directory in `.loopx/` with valid package.json → followed, discoverable. *(Spec 5.1)*
- **T-DISC-35**: Directory script whose `main` is a symlink to a file within the directory → valid. *(Spec 5.1)*
- **T-DISC-36**: Directory script whose `main` is a symlink that resolves outside the directory → warning, ignored. *(Spec 5.1)*

#### Discovery Caching

- **T-DISC-37**: During a loop (`-n 3`), create a new script in `.loopx/` between iteration 1 and 2 (using a script that creates a file). Then have iteration 2 `goto` the new script name → error (not in cached discovery). *(Spec 5.1)*
- **T-DISC-38**: During a loop, modify the content of an already-discovered script between iterations. Assert the new content takes effect on the next iteration (since the file is re-read from disk). *(Spec 5.1)*
- **T-DISC-38a**: During a multi-iteration loop, an already-discovered script is removed (deleted from disk) between iterations. On the next iteration that would execute this script (either via goto or as the starting target), loopx fails at spawn time because the cached entry path no longer exists. Assert loopx exits with code 1. Use a two-script setup: script A writes a marker file and outputs `goto:"B"` on the first iteration; between iterations, a side-effect from A removes script B's file. When loopx tries to spawn B, it fails. *(Spec 5.1, 7.2)*
- **T-DISC-38b**: During a multi-iteration loop, an already-discovered script is renamed (moved to a different filename) between iterations. The cached entry path becomes stale. On the next iteration that would execute the original script, loopx fails at spawn time. Assert loopx exits with code 1. *(Spec 5.1, 7.2)*

#### Run-Mode Discovery Warnings

- **T-DISC-50**: `.loopx/` contains a valid script `good.sh` and an invalid directory script `bad/` (with malformed `package.json`). `loopx run -n 1 good` runs the valid script successfully (assert via marker file) AND stderr contains a warning about the invalid directory script. This verifies that discovery warnings are emitted in run mode, not just help mode. *(Spec 5.1)*

#### Validation Scope

- **T-DISC-39**: `loopx version` works when `.loopx/` doesn't exist. *(Spec 5.4)*
- **T-DISC-40**: `loopx env set X Y` when `.loopx/` doesn't exist → exits 0, AND `loopx env list` subsequently shows `X=Y`. Assert stderr does not contain script-validation warnings. *(Spec 5.4)*
- **T-DISC-41**: `loopx output --result "x"` when `.loopx/` doesn't exist → exits 0, AND stdout contains valid JSON with `result: "x"`. Assert stderr does not contain script-validation warnings. *(Spec 5.4)*
- **T-DISC-42**: `loopx` (no arguments) shows top-level help and exits 0 — even when `.loopx/` doesn't exist. No script discovery is performed. *(Spec 4.1, 5.4)*
- **T-DISC-43**: `loopx version` when `.loopx/` exists and contains name collisions → exits 0 with a version string on stdout. Assert stderr does not contain script-validation warnings (validation not performed). *(Spec 5.4)*
- **T-DISC-44**: `loopx env set X Y` when `.loopx/` exists and contains collisions → exits 0, AND `loopx env list` subsequently shows `X=Y`. Assert stderr does not contain script-validation warnings. *(Spec 5.4)*
- **T-DISC-45**: `loopx output --result "x"` when `.loopx/` exists and contains name restriction violations → exits 0, AND stdout contains valid JSON with `result: "x"`. Assert stderr does not contain script-validation warnings. *(Spec 5.4)*
- **T-DISC-46**: `loopx install <source>` when `.loopx/` exists and contains collisions → the install succeeds (exits 0, installed script present in `.loopx/`). Assert stderr does not contain script-validation warnings about existing scripts. *(Spec 5.4)*
- **T-DISC-46a**: `loopx env remove X` when `.loopx/` doesn't exist → exits 0 (silent no-op, since there is no variable to remove). Assert stderr does not contain script-validation warnings. *(Spec 5.4, 4.3)*
- **T-DISC-46b**: `loopx env remove X` when `.loopx/` exists and contains name collisions → exits 0 (the `env remove` subcommand does not trigger script validation). Assert stderr does not contain script-validation warnings. *(Spec 5.4, 4.3)*

#### Discovery Scope

- **T-DISC-47**: A parent directory has `.loopx/` with scripts, but the current working directory does not have `.loopx/`. `loopx run myscript` in the child directory fails — parent `.loopx/` is not discovered. *(Spec 5.1)*
- **T-DISC-49**: `.loopx/subdir/nested.ts` (a `.ts` file nested inside a non-script subdirectory within `.loopx/`) is NOT discovered. `loopx run -n 1 nested` fails. Discovery is top-level only — subdirectories without a valid `package.json` and their contents are ignored. *(Spec 5.1)*

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

- **T-EXEC-05**: A `.sh` script runs successfully and its stdout is captured as structured output. Observe via `runPromise("myscript", { maxIterations: 1 })`: the yielded Output contains the expected `result`. *(Spec 6.2)*
- **T-EXEC-06**: A `.sh` script's stderr appears on the CLI's stderr (pass-through). Assert by writing a known string to stderr and checking CLI stderr. *(Spec 6.2)*
- **T-EXEC-07**: A `.sh` script that lacks `#!/bin/bash` still runs (loopx invokes via `/bin/bash` explicitly, not via shebang). Assert actual execution via marker file: the script writes a known value to a marker file, confirming it ran despite having no shebang. *(Spec 6.2)*

#### JS/TS Scripts

- **T-EXEC-08**: `.ts` script runs and produces structured output. Observe via `runPromise("myscript", { maxIterations: 1 })`: the yielded Output has the expected `result`. *(Spec 6.3)*
- **T-EXEC-09**: `.js` script runs and produces structured output. Observe via `runPromise("myscript", { maxIterations: 1 })`. *(Spec 6.3)*
- **T-EXEC-10**: `.tsx` script runs and produces structured output. Observe via `runPromise("myscript", { maxIterations: 1 })`. The fixture **must use actual TSX syntax** to verify that the runtime handles JSX transformation, not just extension acceptance. Use a self-contained JSX pragma that does not depend on React: e.g., `/** @jsxImportSource ./jsx-shim */` where the shim's `jsx()` function returns a plain string, or use `React.createElement = (tag: string) => tag;` and write `const el = <div/>;`. The script outputs `{ result: String(el) }`. This proves the TSX-to-JS compilation actually ran. *(Spec 6.3)*
- **T-EXEC-11**: `.jsx` script runs and produces structured output. Observe via `runPromise("myscript", { maxIterations: 1 })`. Same approach as T-EXEC-10 — the fixture **must use actual JSX syntax** (e.g., `const el = <div/>;` with a custom pragma or shim) to verify JSX transformation works, not just that the extension is accepted. *(Spec 6.3)*
- **T-EXEC-12**: JS/TS script stderr passes through to CLI stderr. *(Spec 6.3)*
- **T-EXEC-13**: JS/TS script can use TypeScript type annotations (verifies tsx handles TS syntax under Node.js). `[Node]` *(Spec 6.3)*
- **T-EXEC-13b**: JS/TS script can use TypeScript type annotations under Bun (verifies Bun's native TS support). `[Bun]` *(Spec 6.3)*
- **T-EXEC-13a**: A `.js` script that uses `require()` (CJS) fails with an error. CJS is not supported. *(Spec 6.3)*
- **T-EXEC-14**: `[Bun]` When running under Bun, JS/TS scripts are executed via Bun's native runtime, not `tsx`. Create a `.ts` fixture script that writes `JSON.stringify({ bunVersion: process.versions.bun })` as its result. Observe via `runPromise("myscript", { maxIterations: 1 })`: the yielded Output's `result` parsed as JSON has a truthy `bunVersion` string, confirming the child process ran under Bun (not Node.js/tsx). The spec requires: "When running under Bun, loopx uses Bun's native TypeScript/JSX support instead of tsx." *(Spec 6.3)*

#### Directory Scripts

- **T-EXEC-15**: Directory script with `"main": "index.ts"` → `index.ts` is executed. Observe via `runPromise("mypipe", { maxIterations: 1 })`: the yielded Output has the expected `result`. *(Spec 6.4)*
- **T-EXEC-16**: Directory script with `"main": "run.sh"` → `run.sh` is executed via bash. Observe via `runPromise("mypipe", { maxIterations: 1 })`. *(Spec 6.4)*
- **T-EXEC-17**: Directory script can import from its own `node_modules/`. Setup: create a directory script with a local dependency (a simple `.js` file in `node_modules/`). Script writes a marker file confirming the import succeeded. *(Spec 2.1)*
- **T-EXEC-18**: Directory script CWD is its own directory. Script writes `process.cwd()` to a marker file. Assert marker content matches the script's directory. *(Spec 6.1)*
- **T-EXEC-18a**: Directory script that imports a package not present in its `node_modules/` (e.g., `import "nonexistent-pkg"`) — loopx does not auto-install dependencies. The script fails with a module resolution error from the active runtime, and loopx exits with code 1. *(Spec 2.1)*

### 4.5 Structured Output Parsing

**Spec refs:** 2.3

These tests use bash fixture scripts that echo specific strings to stdout. **Parsing correctness is asserted by examining the actual yielded `Output` object** via the programmatic API (`run()`, `runPromise()`, or `runAPIDriver()`), not by inferring from loop behavior alone. This is critical because distinct parsing outcomes (raw fallback, structured output with invalid fields, empty stdout) can produce identical control flow but different `Output` objects.

#### Valid Structured Output

- **T-PARSE-01**: Script outputs `{"result":"hello"}`. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output is `{ result: "hello" }` — no `goto` or `stop` properties present. *(Spec 2.3)*
- **T-PARSE-02**: Script outputs `{"goto":"next"}` → loopx transitions to script `next`. *(Spec 2.3)*
- **T-PARSE-03**: Script outputs `{"stop":true}` → loop halts, exit code 0. *(Spec 2.3)*
- **T-PARSE-04**: Script outputs `{"result":"x","goto":"next","stop":true}` → stop takes priority, loop halts. *(Spec 2.3)*
- **T-PARSE-05**: Script outputs `{"result":"x","extra":"ignored"}`. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "x"` and no `extra` property. *(Spec 2.3)*

#### Fallback to Raw Result

- **T-PARSE-06**: Script outputs `{"unknown":"field"}` (valid JSON object, no known fields). Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output is `{ result: '{"unknown":"field"}' }` — entire stdout becomes the raw result string, not an empty object. *(Spec 2.3)*
- **T-PARSE-07**: Script outputs `[1,2,3]` (JSON array). Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "[1,2,3]"`. *(Spec 2.3)*
- **T-PARSE-08**: Script outputs `"hello"` (JSON string). Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: '"hello"'` (the raw stdout, including the quotes). *(Spec 2.3)*
- **T-PARSE-09**: Script outputs `42` (JSON number). Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "42"` (raw stdout string, not a parsed number). *(Spec 2.3)*
- **T-PARSE-10**: Script outputs `true` (JSON boolean). Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "true"` (raw stdout string). *(Spec 2.3)*
- **T-PARSE-11**: Script outputs `null` (JSON null). Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "null"` (raw stdout string). *(Spec 2.3)*
- **T-PARSE-12**: Script outputs `not json at all`. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "not json at all"`. *(Spec 2.3)*
- **T-PARSE-12a**: Raw fallback preserves exact stdout including trailing newline. Script outputs `hello\n` (using `emit-raw-ln("hello")` fixture — `printf '%s\n' 'hello'`). Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "hello\n"` — the trailing newline is part of the raw result, not stripped. *(Spec 2.3)*
- **T-PARSE-13**: Script produces empty stdout (no output). Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output is `{ result: "" }` — not an empty object `{}`. *(Spec 2.3)*

#### Type Coercion

- **T-PARSE-14**: `{"result": 42}`. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "42"` (coerced via `String()`). *(Spec 2.3)*
- **T-PARSE-15**: `{"result": true}`. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "true"`. *(Spec 2.3)*
- **T-PARSE-16**: `{"result": {"nested": "obj"}}`. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "[object Object]"`. *(Spec 2.3)*
- **T-PARSE-17**: `{"result": null}`. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "null"`. *(Spec 2.3)*
- **T-PARSE-18**: `{"goto": 42}` (goto is not a string). Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output is exactly `{}` — an empty object with no `result`, `goto`, or `stop` properties. The output is parsed as structured (it is a JSON object with a known field), but the invalid-typed `goto` is discarded. This is distinct from raw fallback, which would yield `{ result: '{"goto":42}' }`. *(Spec 2.3)*
- **T-PARSE-19**: `{"goto": true}`. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-20**: `{"goto": null}`. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-21**: `{"stop": "true"}` (string, not boolean). Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output is exactly `{}`. Loop continues (does not halt). *(Spec 2.3)*
- **T-PARSE-22**: `{"stop": 1}`. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-23**: `{"stop": false}`. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-24**: `{"stop": "false"}`. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-20a**: `{"goto":""}` (empty string goto). An empty string IS a string (`typeof "" === "string"`), so the parser must preserve it — it is NOT treated as absent. Assert via `run("myscript")`: the generator throws an error on the first iteration (because `""` is not a valid script name), confirming the empty string was forwarded to the goto validation logic rather than silently discarded. This is distinct from T-PARSE-18/19/20 which test non-string goto values that are discarded. *(Spec 2.3)*

#### Mixed Valid/Invalid Fields

- **T-PARSE-28**: `{"result":"x","goto":42}` (valid result + invalid goto). Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output is exactly `{ result: "x" }` — the valid `result` is preserved, the invalid-typed `goto` is discarded. No `goto` or `stop` properties present. *(Spec 2.3)*
- **T-PARSE-29**: `{"result":"x","stop":"true"}` (valid result + invalid stop). Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output is exactly `{ result: "x" }` — the valid `result` is preserved, the invalid-typed `stop` is discarded. Loop continues (does not halt). *(Spec 2.3)*

#### Whitespace & Formatting

- **T-PARSE-25**: Script outputs JSON with trailing newline `{"result":"x"}\n`. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "x"` (parsed correctly, not raw fallback). *(Spec 2.3)*
- **T-PARSE-26**: Script outputs pretty-printed JSON (with newlines and indentation). Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has the expected fields (parsed correctly). *(Spec 2.3)*
- **T-PARSE-27**: Script outputs JSON with leading whitespace. Assert via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has the expected fields (parsed correctly). *(Spec 2.3)*

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

- **T-LOOP-11**: A outputs `{"result":"payload","goto":"B"}`. B reads stdin (via `cat-stdin` fixture) and outputs the received value as its result. Observe via `runPromise("A", { maxIterations: 2 })`: the second yielded Output has `result: "payload"`. *(Spec 6.7)*
- **T-LOOP-12**: A outputs `{"goto":"B"}` (no result). B reads stdin and outputs it as result. Observe via `runPromise("A", { maxIterations: 2 })`: the second yielded Output has `result: ""` (empty string). *(Spec 2.3, 6.7)*
- **T-LOOP-13**: A outputs `{"result":"payload"}` (no goto). Loop resets to A. A reads stdin and outputs it as result. Observe via `runPromise("A", { maxIterations: 2 })`: the second yielded Output has `result: ""` (result not piped on reset). *(Spec 6.7)*
- **T-LOOP-14**: First iteration (starting target) receives empty stdin. Script reads stdin and outputs it as result. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: ""`. *(Spec 6.8)*
- **T-LOOP-15**: A → `goto:"B"` with result → B → `goto:"C"` with result → C reads stdin and outputs it as result. Observe via `runPromise("A", { maxIterations: 3 })`: the third yielded Output has `result` equal to B's result, not A's. *(Spec 6.7)*

#### Goto Behavior

- **T-LOOP-16**: Goto is a transition, not permanent. A → `goto:"B"` → B → no goto → A runs again (not B). *(Spec 2.2)*
- **T-LOOP-17**: A → `goto:"A"` (self-referencing goto). Verify it works: A runs, then A runs again (2 iterations with -n 2). *(Spec 2.2)*
- **T-LOOP-18**: Goto target that doesn't exist → error, exit code 1. Stderr mentions the invalid target name. *(Spec 7.2)*
- **T-LOOP-19**: Goto to a script that was not discovered (e.g., a `.mjs` file) → error. *(Spec 7.2)*
- **T-LOOP-18a**: Script outputs `{"goto":""}` (empty string goto). An empty string is a valid string per section 2.3 parsing rules, so it is preserved as a goto value. However, `""` does not match any script name in `.loopx/` (script names must match `[a-zA-Z0-9_][a-zA-Z0-9_-]*`). Assert: loopx exits with code 1, stderr contains an error about the invalid goto target. The empty string goto must not be silently treated as absent (which would cause the loop to reset instead of erroring). *(Spec 2.3, 7.1, 7.2)*

#### Error Handling

- **T-LOOP-20**: Script exits with code 1 → loop stops immediately. loopx exits with code 1. *(Spec 7.2)*
- **T-LOOP-21**: Script exits with code 2 → same behavior (any non-zero is an error). *(Spec 7.2)*
- **T-LOOP-22**: Script fails on iteration 3 of 5 (`-n 5`). Assert exactly 3 iterations ran (loop stopped at failure). *(Spec 7.2)*
- **T-LOOP-23**: Script's stderr output on failure is visible on CLI stderr. *(Spec 7.2)*
- **T-LOOP-24**: Script's stdout on failure is NOT parsed as structured output. Use a script that prints `{"result":"should-not-appear","stop":true}` to stdout then exits 1. Observe via `run("myscript")`: the generator should throw on the failing iteration without yielding any `Output` for that iteration. If the JSON were parsed, it would yield a result and halt cleanly — the throw with no yield proves it was not parsed. *(Spec 7.2)*

#### Final Iteration Output

- **T-LOOP-25**: `-n 2` with script producing `{"result":"iter-N"}`. Both iterations' outputs are observable via programmatic API. Verify programmatic API yields both. *(Spec 7.1)*

### 4.7 Environment Variables

**Spec refs:** 8.1–8.3

All env tests use `withGlobalEnv` to isolate from the real user config.

#### Global Env File

- **T-ENV-01**: Variable set via `loopx env set` is available in a script. Use `write-env-to-file` fixture: the script writes `$VAR_NAME` to a marker file. Assert the marker file contains the expected value. *(Spec 8.1, 8.3)*
- **T-ENV-02**: Variable removed via `loopx env remove` is no longer available in scripts. Use `observe-env` fixture: the script writes JSON to a marker file. Assert the marker file contains `{ "present": false }` (variable truly unset, not merely empty). *(Spec 8.1)*
- **T-ENV-03**: `XDG_CONFIG_HOME` is respected. Set `XDG_CONFIG_HOME=/tmp/custom`, run `loopx env set X Y`, verify file exists at `/tmp/custom/loopx/env`. *(Spec 8.1)*
- **T-ENV-04**: When `XDG_CONFIG_HOME` is unset, default is `~/.config`. Use `withIsolatedHome` (not `withGlobalEnv`) to safely verify the fallback path without touching the real home directory. *(Spec 8.1)*
- **T-ENV-05**: Config directory created on first `env set`. Start with no directory, run `env set`, verify directory was created. *(Spec 8.1)*
- **T-ENV-05a**: Unreadable global env file. Create the global env file, then `chmod 000` it. Run `loopx run -n 1 myscript` → exits with code 1 and an error message about the unreadable file. **This test is conditional on `process.getuid() !== 0`** — root can read any file, so the test is skipped when running as root. *(Spec 8.1)*
- **T-ENV-05b**: Unreadable global env file via programmatic API. Same setup as T-ENV-05a (`chmod 000`). `run("myscript")` returns a generator; on the first `next()`, the generator throws an error about the unreadable file. **Conditional on `process.getuid() !== 0`.** *(Spec 8.1, 9.3)*
- **T-ENV-05c**: Unreadable global env file with `loopx env list`. Create the global env file with content, then `chmod 000`. Run `loopx env list` → exits with code 1 and an error message about the unreadable file. **Conditional on `process.getuid() !== 0`.** *(Spec 8.1)*
- **T-ENV-05d**: Unreadable global env file with `loopx env set`. Create the global env file with content, then `chmod 000`. Run `loopx env set KEY val` → exits with code 1 and an error message about the unreadable file. The `env set` command must read the existing file before writing (to preserve other entries), so an unreadable file is an error. **Conditional on `process.getuid() !== 0`.** *(Spec 8.1)*
- **T-ENV-05e**: Unreadable global env file with `loopx env remove`. Create the global env file with content, then `chmod 000`. Run `loopx env remove KEY` → exits with code 1 and an error message about the unreadable file. The `env remove` command must read the existing file to remove a key, so an unreadable file is an error. **Conditional on `process.getuid() !== 0`.** *(Spec 8.1)*

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
- **T-ENV-15a**: `writeEnvFileRaw(path, "KEY=\n")`. Empty value. Use `observe-env` fixture: assert marker contains `{ "present": true, "value": "" }` — the variable is present with an empty string value, not absent. *(Spec 8.1)*
- **T-ENV-15b**: `writeEnvFileRaw(path, "KEY=a=b=c\n")`. Multiple `=`. Script sees `KEY` with value `a=b=c` (split on first `=`). *(Spec 8.1)*
- **T-ENV-15c**: `writeEnvFileRaw(path, "1BAD=val\n")`. Invalid key (starts with digit). Line ignored with warning to stderr. Use `observe-env` fixture with varname `1BAD`: assert marker contains `{ "present": false }` — confirming the variable is truly unset. *(Spec 8.1)*
- **T-ENV-15d**: `writeEnvFileRaw(path, "justtext\n")`. Malformed non-comment line without `=`. Line ignored with warning to stderr. *(Spec 8.1)*
- **T-ENV-15e**: `writeEnvFileRaw(path, 'KEY="hello\n')`. Unmatched quotes: opening double quote, no closing. "Wrapped" requires both opening and closing quotes of the same type — an unmatched quote is not wrapping, so the literal value `"hello` (including the quote character) is preserved. *(Spec 8.1)*

#### Local Env Override (`-e`)

- **T-ENV-16**: `-e local.env` loads variables into script environment. Script writes the env var to a marker file. Assert marker file contains the expected value. *(Spec 8.2)*
- **T-ENV-17**: `-e nonexistent.env` → error, exit 1. *(Spec 8.2)*
- **T-ENV-17a**: `-e unreadable.env` → error, exit 1. Create a local env file, then `chmod 000` it. Run `loopx run -e unreadable.env -n 1 myscript` → exits with code 1 and an error message. Behavior is identical to an unreadable global env file (Spec 8.1). **This test is conditional on `process.getuid() !== 0`.** *(Spec 8.2)*
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
- **T-ENV-24a**: `LOOPX_DELEGATED` is not visible in script execution environments. Spawn loopx with `LOOPX_DELEGATED=1` in the process environment (simulating post-delegation state). A script uses the `observe-env` fixture to write the presence/value of `LOOPX_DELEGATED` to a marker file. Assert the marker file contains `{ "present": false }`. The spec (section 8.3) exhaustively lists the loopx-injected variables as `LOOPX_BIN` and `LOOPX_PROJECT_ROOT` — `LOOPX_DELEGATED` is an internal delegation guard (section 3.2) and must not leak into script environments. *(Spec 8.3, 3.2)*
- **T-ENV-24b**: Empty-string value in local env file overrides non-empty global/system value. System env has `MY_VAR=system`, global env has `MY_VAR=global`, local env file sets `MY_VAR=` (empty string). Script writes `$MY_VAR` to a marker file via `observe-env`. Assert marker contains `{ "present": true, "value": "" }` — the local empty string wins, not the global or system value. This verifies that the env merge logic uses nullish coalescing (not logical OR), preserving empty strings as valid values per the precedence chain. *(Spec 8.3)*

#### Env Caching

- **T-ENV-25**: During a multi-iteration loop, modify the global env file between iterations (use a script that rewrites the env file as a side effect on iteration 1). On iteration 2, a different script writes `$VAR` to a marker file. Assert the marker contains the original value (env loaded once at start, not re-read). *(Spec 8.1)*
- **T-ENV-25a**: During a multi-iteration loop with `-e local.env`, modify `local.env` between iterations (use a script that rewrites the local env file as a side effect on iteration 1). On iteration 2, a different script writes `$VAR` to a marker file via `observe-env`. Assert the marker contains the original value (local env file loaded once at start, not re-read per iteration). *(Spec 8.2)*

### 4.8 Module Resolution & Script Helpers

**Spec refs:** 3.3, 3.4, 6.5, 6.6

#### `import from "loopx"` Resolution

- **T-MOD-01**: A TS script with `import { output } from "loopx"` runs successfully under Node.js. The script calls `output({ result: "resolved" })`. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "resolved"`. `[Node]` *(Spec 3.3)*
- **T-MOD-02**: Same import works under Bun. The script calls `output({ result: "resolved" })`. Observe via `runAPIDriver("bun", ...)`: yielded Output has `result: "resolved"`. `[Bun]` *(Spec 3.3)*
- **T-MOD-03**: A JS script with `import { output } from "loopx"` also works. The script calls `output({ result: "resolved" })`. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "resolved"`. *(Spec 3.3)*
- **T-MOD-03a**: A directory script that has its own `node_modules/loopx` (a different version) resolves `import from "loopx"` to the **local** package, not the running CLI's package. Standard module resolution applies — the closest `node_modules` wins. The local shadow package exports an `output()` function that writes a distinctive marker to a marker file before writing JSON to stdout. The test asserts that the shadow's marker file **exists** (proving the local package was resolved). This verifies the spec's "standard module resolution applies" behavior (Spec 2.1, 3.3). *(Spec 3.3, 2.1)*

#### `output()` Function

These tests observe `output()` behavior via the programmatic API (`run()` / `runPromise()`) or side-effect files — not by inspecting CLI stdout, because the CLI never prints `result` to its own stdout (Spec 7.1).

- **T-MOD-04**: Script uses `output({ result: "hello" })`. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "hello"`. *(Spec 6.5)*
- **T-MOD-05**: Script uses `output({ result: "x", goto: "y" })`. Observe via `run("myscript")`: yielded Output has both `result: "x"` and `goto: "y"`, and loopx transitions to script `y`. *(Spec 6.5)*
- **T-MOD-06**: Script uses `output({ stop: true })`. Observe via `runPromise("myscript")`: loop completes after one iteration, yielded Output has `stop: true`. *(Spec 6.5)*
- **T-MOD-07**: Script uses `output({})` (no known fields). Script crashes with non-zero exit code. `runPromise("myscript")` rejects. *(Spec 6.5)*
- **T-MOD-08**: Script uses `output(null)`. Script crashes with non-zero exit code. *(Spec 6.5)*
- **T-MOD-09**: Script uses `output(undefined)`. Script crashes with non-zero exit code. *(Spec 6.5)*
- **T-MOD-10**: Script uses `output("string")`. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "string"`. *(Spec 6.5)*
- **T-MOD-11**: Script uses `output(42)`. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "42"`. *(Spec 6.5)*
- **T-MOD-12**: Script uses `output(true)`. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "true"`. *(Spec 6.5)*
- **T-MOD-13**: Script uses `output({ result: "x", goto: undefined })`. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "x"` and no `goto` property. *(Spec 6.5)*
- **T-MOD-13a**: Script uses `output([1, 2, 3])` (array, no known fields). Script crashes with non-zero exit code. *(Spec 6.5)*
- **T-MOD-13c**: Script uses `output({ foo: "bar" })` (object with no known fields — `foo` is not `result`, `goto`, or `stop`). Script crashes with non-zero exit code. This is distinct from T-MOD-07 (`output({})`) — it verifies that an object must have at least one *known* field, not just any field. *(Spec 6.5)*
- **T-MOD-13b**: Script uses `output({ result: undefined, goto: undefined, stop: undefined })`. All known fields are `undefined`, which are omitted during JSON serialization — equivalent to `output({})`. Script crashes with non-zero exit code (no known fields with defined values). *(Spec 6.5)*
- **T-MOD-13d**: Script uses `output({ stop: false })`. The `stop` field has a defined value (`false`), which is a known field — so `output()` accepts the object (it has at least one known field with a defined value). The emitted JSON `{"stop":false}` is then parsed by the loop engine, where `stop` must be exactly `true` (boolean) to take effect. Observe via `runPromise("myscript", { maxIterations: 2 })`: the first yielded Output is `{}` (the `stop: false` is discarded during parsing), and the loop continues to a second iteration rather than halting. *(Spec 6.5, 2.3)*
- **T-MOD-13e**: Script uses `output({ goto: 42 })`. The `goto` field has a defined value (`42`), which is a known field — so `output()` accepts the object. The emitted JSON `{"goto":42}` is then parsed by the loop engine, where `goto` must be a string. Observe via `runPromise("myscript", { maxIterations: 2 })`: the first yielded Output is `{}` (the non-string `goto` is discarded during parsing), and the loop resets to the starting target rather than transitioning. *(Spec 6.5, 2.3)*
- **T-MOD-13f**: Script uses `output({ result: null })`. The `result` field has a defined value (`null`), which is a known field — so `output()` accepts the object. The emitted JSON `{"result":null}` is then parsed by the loop engine, where non-string `result` is coerced via `String()`. Observe via `runPromise("myscript", { maxIterations: 1 })`: yielded Output has `result: "null"`. *(Spec 6.5, 2.3)*
- **T-MOD-13g**: Script uses `output({ goto: null })`. The `goto` field has a defined value (`null`), which is a known field — so `output()` accepts the object. The emitted JSON `{"goto":null}` is then parsed by the loop engine, where `goto` must be a string. Observe via `runPromise("myscript", { maxIterations: 2 })`: the first yielded Output is `{}` (the null `goto` is discarded during parsing), and the loop resets to the starting target. *(Spec 6.5, 2.3)*
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
- **T-MOD-21**: Bash script runs `$LOOPX_BIN version` and captures its stdout to a marker file. Assert the marker file content (trimmed) matches loopx's own `package.json` `version` field. *(Spec 3.4)*

### 4.9 Programmatic API

**Spec refs:** 9.1–9.5

**Runtime-matrix methodology:** All programmatic API tests that run under both Node.js and Bun use `runAPIDriver()` to spawn a driver process under the target runtime. This is the correct way to test API behavior under Bun — importing loopx directly inside a Node-hosted Vitest process does not exercise Bun's runtime. Node-only direct-import tests may exist as supplementary smoke tests, but they do not substitute for `runAPIDriver()`-based coverage in the runtime matrix.

#### `run()` (AsyncGenerator)

- **T-API-01**: `run("myscript")` returns an async generator. Calling `next()` yields an `Output` object. *(Spec 9.1)*
- **T-API-02**: Generator yields one `Output` per iteration. With `maxIterations: 3`, collect all yields → array of 3 outputs. *(Spec 9.1)*
- **T-API-03**: Generator completes (returns `{ done: true }`) when script outputs `stop: true`. *(Spec 9.1)*
- **T-API-04**: Generator completes when `maxIterations` is reached. *(Spec 9.1)*
- **T-API-05**: The output from the final iteration is yielded before the generator completes. *(Spec 9.1)*
- **T-API-06**: Breaking out of `for await` loop after the first yield prevents further iterations from starting. Setup: script produces a result (no `stop`) on each iteration, with `maxIterations: 10`. Break after receiving the first yield. Assert: no additional iterations execute (use a counter file — counter should be exactly 1). *(Spec 9.1)*
- **T-API-07**: `run("myscript", { cwd: "/path/to/project" })` resolves scripts relative to the given cwd. *(Spec 9.5)*
- **T-API-08**: `run("myscript", { maxIterations: 0 })` → generator completes immediately with no yields. *(Spec 9.5)*
- **T-API-08a**: `run("nonexistent", { maxIterations: 0 })` → `run()` returns a generator. On the first `next()`, the generator throws because the script does not exist. Even with `maxIterations: 0`, validation (discovery, script resolution, env file loading) runs before the zero-iteration short-circuit. This mirrors CLI `-n 0` behavior (T-CLI-19). *(Spec 9.1, 9.5, 7.1)*

#### `run()` with Invalid `scriptName`

`scriptName` is a required parameter. In TypeScript, omitting it is a static type error. In JavaScript, or when the type check is bypassed, runtime-invalid `scriptName` values are rejected lazily.

- **T-API-09**: `run(undefined as any)` returns a generator without throwing. On the first `next()`, the generator throws an error (invalid scriptName). No child process is spawned. *(Spec 9.1)*
- **T-API-20h**: `run(null as any)` returns a generator without throwing. On the first `next()`, the generator throws (invalid scriptName). *(Spec 9.1)*
- **T-API-20i**: `run(42 as any)` returns a generator without throwing. On the first `next()`, the generator throws (non-string scriptName). *(Spec 9.1)*

#### `run()` Snapshot & Cancellation

- **T-API-09b**: `run()` cwd snapshot timing. Create two temp projects, each with a script named `myscript` that writes a unique marker. Call `run("myscript")` while `process.cwd()` is project A (no explicit `cwd` option). Then change `process.cwd()` to project B before calling `next()`. Assert the generator executes project A's script, not project B's — proving `cwd` was snapshotted at `run()` call time. *(Spec 9.1, 9.5)*
- **T-API-09a**: Manual iterator cancellation during a pending `next()`. Use the `write-pid-to-file` fixture (a TS script that writes its PID to a marker file, writes `"ready"` to stderr, then blocks). Obtain the async iterator, call `iterator.next()` to start the first iteration. Wait for the child to be ready (e.g., poll the marker file or observe stderr). Then call `iterator.return()` while `next()` is still pending. Assert: (1) the child process / process group is terminated (read PID from marker file, verify it is no longer running), and (2) the generator completes with no further yields. *(Spec 9.1)*
- **T-API-09c**: `run()` options snapshot — mutating `maxIterations` after call. Create a `RunOptions` object with `maxIterations: 2`. Call `run("myscript", opts)` to obtain the generator. Then mutate `opts.maxIterations = 100`. Iterate the generator to completion. Assert exactly 2 outputs are yielded — proving the options were snapshotted at `run()` call time and the mutation had no effect. *(Spec 9.1)*

#### `run()` with AbortSignal

- **T-API-10**: `run("myscript", { signal })` — aborting the signal terminates the loop and the generator throws an abort error. *(Spec 9.5)*
- **T-API-10a**: `run("myscript", { signal })` — aborting the signal while a child process is actively running terminates the child process group. Use the `write-pid-to-file` fixture. Wait for the child to write its PID to the marker file and emit `"ready"` on stderr. Abort the signal. Assert: (1) the generator throws an abort error, and (2) the PID from the marker file is no longer running. *(Spec 9.5, 9.1)*
- **T-API-10b**: Pre-aborted signal. Create an `AbortController`, call `controller.abort()` immediately, then call `run("myscript", { signal: controller.signal })`. On the first `next()`, the generator throws an abort error. No child process is spawned (use a counter file to verify no script ran). *(Spec 9.5, 9.1)*
- **T-API-10c**: Signal aborted between iterations (no active child). Use a script that emits a result with no `goto` (loop resets). Collect the first yield, then abort the signal before calling `next()` again. The next `next()` call throws an abort error. No further iterations execute. *(Spec 9.5, 9.1)*

#### `runPromise()`

- **T-API-11**: `runPromise("myscript", { maxIterations: 3 })` resolves with an array of 3 `Output` objects. *(Spec 9.2)*
- **T-API-12**: `runPromise("myscript")` resolves when `stop: true` is output. *(Spec 9.2)*
- **T-API-13**: `runPromise("myscript")` rejects when a script exits non-zero. *(Spec 9.3)*
- **T-API-14**: `runPromise("myscript", { maxIterations: 3, envFile: "local.env", cwd: project.dir })` resolves with correct outputs using all option fields. The env file variable is visible to the script (via marker file), `cwd` is respected (script runs in the correct project), and exactly 3 iterations are collected. *(Spec 9.2, 9.5)*

#### `runPromise()` with Invalid `scriptName`

- **T-API-14a**: `runPromise(undefined as any)` returns a rejected promise (not a synchronous throw). The call itself always returns a promise, and the validation error surfaces as a rejection. *(Spec 9.2)*
- **T-API-14a2**: `runPromise(null as any)` returns a rejected promise. *(Spec 9.2)*
- **T-API-14a3**: `runPromise(42 as any)` returns a rejected promise. *(Spec 9.2)*

#### `runPromise()` Snapshot & Options

- **T-API-14b**: `runPromise("myscript", { maxIterations: 0 })` resolves with an empty array `[]`. *(Spec 9.2, 9.5)*
- **T-API-14c**: `runPromise()` cwd snapshot timing. Create two temp projects, each with a script named `myscript` that writes a unique marker. Call `runPromise("myscript")` while `process.cwd()` is project A (no explicit `cwd` option). Change `process.cwd()` to project B before the promise resolves. Assert the promise resolves with outputs from project A's script, not project B's — proving `cwd` was snapshotted at `runPromise()` call time. *(Spec 9.2, 9.5)*
- **T-API-14d**: `runPromise()` options snapshot — mutating `maxIterations` after call. Create a `RunOptions` object with `maxIterations: 2`. Call `runPromise("myscript", opts)` to obtain the promise. Then mutate `opts.maxIterations = 100`. Await the promise. Assert exactly 2 outputs are returned — proving the options were snapshotted at `runPromise()` call time. *(Spec 9.2, 9.1)*
- **T-API-14e**: `runPromise("nonexistent", { maxIterations: 0 })` rejects because the script does not exist. Even with `maxIterations: 0`, validation (discovery, script resolution) runs before the zero-iteration short-circuit. This mirrors CLI `-n 0` behavior (T-CLI-19). *(Spec 9.2, 9.5, 7.1)*

#### Error Behavior

- **T-API-15**: Programmatic API never prints `result` to stdout. Use `runAPIDriver()` to spawn a driver process that calls `run("myscript")` and collects outputs. Assert the driver's stdout contains only the driver's own JSON output — no `result` values from scripts leak to stdout. *(Spec 9.3)*
- **T-API-16**: Non-zero script exit causes `run("myscript")` generator to throw. *(Spec 9.3)*
- **T-API-17**: Invalid goto target causes `run("myscript")` generator to throw. *(Spec 9.3)*
- **T-API-18**: Script stderr is forwarded to the calling process's stderr. *(Spec 9.3)*
- **T-API-19**: When `run("myscript")` throws, previously yielded outputs are preserved (the caller already consumed them). Test: collect outputs in an array, handle the throw, verify array has the partial results. *(Spec 9.3)*
- ~~**T-API-20**~~: *Removed.* "Partial outputs are not available" from `runPromise()` rejection is not meaningfully observable beyond the promise rejecting. The relevant surface is already covered by T-API-13 (rejection on non-zero exit), T-API-15 (no stdout leakage), and T-API-19 (partial outputs preserved with `run()`). *(Spec 9.3)*
- **T-API-20a**: `run("nonexistent")` — `run()` returns a generator without throwing. On the first `next()`, the generator throws because the script does not exist. No child process is spawned (use a counter file in `.loopx/` to verify no script ran). *(Spec 9.1, 9.3)*
- **T-API-20b**: `runPromise("nonexistent")` — rejects because the script does not exist. *(Spec 9.3)*
- **T-API-20c**: `run("myscript")` with `.loopx/` containing a name collision — `run()` returns a generator. On the first `next()`, the generator throws (validation failure). No child process is spawned. *(Spec 9.1, 9.3)*
- **T-API-20d**: `run("myscript", { envFile: "nonexistent.env" })` — `run()` returns a generator. On the first `next()`, the generator throws because the env file does not exist. No child process is spawned. *(Spec 9.1, 9.3, 9.5)*
- **T-API-20e**: `runPromise("myscript", { envFile: "nonexistent.env" })` — rejects because the env file does not exist. *(Spec 9.3, 9.5)*
- **T-API-20f**: `run("myscript", { cwd: dirWithoutLoopx })` — `run()` returns a generator without throwing. On the first `next()`, the generator throws because `.loopx/` does not exist in the specified `cwd`. *(Spec 9.1, 9.3)*
- **T-API-20g**: `runPromise("myscript", { cwd: dirWithoutLoopx })` — rejects because `.loopx/` does not exist. *(Spec 9.3)*

#### `envFile` Option

- **T-API-21**: `run("myscript", { envFile: "local.env" })` loads the env file. Script sees the variables. *(Spec 9.5)*
- **T-API-21a**: `run("myscript", { envFile: "relative/path.env", cwd: "/some/dir" })` — relative envFile path is resolved against the provided `cwd`. *(Spec 9.5)*
- **T-API-21b**: `run("myscript", { envFile: "relative/path.env" })` with no `cwd` option — relative envFile path is resolved against `process.cwd()` at call time. Set up a temp project, place the env file at a relative path from `process.cwd()`, and verify the script sees the variables. *(Spec 9.5)*
- **T-API-21c**: Env file parse warnings are forwarded to stderr via the programmatic API. Use `runAPIDriver()` to spawn a driver that calls `run("myscript", { envFile: "local.env" })` where `local.env` contains a malformed line (e.g., `justtext` with no `=`). Assert the driver process's stderr contains a warning about the invalid line. This verifies that local env parse warnings reach stderr in the programmatic API path, not just the CLI path. *(Spec 8.1, 9.3)*
- **T-API-21d**: Global env file parse warnings are forwarded to stderr via the programmatic API. Set up `XDG_CONFIG_HOME` to a temp directory with a global env file containing a malformed line (e.g., `1BAD=val`). Use `runAPIDriver()` to call `run("myscript")`. Assert the driver process's stderr contains a warning about the invalid key. *(Spec 8.1, 9.3)*

#### `maxIterations` Validation

- **T-API-22**: `run("myscript", { maxIterations: -1 })` → `run()` returns a generator. On the first `next()`, the generator throws (non-negative integer required). No script is executed. *(Spec 9.1, 9.5)*
- **T-API-23**: `run("myscript", { maxIterations: 1.5 })` → `run()` returns a generator. On the first `next()`, the generator throws (non-integer). No script is executed. *(Spec 9.1, 9.5)*
- **T-API-23a**: `run("myscript", { maxIterations: NaN })` → `run()` returns a generator. On the first `next()`, the generator throws (NaN is not a valid non-negative integer). No script is executed. *(Spec 9.1, 9.5)*
- **T-API-24**: `runPromise("myscript", { maxIterations: NaN })` → rejects before execution. *(Spec 9.5)*
- **T-API-24a**: `runPromise("myscript", { maxIterations: -1 })` → rejects before execution (negative values are invalid). *(Spec 9.5)*
- **T-API-24b**: `runPromise("myscript", { maxIterations: 1.5 })` → rejects before execution (non-integer values are invalid). *(Spec 9.5)*

#### `runPromise()` with AbortSignal

- **T-API-25**: `runPromise("myscript", { signal })` — aborting the signal terminates the loop and the promise rejects with an abort error. *(Spec 9.5)*
- **T-API-25a**: `runPromise("myscript", { signal })` with pre-aborted signal — the promise rejects immediately with an abort error. No child process is spawned. *(Spec 9.5)*
- **T-API-25b**: `runPromise("myscript", { signal, maxIterations: 3 })` — abort signal between iterations. Use a script that completes quickly (no `goto`, no `stop`). Set up the `AbortController` and abort the signal after a short delay (enough for one iteration to complete but before the loop finishes all 3). Assert the promise rejects with an abort error. Since `runPromise` is an all-or-nothing API, the rejection occurs even though some iterations completed internally. *(Spec 9.5, 9.2)*

### 4.10 Install Command

**Spec refs:** 10.1–10.3

All install tests use local servers (HTTP, file:// git repos). No network access.

#### Source Detection

- **T-INST-01**: `loopx install myorg/my-script` is treated as a git source (github shorthand). Expands to `https://github.com/myorg/my-script.git`. Verify by using `withGitURLRewrite` to redirect `https://github.com/myorg/my-script.git` to a local bare repo, and asserting that the repo is cloned into `.loopx/my-script/`. *(Spec 10.1)*
- **T-INST-01a**: `loopx install myorg/my-script.git` → error, exit code 1. The `<repo>` segment of the shorthand must not end in `.git`. Users who want a `.git` URL must provide the full URL. *(Spec 10.1)*
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
- **T-INST-08d**: `loopx install http://localhost:PORT/pkg.tar.gz?token=abc` → treated as tarball. Source detection operates on the URL pathname (ignoring query string), so the pathname `/pkg.tar.gz` is recognized as a tarball by its `.tar.gz` extension. *(Spec 10.1)*

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
- **T-INST-21**: Successful git install → directory script is runnable via `loopx run -n 1 <name>`. *(Spec 10.2)*

#### Tarball Install

- **T-INST-22**: Downloading and extracting a `.tar.gz` file places contents in `.loopx/<archive-name>/`. *(Spec 10.2)*
- **T-INST-23**: Single top-level directory in archive → that directory becomes the package root (unwrapped). *(Spec 10.2)*
- **T-INST-24**: Multiple top-level entries in archive → placed directly in `.loopx/<archive-name>/`. *(Spec 10.2)*
- **T-INST-25**: `.tgz` extension handled identically. *(Spec 10.2)*
- **T-INST-26**: Extracted directory must have `package.json` with `main`. If not → directory removed, error. *(Spec 10.2)*
- **T-INST-26a**: Tarball URL with query string (e.g., `http://localhost:PORT/pkg.tar.gz?token=abc`) → query stripped from archive-name derivation. Installed directory is `.loopx/pkg/`, not `.loopx/pkg.tar.gz?token=abc/`. *(Spec 10.2)*
- **T-INST-26b**: Tarball URL with fragment (e.g., `http://localhost:PORT/pkg.tgz#v1`) → fragment stripped from archive-name. *(Spec 10.2)*

#### Common Rules

- **T-INST-27**: Destination-path collision. Installing when a filesystem entry already exists at the exact destination path → error, existing entry untouched. Example: `.loopx/foo.ts` exists, install a single-file URL that would also place `foo.ts` → rejected. *(Spec 10.3)*
- **T-INST-27a**: Destination-path collision with non-script directory. Installing when a non-script directory with the same name already exists in `.loopx/` (e.g., `.loopx/foo/` exists as a shared utility directory with no `package.json`, install a git repo that would go to `.loopx/foo/`) → error, existing directory untouched. *(Spec 10.3)*
- **T-INST-27b**: Script-name collision across different path types. `.loopx/foo.sh` exists (file script named `foo`), install a git repo that would clone to `.loopx/foo/` — different destination path, but same derived script name `foo`. → error, existing script untouched, no `.loopx/foo/` directory created. *(Spec 10.3, 5.2)*
- **T-INST-27c**: Script-name collision across different file extensions. `.loopx/foo.ts` exists (file script named `foo`), install a single-file URL for `foo.sh` → error. Both resolve to script name `foo`. The existing `.loopx/foo.ts` is untouched and no `.loopx/foo.sh` is created. *(Spec 10.3, 5.2)*
- **T-INST-27d**: Script-name collision when target name already has a pre-existing collision in `.loopx/`. Setup: `.loopx/foo.sh` and `.loopx/foo.ts` both exist (pre-existing name collision on `foo`). Attempt to install a git repo that would clone to `.loopx/foo/`. Assert: exit code 1, error on stderr mentioning name collision, no `.loopx/foo/` directory created, both `.loopx/foo.sh` and `.loopx/foo.ts` untouched. This is distinct from T-INST-27b/27c: those test single-entry collisions where the name is in the scripts map; this tests that install detects the name even when it is already involved in a pre-existing collision (and therefore excluded from the scripts map during discovery). *(Spec 10.3, 5.2)*
- **T-INST-28**: Installing a script named after a former reserved name succeeds. Parameterized across all former reserved names and the `run` built-in subcommand name: `output.ts`, `env.ts`, `install.ts`, `version.ts`, and `run.ts`. For each name, serve the file via the local HTTP server, run `loopx install <url>`, and assert: exit code 0, the script is placed in `.loopx/`, and `loopx run -n 1 <name>` executes it successfully (assert via marker file). Reserved names no longer exist — all names that pass name restriction rules (section 5.3) are allowed, and scripts are always invoked via `loopx run <name>` so there is no ambiguity with built-in subcommands. *(Spec 10.3, 5.3)*
- **T-INST-29**: Installing a script with invalid name (e.g., `-invalid.ts`) → error, nothing saved. *(Spec 10.3)*
- **T-INST-30**: No automatic `npm install` / `bun install` after clone/extract. Verify `node_modules/` does not appear in installed directory script. *(Spec 10.3)*
- **T-INST-31**: HTTP 404 during single-file download → error, exit code 1, no partial file left in `.loopx/`. *(Spec 10.3)*
- **T-INST-31b**: Single-file install write failure cleans up partial file. Serve a valid `.ts` file via the local HTTP server, then make `.loopx/` directory read-only (`chmod 0o555`) before running install so the download succeeds but `writeFileSync` fails. Assert: exit code 1, error on stderr, no partial file left at the destination path in `.loopx/`. **This test is conditional on `process.getuid() !== 0`** — root can write to any directory. *(Spec 10.3)*
- **T-INST-32**: Git clone failure (non-existent repo) → error, exit code 1, no partial directory left in `.loopx/`. *(Spec 10.3)*
- **T-INST-33**: Tarball extraction failure (corrupt archive) → error, exit code 1, no partial directory left in `.loopx/`. *(Spec 10.3)*
- **T-INST-33a**: Empty tarball (valid `.tar.gz` with no entries). Serve a valid but empty tarball via the local HTTP server. `loopx install <url>` → exit code 1, stderr contains error about the empty archive, no partial directory left in `.loopx/`. An empty tarball is an extraction failure — it produces zero usable entries. *(Spec 10.3)*

#### Install Post-Validation (Directory Scripts)

These tests verify that git/tarball installs apply the same validation as discovery (Spec 5.1) to the resulting directory.

- **T-INST-34**: Git install where cloned repo has invalid JSON in `package.json` → clone removed, error, exit code 1, no partial directory left in `.loopx/`. *(Spec 10.2, 5.1)*
- **T-INST-35**: Git install where cloned repo has `package.json` with non-string `main` (e.g., `{"main": 42}`) → clone removed, error, exit code 1. *(Spec 10.2, 5.1)*
- **T-INST-36**: Git install where cloned repo has `package.json` with `main` escaping the directory (e.g., `{"main": "../escape.ts"}`) → clone removed, error, exit code 1. *(Spec 10.2, 5.1)*
- **T-INST-37**: Git install where cloned repo has `package.json` with `main` pointing to a file that does not exist → clone removed, error, exit code 1. *(Spec 10.2, 5.1)*
- **T-INST-38**: Tarball install where extracted directory has invalid JSON in `package.json` → directory removed, error, exit code 1. *(Spec 10.2, 5.1)*
- **T-INST-39**: Tarball install where extracted directory has `package.json` with `main` pointing to a missing file → directory removed, error, exit code 1. *(Spec 10.2, 5.1)*
- **T-INST-39a**: Tarball install where extracted directory has `package.json` with non-string `main` (e.g., `{"main": 42}`) → directory removed, error, exit code 1. *(Spec 10.2, 5.1)*
- **T-INST-39b**: Tarball install where extracted directory has `package.json` with `main` escaping the directory (e.g., `{"main": "../escape.ts"}`) → directory removed, error, exit code 1. *(Spec 10.2, 5.1)*
- **T-INST-39c**: Tarball install where extracted directory has `package.json` with `main` pointing to unsupported extension (e.g., `{"main": "index.py"}`) → directory removed, error, exit code 1. *(Spec 10.2, 5.1)*
- **T-INST-39d**: Git install where cloned repo has `package.json` with `main` pointing to a symlink that resolves outside the directory boundary (e.g., `entry.ts` is a symlink to `../../outside.ts`). Assert: exit code 1, error on stderr referencing the symlink/boundary violation, clone is fully removed from `.loopx/`. Install post-validation must apply the same symlink boundary check as discovery (Spec 5.1: "must still resolve to a path within the script's directory after symlink resolution"). *(Spec 10.2, 5.1)*
- **T-INST-39e**: Tarball install where extracted directory has `package.json` with `main` pointing to a symlink that resolves outside the directory boundary. Same assertions as T-INST-39d but for tarball installs: exit code 1, error on stderr, extracted directory removed. *(Spec 10.2, 5.1)*

#### Global Install Smoke Test

- **T-INST-GLOBAL-01**: Full global install lifecycle. `npm pack` the built loopx package, install the resulting tarball into an isolated global prefix (using `npm install -g --prefix <tempdir>`), create a fixture project with a `.loopx/myscript.ts` script, run `<tempdir>/bin/loopx run -n 1 myscript` against the fixture project, and assert the script ran (via marker file) and exit code is 0. This exercises the full Spec 3.1 workflow: global binary on PATH, module resolution for `import from "loopx"`, and script execution. *(Spec 3.1)*
- **T-INST-GLOBAL-01a**: `[Bun]` Full global install lifecycle under Bun. Same workflow as T-INST-GLOBAL-01 but the fixture script is run via Bun: install globally, create a fixture project with a `.loopx/myscript.ts` script that uses `import { output } from "loopx"`, invoke the global `loopx` binary under Bun (`bun <global-bin>/loopx run -n 1 myscript`). Assert the script ran (via marker file) and `import from "loopx"` resolved correctly. This exercises the `NODE_PATH`-based module resolution path that Bun uses for global installs (Spec 3.3). *(Spec 3.1, 3.3)*

### 4.11 Signal Handling

**Spec refs:** 7.3

Signal tests use the `signal-ready-then-sleep`, `signal-trap-exit`, `signal-trap-ignore`, and `spawn-grandchild` fixtures. All signal fixtures follow the ready-protocol: write PID to marker file, write `"ready"` to stderr, then block. Tests use `waitForStderr("ready")` to synchronize before sending signals.

- **T-SIG-01**: Send SIGINT to loopx while a script is running. Use `signal-ready-then-sleep` fixture. `waitForStderr("ready")`, then send SIGINT. Assert loopx exits with code 130 (128 + 2). *(Spec 7.3)*
- **T-SIG-02**: Send SIGTERM to loopx while a script is running. Use `signal-ready-then-sleep` fixture. `waitForStderr("ready")`, then send SIGTERM. Assert loopx exits with code 143 (128 + 15). *(Spec 7.3)*
- **T-SIG-03**: After SIGINT, the child script process is no longer running. Use `signal-ready-then-sleep` fixture which writes PID to marker file. After loopx exits, read the PID from the marker file and verify the process is gone (e.g., `kill(pid, 0)` throws). *(Spec 7.3)*
- **T-SIG-04**: Grace period: child script traps SIGTERM and exits within 2 seconds. Use `signal-trap-exit(markerPath, 2)` fixture. `waitForStderr("ready")`, send SIGTERM. Assert loopx exits with code 128+15 (no SIGKILL needed — child exited within grace period). *(Spec 7.3)*
- **T-SIG-05**: Grace period exceeded: child script traps SIGTERM and hangs (ignores it). Use `signal-trap-ignore(markerPath)` fixture. `waitForStderr("ready")`, send SIGTERM. Assert loopx sends SIGKILL after ~5 seconds and exits. Verify the child PID (from marker file) is no longer running. *(Spec 7.3)*
- **T-SIG-06**: Process group signal: script spawns a grandchild process. Use `spawn-grandchild(markerPath)` fixture. `waitForStderr("ready")`, send SIGTERM to loopx. Read both PIDs from marker file. Assert both the script and grandchild are no longer running after loopx exits. *(Spec 7.3)*
- **T-SIG-07**: Between-iterations signal: Use a script that outputs no `goto` or `stop` (so the loop resets) and writes a ready marker to a known file after each iteration. The test sends SIGTERM between iterations by coordinating via the marker file. Assert loopx exits immediately with code 143 (128 + 15). This test may require a small sleep or poll to hit the between-iterations window, so it is tagged as `@flaky-retry(3)` to tolerate occasional timing misses. *(Spec 7.3)*
- **T-SIG-08**: The child process receives the same signal that was sent to loopx (forwarding preserves signal identity). Use a bash fixture that traps both SIGINT and SIGTERM separately: `trap 'printf SIGINT > $MARKER' INT; trap 'printf SIGTERM > $MARKER' TERM`. The script writes its PID to a separate marker file and emits `"ready"` to stderr, then sleeps. (a) Send SIGINT to loopx. Read the signal marker file. Assert it contains `"SIGINT"`. (b) Repeat with SIGTERM and assert `"SIGTERM"`. This ensures loopx forwards the *original* signal to the child process group, not a generic SIGTERM for all cases. *(Spec 7.3)*

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
- **T-DEL-06**: After delegation, `import from "loopx"` in scripts resolves to the **local (delegated-to) version's** package, not the global version. The local version must be **observably distinct** — e.g., it includes an additional non-standard export (like `__loopxVersion`) or writes a distinctive marker during module initialization. A TS script imports from `"loopx"` and checks for the local version's marker. Assert that the script observes the local version's marker, not the global's. *(Spec 3.2)*
- **T-DEL-07**: Delegation sets `LOOPX_DELEGATED=1` in the delegated process. Use `withDelegationSetup`. The local binary is a script that writes `$LOOPX_DELEGATED` to a marker file via `observe-env`. Assert the marker file contains `{ "present": true, "value": "1" }`. This verifies the environment variable is actually received, not just that the recursion guard works. *(Spec 3.2)*
- **T-DEL-08**: Delegation happens before command handling. Use `withDelegationSetup`. Run the global binary with `version` as the argument. The local binary writes a marker file on invocation. Assert: (1) the marker file exists (proving the local binary was invoked), and (2) the local binary's version output is observed (not the global's). This verifies delegation occurs before the `version` subcommand is processed. *(Spec 3.2)*
- **T-DEL-09**: `LOOPX_DELEGATED=""` (empty string) in environment prevents delegation. The spec says delegation is skipped when `LOOPX_DELEGATED` is "set" — in POSIX semantics, an empty string is "set." Use `withDelegationSetup`, spawn the global binary with `env: { LOOPX_DELEGATED: "" }`. Assert the local binary's marker file does NOT exist (the global binary ran directly, delegation was skipped). *(Spec 3.2)*
- **T-DEL-10**: Delegation preserves SIGINT exit code. Use `withDelegationSetup` with a `.loopx/` fixture containing a `signal-ready-then-sleep` script. Spawn the global binary (which delegates to local). `waitForStderr("ready")`, then send SIGINT to the global binary process. Assert the global binary exits with code 130 (128 + 2). *(Spec 3.2, 7.3, 12)*
- **T-DEL-11**: Delegation preserves SIGTERM exit code. Same setup as T-DEL-10, but send SIGTERM instead. Assert the global binary exits with code 143 (128 + 15). *(Spec 3.2, 7.3, 12)*

### 4.13 Exit Codes (Cross-Cutting)

**Spec refs:** 12

These tests consolidate exit code assertions. Many are also verified in other sections, but this section ensures completeness. **Note:** T-EXIT-01 through T-EXIT-04 are redundant smoke checks — they overlap with stronger originating tests (T-LOOP-04, T-LOOP-07, T-CLI-15, T-CLI-01) and are expected to pass against the stub. They exist for cross-cutting traceability, not as primary contract tests.

- **T-EXIT-01**: Clean exit via `stop: true` → code 0. *(Spec 12)* *(Redundant with T-LOOP-04)*
- **T-EXIT-02**: Clean exit via `-n` limit reached → code 0. *(Spec 12)* *(Redundant with T-LOOP-07)*
- **T-EXIT-03**: Clean exit via `-n 0` → code 0. *(Spec 12)* *(Redundant with T-CLI-15)*
- **T-EXIT-04**: Successful subcommand (`loopx version`) → code 0. *(Spec 12)* *(Redundant with T-CLI-01)*
- **T-EXIT-05**: Script exits non-zero → code 1. *(Spec 12)*
- **T-EXIT-06**: Validation failure (name collision) → code 1. *(Spec 12)*
- **T-EXIT-07**: Invalid goto target → code 1. *(Spec 12)*
- **T-EXIT-08**: Missing script → code 1. *(Spec 12)*
- **T-EXIT-09**: Missing `.loopx/` directory (during `loopx run <script>`) → code 1. *(Spec 12)*
- **T-EXIT-10**: Usage error (invalid `-n`) → code 1. *(Spec 12)*
- **T-EXIT-11**: Missing `-e` file → code 1. *(Spec 12)*
- **T-EXIT-12**: SIGINT → code 130. *(Spec 12)*
- **T-EXIT-13**: SIGTERM → code 143. *(Spec 12)*
- **T-EXIT-14**: `loopx run` with no script name → code 1 (usage error). *(Spec 12)*
- **T-EXIT-15**: `loopx myscript` (unrecognized subcommand) → code 1 (usage error). *(Spec 12)*
- **T-EXIT-16**: `loopx --unknown` (unrecognized top-level flag) → code 1 (usage error). *(Spec 12)*

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

- **F-PARSE-05: Non-ASCII safe.** Stdout containing UTF-8 text with embedded NUL bytes, control characters (0x01–0x1F), and high Unicode (emoji, CJK, supplementary plane codepoints) does not cause crashes or hangs. This property does not test arbitrary binary byte sequences — the spec does not define encoding behavior for non-UTF-8 content.

#### Methodology

For each generated input:
1. Write a **JS/TS script** (not bash `echo`) that reads the test payload from a file and writes it to stdout using `process.stdout.write()`. This safely handles arbitrary strings including control characters and null bytes, which shell `echo` cannot represent reliably.
2. Set up a two-script chain: A (the writer script) → goto B (a stdin reader). Use a wrapper script that always outputs `goto:"reader"` regardless of what the inner writer produces. If the writer output overrides the goto (i.e., it's a valid structured output with its own goto or stop), the test observes that behavior instead.
3. Alternatively, use the programmatic API (`run()`) to observe the parsed output directly.
4. Assert the invariants above.

**Iterations:** The structured output fuzzer has two tiers:
- **Unit-level parser fuzzing:** At least 1000 random inputs per property. These call the parser function directly (no child process), so they are fast. This is where high-volume fuzzing lives. Uses the `parseOutput` internal seam (section 1.4).
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

**Iterations:** Same two-tier approach as section 5.1: at least 1000 inputs at the unit-parser level, 50–100 at the E2E level. Uses the `parseEnvFile` internal seam (section 1.4).

---

## 6. Supplementary Unit Tests

Unit tests provide fast feedback on isolated parsing/logic functions. They are NOT the primary validation strategy but add confidence.

### 6.1 Output Parsing Unit Tests

**File:** `tests/unit/parse-output.test.ts`

Uses the `parseOutput` internal seam (section 1.4).

Test the parser function directly:

- Valid JSON objects with various field combinations
- Type coercion cases (result as number, goto as boolean, stop as string)
- Edge cases: empty string, whitespace-only, very large strings
- Non-object JSON values (arrays, primitives, null)
- Malformed JSON

### 6.2 Env Parsing Unit Tests

**File:** `tests/unit/parse-env.test.ts`

Uses the `parseEnvFile` internal seam (section 1.4).

Test the parser function directly:

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

These tests verify the public TypeScript type surface documented in Spec section 9.5. **They must be validated via a real typecheck stage — not just ordinary Vitest runtime execution.** A test that merely imports a type and uses it at runtime can pass vacuously if the type is `any` or the assertion is elided at compile time.

**Required execution method (pick one):**
- **Vitest typecheck mode** (`vitest typecheck`): runs type-level assertions via `expectTypeOf` without executing runtime code.
- **`tsc --noEmit`**: a separate CI step that typechecks the test file against the built package's `.d.ts` files.
- **`tsd`**: a dedicated type-testing library that asserts against `.d.ts` exports.

Ordinary `vitest run` on `types.test.ts` is **not sufficient** as the sole verification. If `vitest run` is used, it must be paired with one of the above to ensure the type assertions are enforced at the type level.

**Setup:** The test file imports from the built loopx package as a real consumer would (same symlink/link approach as `runAPIDriver`).

- **T-TYPE-01**: `import type { Output, RunOptions } from "loopx"` compiles without error. *(Spec 9.5)*
- **T-TYPE-02**: `Output` has optional `result?: string`, `goto?: string`, `stop?: boolean` fields — and no other required fields. Assert via `expectTypeOf<Output>()` or equivalent. *(Spec 9.5)*
- **T-TYPE-03**: `RunOptions` has optional `maxIterations?: number`, `envFile?: string`, `signal?: AbortSignal`, `cwd?: string` fields. *(Spec 9.5)*
- **T-TYPE-04**: `run()` returns `AsyncGenerator<Output>`. Assert that `import { run } from "loopx"` compiles and the return type is assignable to `AsyncGenerator<Output>`. *(Spec 9.1, 9.5)*
- **T-TYPE-05**: `runPromise()` returns `Promise<Output[]>`. Assert the return type is assignable to `Promise<Output[]>`. *(Spec 9.2, 9.5)*
- **T-TYPE-06**: `run()` and `runPromise()` accept an optional `RunOptions` second argument. *(Spec 9.1, 9.2, 9.5)*
- **T-TYPE-07**: `run()` and `runPromise()` require `scriptName` as the first argument (`string`). Omitting `scriptName` is a static type error. Assert via `expectTypeOf` or `tsd` that calling `run()` with zero arguments or `runPromise()` with zero arguments fails the typecheck. *(Spec 9.1, 9.2, 9.5)*

---

## 7. Edge Cases & Boundary Tests

These tests specifically target boundary conditions that could reveal implementation bugs.

- **T-EDGE-01**: Very long result string (~1 MB). Script outputs `{"result":"<1MB>"}`. Assert it is handled without truncation or hang. *(Spec 2.3)*
- **T-EDGE-02**: Result containing JSON-special characters (quotes, backslashes, newlines). Verify correct JSON serialization/deserialization. *(Spec 2.3)*
- **T-EDGE-03**: Script that writes stdout in multiple `write()` calls (partial writes). Assert the full output is captured and parsed as a unit. *(Spec 2.3)*
- **T-EDGE-04**: Script that writes to both stdout and stderr. Assert stdout captured as output, stderr passed through. No interleaving issues. *(Spec 6.2, 6.3)*
- **T-EDGE-05**: Unicode in result values and env values is preserved correctly. Unicode in script names (e.g., `.loopx/café.sh`) is rejected — script names are ASCII-only per the `[a-zA-Z0-9_][a-zA-Z0-9_-]*` pattern. Assert that a unicode-named script produces a validation error. *(Spec 2.3, 5.3, 8.1)*
- **T-EDGE-06**: Deeply nested goto chain (A → B → C → D → E → ... → Z). Assert correct execution order and iteration counting. *(Spec 7.1)*
- **T-EDGE-07**: Script that produces output on stdout but also reads from stdin when no input is available. Assert no deadlock. *(Spec 6.8)*
- ~~**T-EDGE-08**~~: *Moved to robustness suite.* Concurrent loopx invocations — not direct spec conformance.
- ~~**T-EDGE-09**~~: *Moved to robustness suite.* Large script count discovery performance — not direct spec conformance.
- ~~**T-EDGE-10**~~: *Moved to robustness suite.* Maximum-length script name — filesystem limit, not direct spec conformance.
- **T-EDGE-11**: `-n` with very large value (e.g., `999999`). Assert no integer overflow or similar. Script should `stop` after a few iterations. *(Spec 4.2)*
- **T-EDGE-12**: Empty `.loopx/` directory (exists but no scripts). `loopx run myscript` → error (script not found). `loopx run -h` → run help displayed with no scripts listed (empty directory is not an error for run help). *(Spec 4.1, 11.2)*
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
3. **Typecheck**: Run `tsc --noEmit` or `vitest typecheck` on `tests/unit/types.test.ts` to verify public type surface. This must run as a dedicated stage, not as part of ordinary Vitest runtime execution (see section 6.4).
4. **Unit Tests**: Run `tests/unit/`.
5. **E2E Tests**: Run `tests/e2e/`. Parameterized over runtime matrix.
6. **Fuzz Tests**: Run `tests/fuzz/` with a CI-appropriate iteration count (e.g., 5000).
7. **Stub Validation** (optional, periodic): Run spec tests against stub binary and verify failure count hasn't decreased (tests haven't become vacuous).

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

## 9. Pending Spec Decisions

This section tracks any tests that are blocked by unresolved spec ambiguities. If a test's assertions depend on a spec decision that has not been made, it is listed here so it cannot be accidentally treated as an authoritative failure.

All previously identified spec problems (SP-15 through SP-31) have been resolved.

**Currently pending:**
- SP-32 (SSH/SCP URL classification — commit d6cdb2c classifies all `git@`-prefixed URLs as git sources, but SPEC.md section 10.1 does not mention SSH or SCP-style URLs. The five ordered source detection rules are written entirely in terms of `http(s)://` URLs and the `org/repo` shorthand. Either the spec should be updated to add a rule for `git@` URLs, or the implementation should be narrowed to only handle known-host patterns consistent with Rule 2. No tests are added for this behavior until the spec ambiguity is resolved.)

Resolved during this revision:
- SP-28 (mid-loop removed/renamed script behavior — resolved: discovery caching freezes names and resolved paths; execution uses cached path; file disappearance fails at spawn time as a normal child-process launch error)
- SP-29 (CommonJS support — resolved: using `require()` / CommonJS in loopx JS/TS scripts is invalid and must fail at execution time)
- SP-30 (install collision with non-script entries — resolved: loopx refuses to overwrite any existing filesystem entry at the destination path, not just discovered scripts)
- SP-31 (install name-collision across different destination paths — resolved: install always rejects when the derived script name would collide with any existing discovered script, even if the destination path differs)

Resolved in prior revisions: SP-15 (unmatched quotes → literal preserved), SP-17 (install validation → full 5.1 parity), SP-20/SP-21 (shorthand → reject `.git` suffix, consistent expansion), SP-22 (run() errors → lazy on first iteration), SP-23 (version format → bare string + newline), SP-24 (shadowed loopx → local wins, standard resolution), SP-25 (tarball detection → parsed URL pathname), SP-26 (cancellation → always terminate if child active), SP-27 (AbortSignal cancellation semantics — AbortSignal always throws/rejects, `break`/`generator.return()` completes silently).

---

## Appendix A: Spec Requirement Traceability Matrix

Maps each SPEC.md section to the test IDs that verify it.

| Spec Section | Description | Test IDs |
|-------------|-------------|----------|
| 1 | Overview (ESM-only) | T-MOD-22 |
| 2.1 | Script (file & directory) | T-DISC-01–17, T-DISC-11a, T-DISC-14a–14c, T-DISC-16a–16d, T-MOD-03a, T-EXEC-18a |
| 2.2 | Loop (state machine) | T-LOOP-01–05, T-LOOP-16–17 |
| 2.3 | Structured Output | T-PARSE-01–29, T-PARSE-12a, T-PARSE-20a, F-PARSE-01–05 |
| 3.1 | Global Install | T-INST-GLOBAL-01, T-INST-GLOBAL-01a |
| 3.2 | CLI Delegation | T-DEL-01–11 |
| 3.3 | Module Resolution | T-MOD-01–03, T-MOD-03a |
| 3.4 | Bash Script Binary Access | T-MOD-19–21 |
| 4.1 | Running Scripts (run subcommand) | T-CLI-11–13, T-CLI-27–33, T-CLI-59–60, T-DISC-22–26 |
| 4.2 | Options (-n, -e, run -h, top-level -h) | T-CLI-02–06, T-CLI-07b–07c, T-CLI-07e–07g, T-CLI-07j, T-CLI-14–22d, T-CLI-19a, T-CLI-20a–20b, T-CLI-28, T-CLI-34–63 |
| 4.3 | Subcommands | T-SUB-01–19, T-SUB-06a–06b, T-SUB-14a–14k, T-DISC-46a–46b |
| 5.1 | Discovery | T-DISC-01–17, T-DISC-11a, T-DISC-14a–14c, T-DISC-16a–16d, T-DISC-33–38b, T-DISC-47–50, T-CLI-55–55d, T-CLI-60 |
| 5.2 | Name Collision | T-DISC-18–21, T-CLI-22b |
| 5.3 | Name Restrictions | T-DISC-27–32, T-DISC-30a–30b, T-CLI-44, T-CLI-22d, T-EDGE-05 |
| 5.4 | Validation Scope | T-DISC-39–46b, T-SUB-06, T-SUB-13, T-SUB-19 |
| 6.1 | Working Directory | T-EXEC-01–04 |
| 6.2 | Bash Scripts | T-EXEC-05–07 |
| 6.3 | JS/TS Scripts | T-EXEC-08–14 |
| 6.4 | Directory Scripts | T-EXEC-15–18, T-EXEC-18a |
| 6.5 | output() Function | T-MOD-04–14a, T-MOD-13a–13g |
| 6.6 | input() Function | T-MOD-15–18 |
| 6.7 | Input Piping | T-LOOP-11–15 |
| 6.8 | Initial Input | T-LOOP-14 |
| 7.1 | Basic Loop | T-LOOP-01–10, T-LOOP-25 |
| 7.2 | Error Handling | T-LOOP-18–24, T-LOOP-18a, T-DISC-38a–38b |
| 7.3 | Signal Handling | T-SIG-01–08 |
| 8.1 | Global Env Storage | T-ENV-01–15f, T-ENV-05a–05e, T-ENV-25–25a, F-ENV-01–05 |
| 8.2 | Local Env Override | T-ENV-16–19, T-ENV-17a, T-ENV-25a |
| 8.3 | Env Injection Precedence | T-ENV-20–24, T-ENV-20a, T-ENV-21a, T-ENV-24a, T-ENV-24b |
| 9.1 | run() | T-API-01–09c, T-API-08a, T-API-09–09, T-API-10–10c, T-API-20h–20i, T-TYPE-04, T-TYPE-06–07 |
| 9.2 | runPromise() | T-API-11–14e, T-API-14a–14a3, T-API-25–25b, T-TYPE-05–07 |
| 9.3 | API Error Behavior | T-API-15–19, T-API-20a–20g, T-API-21c–21d |
| 9.4 | output() and input() (script-side) | T-MOD-04–14a, T-MOD-13a–13g (output()), T-MOD-15–18 (input()) — these are the same tests listed under 6.5/6.6; 9.4 references them |
| 9.5 | Types / RunOptions | T-API-07–08, T-API-10–10c, T-API-20d–20e, T-API-21–21b, T-API-22–25b, T-API-23a, T-API-24a–24b, T-TYPE-01–07 |
| 10.1 | Source Detection | T-INST-01–01a, T-INST-02–08d |
| 10.2 | Source Type Details | T-INST-09–26b, T-INST-34–39e |
| 10.3 | Common Install Rules | T-INST-27–27d, T-INST-28–33a, T-INST-31b |
| 11.1 | Top-Level Help | T-CLI-02–06, T-CLI-07e–07g, T-CLI-07j, T-CLI-28, T-CLI-39, T-CLI-61 |
| 11.2 | Run Help | T-CLI-40–55d, T-CLI-62 |
| 12 | Exit Codes | T-EXIT-01–16 |
