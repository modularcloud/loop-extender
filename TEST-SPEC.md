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
| P0 | Loop state machine, structured output parsing, script execution, workflow discovery | Core functionality — if these break, nothing works |
| P1 | Environment variables, CLI options, subcommands, goto semantics | Essential user-facing features |
| P2 | Install command, CLI delegation, signal handling, version checking | Important but less frequently exercised |
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
| `classifySource` | `(source: string) => { type: "git" \| "tarball", url: string }` | Classifies an install source per Spec 10.1 rules. Throws for rejected sources (e.g., single-file URLs) |

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
| **http** (Node built-in) | Local HTTP server for install tests (tarball downloads). |
| **Local bare git repos** | Testing git clone install source (no network dependency). |

### 2.2 Directory Layout

```
tests/
  harness/
    smoke.test.ts              Phase 0 harness validation
  e2e/
    cli-basics.test.ts         CLI invocation, help, version
    subcommands.test.ts        output, env, install subcommands
    discovery.test.ts          Workflow & script discovery, validation
    execution.test.ts          Script execution (bash, JS/TS, workflow cwd)
    output-parsing.test.ts     Structured output parsing
    loop-state.test.ts         Loop state machine, goto semantics, control flow
    env-vars.test.ts           Environment variable management
    module-resolution.test.ts  import from "loopx", output(), input()
    programmatic-api.test.ts   run(), runPromise()
    install.test.ts            loopx install from various sources
    signals.test.ts            Signal handling (SIGINT, SIGTERM)
    delegation.test.ts         Project-root CLI delegation
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
    fixtures.ts                Temp dir, workflow, script, and project creation
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

#### `createWorkflow(project, workflowName): string`

Creates a workflow directory at `.loopx/<workflowName>/` inside the project. Returns the absolute path to the workflow directory. Example:
```typescript
const wfDir = createWorkflow(project, "ralph");
// creates <project.dir>/.loopx/ralph/
```

#### `createWorkflowScript(project, workflowName, scriptName, ext, content): string`

Creates a script file inside a workflow directory. Creates the workflow directory if it does not already exist. Returns the full path to the created file. Example:
```typescript
createWorkflowScript(project, "ralph", "index", ".ts", `
  import { output } from "loopx";
  output({ result: "hello" });
`);
// creates <project.dir>/.loopx/ralph/index.ts
```

#### `createBashWorkflowScript(project, workflowName, scriptName, body): string`

Shorthand for creating a `.sh` script with `#!/bin/bash` header and executable permission inside a workflow. Creates the workflow directory if needed.

#### `createWorkflowPackageJson(project, workflowName, content): string`

Creates a `package.json` file inside a workflow directory. Returns the full path. Used for dependency management and version declaration tests.

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
  const outputs = await runPromise("ralph", { cwd: "${project.dir}" });
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

Starts a local HTTP server serving the specified routes. Used for install tests (tarball downloads).

#### `startLocalGitServer(repos): Promise<{ url: string, close: () => void }>`

Creates local bare git repositories and serves them over a local protocol. Used for `loopx install` git tests. Implementation: create bare repos with `git init --bare`, then clone/commit/push fixture content, and serve via `git daemon` or direct file:// URLs.

#### `withGitURLRewrite(rewrites, fn): Promise<void>`

Sets up an isolated git configuration (via `GIT_CONFIG_GLOBAL` and isolated `HOME`) with `url.<base>.insteadOf` rules so that known-host URLs (e.g., `https://github.com/org/repo.git`) are transparently rewritten to local `file://` bare repos. This allows T-INST-01 through T-INST-04 to test known-host source detection without network access.

```typescript
await withGitURLRewrite({
  "https://github.com/myorg/my-workflow.git": "file:///tmp/bare-repos/my-workflow.git"
}, async () => {
  const result = await runCLI(["install", "myorg/my-workflow"], { cwd: project.dir });
  // Verifies org/repo shorthand expands to github URL, which is rewritten to local repo
});
```

#### `forEachRuntime(fn): void`

Test parameterization helper. Runs a test block once for each available runtime (Node.js, Bun). Skips a runtime if it's not installed. Example:
```typescript
forEachRuntime((runtime) => {
  it("runs a bash script", async () => {
    const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir, runtime });
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

**Workflow fixture convention:** All fixture scripts are created inside workflow directories using `createWorkflowScript` or `createBashWorkflowScript`. A typical single-script test creates a workflow (e.g., `myscript`) with an `index` script. A multi-script test creates multiple scripts within one or more workflows.

### 2.5 Runtime Matrix

Tests are parameterized over runtimes where applicable:

| Category | Node.js | Bun |
|----------|---------|-----|
| CLI basics, help, version | Yes | Yes |
| Subcommands (output, env) | Yes | Yes |
| Workflow & script discovery | Yes | Yes |
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
- **Tarball routes:** Serve `.tar.gz` archives created on-the-fly from fixture directories.
- **Query string routes:** Serve files at URLs with `?token=abc` to test query stripping.
- **Error routes:** Return 404, 500, etc. to test error handling.
- **Rejected URL routes:** Serve files at non-tarball, non-git URLs to test single-file URL rejection.

The server starts in `beforeAll` and closes in `afterAll` for the install test suite.

#### Git Server

For git install tests, use `file://` protocol URLs pointing to local bare repos:
1. Create a temp directory with `git init --bare`.
2. Clone it to a working directory, add fixture files (workflow scripts, optional `package.json`), commit, push.
3. Tests use `file:///path/to/bare/repo.git` as the install source.

This avoids any network dependency and is fast. The bare repos are created in `beforeAll` and cleaned up in `afterAll`.

---

## 3. Test Verification Strategy

The central challenge: tests are written before the implementation exists. We need confidence that when a test passes, it genuinely validates the spec requirement — not that it passes vacuously.

### 3.1 Phase 0: Harness Validation

**Purpose:** Verify the test infrastructure works correctly. These tests pass without any loopx implementation.

**Tests (`tests/harness/smoke.test.ts`):**

- **H-01: Temp project creation and cleanup.** `createTempProject()` creates a directory that exists, `cleanup()` removes it.
- **H-02: Workflow and script fixture creation.** `createWorkflowScript()` writes a file inside `.loopx/<workflow>/` with correct content and permissions.
- **H-03: Workflow directory creation.** `createWorkflow()` creates a workflow directory at `.loopx/<name>/`.
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

- **T-CLI-02**: `loopx -h` prints usage text containing "loopx" and "usage" (case-insensitive), exits 0. Assert that the output lists the available subcommands: `run`, `version`, `output`, `env`, and `install` must all appear in the help text. Does not list workflows — top-level help performs no discovery. Additionally assert that the help text does **not** contain patterns reflecting the removed legacy flat-script invocation model: (a) no usage line showing `loopx [options] [script-name]` or `loopx [script-name]` (the old implicit-script invocation form), (b) no mention of `-n` or `-e` as top-level options (these are `run`-scoped). These negative assertions guard against stale help text that advertises removed behavior. *(Spec 4.2, 11.1)*
- **T-CLI-03**: `loopx --help` produces identical stdout, stderr, and exit code as `loopx -h`. Run both in the same fixture containing `.loopx/` with workflows, a name collision (e.g., `check.sh` and `check.ts` in the same workflow), and an invalid workflow name. Assert: (a) stdout is byte-identical between the two invocations, (b) stderr is byte-identical (both empty — no discovery or validation warnings), and (c) both exit 0. This proves the `--help` long form is a true alias for `-h` including the non-discovery guarantee, not just a help-text match in a clean fixture. *(Spec 4.2, 11.1)*
- **T-CLI-04**: `loopx -h` with `.loopx/` containing workflows does NOT list discovered workflow or script names in output. Top-level help performs no discovery. Assert that stdout does not contain any of the workflow or script names. *(Spec 4.2, 11.1)*
- **T-CLI-05**: `loopx -h` without `.loopx/` directory still prints help (no error). No workflow list, no warnings. *(Spec 4.2, 11.1)*
- **T-CLI-06**: `loopx -h` with `.loopx/` containing name collisions does NOT print warnings on stderr. Top-level help performs no validation. *(Spec 4.2, 11.1)*
- **T-CLI-07e**: `loopx -h version` prints top-level help and exits 0 (top-level `-h` takes precedence over everything that follows). The `version` subcommand does not execute. *(Spec 4.2)*
- **T-CLI-07f**: `loopx -h env set FOO bar` prints top-level help and exits 0 (top-level `-h` takes precedence over `env` subcommand). *(Spec 4.2)*
- **T-CLI-07g**: `loopx -h --invalid-flag` prints top-level help and exits 0 (top-level `-h` takes precedence over invalid flags). *(Spec 4.2)*
- **T-CLI-07j**: `loopx -h -e nonexistent.env` prints top-level help and exits 0 (top-level `-h` takes precedence over `-e`). The nonexistent env file is not read or validated. *(Spec 4.2)*
- **T-CLI-39**: `loopx -h run foo` shows top-level help (not run help) and exits 0. Top-level `-h` takes precedence over everything that follows, including `run` subcommand dispatch. *(Spec 4.2)*
- **T-CLI-61**: `loopx --help run foo` shows top-level help (not run help) and exits 0. Same behavior as `loopx -h run foo` — verifies that the `--help` long form has identical precedence semantics to `-h` when followed by additional arguments. *(Spec 4.2)*
- **T-CLI-90**: `loopx --help --invalid-flag` prints top-level help and exits 0 (top-level `--help` takes precedence over invalid flags). This is the `--help` long-form counterpart to T-CLI-07g (`loopx -h --invalid-flag`), verifying both help spellings suppress subsequent invalid flags identically. *(Spec 4.2)*
- **T-CLI-91**: `loopx --help -e nonexistent.env` prints top-level help and exits 0 (top-level `--help` takes precedence over `-e`). The nonexistent env file is not read or validated. This is the `--help` long-form counterpart to T-CLI-07j (`loopx -h -e nonexistent.env`). *(Spec 4.2)*

#### Run Help

- **T-CLI-40**: `loopx run -h` with `.loopx/` containing workflows prints run-specific help that includes: (a) run syntax showing the target form (e.g., `loopx run [options] <workflow>[:<script>]` or equivalent), (b) the `-n` and `-e` options with descriptions, and (c) a list of discovered workflows and their scripts. If a workflow has an `index` script, it is indicated as the default entry point. Exits 0. *(Spec 4.2, 11.2)*
- **T-CLI-41**: `loopx run --help` produces identical stdout, stderr, and exit code as `loopx run -h`. Run both in the same fixture containing `.loopx/` with valid workflows and a name collision (e.g., `check.sh` and `check.ts` in the same workflow). Assert: (a) stdout is byte-identical between the two invocations, (b) stderr is byte-identical (both should contain the same non-fatal discovery/validation warnings — collision warnings), and (c) both exit 0. This proves the `--help` long form is a true alias for `-h` including non-fatal warning behavior, not just a help-text match in a clean fixture. *(Spec 4.2, 11.2)*
- **T-CLI-42**: `loopx run -h` without `.loopx/` directory still prints run help with a warning that the directory was not found. The discovered-workflows section is omitted. Exits 0. *(Spec 11.2)*
- **T-CLI-43**: `loopx run -h` with `.loopx/` containing name collisions (e.g., `check.sh` and `check.ts` in the same workflow) prints run help with warnings on stderr about the conflicting entries. Exits 0. *(Spec 5.2, 11.2)*
- **T-CLI-43a**: `loopx run -h` with `.loopx/` containing an `index` name collision (`index.sh` and `index.ts` in the same workflow) prints run help with warnings on stderr about the conflicting `index` entries. Exits 0. This is the `index`-specific variant of T-CLI-43 — a bad implementation could special-case `index` and bypass collision warnings for the default entry point. *(Spec 2.1, 5.2, 11.2)*
- **T-CLI-44**: `loopx run -h` with `.loopx/` containing a script with an invalid name (e.g., `-startswithdash.sh`) prints run help with a non-fatal warning on stderr about the invalid name. Assert that the warning text contains the offending script name (e.g., `-startswithdash`). Help still exits 0. *(Spec 5.3, 11.2)*
- **T-CLI-101**: `loopx run -h` with `.loopx/` containing a workflow that has an `index` script indicates the default entry point in the output. Assert that the help text marks `index` as the default entry point for that workflow. *(Spec 11.2)*
- **T-CLI-102**: `loopx run -h` with `.loopx/` containing a workflow with invalid script names shows non-fatal warnings. The workflow is still listed. Exits 0. *(Spec 5.3, 11.2)*
- **T-CLI-104**: `loopx run -h` with `.loopx/` containing non-workflow files directly in `.loopx/` root (e.g., `.loopx/loose-script.sh`) — the files are neither listed nor warned about. Only workflow subdirectories appear. *(Spec 5.1, 11.2)*
- **T-CLI-104a**: `loopx run -h` with `.loopx/` containing an empty subdirectory (`.loopx/empty/`) alongside a valid workflow (`.loopx/ralph/index.sh`). The empty directory is not a workflow (no top-level script files) and is neither listed in the workflow discovery output nor warned about on stderr. Only `ralph` appears. *(Spec 5.1, 11.2)*
- **T-CLI-104b**: `loopx run -h` with `.loopx/` containing a subdirectory with only non-script files (`.loopx/meta/` containing `config.json` and `notes.md`) alongside a valid workflow (`.loopx/ralph/index.sh`). The `meta` directory is not a workflow (no supported-extension files) and is neither listed in the workflow discovery output nor warned about on stderr. Only `ralph` appears. *(Spec 5.1, 11.2)*
- **T-CLI-105**: `loopx run ralph -h` is equivalent to `loopx run -h` — the `-h` short-circuit applies, and the workflow argument is ignored. Assert identical stdout/stderr to `loopx run -h`. *(Spec 4.2, 11.2)*
- **T-CLI-106**: `loopx run ralph:index -h` is equivalent to `loopx run -h` — the target argument including script is ignored. *(Spec 4.2, 11.2)*
- **T-CLI-62**: `loopx run myscript --help` shows run help and exits 0. Same behavior as `loopx run myscript -h` — verifies that the `--help` long form triggers the run-help short-circuit identically to `-h` when appearing after a target name. *(Spec 4.2, 11.2)*
- **T-CLI-120**: `loopx run -h` with `.loopx/` containing a workflow with an invalid name (e.g., `.loopx/-bad-workflow/index.sh`) prints run help with a non-fatal warning on stderr about the invalid workflow name. Assert that the warning text contains the offending workflow name (e.g., `-bad-workflow`). Help still exits 0. *(Spec 5.3, 11.2)*

#### Run Help Short-Circuit

Within `run`, `-h` / `--help` is a full short-circuit: when present, loopx shows run help, exits 0, and ignores all other run-level arguments unconditionally.

- **T-CLI-48**: `loopx run -h foo` shows run help and exits 0 (target name ignored). *(Spec 4.2)*
- **T-CLI-49**: `loopx run ralph -h` shows run help and exits 0 (`-h` after target name still triggers help short-circuit). In the same fixture, assert that stdout and stderr are identical to `loopx run -h` output and that exit code is 0 — proving the short-circuit produces the canonical run-help behavior, not a degraded or partial variant. *(Spec 4.2, 11.2)*
- **T-CLI-50**: `loopx run -h -e missing.env` shows run help and exits 0 (env file not validated). *(Spec 4.2)*
- **T-CLI-51**: `loopx run -h -n bad` shows run help and exits 0 (`-n` not validated). *(Spec 4.2)*
- **T-CLI-52**: `loopx run -h -n 5 -n 10` shows run help and exits 0 (duplicate `-n` not rejected under help). *(Spec 4.2)*
- **T-CLI-53**: `loopx run -h foo bar` shows run help and exits 0 (extra positional not rejected under help). *(Spec 4.2)*
- **T-CLI-54**: `loopx run -h --unknown` shows run help and exits 0 (unknown flag not rejected under help). *(Spec 4.2)*
- **T-CLI-63**: `loopx run -h -e a.env -e b.env` shows run help and exits 0 (duplicate `-e` not rejected under help). *(Spec 4.2)*
- **T-CLI-67**: `loopx run ralph -h --unknown` shows run help and exits 0. The `-h` after the target name triggers the help short-circuit, suppressing the unknown flag error. *(Spec 4.2)*
- **T-CLI-68**: `loopx run ralph -h -e missing.env` shows run help and exits 0. The `-h` after the target name triggers the help short-circuit, suppressing env file validation. *(Spec 4.2)*
- **T-CLI-69**: `loopx run --help --unknown` shows run help and exits 0. Verifies that the `--help` long form inherits the full ignore-everything-else short-circuit semantics, not just help display. *(Spec 4.2)*
- **T-CLI-70**: `loopx run ralph --help -e missing.env` shows run help and exits 0. Verifies that the `--help` long form after a target name suppresses env file validation identically to `-h`. *(Spec 4.2)*
- **T-CLI-92**: `loopx run -h -n` shows run help and exits 0 (missing `-n` operand not rejected under help). *(Spec 4.2)*
- **T-CLI-93**: `loopx run -h -e` shows run help and exits 0 (missing `-e` operand not rejected under help). *(Spec 4.2)*
- **T-CLI-94**: `loopx run --help -n` shows run help and exits 0 (long-form help, missing `-n` operand not rejected). *(Spec 4.2)*
- **T-CLI-95**: `loopx run --help -e` shows run help and exits 0 (long-form help, missing `-e` operand not rejected). *(Spec 4.2)*

#### Late-Help Short-Circuit (Invalid Args Before `-h`)

- **T-CLI-73**: `loopx run --unknown -h` shows run help and exits 0. *(Spec 4.2)*
- **T-CLI-74**: `loopx run -e missing.env -h` shows run help and exits 0. *(Spec 4.2)*
- **T-CLI-75**: `loopx run -n 5 -n 10 -h` shows run help and exits 0. *(Spec 4.2)*
- **T-CLI-76**: `loopx run foo bar -h` shows run help and exits 0. *(Spec 4.2)*
- **T-CLI-77**: `loopx run -n bad -h` shows run help and exits 0. *(Spec 4.2)*
- **T-CLI-78**: `loopx run --unknown --help` shows run help and exits 0. *(Spec 4.2)*
- **T-CLI-78a**: `loopx run ":script" -h` shows run help and exits 0. The malformed target (leading colon) before `-h` does not prevent the help short-circuit. This proves help suppresses the target validation rules introduced for the `workflow:script` syntax. *(Spec 4.1, 4.2)*
- **T-CLI-78b**: `loopx run "a:b:c" --help` shows run help and exits 0. The malformed target (multiple colons) before `--help` does not prevent the help short-circuit. *(Spec 4.1, 4.2)*
- **T-CLI-84**: `loopx run -e a.env -e b.env -h` shows run help and exits 0. *(Spec 4.2)*

#### Bare Invocation & Top-Level Parsing Errors

- **T-CLI-28**: `loopx` with no arguments shows top-level help (equivalent to `loopx -h`). Exits 0. Set up `.loopx/` containing a name collision in a workflow. Assert that stdout is identical to `loopx -h` output, that stdout does not contain any workflow names, and that stderr does not contain any discovery or validation warnings. This proves bare `loopx` truly behaves as top-level help and does not inspect `.loopx/`. *(Spec 4.1, 4.2, 5.4)*
- **T-CLI-33**: `loopx ralph` is a usage error (unrecognized subcommand, no implicit fallback to `run`). Create `.loopx/ralph/index.sh` that writes a known value to a marker file. Assert exit code 1 AND assert the marker file does not exist (proving the script was not executed despite being present). *(Spec 4.1)*
- **T-CLI-34**: `loopx --unknown` is a usage error (unrecognized top-level flag). Exit code 1. *(Spec 4.2)*
- **T-CLI-71**: `loopx -x` is a usage error (unrecognized top-level short flag). Exit code 1. *(Spec 4.2)*
- **T-CLI-36**: `loopx -n 5 ralph` is a usage error (top-level `-n` rejected — only `-h` is recognized at top level). Exit code 1. *(Spec 4.2)*
- **T-CLI-37**: `loopx -e .env ralph` is a usage error (top-level `-e` rejected). Exit code 1. *(Spec 4.2)*
- **T-CLI-07b**: `loopx -n 5 -h` is a usage error (exit code 1). The first argument is `-n`, which is not `-h` and not a recognized subcommand, so top-level parsing fails before `-h` is reached. *(Spec 4.2)*
- **T-CLI-07c**: `loopx ralph -h` is a usage error (exit code 1). `ralph` is an unrecognized token in the subcommand position. *(Spec 4.2)*
- **T-CLI-38**: `loopx foo -h` is a usage error (unrecognized subcommand, exit code 1 — not top-level help). *(Spec 4.2)*
- **T-CLI-79**: `loopx foo --help` is a usage error (unrecognized subcommand, exit code 1 — not top-level help). *(Spec 4.2)*

#### Target Invocation via `run`

- **T-CLI-30**: `loopx run -n 1 ralph` with `.loopx/ralph/index.sh` runs the script. Assert via marker file: the script writes a known value to a marker file, confirming execution. *(Spec 4.1)*
- **T-CLI-11**: `loopx run ralph` (no `-n`, no `-e`) with `.loopx/ralph/index.sh` that outputs `{"stop":true}` on the first iteration. Assert via marker file that the script executed AND assert exit code 0. *(Spec 4.1)*
- **T-CLI-107**: `loopx run ralph:check-ready` with `.loopx/ralph/check-ready.sh` runs the specified script. Assert via marker file. *(Spec 4.1)*
- **T-CLI-108**: `loopx run ralph:index` is equivalent to `loopx run ralph`. Both run `.loopx/ralph/index.sh`. Assert via marker file that the same script executes in both cases. *(Spec 4.1)*
- **T-CLI-109**: `loopx run ralph` where `.loopx/ralph/` exists but has no `index` script → exits with code 1 (error about missing default entry point). The workflow has other scripts (e.g., `check.sh`) but no `index`. *(Spec 4.1, 7.2)*
- **T-CLI-110**: `loopx run ralph:check` where `.loopx/ralph/` exists and has `check.sh` but no `index` → runs successfully. A workflow without `index` is valid when targeting explicit scripts. *(Spec 4.1)*
- **T-CLI-12**: `loopx run nonexistent` with `.loopx/` existing but no matching workflow exits with code 1. *(Spec 4.1)*
- **T-CLI-111**: `loopx run ralph:nonexistent` with `.loopx/ralph/` existing but no matching script → exits with code 1 (error about missing script in workflow). *(Spec 4.1, 7.2)*
- **T-CLI-13**: `loopx run -n 1 default` runs the `index` script in a workflow named `default` — `default` has no special behavior. Assert via marker file. *(Spec 4.1)*
- **T-CLI-29**: `loopx run` with no target is a usage error (exit code 1). This does not inspect `.loopx/` or perform discovery. *(Spec 4.1)*
- **T-CLI-64**: `loopx run` with no target, with `.loopx/default/index.sh` present — still exits 1. There is no implicit default workflow concept. *(Spec 4.1)*
- **T-CLI-65**: `loopx` (bare invocation) with `.loopx/default/index.sh` present — shows top-level help and exits 0. There is no implicit default workflow concept. *(Spec 4.1, 4.2, 11.1)*
- **T-CLI-59**: `loopx run -n 5` (options present but no target) is a usage error (exit code 1). Assert exit code 1 AND assert stderr does not contain any discovery or validation warnings. *(Spec 4.1, 5.1)*
- **T-CLI-60**: `loopx run` with `.loopx/` containing a name collision — still exits with code 1 as a usage error (missing target), AND stderr does not contain any discovery warnings. *(Spec 4.1, 5.1)*
- **T-CLI-85**: `loopx run -e missing.env` (no target, with `-e`) exits with code 1 as a usage error (missing target). Assert stderr does not mention the missing env file. *(Spec 4.1, 4.2, 5.1)*
- **T-CLI-31**: `loopx run -n 1 version` with `.loopx/version/index.sh` runs the script named `version`, not the built-in subcommand. Assert via marker file that the script executed. Also assert that CLI stdout is empty — proving `run version` dispatched to the workflow, not the built-in `version` subcommand. *(Spec 4.1)*
- **T-CLI-32**: `loopx run -n 1 run` with `.loopx/run/index.sh` runs the workflow named `run`. Assert via marker file. *(Spec 4.1)*
- **T-CLI-66**: `loopx version` with `.loopx/version/index.sh` present still prints the CLI version string and exits 0. The workflow is not executed. *(Spec 4.1, 4.3)*
- **T-CLI-80**: `loopx output --result "x"` with `.loopx/output/index.sh` present still runs the built-in `output` subcommand, not the workflow. *(Spec 4.1, 4.3)*
- **T-CLI-81**: `loopx env list` with `.loopx/env/index.ts` present still runs the built-in `env` subcommand, not the workflow. *(Spec 4.1, 4.3)*

#### Target Validation

- **T-CLI-112**: `loopx run ""` (empty string target) → error, exit code 1. *(Spec 4.1)*
- **T-CLI-113**: `loopx run ":"` (bare colon) → error, exit code 1. *(Spec 4.1)*
- **T-CLI-114**: `loopx run ":script"` (leading colon) → error, exit code 1. *(Spec 4.1)*
- **T-CLI-115**: `loopx run "workflow:"` (trailing colon) → error, exit code 1. *(Spec 4.1)*
- **T-CLI-116**: `loopx run "a:b:c"` (multiple colons) → error, exit code 1. *(Spec 4.1)*
- **T-CLI-117**: `loopx run "-bad:index"` (workflow name violates name restrictions) → error, exit code 1. *(Spec 4.1)*
- **T-CLI-118**: `loopx run "ralph:-bad"` (script name violates name restrictions) → error, exit code 1. *(Spec 4.1)*
- **T-CLI-114a**: Invalid target format is rejected after discovery and global validation, not as an early usage error. Create `.loopx/broken/check.sh` and `.loopx/broken/check.ts` (name collision) alongside `.loopx/valid/index.sh`. Run `loopx run ":script"` (an invalid target string). Assert exit code 1 AND that stderr mentions the name collision in `broken` — proving discovery and global validation ran before the invalid target was rejected. Per Spec 4.1, invalid targets are rejected "at the same point as a missing workflow (after discovery)." *(Spec 4.1, 5.4)*

#### Option Order

- **T-CLI-57**: `loopx run ralph -n 1` (target name before `-n`) runs the script for exactly 1 iteration. Assert via counter file that the script ran exactly once. *(Spec 4.2)*
- **T-CLI-58**: `loopx run ralph -e local.env -n 1` (target name before both `-e` and `-n`) runs the script with the env file loaded. Assert via marker file that the env variable from `local.env` is visible to the script. *(Spec 4.2)*
- **T-CLI-83**: `loopx run -e local.env ralph -n 1` (options on both sides of the target name) runs the script for exactly 1 iteration with the env file loaded. *(Spec 4.2)*

#### CLI `-n` Option

- **T-CLI-14**: `loopx run -n 3 ralph` with a counter fixture runs exactly 3 iterations. Assert counter file contains 3 marks. *(Spec 4.2, 7.1)*
- **T-CLI-15**: `loopx run -n 0 ralph` exits 0 without running the script. Assert counter file does not exist or is empty. *(Spec 4.2, 7.1)*
- **T-CLI-16**: `loopx run -n -1 ralph` exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-17**: `loopx run -n 1.5 ralph` exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-18**: `loopx run -n abc ralph` exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-19**: `loopx run -n 0 nonexistent` with `.loopx/` existing but no workflow named `nonexistent` — exits with code 1 (validation occurs before `-n 0` short-circuit). *(Spec 4.2, 7.1)*
- **T-CLI-19a**: `loopx run -n 0 ralph` with `.loopx/` directory missing entirely → exits with code 1. *(Spec 4.2, 7.1, 7.2)*
- **T-CLI-20**: `loopx run -n 1 ralph` runs exactly 1 iteration even if the script produces no `stop`. *(Spec 4.2)*
- **T-CLI-56**: `loopx run -n 0 ralph` with a valid workflow performs discovery and validation (target must exist), then executes zero iterations, and exits 0. *(Spec 4.2, 7.1)*
- **T-CLI-119**: `loopx run -n 0 ralph` skips workflow-level version checking. Set up `.loopx/ralph/package.json` declaring a loopx version range not satisfied by the running version. Assert exit code 0 and no version mismatch warning on stderr. *(Spec 3.2, 4.2)*
- **T-CLI-119c**: `loopx run -n 0 ralph` skips the entire version-check path, including `package.json` reading. Set up `.loopx/ralph/package.json` with invalid JSON content (e.g., `{broken`). Assert exit code 0 and no `package.json` warning on stderr. This extends T-CLI-119 (which tests unsatisfied range) to prove the whole runtime version-check path is skipped under `-n 0` — not just the range comparison. SPEC 3.2 says "no workflow is entered for execution," so `package.json` is never read. *(Spec 3.2, 4.2)*
- **T-CLI-119a**: `loopx run -n 0 ralph` where `.loopx/ralph/` exists but has no `index` script (e.g., only `check.sh`) → exits with code 1. Target resolution requires the default entry point to exist even under `-n 0`. *(Spec 4.1, 4.2, 7.1)*
- **T-CLI-119b**: `loopx run -n 0 ralph:missing` where `.loopx/ralph/` exists (with `index.sh`) but has no script named `missing` → exits with code 1. Target resolution validates the specified script exists even under `-n 0`. *(Spec 4.1, 4.2, 7.1)*

#### Duplicate Flags

- **T-CLI-20a**: `loopx run -n 3 -n 5 ralph` exits with code 1 (duplicate `-n` is a usage error). *(Spec 4.2)*
- **T-CLI-20b**: `loopx run -e .env1 -e .env2 ralph` exits with code 1 (duplicate `-e` is a usage error). *(Spec 4.2)*

#### Unrecognized Run Flags

- **T-CLI-35**: `loopx run --unknown ralph` exits with code 1 (unrecognized flag within `run` is a usage error). *(Spec 4.2)*
- **T-CLI-72**: `loopx run -x ralph` exits with code 1 (unrecognized short flag within `run`). *(Spec 4.2)*
- **T-CLI-86**: `loopx run ralph --unknown` exits with code 1. Create `.loopx/ralph/index.sh` that writes a known value to a marker file. Assert exit code 1 AND assert the marker file does not exist. *(Spec 4.2)*
- **T-CLI-87**: `loopx run ralph -x` exits with code 1. *(Spec 4.2)*
- **T-CLI-88**: `loopx run ralph -n 1 -n 2` exits with code 1 (duplicate `-n` after target name). *(Spec 4.2)*
- **T-CLI-89**: `loopx run ralph -e a.env -e b.env` exits with code 1 (duplicate `-e` after target name). *(Spec 4.2)*

#### Missing Flag Operands

- **T-CLI-97**: `loopx run -n` (no operand for `-n`, no target) exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-98**: `loopx run -e` (no operand for `-e`, no target) exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-99**: `loopx run ralph -n` (missing `-n` operand after target name) exits with code 1 (usage error). *(Spec 4.2)*
- **T-CLI-100**: `loopx run ralph -e` (missing `-e` operand after target name) exits with code 1 (usage error). *(Spec 4.2)*

#### CLI `-e` Option

- **T-CLI-21**: `loopx run -e .env -n 1 ralph` with a valid `.env` file makes its variables available in the script. Use `write-env-to-file` fixture in the workflow's `index.sh`. Assert the marker file contains the expected value. *(Spec 4.2)*
- **T-CLI-22**: `loopx run -e nonexistent.env ralph` exits with code 1. Stderr mentions the missing file. *(Spec 4.2)*
- **T-CLI-22a**: `loopx run -n 0 -e nonexistent.env ralph` exits with code 1 (env file validation happens before `-n 0` short-circuit). *(Spec 4.2, 7.1)*
- **T-CLI-22c**: `loopx run -n 0 -e malformed.env ralph` where `malformed.env` exists and is readable but contains an invalid line (e.g., `1BAD=val`) → exits with code 0, stderr contains a parser warning for the invalid key, and the script never runs (assert counter file does not exist). Proves env files are actually parsed under `-n 0`, not just existence/readability checked. *(Spec 4.2, 7.1, 8.1)*
- **T-CLI-22b**: `loopx run -n 0 ralph` with `.loopx/` containing a name collision in a workflow → exits with code 1 (validation occurs before `-n 0` short-circuit). *(Spec 4.2, 5.2, 7.1)*
- **T-CLI-22d**: `loopx run -n 0 ralph` with `.loopx/` containing an invalid script name (e.g., `-bad.sh` in any workflow) → exits with code 1. *(Spec 4.2, 5.3, 7.1)*
- **T-CLI-22e**: `loopx run -n 0 ralph` with `.loopx/` containing a sibling with an invalid workflow name (e.g., `.loopx/-bad-workflow/index.sh`) → exits with code 1 (global validation catches the invalid workflow name before the `-n 0` short-circuit). This is the `-n 0` counterpart to T-DISC-47b (invalid workflow name in sibling, normal run mode). *(Spec 4.2, 5.3, 7.1)*

#### CLI Stdout Silence

- **T-CLI-23**: `loopx run -n 1 ralph` where `ralph:index` outputs `{"result":"hello"}` and writes a marker file — the CLI's own stdout is empty (result is not printed), AND the marker file exists (proving the script actually ran). *(Spec 7.1)*
- **T-CLI-27**: `loopx run ralph beta` (two positional arguments within `run`) exits with code 1. `run` accepts exactly one positional argument. *(Spec 4.1)*
- **T-CLI-96**: `loopx run ralph -n 1 beta` exits with code 1 (extra positional argument interleaved with options). *(Spec 4.1)*

### 4.2 Subcommands

**Spec refs:** 4.3, 5.4

#### `loopx output`

- **T-SUB-01**: `loopx output --result "hello"` prints valid JSON to stdout, exits 0. Parse stdout as JSON and assert `result === "hello"`. Do not assert exact byte-for-byte text or field order. *(Spec 4.3)*
- **T-SUB-02**: `loopx output --goto "next"` prints valid JSON to stdout, exits 0. Parse stdout as JSON and assert `goto === "next"`. *(Spec 4.3)*
- **T-SUB-02a**: `loopx output --goto "review-adr:request-feedback"` prints valid JSON with a qualified goto target. Parse stdout as JSON and assert `goto === "review-adr:request-feedback"`. The output helper does not validate the goto target format — it only serializes. *(Spec 4.3)*
- **T-SUB-02b**: `loopx output --goto "check-ready"` prints valid JSON with a bare goto target (intra-workflow). *(Spec 4.3)*
- **T-SUB-02c**: `loopx output --goto ""` prints valid JSON with `goto === ""`. The output helper does not validate — empty string is serialized as-is. *(Spec 4.3)*
- **T-SUB-02d**: `loopx output --goto "a:b:c"` prints valid JSON with `goto === "a:b:c"`. The output helper does not validate malformed targets; it only serializes them. *(Spec 4.3)*
- **T-SUB-03**: `loopx output --stop` prints valid JSON to stdout, exits 0. Parse stdout as JSON and assert `stop === true`. *(Spec 4.3)*
- **T-SUB-04**: `loopx output --result "x" --goto "y" --stop` prints valid JSON to stdout. Parse as JSON and assert all three fields present with correct values. *(Spec 4.3)*
- **T-SUB-05**: `loopx output` with no flags exits with code 1 (error). *(Spec 4.3)*
- **T-SUB-06**: `loopx output --result "x"` works without `.loopx/` directory existing. *(Spec 5.4)*
- **T-SUB-06a**: `loopx output --result 'value with "quotes" and \\backslashes'` → stdout is valid JSON with the value correctly escaped. *(Spec 4.3)*
- **T-SUB-06b**: `loopx output --result $'line1\nline2'` → stdout is valid JSON with the newline correctly escaped. *(Spec 4.3)*

#### `loopx env set`

- **T-SUB-07**: `loopx env set FOO bar` then `loopx env list` shows `FOO=bar`. *(Spec 4.3)*
- **T-SUB-08**: `loopx env set _UNDER score` succeeds (underscore-prefixed name valid). Follow with `loopx env list` and assert `_UNDER=score` is present. *(Spec 4.3)*
- **T-SUB-09**: `loopx env set A1 val` succeeds (alphanumeric name). *(Spec 4.3)*
- **T-SUB-10**: `loopx env set 1INVALID val` exits with code 1 (starts with digit). *(Spec 4.3)*
- **T-SUB-11**: `loopx env set -DASH val` exits with code 1 (invalid name). *(Spec 4.3)*
- **T-SUB-12**: `loopx env set FOO bar` then `loopx env set FOO baz` then `loopx env list` shows `FOO=baz` (overwrite). *(Spec 4.3)*
- **T-SUB-13**: `loopx env set FOO bar` in a directory with no `.loopx/` → exits 0 AND `loopx env list` subsequently shows `FOO=bar`. *(Spec 5.4)*
- **T-SUB-14**: `loopx env set` creates the config directory (`$XDG_CONFIG_HOME/loopx/`) if it doesn't exist. *(Spec 8.1)*
- **T-SUB-14a**: `loopx env set KEY "value with spaces"` → `loopx env list` shows `KEY=value with spaces`. *(Spec 4.3)*
- **T-SUB-14b**: `loopx env set KEY "value#hash"` → value preserved including `#`. *(Spec 4.3)*
- **T-SUB-14c**: `loopx env set KEY "val=ue"` → value with `=` round-trips correctly. *(Spec 4.3)*
- **T-SUB-14d**: `loopx env set KEY <value containing an actual newline byte>` → rejected. Exit code 1. *(Spec 4.3)*
- **T-SUB-14e**: `loopx env set KEY 'val"ue'` → `loopx env list` shows `KEY=val"ue`. *(Spec 4.3)*
- **T-SUB-14f**: `loopx env set KEY "value  "` → `loopx env list` shows `KEY=value  `. Trailing spaces preserved. *(Spec 4.3)*
- **T-SUB-14g**: `loopx env set KEY <value containing an actual CR byte>` → rejected. Exit code 1. *(Spec 4.3)*

#### `loopx env set` On-Disk Serialization

- **T-SUB-14h**: `loopx env set FOO bar` → read the global env file. Assert it contains the line `FOO="bar"\n`. *(Spec 4.3)*
- **T-SUB-14i**: `loopx env set FOO "value with spaces"` → file contains `FOO="value with spaces"\n`. *(Spec 4.3)*
- **T-SUB-14j**: `loopx env set FOO 'val"ue'` → file contains `FOO="val"ue"\n` (no escaping). *(Spec 4.3)*
- **T-SUB-14k**: `loopx env set FOO ""` (empty value) → file contains `FOO=""\n`. *(Spec 4.3)*

#### `loopx env remove`

- **T-SUB-15**: `loopx env set FOO bar` then `loopx env remove FOO` then `loopx env list` — `FOO` is absent. *(Spec 4.3)*
- **T-SUB-16**: `loopx env remove NONEXISTENT` exits with code 0 (silent no-op). *(Spec 4.3)*

#### `loopx env list`

- **T-SUB-17**: With no variables set, `loopx env list` produces no stdout output, exits 0. *(Spec 4.3)*
- **T-SUB-18**: With variables `ZEBRA=z`, `ALPHA=a`, `MIDDLE=m` set, `loopx env list` outputs them sorted: `ALPHA=a`, `MIDDLE=m`, `ZEBRA=z`. *(Spec 4.3)*
- **T-SUB-19**: `loopx env list` in a directory with no `.loopx/` → exits 0 and produces no stdout. *(Spec 5.4)*

### 4.3 Workflow & Script Discovery

**Spec refs:** 2.1, 5.1–5.4

#### Workflow Discovery

- **T-DISC-01**: `.loopx/ralph/` containing `index.sh` is a valid workflow. `loopx run -n 1 ralph` runs the `index.sh` script. Assert via marker file. *(Spec 2.1, 5.1)*
- **T-DISC-02**: `.loopx/ralph/` containing `index.ts` is a valid workflow. `loopx run -n 1 ralph` runs it. Assert via marker file. *(Spec 2.1, 5.1)*
- **T-DISC-03**: `.loopx/ralph/` containing `index.js` is a valid workflow. Assert via marker file. *(Spec 2.1, 5.1)*
- **T-DISC-04**: `.loopx/ralph/` containing `index.jsx` is a valid workflow. Assert via marker file. *(Spec 2.1, 5.1)*
- **T-DISC-05**: `.loopx/ralph/` containing `index.tsx` is a valid workflow. Assert via marker file. *(Spec 2.1, 5.1)*
- **T-DISC-06**: `.loopx/ralph/` containing only `index.mjs` → not recognized as a workflow (`.mjs` is unsupported). `loopx run -n 1 ralph` fails with "not found." *(Spec 2.1, 5.1)*
- **T-DISC-07**: `.loopx/ralph/` containing only `index.cjs` → not recognized as a workflow. *(Spec 2.1, 5.1)*
- **T-DISC-08**: `.loopx/ralph/` containing only `readme.txt` and `config.json` → not a workflow (no supported script extensions). `loopx run -n 1 ralph` fails. No warning. *(Spec 2.1, 5.1)*
- **T-DISC-09**: Empty subdirectory `.loopx/ralph/` → not a workflow (no script files). `loopx run -n 1 ralph` fails. No warning. *(Spec 5.1)*
- **T-DISC-10**: Files placed directly in `.loopx/` are never discovered. `.loopx/loose-script.sh` exists alongside `.loopx/ralph/index.sh`. `loopx run -n 1 loose-script` fails (not found). `loopx run -n 1 ralph` succeeds. *(Spec 5.1)*
- **T-DISC-11**: `.loopx/loose-script.ts` directly in `.loopx/` is not discovered even if it has a supported extension. Assert `loopx run -n 1 loose-script` fails. *(Spec 5.1)*
- **T-DISC-10a**: Flat-script explicit no-migration-warning test. `.loopx/loose-script.sh` exists alongside a valid workflow (`.loopx/ralph/index.sh`). `loopx run loose-script` fails with exit code 1 (not found). Additionally assert that stderr does not contain deprecation, migration, or legacy hints (e.g., no "migrate", "upgrade", "legacy", "deprecated", "flat script", or "move" language). This is the flat-script counterpart to T-DISC-20c (legacy directory-script no-migration-warning), explicitly locking down the ADR-0003 consequence that no migration warnings are provided for any legacy layout. *(Spec 5.1)*
- **T-DISC-10b**: An invalid loose file directly under `.loopx/` is ignored, not just valid ones. `.loopx/-bad-name.sh` exists (a name that would fail name restriction validation if it were inside a workflow) alongside a valid workflow (`.loopx/ralph/index.sh`). `loopx run -n 1 ralph` succeeds with no errors or warnings about the invalid file. This proves flat-root files are completely outside discovery and validation — they are not scanned, named, or validated at all. *(Spec 5.1)*

#### Script Discovery Within Workflows

- **T-DISC-12**: All top-level files with supported extensions inside a workflow are discovered as scripts. `.loopx/ralph/` contains `index.sh`, `check-ready.sh`, `setup.ts`. `loopx run -n 1 ralph:check-ready` runs `check-ready.sh`. `loopx run -n 1 ralph:setup` runs `setup.ts`. Assert via marker files. *(Spec 2.1, 5.1)*
- **T-DISC-13**: Script name is the base name without extension. `.loopx/ralph/my-check.ts` → script name is `my-check`. `loopx run -n 1 ralph:my-check` runs it. *(Spec 2.1)*
- **T-DISC-14**: Files in subdirectories within a workflow are NOT discovered. `.loopx/ralph/lib/helpers.ts` exists. `loopx run -n 1 ralph:helpers` fails. The `lib/` subdirectory is ignored during script discovery. *(Spec 2.1, 5.1)*
- **T-DISC-15**: Non-script files inside a workflow are allowed and ignored. `.loopx/ralph/` contains `index.ts`, `schema.json`, `README.md`. The non-script files do not cause warnings. `loopx run -n 1 ralph` works. *(Spec 2.1)*
- **T-DISC-15a**: Config-style file with a supported extension is discovered as a script (no exclusion mechanism). `.loopx/ralph/` contains `index.ts` and `eslint.config.js`. Discovery treats `eslint.config.js` as a script with base name `eslint.config`. The dot in `eslint.config` violates the name restriction pattern `[a-zA-Z0-9_][a-zA-Z0-9_-]*`. `loopx run ralph` fails (exit code 1) due to global validation catching the invalid script name. *(Spec 2.1, 5.3)*
- **T-DISC-15b**: Same setup as T-DISC-15a but via `loopx run -h`. The invalid script name `eslint.config` is reported as a non-fatal warning on stderr. Assert that the warning text contains the offending script name. Help still exits 0. This locks down the ADR-0003 rule that there is no exclusion mechanism — every top-level file with a supported extension is a discovered script, even config-style files. *(Spec 2.1, 5.3, 11.2)*
- **T-DISC-16**: Workflow directory with no top-level supported script files — only supported-extension files in subdirectories (e.g., `.loopx/ralph/lib/helpers.ts` exists but no `.loopx/ralph/*.{sh,js,jsx,ts,tsx}`) — is not recognized as a valid workflow. *(Spec 2.1, 5.1)*

#### Default Entry Point

- **T-DISC-17**: `loopx run ralph` runs `ralph:index`. Create `.loopx/ralph/index.sh` and `.loopx/ralph/check.sh`. Assert `loopx run -n 1 ralph` runs `index.sh` (via marker file), not `check.sh`. *(Spec 2.1)*
- **T-DISC-18**: `loopx run ralph:index` is equivalent to `loopx run ralph`. Assert both produce the same marker file content. *(Spec 2.1, 4.1)*
- **T-DISC-19**: Workflow with no `index` script: `loopx run ralph` → error (exit code 1). `loopx run ralph:check` with `check.sh` present → succeeds. *(Spec 2.1, 4.1)*
- **T-DISC-20**: `index` is not otherwise special. It can be the target of `goto`, follows collision rules, can `goto` other scripts. Create a chain: `ralph:index` → goto `check` → `ralph:check` produces stop. Assert both scripts execute. *(Spec 2.1)*
- **T-DISC-20a**: `package.json` `main` field is ignored for entry point resolution. Create `.loopx/ralph/` with `package.json` containing `{ "main": "check.ts" }`, `index.ts`, and `check.ts`. `loopx run -n 1 ralph` runs `index.ts`, not `check.ts`. Assert via marker files that `index.ts` executed and `check.ts` did not. *(Spec 2.1)*
- **T-DISC-20b**: `package.json` `main` field does not provide a fallback entry point. Create `.loopx/ralph/` with `package.json` containing `{ "main": "check.ts" }` and `check.ts` but NO `index` script. `loopx run ralph` → error (exit code 1, missing default entry point). The `main` field is ignored. *(Spec 2.1)*
- **T-DISC-20c**: A legacy-style directory-script layout is not discovered as a workflow, and loopx does not emit migration warnings. Create `.loopx/mypipeline/` with `package.json` containing `{ "main": "src/run.js" }` and no top-level files with supported script extensions (place `run.js` inside a `src/` subdirectory so no top-level supported-extension files exist). The subdirectory is not a workflow (no top-level supported-extension files). `loopx run mypipeline` fails with exit code 1. Additionally assert that stderr does not contain migration-related messaging (e.g., no "migrate", "upgrade", "legacy", or "directory script" language). The spec states legacy layouts are simply not recognized — no migration tooling or warnings are provided. *(Spec 2.1, 5.1)*

#### Name Collisions Within Workflows

- **T-DISC-21**: `.loopx/ralph/check.sh` and `.loopx/ralph/check.ts` both exist → `loopx run -n 1 ralph:check` refuses to start with error listing the conflicting entries. Exit code 1. *(Spec 5.2)*
- **T-DISC-21a**: `index` follows the same collision rules as any other script. `.loopx/ralph/index.sh` and `.loopx/ralph/index.ts` both exist → `loopx run -n 1 ralph` refuses to start with error listing the conflicting `index` entries. Exit code 1. A bad implementation could special-case `index` and still pass collision tests that only use non-index names (T-DISC-21). *(Spec 2.1, 5.2)*
- **T-DISC-22**: Same-base-name collision in one workflow is fatal for any target in any workflow. `.loopx/ralph/check.sh` and `.loopx/ralph/check.ts` exist, `.loopx/other/index.sh` is valid. `loopx run -n 1 other` still fails because global validation catches ralph's collision. *(Spec 5.2, 5.4)*
- **T-DISC-23**: Same base names in **different** workflows are allowed. `.loopx/ralph/check.sh` and `.loopx/other/check.ts` coexist without collision. Both `loopx run -n 1 ralph:check` and `loopx run -n 1 other:check` succeed. *(Spec 5.2)*
- **T-DISC-24**: Non-conflicting scripts within the same workflow → no error. `.loopx/ralph/alpha.sh` and `.loopx/ralph/beta.ts` coexist. *(Spec 5.2)*

#### Workflow and Script Naming

- **T-DISC-25**: Workflow name restrictions follow `[a-zA-Z0-9_][a-zA-Z0-9_-]*`. `.loopx/my-workflow/index.sh` → valid. *(Spec 5.3)*
- **T-DISC-26**: `.loopx/_underscore/index.sh` → valid workflow name. *(Spec 5.3)*
- **T-DISC-27**: `.loopx/-startswithdash/index.sh` → invalid workflow name, error. *(Spec 5.3)*
- **T-DISC-28**: `.loopx/has space/index.sh` → invalid workflow name (space not allowed). *(Spec 5.3)*
- **T-DISC-29**: `.loopx/has.dot/index.sh` → invalid workflow name (dot not allowed). *(Spec 5.3)*
- **T-DISC-30**: Script name `check-ready` (hyphen in middle) → valid. *(Spec 5.3)*
- **T-DISC-30a**: Script name `1start` (digit first) → valid per `[a-zA-Z0-9_]`. *(Spec 5.3)*
- **T-DISC-30b**: Script name `42` (all digits) → valid. *(Spec 5.3)*
- **T-DISC-31**: Script name with `:` → error. The `:` is explicitly disallowed in both workflow and script names. *(Spec 5.3)*
- **T-DISC-32**: Workflow name with `:` → error. *(Spec 5.3)*

#### Previously Reserved Names (Now Allowed)

- **T-DISC-33**: `.loopx/output/index.sh` is discoverable. `loopx run -n 1 output` runs the script (not the built-in `output` subcommand). Assert via marker file. *(Spec 4.1, 5.1)*
- **T-DISC-34**: `.loopx/env/index.ts` is discoverable. `loopx run -n 1 env` runs the script. *(Spec 5.1)*
- **T-DISC-35**: `.loopx/install/index.js` is discoverable. `loopx run -n 1 install` runs the script. *(Spec 5.1)*
- **T-DISC-36**: `.loopx/version/index.sh` is discoverable. `loopx run -n 1 version` runs the script (not the built-in). *(Spec 4.1, 5.1)*
- **T-DISC-37**: `.loopx/run/index.sh` is discoverable. `loopx run -n 1 run` runs the workflow named `run`. *(Spec 4.1, 5.1)*
- **T-DISC-38**: `loopx run -h` with `.loopx/` containing **only** workflows named `version`, `output`, `env`, `install`, and `run` lists all five workflows and stderr is empty. No warnings about these names. *(Spec 5.1, 11.2)*

#### Symlinks

- **T-DISC-39**: Symlink to a workflow directory inside `.loopx/` → discovered under the **symlink's own name**, not the target directory's name. Create a workflow directory outside `.loopx/` (e.g., `/tmp/real-workflow/` with `index.sh`), then symlink `.loopx/my-alias/ → /tmp/real-workflow/`. `loopx run -n 1 my-alias` succeeds. `loopx run -n 1 real-workflow` fails (not discovered under the target's name). *(Spec 5.1)*
- **T-DISC-39a**: `LOOPX_WORKFLOW` reflects the symlink name for a symlinked workflow. Same setup as T-DISC-39. Script writes `$LOOPX_WORKFLOW` to a marker file. Assert marker contains `my-alias`, not the real directory's name. *(Spec 5.1, 8.3)*
- **T-DISC-40**: Symlinked script file inside a workflow → discovered and targetable by the **symlink's base name**, not the original file's name. Create `.loopx/ralph/` with `index.sh` and a symlink `my-check.sh → /tmp/original-check.sh`. `loopx run -n 1 ralph:my-check` succeeds. `loopx run -n 1 ralph:original-check` fails (not discovered under the target's name). *(Spec 5.1)*

#### Discovery Caching

- **T-DISC-41**: During a loop (`-n 3`), create a new workflow in `.loopx/` between iteration 1 and 2 (using a script that creates a directory with a script file). Then have iteration 2 `goto` a script in the new workflow → error (not in cached discovery). *(Spec 5.1)*
- **T-DISC-42**: During a loop, modify the content of an already-discovered script between iterations. Assert the new content takes effect on the next iteration (since the file is re-read from disk). *(Spec 5.1)*
- **T-DISC-42a**: During a multi-iteration loop, an already-discovered script is removed (deleted from disk) between iterations. On the next iteration that would execute this script, loopx fails at spawn time. Assert loopx exits with code 1. *(Spec 5.1, 7.2)*

#### Validation Scope

- **T-DISC-43**: `loopx version` works when `.loopx/` doesn't exist. *(Spec 5.4)*
- **T-DISC-44**: `loopx env set X Y` when `.loopx/` doesn't exist → exits 0. *(Spec 5.4)*
- **T-DISC-45**: `loopx output --result "x"` when `.loopx/` doesn't exist → exits 0. *(Spec 5.4)*
- **T-DISC-46**: `loopx version` when `.loopx/` exists and contains name collisions → exits 0 with version string. No validation warnings. *(Spec 5.4)*
- **T-DISC-47**: `loopx install <source>` when `.loopx/` exists and contains collisions → install succeeds for a non-colliding workflow. Install validates the source workflows, not all of `.loopx/`. *(Spec 5.4, 10.5)*
- **T-DISC-47a**: Invalid script name in a sibling workflow is fatal in normal run mode. Create `.loopx/ralph/index.sh` (valid) and `.loopx/broken/-bad.sh` (invalid script name). `loopx run ralph` → exits with code 1. Global validation catches the invalid name in the sibling workflow before execution begins. This is the normal-run-mode counterpart to T-CLI-22d (`-n 0`) and the name-restriction analogue to T-DISC-22 (sibling collision). *(Spec 5.3, 5.4)*
- **T-DISC-47b**: Invalid workflow name in a sibling workflow is fatal in normal run mode. Create `.loopx/good/index.sh` (valid) and `.loopx/-bad-workflow/index.sh` (invalid workflow name). `loopx run good` → exits with code 1. Global validation catches the invalid workflow name in the sibling before execution begins. This is the workflow-name counterpart to T-DISC-47a (sibling invalid script name) and the normal-run-mode counterpart to T-CLI-120 (invalid workflow name non-fatal in `run -h`). *(Spec 5.3, 5.4)*

#### Discovery Scope

- **T-DISC-48**: A parent directory has `.loopx/` with workflows, but the current working directory does not have `.loopx/`. `loopx run ralph` in the child directory fails — parent `.loopx/` is not discovered. *(Spec 5.1)*

### 4.4 Script Execution

**Spec refs:** 6.1–6.5

#### Working Directory

- **T-EXEC-01**: Script in workflow `.loopx/ralph/index.sh` writes `$PWD` to a marker file. Assert the marker file content equals the absolute path of `.loopx/ralph/` (the workflow directory), **not** the project root. *(Spec 6.1)*
- **T-EXEC-02**: A different workflow `.loopx/other/index.sh` writes `$PWD` to a marker file. Assert it equals `.loopx/other/`. *(Spec 6.1)*
- **T-EXEC-03**: Script writes `$LOOPX_PROJECT_ROOT` to a marker file. Assert marker content equals the invocation directory (project root), not the workflow directory. *(Spec 6.1)*
- **T-EXEC-04**: `LOOPX_WORKFLOW` is injected correctly. Script writes `$LOOPX_WORKFLOW` to a marker file. Assert marker content equals the workflow name (e.g., `ralph`). *(Spec 8.3)*
- **T-EXEC-04a**: `LOOPX_WORKFLOW` overrides inherited/env-file values. Set `LOOPX_WORKFLOW=fake` in global env and spawn with `LOOPX_WORKFLOW=fake` in the process environment. Script writes `$LOOPX_WORKFLOW` to a marker file. Assert marker contains the real workflow name, not `"fake"`. *(Spec 8.3)*
- **T-EXEC-04b**: Cross-workflow goto updates `LOOPX_WORKFLOW`. Script `ralph:index` outputs `goto:"other:check"`. Script `other:check` writes `$LOOPX_WORKFLOW` to a marker file. Assert marker contains `other`, not `ralph`. *(Spec 8.3)*

#### Bash Scripts

- **T-EXEC-05**: A `.sh` script runs successfully and its stdout is captured as structured output. Observe via `runPromise("ralph", { maxIterations: 1 })`: the yielded Output contains the expected `result`. *(Spec 6.2)*
- **T-EXEC-06**: A `.sh` script's stderr appears on the CLI's stderr (pass-through). *(Spec 6.2)*
- **T-EXEC-07**: A `.sh` script that lacks `#!/bin/bash` still runs (loopx invokes via `/bin/bash` explicitly). Assert actual execution via marker file. *(Spec 6.2)*

#### JS/TS Scripts

- **T-EXEC-08**: `.ts` script runs and produces structured output. Observe via `runPromise("ralph", { maxIterations: 1 })`. *(Spec 6.3)*
- **T-EXEC-09**: `.js` script runs and produces structured output. *(Spec 6.3)*
- **T-EXEC-10**: `.tsx` script runs and produces structured output. The fixture **must use actual TSX syntax** to verify JSX transformation. *(Spec 6.3)*
- **T-EXEC-11**: `.jsx` script runs and produces structured output. The fixture **must use actual JSX syntax**. *(Spec 6.3)*
- **T-EXEC-12**: JS/TS script stderr passes through to CLI stderr. *(Spec 6.3)*
- **T-EXEC-13**: JS/TS script can use TypeScript type annotations (verifies tsx handles TS syntax under Node.js). `[Node]` *(Spec 6.3)*
- **T-EXEC-13b**: JS/TS script can use TypeScript type annotations under Bun. `[Bun]` *(Spec 6.3)*
- **T-EXEC-13a**: A `.js` script that uses `require()` (CJS) fails with an error. CJS is not supported. *(Spec 6.3)*
- **T-EXEC-14**: `[Bun]` When running under Bun, JS/TS scripts are executed via Bun's native runtime, not `tsx`. *(Spec 6.3)*

#### Workflow-Local Dependencies

- **T-EXEC-15**: Workflow with its own `node_modules/` can import from local dependencies. Setup: create a workflow with a local dependency in `node_modules/`. Script writes a marker file confirming the import succeeded. *(Spec 2.1)*
- **T-EXEC-16**: Workflow CWD is the workflow directory. TS script writes `process.cwd()` to a marker file. Assert marker content matches the workflow's directory path (e.g., `.loopx/ralph/`). *(Spec 6.1)*
- **T-EXEC-16a**: Workflow that imports a package not present in its `node_modules/` — the script fails with a module resolution error from the active runtime, and loopx exits with code 1. *(Spec 2.1)*
- **T-EXEC-16b**: Cross-workflow goto preserves per-workflow cwd. Set up `ralph:index` to output `goto:"other:check"`. Script `other:check` writes `$PWD` (bash) or `process.cwd()` (TS) to a marker file. Assert the marker content equals the absolute path of `.loopx/other/`, not `.loopx/ralph/`. This proves cwd switches to the target workflow's directory on cross-workflow goto — locking down ADR-0003 behavior that each workflow's scripts always execute in their own workflow directory, even when reached via cross-workflow transition. *(Spec 6.1, 2.2)*

### 4.5 Structured Output Parsing

**Spec refs:** 2.3

These tests use bash fixture scripts that echo specific strings to stdout. **Parsing correctness is asserted by examining the actual yielded `Output` object** via the programmatic API (`run()`, `runPromise()`, or `runAPIDriver()`), not by inferring from loop behavior alone.

All fixture scripts live inside a workflow (e.g., `.loopx/test/index.sh`). The `runPromise` calls use the workflow name.

#### Valid Structured Output

- **T-PARSE-01**: Script outputs `{"result":"hello"}`. Assert via `runPromise("test", { maxIterations: 1 })`: yielded Output is `{ result: "hello" }`. *(Spec 2.3)*
- **T-PARSE-02**: Script outputs `{"goto":"next"}` → loopx transitions to script `next` (within the same workflow). *(Spec 2.3)*
- **T-PARSE-03**: Script outputs `{"stop":true}` → loop halts, exit code 0. *(Spec 2.3)*
- **T-PARSE-04**: Script outputs `{"result":"x","goto":"next","stop":true}` → stop takes priority, loop halts. *(Spec 2.3)*
- **T-PARSE-05**: Script outputs `{"result":"x","extra":"ignored"}`. Assert via `runPromise("test", { maxIterations: 1 })`: yielded Output has `result: "x"` and no `extra` property. *(Spec 2.3)*

#### Fallback to Raw Result

- **T-PARSE-06**: Script outputs `{"unknown":"field"}` (valid JSON object, no known fields). Assert via `runPromise("test", { maxIterations: 1 })`: yielded Output is `{ result: '{"unknown":"field"}' }`. *(Spec 2.3)*
- **T-PARSE-07**: Script outputs `[1,2,3]` (JSON array). Assert yielded Output has `result: "[1,2,3]"`. *(Spec 2.3)*
- **T-PARSE-08**: Script outputs `"hello"` (JSON string). Assert yielded Output has `result: '"hello"'`. *(Spec 2.3)*
- **T-PARSE-09**: Script outputs `42` (JSON number). Assert yielded Output has `result: "42"`. *(Spec 2.3)*
- **T-PARSE-10**: Script outputs `true` (JSON boolean). Assert yielded Output has `result: "true"`. *(Spec 2.3)*
- **T-PARSE-11**: Script outputs `null` (JSON null). Assert yielded Output has `result: "null"`. *(Spec 2.3)*
- **T-PARSE-12**: Script outputs `not json at all`. Assert yielded Output has `result: "not json at all"`. *(Spec 2.3)*
- **T-PARSE-12a**: Raw fallback preserves exact stdout including trailing newline. Script outputs `hello\n`. Assert yielded Output has `result: "hello\n"`. *(Spec 2.3)*
- **T-PARSE-13**: Script produces empty stdout. Assert yielded Output is `{ result: "" }`. *(Spec 2.3)*

#### Type Coercion

- **T-PARSE-14**: `{"result": 42}`. Assert yielded Output has `result: "42"` (coerced via `String()`). *(Spec 2.3)*
- **T-PARSE-15**: `{"result": true}`. Assert yielded Output has `result: "true"`. *(Spec 2.3)*
- **T-PARSE-16**: `{"result": {"nested": "obj"}}`. Assert yielded Output has `result: "[object Object]"`. *(Spec 2.3)*
- **T-PARSE-17**: `{"result": null}`. Assert yielded Output has `result: "null"`. *(Spec 2.3)*
- **T-PARSE-18**: `{"goto": 42}` (goto is not a string). Assert yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-19**: `{"goto": true}`. Assert yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-20**: `{"goto": null}`. Assert yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-21**: `{"stop": "true"}` (string, not boolean). Assert yielded Output is exactly `{}`. Loop continues. *(Spec 2.3)*
- **T-PARSE-22**: `{"stop": 1}`. Assert yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-23**: `{"stop": false}`. Assert yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-24**: `{"stop": "false"}`. Assert yielded Output is exactly `{}`. *(Spec 2.3)*
- **T-PARSE-20a**: `{"goto":""}` (empty string goto). An empty string IS a string, so parser preserves it. Assert the generator throws an error on the first iteration (because `""` is not a valid target). *(Spec 2.3, 4.1)*

#### Mixed Valid/Invalid Fields

- **T-PARSE-28**: `{"result":"x","goto":42}` (valid result + invalid goto). Assert yielded Output is exactly `{ result: "x" }`. *(Spec 2.3)*
- **T-PARSE-29**: `{"result":"x","stop":"true"}` (valid result + invalid stop). Assert yielded Output is exactly `{ result: "x" }`. *(Spec 2.3)*

#### Whitespace & Formatting

- **T-PARSE-25**: Script outputs JSON with trailing newline `{"result":"x"}\n`. Parsed correctly. *(Spec 2.3)*
- **T-PARSE-26**: Script outputs pretty-printed JSON (with newlines and indentation). Parsed correctly. *(Spec 2.3)*
- **T-PARSE-27**: Script outputs JSON with leading whitespace. Parsed correctly. *(Spec 2.3)*

### 4.6 Loop State Machine

**Spec refs:** 2.2, 7.1, 7.2, 6.6, 6.7

#### Basic Loop Behavior

- **T-LOOP-01**: Script produces no output → loop resets, starting target runs again. Use counter fixture with `-n 3` and verify 3 runs. *(Spec 2.2, 7.1)*
- **T-LOOP-02**: Script A (`ralph:index`) → `goto:"check"` → `ralph:check` produces no output → starting target `ralph:index` runs again. With `-n 4`, assert A ran twice, check ran twice. *(Spec 2.2)*
- **T-LOOP-03**: `ralph:index` → `goto:"setup"` → `ralph:setup` → `goto:"check"` → `ralph:check` → no goto → back to `ralph:index`. With `-n 4`, assert execution order index, setup, check, index. *(Spec 2.2)*
- **T-LOOP-04**: Script outputs `{"stop":true}` on first iteration → loop runs once, exits 0. *(Spec 2.2)*
- **T-LOOP-05**: Script runs 3 times then outputs `{"stop":true}` on 4th. Assert exactly 4 iterations. *(Spec 2.2)*

#### `-n` Counting

- **T-LOOP-06**: `-n 1` → exactly 1 iteration. *(Spec 7.1)*
- **T-LOOP-07**: `-n 3` with script that never stops → exactly 3 iterations. *(Spec 7.1)*
- **T-LOOP-08**: `-n 3` with `ralph:index` → `goto:"check"` → `ralph:check` → no goto. Execution: index, check, index. That's 3 iterations. *(Spec 7.1)*
- **T-LOOP-09**: `-n 2` with `ralph:index` → `goto:"check"`. Execution: index (1), check (2). *(Spec 7.1)*
- **T-LOOP-10**: `-n 0` → no iterations, script never runs. *(Spec 7.1)*

#### Input Piping

- **T-LOOP-11**: `ralph:index` outputs `{"result":"payload","goto":"reader"}`. `ralph:reader` reads stdin and outputs the received value as its result. Observe via `runPromise("ralph", { maxIterations: 2 })`: the second yielded Output has `result: "payload"`. *(Spec 6.6)*
- **T-LOOP-12**: `ralph:index` outputs `{"goto":"reader"}` (no result). `ralph:reader` reads stdin → empty string. *(Spec 2.3, 6.6)*
- **T-LOOP-13**: `ralph:index` outputs `{"result":"payload"}` (no goto). Loop resets to index. Index reads stdin → empty string (result not piped on reset). *(Spec 6.6)*
- **T-LOOP-14**: First iteration receives empty stdin. *(Spec 6.7)*
- **T-LOOP-15**: Chain A → goto B with result → B → goto C with result → C reads stdin and gets B's result, not A's. *(Spec 6.6)*
- **T-LOOP-15a**: Cross-workflow stdin piping. `ralph:index` outputs `{"result":"cross-payload","goto":"other:reader"}`. `other:reader` reads stdin and outputs the received value as its result. Observe via `runPromise("ralph", { maxIterations: 2 })`: the second yielded Output has `result: "cross-payload"`. Proves `result` crosses the workflow boundary via stdin. *(Spec 6.6, 2.2)*

#### Goto Semantics — Intra-Workflow

- **T-LOOP-16**: Goto is a transition, not permanent. `ralph:index` → `goto:"check"` → `ralph:check` → no goto → `ralph:index` runs again (not check). *(Spec 2.2)*
- **T-LOOP-17**: Self-referencing goto. `ralph:index` → `goto:"index"`. With `-n 2`, index runs twice. *(Spec 2.2)*
- **T-LOOP-18**: Goto target that doesn't exist within the workflow → error, exit code 1. *(Spec 7.2)*
- **T-LOOP-18a**: `{"goto":""}` (empty string goto) → error, exit code 1. *(Spec 2.3, 4.1, 7.2)*
- **T-LOOP-19**: Goto to a script name that exists in a different workflow but not the current one → error (bare goto resolves in current workflow). *(Spec 2.2, 7.2)*
- **T-LOOP-19a**: Bare goto matching an existing workflow name does not jump to that workflow's default entry point. Starting target: `ralph:index`. `ralph:index` emits `{"goto":"other"}`. `.loopx/other/index.sh` exists (a valid workflow with a default entry point). `.loopx/ralph/` has no `other.*` script. Expected: error (exit code 1), not a transition to `other:index`. In `goto`, a bare name is always a script in the current workflow, never another workflow's default entry point — the qualified form `"other:index"` is required for cross-workflow default-entry targeting. *(Spec 2.2, 7.2)*
- **T-LOOP-19b**: Positive bare-goto disambiguation: current-workflow script takes precedence over a same-named workflow. Set up: `.loopx/ralph/index.sh` (starting target), `.loopx/ralph/apply.sh` (a script in the current workflow), `.loopx/apply/index.sh` (another workflow also named `apply`). `ralph:index` emits `{"goto":"apply"}`. Expected: `ralph:apply` runs (bare goto resolves to the current workflow's `apply` script), not `apply:index`. Assert via marker file that `ralph/apply.sh` executed. *(Spec 2.2)*

#### Goto Semantics — Cross-Workflow

- **T-LOOP-30**: Qualified goto crosses workflows. `ralph:index` → `goto:"other:check"` → `other:check` runs. Assert via marker file that `other:check` executed. *(Spec 2.2)*
- **T-LOOP-31**: Qualified same-workflow goto works. `ralph:index` → `goto:"ralph:check"` is equivalent to bare `goto:"check"`. *(Spec 2.2)*
- **T-LOOP-31a**: Cross-workflow default-entry targeting via qualified goto. Starting target: `ralph:index`. `ralph:index` → `goto:"other:index"`. Assert `other:index` runs (via marker file). This tests the positive case of targeting another workflow's default entry point via goto — goto requires the qualified form `"workflow:index"` since a bare name resolves as a script within the current workflow. *(Spec 2.2, 4.1)*
- **T-LOOP-32**: Bare goto from a cross-workflow context resolves in the executing workflow, not the starting workflow. Starting target: `ralph:index`. `ralph:index` → `goto:"other:step1"`. `other:step1` → `goto:"step2"` (bare). Assert `other:step2` runs, not `ralph:step2`. *(Spec 2.2)*
- **T-LOOP-33**: Loop reset always returns to the starting target. Starting target: `ralph:index`. `ralph:index` → `goto:"other:check"` → `other:check` → no goto → loop resets to `ralph:index` (not `other:index`). *(Spec 2.2)*
- **T-LOOP-34**: Missing workflow in qualified goto → error, exit code 1. `ralph:index` → `goto:"nonexistent:check"`. *(Spec 7.2)*
- **T-LOOP-35**: Missing script in target workflow → error, exit code 1. `ralph:index` → `goto:"other:nonexistent"`. *(Spec 7.2)*
- **T-LOOP-36**: Malformed goto target → error at transition time. `ralph:index` → `goto:":script"` (leading colon). *(Spec 4.1, 7.2)*
- **T-LOOP-37**: Malformed goto target → error. `ralph:index` → `goto:"a:b:c"` (multiple colons). *(Spec 4.1, 7.2)*
- **T-LOOP-38**: Malformed goto target → error. `ralph:index` → `goto:":"` (bare colon). *(Spec 4.1, 7.2)*
- **T-LOOP-39**: Malformed goto target → error. `ralph:index` → `goto:"other:"` (trailing colon). *(Spec 4.1, 7.2)*
- **T-LOOP-40**: Goto with name restriction failure in bare name. `ralph:index` → `goto:"-bad"`. Error, exit code 1. *(Spec 4.1, 5.3, 7.2)*
- **T-LOOP-41**: Goto with name restriction failure in qualified target's script portion. `ralph:index` → `goto:"other:-bad"`. Error, exit code 1. *(Spec 4.1, 5.3, 7.2)*
- **T-LOOP-42**: Goto with name restriction failure in qualified target's workflow portion. `ralph:index` → `goto:"-bad:index"`. Error, exit code 1. *(Spec 4.1, 5.3, 7.2)*
- **T-LOOP-43**: Reset to explicit script starting target (not the workflow default). Starting target: `ralph:check` (not `index`). `ralph:check` → `goto:"other:step"` → `other:step` → no goto → loop resets to `ralph:check`, not `ralph:index`. Assert via counter/marker files that `ralph:check` runs again. *(Spec 2.2)*

#### Error Handling

- **T-LOOP-20**: Script exits with code 1 → loop stops immediately. loopx exits with code 1. *(Spec 7.2)*
- **T-LOOP-21**: Script exits with code 2 → same behavior (any non-zero is an error). *(Spec 7.2)*
- **T-LOOP-22**: Script fails on iteration 3 of 5 (`-n 5`). Assert exactly 3 iterations ran. *(Spec 7.2)*
- **T-LOOP-23**: Script's stderr output on failure is visible on CLI stderr. *(Spec 7.2)*
- **T-LOOP-24**: Script's stdout on failure is NOT parsed as structured output. Observe via `run("ralph")`: the generator throws without yielding an Output for that iteration. *(Spec 7.2)*

#### Final Iteration Output

- **T-LOOP-25**: `-n 2` with script producing `{"result":"iter-N"}`. Both iterations' outputs are observable via programmatic API. *(Spec 7.1)*

### 4.7 Environment Variables

**Spec refs:** 8.1–8.3

All env tests use `withGlobalEnv` to isolate from the real user config.

#### Global Env File

- **T-ENV-01**: Variable set via `loopx env set` is available in a script. Use `write-env-to-file` fixture inside a workflow's `index.sh`. Assert the marker file contains the expected value. *(Spec 8.1, 8.3)*
- **T-ENV-02**: Variable removed via `loopx env remove` is no longer available. Use `observe-env` fixture. Assert `{ "present": false }`. *(Spec 8.1)*
- **T-ENV-03**: `XDG_CONFIG_HOME` is respected. *(Spec 8.1)*
- **T-ENV-04**: When `XDG_CONFIG_HOME` is unset, default is `~/.config`. Use `withIsolatedHome`. *(Spec 8.1)*
- **T-ENV-05**: Config directory created on first `env set`. *(Spec 8.1)*
- **T-ENV-05a**: Unreadable global env file → exits with code 1. **Conditional on `process.getuid() !== 0`.** *(Spec 8.1)*
- **T-ENV-05b**: Unreadable global env file via programmatic API → generator throws. **Conditional on `process.getuid() !== 0`.** *(Spec 8.1, 9.3)*
- **T-ENV-05c**: Unreadable global env file with `loopx env list` → exits with code 1. **Conditional on `process.getuid() !== 0`.** *(Spec 8.1)*
- **T-ENV-05d**: Unreadable global env file with `loopx env set` → exits with code 1. **Conditional on `process.getuid() !== 0`.** *(Spec 8.1)*
- **T-ENV-05e**: Unreadable global env file with `loopx env remove` → exits with code 1. **Conditional on `process.getuid() !== 0`.** *(Spec 8.1)*

#### Env File Parsing

All env file parsing tests below use `writeEnvFileRaw` to write exact file content, then a `write-env-to-file` fixture script inside a workflow to observe the parsed value via a marker file.

- **T-ENV-06**: `writeEnvFileRaw(path, "KEY=VALUE\n")`. Assert marker contains `VALUE`. *(Spec 8.1)*
- **T-ENV-07**: `writeEnvFileRaw(path, "# comment\nKEY=val\n")`. Assert `KEY=val`. *(Spec 8.1)*
- **T-ENV-08**: Blank lines ignored, `KEY=val` loaded. *(Spec 8.1)*
- **T-ENV-09**: Duplicate keys: last occurrence wins. *(Spec 8.1)*
- **T-ENV-10**: Double-quoted value → quotes stripped. *(Spec 8.1)*
- **T-ENV-11**: Single-quoted value → quotes stripped. *(Spec 8.1)*
- **T-ENV-12**: No escape sequences → literal `hello\nworld`. *(Spec 8.1)*
- **T-ENV-13**: Inline `#` is part of value. *(Spec 8.1)*
- **T-ENV-14**: Trailing whitespace on value trimmed. *(Spec 8.1)*
- **T-ENV-15**: `KEY = value` → invalid key (space before `=`). Warning on stderr. *(Spec 8.1)*
- **T-ENV-15f**: `KEY= value` → leading space in value preserved. *(Spec 8.1)*
- **T-ENV-15a**: `KEY=` → empty value. Variable is present with empty string. *(Spec 8.1)*
- **T-ENV-15b**: `KEY=a=b=c` → split on first `=`. *(Spec 8.1)*
- **T-ENV-15c**: `1BAD=val` → invalid key, line ignored with warning. *(Spec 8.1)*
- **T-ENV-15d**: `justtext` → malformed line, ignored with warning. *(Spec 8.1)*
- **T-ENV-15e**: Unmatched quotes → literal preserved. *(Spec 8.1)*

#### Local Env Override (`-e`)

- **T-ENV-16**: `-e local.env` loads variables into script. *(Spec 8.2)*
- **T-ENV-17**: `-e nonexistent.env` → error, exit 1. *(Spec 8.2)*
- **T-ENV-17a**: `-e unreadable.env` → error, exit 1. **Conditional on `process.getuid() !== 0`.** *(Spec 8.2)*
- **T-ENV-18**: Global has `X=global`, local has `X=local`. Script sees `local`. *(Spec 8.2)*
- **T-ENV-19**: Global has `A=1`, local has `B=2`. Both present. *(Spec 8.2)*

#### Injection Precedence

- **T-ENV-20**: `LOOPX_BIN` is always set, overrides user values. *(Spec 8.3)*
- **T-ENV-20a**: `LOOPX_BIN` overrides inherited system environment. *(Spec 8.3)*
- **T-ENV-21**: `LOOPX_PROJECT_ROOT` always set, overrides user-supplied value. *(Spec 8.3)*
- **T-ENV-21a**: `LOOPX_PROJECT_ROOT` overrides inherited system environment. *(Spec 8.3)*
- **T-ENV-21b**: `LOOPX_WORKFLOW` always set, overrides user-supplied value. Script writes `$LOOPX_WORKFLOW` to a marker file. Set `LOOPX_WORKFLOW=fake` in global env. Assert marker contains the real workflow name. *(Spec 8.3)*
- **T-ENV-22**: System env has `SYS_VAR=sys`, global env has `SYS_VAR=global`. Script sees `global`. *(Spec 8.3)*
- **T-ENV-23**: System env has `SYS_VAR=sys`, no loopx override. Script sees `sys`. *(Spec 8.3)*
- **T-ENV-24**: Full precedence chain. Assert local wins over global over system. *(Spec 8.3)*
- **T-ENV-24a**: `LOOPX_DELEGATED` is visible in script execution environments when inherited. Spawn loopx with `LOOPX_DELEGATED=1` in the inherited process environment. Script uses `observe-env` fixture for `LOOPX_DELEGATED`. Assert marker contains `{ "present": true, "value": "1" }`. The spec does not require loopx to scrub this variable before spawning scripts — it is part of the inherited system environment. *(Spec 8.3, 3.2)*
- **T-ENV-24b**: Empty-string value in local env file overrides non-empty global/system value. *(Spec 8.3)*

#### Env Caching

- **T-ENV-25**: During a multi-iteration loop, modify the global env file between iterations. Assert the marker contains the original value. *(Spec 8.1)*
- **T-ENV-25a**: During a multi-iteration loop with `-e`, modify the local env file between iterations. Assert original value persists. *(Spec 8.2)*
- **T-ENV-25b**: `loopx run -n 0 ralph` with an unreadable global env file → exits with code 1. Global env loading and validation happens before the `-n 0` short-circuit. **Conditional on `process.getuid() !== 0`.** *(Spec 4.2, 8.1)*
- **T-ENV-25c**: `loopx run -n 0 ralph` with a malformed-but-readable global env file (e.g., containing `1BAD=val`) → exits with code 0, stderr contains a parser warning for the invalid key. Proves global env files are actually parsed under `-n 0`, not just existence/readability checked. This is the global-env counterpart to T-CLI-22c (which covers the local `-e` file under `-n 0`). *(Spec 4.2, 8.1)*

### 4.8 Module Resolution & Script Helpers

**Spec refs:** 3.3, 3.4, 6.4, 6.5

#### `import from "loopx"` Resolution

- **T-MOD-01**: A TS script in a workflow with `import { output } from "loopx"` runs successfully under Node.js. `[Node]` *(Spec 3.3)*
- **T-MOD-02**: Same import works under Bun. `[Bun]` *(Spec 3.3)*
- **T-MOD-03**: A JS script with `import { output } from "loopx"` also works. *(Spec 3.3)*
- **T-MOD-03a**: A workflow that has its own `node_modules/loopx` (a different version) resolves `import from "loopx"` to the **local** package, not the running CLI's package. Standard module resolution applies — the closest `node_modules` wins. Assert that **no warning is emitted on stderr** for this scenario — per Spec 3.3, no warning is emitted for workflow-local `node_modules/loopx` resolution in v1. *(Spec 3.3, 2.1)*

#### `output()` Function

- **T-MOD-04**: `output({ result: "hello" })`. Observe via `runPromise("ralph", { maxIterations: 1 })`: yielded Output has `result: "hello"`. *(Spec 6.4)*
- **T-MOD-05**: `output({ result: "x", goto: "check" })`. Observe via `run("ralph")`: yielded Output has both fields, and loopx transitions. *(Spec 6.4)*
- **T-MOD-06**: `output({ stop: true })`. Loop completes after one iteration. *(Spec 6.4)*
- **T-MOD-07**: `output({})` (no known fields). Script crashes with non-zero exit code. *(Spec 6.4)*
- **T-MOD-08**: `output(null)`. Script crashes. *(Spec 6.4)*
- **T-MOD-09**: `output(undefined)`. Script crashes. *(Spec 6.4)*
- **T-MOD-10**: `output("string")`. Yielded Output has `result: "string"`. *(Spec 6.4)*
- **T-MOD-11**: `output(42)`. Yielded Output has `result: "42"`. *(Spec 6.4)*
- **T-MOD-12**: `output(true)`. Yielded Output has `result: "true"`. *(Spec 6.4)*
- **T-MOD-13**: `output({ result: "x", goto: undefined })`. Yielded Output has `result: "x"` and no `goto` property. *(Spec 6.4)*
- **T-MOD-13a**: `output([1, 2, 3])` (array, no known fields). Script crashes. *(Spec 6.4)*
- **T-MOD-13b**: `output({ result: undefined, goto: undefined, stop: undefined })`. Equivalent to `output({})`. Script crashes. *(Spec 6.4)*
- **T-MOD-13c**: `output({ foo: "bar" })`. Script crashes (no known fields). *(Spec 6.4)*
- **T-MOD-13d**: `output({ stop: false })`. Output accepted, but parsed as `{}` (stop must be exactly true). Loop continues. *(Spec 6.4, 2.3)*
- **T-MOD-13e**: `output({ goto: 42 })`. Output accepted, but parsed as `{}` (goto must be string). Loop resets. *(Spec 6.4, 2.3)*
- **T-MOD-13f**: `output({ result: null })`. Coerced to `"null"`. *(Spec 6.4, 2.3)*
- **T-MOD-13g**: `output({ goto: null })`. Parsed as `{}`. Loop resets. *(Spec 6.4, 2.3)*
- **T-MOD-13h**: JS/TS `output()` does not validate goto targets. Script calls `output({ goto: "a:b:c" })`. The script exits 0 (`output()` serializes the value without validation). Observe via `run("test")`: the first yielded Output has `goto: "a:b:c"`, then the generator throws an error at transition time (malformed goto target — multiple colons). This mirrors the CLI-helper non-validation behavior tested in T-SUB-02d. *(Spec 6.4)*
- **T-MOD-14**: Code after `output()` does not execute. *(Spec 6.4)*
- **T-MOD-14a**: Large-payload flush: `output({ result: "x".repeat(1_000_000) })`. Full 1 MB string preserved. *(Spec 6.4)*

#### `input()` Function

- **T-MOD-15**: `input()` returns empty string on first iteration. *(Spec 6.5)*
- **T-MOD-16**: `ralph:index` → `output({ result: "payload", goto: "reader" })` → `ralph:reader` calls `input()` → receives `"payload"`. *(Spec 6.5)*
- **T-MOD-17**: `input()` called twice returns the same value (cached). *(Spec 6.5)*
- **T-MOD-18**: `input()` returns a Promise. *(Spec 6.5)*

#### ESM-Only Package Contract

- **T-MOD-22**: `[Node]` `require("loopx")` from a CJS consumer fails with ERR_REQUIRE_ESM. *(Spec 1)*

#### `LOOPX_BIN` in Bash Scripts

**These tests use `withDelegationSetup` (or the real executable path), not `runCLI`.**

- **T-MOD-19**: Bash script uses `$LOOPX_BIN output --result "payload" --goto "reader"`. Assert the reader script receives `"payload"` via stdin. *(Spec 3.4)*
- **T-MOD-20**: Bash script writes `$LOOPX_BIN` to a marker file. Assert it contains a valid executable path. *(Spec 3.4)*
- **T-MOD-21**: Bash script runs `$LOOPX_BIN version` and captures stdout. Assert it matches the package version. *(Spec 3.4)*

### 4.9 Programmatic API

**Spec refs:** 9.1–9.5

**Runtime-matrix methodology:** All programmatic API tests that run under both Node.js and Bun use `runAPIDriver()` to spawn a driver process under the target runtime.

#### `run()` (AsyncGenerator)

- **T-API-01**: `run("ralph")` returns an async generator. Calling `next()` yields an `Output` object. *(Spec 9.1)*
- **T-API-02**: Generator yields one `Output` per iteration. With `maxIterations: 3`, collect all yields → array of 3 outputs. *(Spec 9.1)*
- **T-API-03**: Generator completes when `stop: true` is output. *(Spec 9.1)*
- **T-API-04**: Generator completes when `maxIterations` is reached. *(Spec 9.1)*
- **T-API-05**: The output from the final iteration is yielded before the generator completes. *(Spec 9.1)*
- **T-API-06**: Breaking out of `for await` loop after the first yield prevents further iterations. *(Spec 9.1)*
- **T-API-07**: `run("ralph", { cwd: "/path/to/project" })` resolves workflows relative to the given cwd. `cwd` is the **project root** — it controls where `.loopx/` is found and sets `LOOPX_PROJECT_ROOT`, but does not control the script's execution working directory (scripts always run with their workflow directory as cwd). The test must explicitly assert that `LOOPX_PROJECT_ROOT` equals the provided `cwd` value (via a marker file written by the script using `observe-env`), not just that discovery succeeded. *(Spec 9.5, 6.1)*
- **T-API-07a**: `RunOptions.cwd` does not control script execution cwd. Create a workflow in project A. Call `run("ralph", { cwd: projectA })`. Script writes `process.cwd()` to a marker file. Assert marker equals the workflow directory path (`.loopx/ralph/`), not `projectA`. *(Spec 9.5, 6.1)*
- **T-API-08**: `run("ralph", { maxIterations: 0 })` → generator completes immediately with no yields. *(Spec 9.5)*
- **T-API-08a**: `run("nonexistent", { maxIterations: 0 })` → generator throws on first `next()` (validation runs before zero-iteration short-circuit). *(Spec 9.1, 9.5, 7.1)*
- **T-API-08b**: `runPromise("ralph", { maxIterations: 0 })` skips workflow-level version checking, mirroring CLI `-n 0`. Set up `.loopx/ralph/` with `package.json` declaring a loopx version range not satisfied by the running version. Assert: (a) resolves with `[]`, and (b) no version mismatch warning on stderr. *(Spec 9.5, 3.2)*
- **T-API-08c**: `run("ralph", { maxIterations: 0 })` where `ralph` exists but has no `index` script → generator throws on first `next()`. Target resolution validates the default entry point even with `maxIterations: 0`. *(Spec 9.1, 9.5, 4.1)*
- **T-API-08d**: `run("ralph:missing", { maxIterations: 0 })` where `ralph` exists but script `missing` does not → generator throws on first `next()`. *(Spec 9.1, 9.5, 4.1)*
- **T-API-08e**: `run("ralph", { maxIterations: 0, envFile: "missing.env" })` → generator throws on first `next()`. Env file validation fires even with `maxIterations: 0`, mirroring CLI `-n 0` behavior (T-CLI-22a). *(Spec 9.1, 9.5, 4.2)*
- **T-API-08f**: `runPromise("ralph", { maxIterations: 0, envFile: "missing.env" })` → rejects. Env file validation fires even with `maxIterations: 0`, mirroring CLI `-n 0` behavior. *(Spec 9.2, 9.5, 4.2)*
- **T-API-08g**: `run("ralph", { maxIterations: 0 })` skips the entire version-check path, including `package.json` reading. Set up `.loopx/ralph/package.json` with an invalid semver range for `loopx` (e.g., `"loopx": "not-a-range"` in `dependencies`). Assert: generator completes with no yields, and no `package.json` or version-related warnings on stderr. This extends T-API-08b (which tests unsatisfied range via `runPromise`) to prove the entire runtime version-check path is skipped under `maxIterations: 0` — not just the range comparison. *(Spec 9.1, 9.5, 3.2)*

#### `run()` with Invalid `target`

`target` is a required parameter. In TypeScript, omitting it is a static type error. In JavaScript, or when the type check is bypassed, runtime-invalid `target` values are rejected lazily.

- **T-API-09**: `run(undefined as any)` returns a generator without throwing. On the first `next()`, the generator throws (invalid target). *(Spec 9.1)*
- **T-API-20h**: `run(null as any)` returns a generator without throwing. On first `next()`, throws. *(Spec 9.1)*
- **T-API-20i**: `run(42 as any)` returns a generator without throwing. On first `next()`, throws. *(Spec 9.1)*
- **T-API-30**: `run("")` (empty string target) returns a generator. On first `next()`, throws (invalid target). *(Spec 9.1, 4.1)*
- **T-API-31**: `run(":")` (bare colon target) returns a generator. On first `next()`, throws. *(Spec 9.1, 4.1)*
- **T-API-32**: `run(":script")` (leading colon). On first `next()`, throws. *(Spec 9.1, 4.1)*
- **T-API-33**: `run("workflow:")` (trailing colon). On first `next()`, throws. *(Spec 9.1, 4.1)*
- **T-API-34**: `run("a:b:c")` (multiple colons). On first `next()`, throws. *(Spec 9.1, 4.1)*
- **T-API-35a**: `run("-bad:index")` (workflow name violates name restrictions). On first `next()`, throws. *(Spec 9.1, 4.1)*
- **T-API-35b**: `run("ralph:-bad")` (script name violates name restrictions). On first `next()`, throws. *(Spec 9.1, 4.1)*
- **T-API-35c**: Invalid target format is rejected after discovery and global validation in the programmatic API, mirroring CLI T-CLI-114a. Create `.loopx/broken/check.sh` and `.loopx/broken/check.ts` (name collision) alongside `.loopx/valid/index.sh`. Call `run(":script")` — generator is returned (lazy). On first `next()`, the generator throws. Assert that the error mentions the name collision in `broken` — proving discovery and global validation ran before the invalid target format was rejected. *(Spec 9.1, 4.1, 5.4)*

#### `run()` Target Semantics

- **T-API-35**: `run("ralph")` runs `ralph:index`. *(Spec 9.1, 4.1)*
- **T-API-36**: `run("ralph:check-ready")` runs the `check-ready` script in the `ralph` workflow. *(Spec 9.1, 4.1)*
- **T-API-37**: `run("ralph:index")` is equivalent to `run("ralph")`. *(Spec 9.1, 4.1)*

#### `run()` Snapshot & Cancellation

- **T-API-09b**: `run()` cwd snapshot timing. Prove `cwd` was snapshotted at `run()` call time. *(Spec 9.1, 9.5)*
- **T-API-09a**: Manual iterator cancellation during a pending `next()`. Assert child process terminated and generator completes. *(Spec 9.1)*
- **T-API-09c**: `run()` options snapshot — mutating `maxIterations` after call has no effect. *(Spec 9.1)*

#### `run()` with AbortSignal

- **T-API-10**: `run("ralph", { signal })` — aborting terminates the loop, generator throws abort error. *(Spec 9.5)*
- **T-API-10a**: Aborting while child process is active terminates the child process group. *(Spec 9.5, 9.1)*
- **T-API-10b**: Pre-aborted signal → generator throws on first `next()`, no child spawned. *(Spec 9.5, 9.1)*
- **T-API-10c**: Signal aborted between iterations → next `next()` throws abort error. *(Spec 9.5, 9.1)*

#### `runPromise()`

- **T-API-11**: `runPromise("ralph", { maxIterations: 3 })` resolves with array of 3 `Output` objects. *(Spec 9.2)*
- **T-API-12**: `runPromise("ralph")` resolves when `stop: true`. *(Spec 9.2)*
- **T-API-13**: `runPromise("ralph")` rejects when script exits non-zero. *(Spec 9.3)*
- **T-API-14**: `runPromise("ralph", { maxIterations: 3, envFile: "local.env", cwd: project.dir })` resolves with correct outputs. *(Spec 9.2, 9.5)*

#### `runPromise()` Target Semantics

- **T-API-47**: `runPromise("ralph:check-ready", { maxIterations: 1 })` resolves with an array containing the Output from the `check-ready` script in the `ralph` workflow. This is the `runPromise()` counterpart to T-API-36 (`run()` with a qualified target). *(Spec 9.2, 4.1)*
- **T-API-48**: `runPromise("ralph:index", { maxIterations: 1 })` is equivalent to `runPromise("ralph", { maxIterations: 1 })` — both resolve with identical Output arrays. This is the `runPromise()` counterpart to T-API-37 (`run()` equivalence test). *(Spec 9.2, 4.1)*

#### `runPromise()` with Invalid `target`

- **T-API-14a**: `runPromise(undefined as any)` returns a rejected promise (not synchronous throw). *(Spec 9.2)*
- **T-API-14a2**: `runPromise(null as any)` returns a rejected promise. *(Spec 9.2)*
- **T-API-14a3**: `runPromise(42 as any)` returns a rejected promise. *(Spec 9.2)*
- **T-API-38**: `runPromise("")` rejects (empty target). *(Spec 9.2, 4.1)*
- **T-API-39**: `runPromise("a:b:c")` rejects (multiple colons). *(Spec 9.2, 4.1)*
- **T-API-40**: `runPromise(":")` rejects (bare colon). *(Spec 9.2, 4.1)*
- **T-API-41**: `runPromise(":script")` rejects (leading colon). *(Spec 9.2, 4.1)*
- **T-API-42**: `runPromise("workflow:")` rejects (trailing colon). *(Spec 9.2, 4.1)*
- **T-API-43**: `runPromise("-bad:index")` rejects (workflow name violates name restrictions). *(Spec 9.2, 4.1)*
- **T-API-44**: `runPromise("ralph:-bad")` rejects (script name violates name restrictions). *(Spec 9.2, 4.1)*
- **T-API-45**: `runPromise("ralph")` where workflow `ralph` exists but has no `index` script → rejects (missing default entry point). *(Spec 9.2, 4.1)*
- **T-API-46**: `runPromise("ralph:missing")` where workflow `ralph` exists but script `missing` does not → rejects. *(Spec 9.2, 4.1)*

#### `runPromise()` Snapshot & Options

- **T-API-14b**: `runPromise("ralph", { maxIterations: 0 })` resolves with empty array `[]`. *(Spec 9.2, 9.5)*
- **T-API-14c**: `runPromise()` cwd snapshot timing. *(Spec 9.2, 9.5)*
- **T-API-14d**: `runPromise()` options snapshot — mutating has no effect. *(Spec 9.2, 9.1)*
- **T-API-14e**: `runPromise("nonexistent", { maxIterations: 0 })` rejects. *(Spec 9.2, 9.5, 7.1)*
- **T-API-14f**: `runPromise("ralph", { maxIterations: 0 })` where `ralph` exists but has no `index` script → rejects. Target resolution validates the default entry point even with `maxIterations: 0`. *(Spec 9.2, 9.5, 4.1)*
- **T-API-14g**: `runPromise("ralph:missing", { maxIterations: 0 })` where `ralph` exists but script `missing` does not → rejects. *(Spec 9.2, 9.5, 4.1)*

#### Error Behavior

- **T-API-15**: Programmatic API never prints `result` to stdout. *(Spec 9.3)*
- **T-API-16**: Non-zero script exit causes `run()` generator to throw. *(Spec 9.3)*
- **T-API-17**: Invalid goto target causes `run()` generator to throw. *(Spec 9.3)*
- **T-API-18**: Script stderr is forwarded to the calling process's stderr. *(Spec 9.3)*
- **T-API-19**: When `run()` throws, previously yielded outputs are preserved. *(Spec 9.3)*
- **T-API-20a**: `run("nonexistent")` → generator throws on first `next()`. *(Spec 9.1, 9.3)*
- **T-API-20b**: `runPromise("nonexistent")` → rejects. *(Spec 9.3)*
- **T-API-20c**: `run("ralph")` with name collision in `.loopx/` → generator throws on first `next()`. *(Spec 9.1, 9.3)*
- **T-API-20d**: `run("ralph", { envFile: "nonexistent.env" })` → generator throws on first `next()`. *(Spec 9.1, 9.3, 9.5)*
- **T-API-20e**: `runPromise("ralph", { envFile: "nonexistent.env" })` → rejects. *(Spec 9.3, 9.5)*
- **T-API-20f**: `run("ralph", { cwd: dirWithoutLoopx })` → generator throws on first `next()`. *(Spec 9.1, 9.3)*
- **T-API-20g**: `runPromise("ralph", { cwd: dirWithoutLoopx })` → rejects. *(Spec 9.3)*
- **T-API-20j**: `run("ralph")` where workflow `ralph` exists but has no `index` script → generator throws on first `next()` (missing default entry point). *(Spec 9.1, 4.1)*
- **T-API-20k**: `run("ralph:missing")` where workflow `ralph` exists but script `missing` does not → generator throws on first `next()`. *(Spec 9.1, 4.1)*

#### `envFile` Option

- **T-API-21**: `run("ralph", { envFile: "local.env" })` loads the env file. *(Spec 9.5)*
- **T-API-21a**: Relative envFile path resolved against provided `cwd`. *(Spec 9.5)*
- **T-API-21b**: Relative envFile path resolved against `process.cwd()` when no `cwd` option. *(Spec 9.5)*
- **T-API-21c**: Env file parse warnings forwarded to stderr via programmatic API. *(Spec 8.1, 9.3)*
- **T-API-21d**: Global env file parse warnings forwarded to stderr. *(Spec 8.1, 9.3)*

#### `maxIterations` Validation

- **T-API-22**: `run("ralph", { maxIterations: -1 })` → generator throws on first `next()`. *(Spec 9.1, 9.5)*
- **T-API-23**: `run("ralph", { maxIterations: 1.5 })` → generator throws. *(Spec 9.1, 9.5)*
- **T-API-23a**: `run("ralph", { maxIterations: NaN })` → generator throws. *(Spec 9.1, 9.5)*
- **T-API-24**: `runPromise("ralph", { maxIterations: NaN })` → rejects. *(Spec 9.5)*
- **T-API-24a**: `runPromise("ralph", { maxIterations: -1 })` → rejects. *(Spec 9.5)*
- **T-API-24b**: `runPromise("ralph", { maxIterations: 1.5 })` → rejects. *(Spec 9.5)*

#### `runPromise()` with AbortSignal

- **T-API-25**: `runPromise("ralph", { signal })` — aborting rejects with abort error. *(Spec 9.5)*
- **T-API-25a**: Pre-aborted signal → rejects immediately, no child spawned. *(Spec 9.5)*
- **T-API-25b**: Abort between iterations → rejects. *(Spec 9.5, 9.2)*

### 4.10 Install Command

**Spec refs:** 10.1–10.9

All install tests use local servers (HTTP, file:// git repos). No network access.

#### Source Detection

- **T-INST-01**: `loopx install myorg/my-workflow` is treated as a git source (github shorthand). Verify by using `withGitURLRewrite` to redirect to a local bare repo, and asserting workflows are installed into `.loopx/`. *(Spec 10.1)*
- **T-INST-01a**: `loopx install myorg/my-workflow.git` → error, exit code 1. The shorthand must not end in `.git`. *(Spec 10.1)*
- **T-INST-02**: `loopx install https://github.com/org/repo` → treated as git (known host). *(Spec 10.1)*
- **T-INST-03**: `loopx install https://gitlab.com/org/repo` → treated as git. *(Spec 10.1)*
- **T-INST-04**: `loopx install https://bitbucket.org/org/repo` → treated as git. *(Spec 10.1)*
- **T-INST-05**: `loopx install https://example.com/repo.git` → treated as git (.git suffix). *(Spec 10.1)*
- **T-INST-06**: `loopx install http://localhost:PORT/pkg.tar.gz` → treated as tarball. *(Spec 10.1)*
- **T-INST-07**: `loopx install http://localhost:PORT/pkg.tgz` → treated as tarball. *(Spec 10.1)*
- **T-INST-08**: `loopx install http://localhost:PORT/script.ts` → rejected (single-file URL install is not supported). Error, exit code 1. *(Spec 10.1)*
- **T-INST-08a**: `loopx install https://github.com/org/repo/archive/main.tar.gz` → treated as tarball (not git). *(Spec 10.1)*
- **T-INST-08c**: `loopx install https://github.com/org/repo/` → treated as git (trailing slash allowed). *(Spec 10.1)*
- **T-INST-08d**: `loopx install http://localhost:PORT/pkg.tar.gz?token=abc` → treated as tarball. *(Spec 10.1)*
- **T-INST-08e**: `loopx install http://localhost:PORT/some-file.js` → rejected. Any URL that is not git or tarball is an error. *(Spec 10.1)*
- **T-INST-08f**: `loopx install https://github.com/org/repo/tree/main` → rejected. Known-host git detection only matches exact `/<owner>/<repo>` or `/<owner>/<repo>.git` paths. A URL with additional path segments (like `/tree/main`) is not treated as a git repo. Since it is also not a tarball URL, it is rejected with an error (exit code 1). *(Spec 10.1)*

#### Install CLI Parsing

- **T-INST-40**: `loopx install` with no source → usage error, exit code 1. *(Spec 4.2, 10)*
- **T-INST-40a**: `loopx install -w ralph` with no source → usage error, exit code 1. The `-w` flag does not substitute for the required `<source>` argument. *(Spec 4.2, 10)*
- **T-INST-40b**: `loopx install --workflow ralph` with no source → usage error, exit code 1. Same as T-INST-40a using the long-form `--workflow` flag. *(Spec 4.2, 10)*
- **T-INST-40c**: `loopx install -y` with no source → usage error, exit code 1. The `-y` flag does not substitute for the required `<source>` argument. *(Spec 4.2, 10)*
- **T-INST-41**: `loopx install -h` → install help, exit 0. Source not required. Assert that the help text explicitly lists: (a) `-w` / `--workflow` option with description, (b) `-y` option with description, and (c) supported source types (git repos, tarballs, `org/repo` shorthand). *(Spec 4.2, 11.3)*
- **T-INST-41a**: `loopx install --help` produces identical stdout, stderr, and exit code as `loopx install -h`. Run both in the same fixture. Assert: (a) stdout is byte-identical between the two invocations, (b) stderr is byte-identical, and (c) both exit 0. This proves the `--help` long form is a true alias for `-h`, consistent with the top-level and run help `--help` parity tests (T-CLI-03, T-CLI-41). *(Spec 4.2, 11.3)*
- **T-INST-42**: `loopx install -h --unknown` → install help, exit 0 (unknown flag ignored under `-h`). *(Spec 4.2)*
- **T-INST-42a**: `loopx install -h http://localhost:PORT/pkg.tar.gz` → install help, exit 0. Start a local HTTP server that tracks incoming requests. Assert: (a) help is shown, (b) the HTTP server received zero requests, and (c) `.loopx/` was not created or modified. Proves that `-h` makes no network requests even when a valid source is provided. *(Spec 4.2, 11.3)*
- **T-INST-42b**: `loopx install http://localhost:PORT/pkg.tar.gz -h` → install help, exit 0. Same assertions as T-INST-42a (zero HTTP requests, `.loopx/` untouched). Proves `-h` after the source argument also short-circuits without network activity. *(Spec 4.2, 11.3)*
- **T-INST-42c**: `loopx install -h` with `.loopx/` containing a broken workflow tree — an invalid workflow name (e.g., `.loopx/-bad-workflow/index.sh`), a name collision (e.g., `check.sh` and `check.ts` in the same workflow), and an invalid script name (e.g., `-bad.sh`) — still exits 0. Assert: (a) help text is shown, (b) stderr contains no discovery or validation warnings, and (c) exit code is 0. This proves install help does not inspect `.loopx/`, per Spec 11.3. *(Spec 4.2, 11.3)*
- **T-INST-43**: `loopx install -w a -w b <source>` → usage error, exit code 1 (duplicate `-w`). *(Spec 4.2)*
- **T-INST-43a**: `loopx install --workflow a --workflow b <source>` → usage error, exit code 1 (duplicate `--workflow`). *(Spec 4.2)*
- **T-INST-43b**: `loopx install -w a --workflow b <source>` → usage error, exit code 1 (duplicate workflow flag — mixed short and long forms still count as a duplicate). *(Spec 4.2)*
- **T-INST-44**: `loopx install -y -y <source>` → usage error, exit code 1 (duplicate `-y`). *(Spec 4.2)*
- **T-INST-45**: `loopx install --unknown <source>` → usage error, exit code 1 (unrecognized flag). *(Spec 4.2)*
- **T-INST-46**: `loopx install -h -w a -w b` shows install help and exits 0 (duplicate `-w` not rejected under help). *(Spec 4.2)*
- **T-INST-47**: `loopx install -h -y -y` shows install help and exits 0 (duplicate `-y` not rejected under help). *(Spec 4.2)*
- **T-INST-48**: `loopx install -h -w` shows install help and exits 0 (missing `-w` operand not rejected under help). *(Spec 4.2)*
- **T-INST-49**: `loopx install -w` (no operand for `-w`, no source) exits with code 1 (usage error). *(Spec 4.2)*

#### Late-Help Short-Circuit (Invalid Args Before `-h`)

- **T-INST-49a**: `loopx install --unknown -h` shows install help and exits 0. The unrecognized flag before `-h` does not prevent the help short-circuit. *(Spec 4.2)*
- **T-INST-49b**: `loopx install -w a -w b -h` shows install help and exits 0. The duplicate `-w` before `-h` does not prevent the help short-circuit. *(Spec 4.2)*
- **T-INST-49c**: `loopx install -y -y -h` shows install help and exits 0. The duplicate `-y` before `-h` does not prevent the help short-circuit. *(Spec 4.2)*
- **T-INST-49d**: `loopx install --unknown --help` shows install help and exits 0. Long-form `--help` after invalid args also short-circuits. *(Spec 4.2)*

#### Workflow Classification — Single-Workflow Source

- **T-INST-50**: Git repo with root-level `index.ts` → single-workflow source. Entire repo installed as `.loopx/<repo-name>/`. Assert the workflow directory contains all root-level files including non-script files (package.json, README, etc.). *(Spec 10.3)*
- **T-INST-51**: Git repo with root-level `index.ts` and a `lib/` subdirectory containing `.ts` files → still single-workflow (root-level script files take precedence unconditionally). `lib/` is workflow content, not a separate workflow. Assert `.loopx/<repo-name>/lib/` exists. *(Spec 10.3)*
- **T-INST-52**: Root-level script files force single-workflow classification even when subdirectories also contain scripts. *(Spec 10.3)*
- **T-INST-52a**: Root-level "config-style" file with a supported extension (e.g., `eslint.config.js` or `vitest.config.ts`) at the repository root forces single-workflow classification, even when subdirectories also qualify as workflows (contain their own top-level script files). The config file is a root-level file with a supported script extension, so it triggers the single-workflow rule unconditionally. Additionally, the config file is a top-level script candidate whose base name (e.g., `eslint.config`) contains a dot — violating the script naming restriction `[a-zA-Z0-9_][a-zA-Z0-9_-]*`. Assert that install classifies the source as single-workflow AND fails with a validation error about the invalid script name. The sibling subdirectories are not treated as separate workflows. *(Spec 10.3, 10.4)*

#### Workflow Classification — Multi-Workflow Source

- **T-INST-53**: Git repo with no root-level script files but two subdirectories `ralph/` and `other/` each containing an `index.sh` → multi-workflow source. Both installed as `.loopx/ralph/` and `.loopx/other/`. *(Spec 10.3)*
- **T-INST-54**: Multi-workflow repo: repo-root support files (README, LICENSE, etc.) are NOT copied into `.loopx/`. Only workflow directories are installed. *(Spec 10.3)*
- **T-INST-55**: Multi-workflow repo: subdirectories with no script files are silently skipped. They don't cause failure. *(Spec 10.3)*
- **T-INST-55a**: Non-recursive workflow detection during install classification. Multi-workflow source contains a candidate directory `tools/` with only nested supported-extension files (e.g., `tools/lib/helper.ts`) and no top-level script files (no `tools/*.sh|js|jsx|ts|tsx`). That directory is skipped as a non-workflow — only top-level files count for workflow detection. Other valid workflow directories in the source are installed normally. *(Spec 10.3, 2.1)*

#### Workflow Classification — Zero-Workflow Source

- **T-INST-56**: Git repo with no root-level script files and no subdirectories that qualify as workflows → error. *(Spec 10.3)*
- **T-INST-56a**: A source repo structured as a legacy directory script — root `package.json` with `main` pointing to a nested file (e.g., `{ "main": "src/run.js" }`), with the script file only in a subdirectory (`src/`) and no top-level files with supported script extensions — is classified as zero-workflow and rejected with an error. Assert exit code 1 and that the error indicates no installable workflows were found. This proves the install mechanism does not fall back to legacy directory-script install behavior — the `main` field is not used for workflow classification. *(Spec 10.3)*

#### Selective Workflow Installation

- **T-INST-57**: `loopx install -w ralph <multi-workflow-source>` installs only `ralph`. Assert `.loopx/ralph/` exists but `.loopx/other/` does not. *(Spec 10.8)*
- **T-INST-57a**: `loopx install --workflow ralph <multi-workflow-source>` is equivalent to `loopx install -w ralph <source>`. Assert `.loopx/ralph/` exists but `.loopx/other/` does not. This tests the long-form `--workflow` flag. *(Spec 4.2, 10.8)*
- **T-INST-58**: `loopx install -w nonexistent <multi-workflow-source>` → error (workflow not in source). *(Spec 10.8)*
- **T-INST-59**: `loopx install -w ralph <single-workflow-source>` → error (`-w` is invalid for single-workflow sources). The source must have root-level script files (e.g., `index.ts`) **and** subdirectories containing supported-extension files (e.g., `lib/helpers.ts`, `src/utils.js`), so the test genuinely proves that root-level scripts force single-workflow classification even in the presence of subdirectories with script-extension files. Using `-w` is an error regardless of the name provided. *(Spec 10.3, 10.8)*
- **T-INST-59a**: `loopx install --workflow ralph <single-workflow-source>` → error. Long-form `--workflow` parity with T-INST-59: `--workflow` is invalid for single-workflow sources, same as `-w`. *(Spec 10.8, 4.2)*
- **T-INST-60**: With `-w`, only the selected workflow is validated. Invalid sibling workflows don't block installation. *(Spec 10.8)*

#### Install-time Validation

- **T-INST-61**: Workflow with invalid script name (e.g., `-bad.sh`) → install fails. *(Spec 10.4)*
- **T-INST-62**: Workflow with same-base-name collision (e.g., `check.sh` and `check.ts`) → install fails. *(Spec 10.4)*
- **T-INST-63**: Derived workflow name must match name restriction rules. Invalid name → install fails. *(Spec 10.4)*
- **T-INST-64**: Missing `index` script is allowed at install time. A workflow without `index` can be installed. *(Spec 10.4)*

#### Collision Handling

- **T-INST-65**: Path does not exist → workflow installed without collision check. *(Spec 10.5)*
- **T-INST-66**: Path exists and is a workflow by structure → install refused with error. *(Spec 10.5)*
- **T-INST-67**: Path exists and is a workflow by structure, with `-y` → existing workflow replaced. *(Spec 10.5)*
- **T-INST-68**: Path exists but is NOT a workflow by structure (e.g., directory with no script files, or a non-directory entry) → install refused with error, even with `-y`. *(Spec 10.5)*
- **T-INST-69**: `-y` must not replace non-workflow entries. A plain file at `.loopx/<name>` is refused even with `-y`. *(Spec 10.5)*
- **T-INST-70**: Symlinked workflow: structural check follows the symlink. When `-y` removes a symlinked workflow, it removes the symlink itself, not the target directory. *(Spec 10.5)*
- **T-INST-70a**: Symlink-to-non-workflow collision refusal. `.loopx/foo` is a symlink whose target is a directory with no top-level script files (e.g., the target contains only `lib/helper.ts` nested in a subdirectory). `loopx install -y <source>` where the source contains a workflow named `foo` → install refuses with an error, even with `-y`. The structural check follows the symlink, finds the target is not a workflow (no top-level script files), and treats it as a non-workflow destination path. *(Spec 10.5)*
- **T-INST-71**: Collision check is local to `.loopx/<workflow-name>` — invalid sibling workflows elsewhere under `.loopx/` do not affect collision evaluation. *(Spec 10.5)*
- **T-INST-97**: Installing workflow `foo` succeeds when a non-workflow file `.loopx/foo.sh` exists. The collision check targets `.loopx/foo/` (directory), not `.loopx/foo.sh` (file) — they are different filesystem paths, so there is no collision. *(Spec 10.5)*

#### Version Checking on Install

- **T-INST-72**: Workflow declares a loopx version range not satisfied by running version → install refused with error. *(Spec 10.6)*
- **T-INST-73**: With `-y`, version mismatch is overridden and install proceeds. Version declaration preserved. *(Spec 10.6)*
- **T-INST-74**: Workflow `package.json` unreadable → warning, install proceeds (no version validation). *(Spec 10.6, 3.2)*
- **T-INST-75**: Workflow `package.json` invalid JSON → warning, install proceeds. *(Spec 10.6, 3.2)*
- **T-INST-76**: Workflow `package.json` invalid semver range → warning, install proceeds. *(Spec 10.6, 3.2)*

#### Install Atomicity

- **T-INST-77**: Multi-workflow install: all workflows pass preflight → all installed. *(Spec 10.7)*
- **T-INST-78**: Multi-workflow install: one workflow fails preflight (e.g., name collision at destination) → entire install fails, no workflows written. Assert `.loopx/` unchanged. *(Spec 10.7)*
- **T-INST-79**: Staging failure: write error during staging → staging directory cleaned up, `.loopx/` unchanged. *(Spec 10.7)*
- **T-INST-80**: With `-y`, replaceable workflow-path collisions and version mismatches are recorded during preflight but not treated as failures. *(Spec 10.7)*
- **T-INST-80a**: Multi-workflow install with multiple preflight failures across different workflows (e.g., workflow A has a name collision at destination, workflow B has an invalid script name, workflow C declares a loopx version range not satisfied by the running version) → single aggregated error report listing all failures across all workflows, including the version mismatch. No workflows written. *(Spec 10.7)*
- **T-INST-80b**: `-y` replacement preserves the existing workflow until the commit phase. Set up a `-y` install, simulate a staging failure (e.g., make the staging directory unwritable). Assert the existing workflow is still intact in `.loopx/`. *(Spec 10.7)*
- **T-INST-80c**: Commit-phase failure reports which workflows were and were not committed. Set up a multi-workflow install where the commit phase fails partway through (e.g., make one target path unwritable after staging succeeds). Assert error output lists the committed workflows and the uncommitted workflows. *(Spec 10.7)*
- **T-INST-80d**: Install-time `package.json` warning behavior is "once per affected workflow" and is not accidentally deduplicated by runtime-style first-entry logic. Install two workflows, each with an unreadable `package.json` → each workflow's warning appears independently (two warnings, not one). **Conditional on `process.getuid() !== 0`.** *(Spec 3.2, 10.6)*
- **T-INST-80e**: Install-time `package.json` warning behavior for invalid semver ranges is "once per affected workflow." Install two workflows, each with a valid `package.json` containing an invalid semver range for `loopx` (e.g., `"loopx": "not-a-range"`) → each workflow's warning appears independently (two warnings, not one). Install proceeds for both workflows (invalid semver skips version check, does not block install). This is the invalid-semver counterpart to T-INST-80d (unreadable files). *(Spec 3.2, 10.6)*
- **T-INST-80f**: Install-time `package.json` warning behavior for invalid JSON is "once per affected workflow." Install two workflows, each with a `package.json` containing invalid JSON (e.g., `{broken`) → each workflow's warning appears independently (two warnings, not one). Install proceeds for both workflows (invalid JSON skips version check, does not block install). This is the invalid-JSON counterpart to T-INST-80d (unreadable files) and T-INST-80e (invalid semver). *(Spec 3.2, 10.6)*
- **T-INST-80g**: `-y` does not override a zero-workflow source. `loopx install -y <source>` where the source contains no root-level script files and no subdirectories that qualify as workflows → error, exit code 1, regardless of `-y`. *(Spec 10.3, 10.7)*
- **T-INST-80h**: `-y` does not override invalid workflow or script names. `loopx install -y <source>` where the source contains a workflow with an invalid script name (e.g., `-bad.sh`) → error, exit code 1, regardless of `-y`. *(Spec 10.4, 10.7)*
- **T-INST-80i**: `-y` does not override same-base-name collisions within a workflow. `loopx install -y <source>` where the source contains a workflow with `check.sh` and `check.ts` (same base name, different extensions) → error, exit code 1, regardless of `-y`. *(Spec 10.4, 10.7)*

#### Tarball Install

- **T-INST-81**: Multi-workflow tarball install with exact name derivation. Create a `.tar.gz` whose source root (after any wrapper-directory stripping) contains subdirectories `ralph/` (with `index.sh`) and `other/` (with `index.sh`). Install the tarball. Assert installed paths are exactly `.loopx/ralph/` and `.loopx/other/`, with the expected scripts present. Workflow names are derived from the source-root subdirectory names. *(Spec 10.2)*
- **T-INST-82**: Wrapper-directory stripping for multi-workflow tarball. Create a `.tar.gz` with a single top-level directory `pkg/` containing `pkg/ralph/index.sh` and `pkg/other/index.sh`. After extraction, `pkg/` is stripped and the source root becomes the contents of `pkg/`. Assert installed paths are `.loopx/ralph/` and `.loopx/other/` (not `.loopx/pkg/`). *(Spec 10.2)*
- **T-INST-83**: No wrapper-directory stripping for multi-entry tarball. Create a `.tar.gz` with multiple top-level entries `ralph/index.sh` and `other/index.sh` (no single wrapper directory). After extraction, the entries are used directly as the source root. Assert installed paths are `.loopx/ralph/` and `.loopx/other/`. *(Spec 10.2)*
- **T-INST-84**: `.tgz` extension handled identically. *(Spec 10.2)*
- **T-INST-85**: Single-workflow tarball: workflow name derived from archive name (URL last segment minus `.tar.gz`/`.tgz`, query/fragment stripped). *(Spec 10.2)*
- **T-INST-86**: Tarball URL with query string → query stripped from archive-name derivation. *(Spec 10.2)*
- **T-INST-86a**: Tarball URL with fragment → fragment stripped from archive-name derivation. `loopx install http://localhost:PORT/pkg.tar.gz#v1` installs a single-workflow source. Assert the installed workflow is named `pkg` (fragment `#v1` stripped before deriving the archive name). *(Spec 10.2)*
- **T-INST-85a**: Single-workflow tarball with wrapper-directory stripping. Create a `.tar.gz` named `my-agent.tar.gz` with a single top-level wrapper directory (e.g., `wrapper/`) containing a single-workflow source at its root (e.g., `wrapper/index.sh`, `wrapper/check.sh` — root-level script files). Install the tarball. Assert: (a) the wrapper directory is stripped before classification (the source is classified as single-workflow from the unwrapped contents), (b) the installed workflow name is `my-agent` (derived from the archive name, not the wrapper directory name `wrapper`), and (c) the installed workflow at `.loopx/my-agent/` contains the expected scripts. This combines wrapper-directory stripping (tested for multi-workflow in T-INST-82) with single-workflow archive-name derivation (tested without wrapping in T-INST-85). *(Spec 10.2)*

#### Git Install

- **T-INST-87**: Shallow clone (`--depth 1`). Verify clone has only 1 commit. *(Spec 10.2)*
- **T-INST-88**: Single-workflow git repo: name derived from repo URL minus `.git`. *(Spec 10.2)*
- **T-INST-89**: Multi-workflow git repo: workflow names derived from subdirectory names. *(Spec 10.2)*

#### Common Rules

- **T-INST-90**: `.loopx/` directory created if it doesn't exist. *(Spec 10)*
- **T-INST-91**: loopx does not run `npm install` / `bun install` after clone/extract. *(Spec 10.9)*
- **T-INST-92**: HTTP 404 during tarball download → error, exit code 1, no partial directory. *(Spec 10.9)*
- **T-INST-93**: Git clone failure (non-existent repo) → error, exit code 1, no partial directory. *(Spec 10.9)*
- **T-INST-94**: Tarball extraction failure (corrupt archive) → error, exit code 1, no partial directory. *(Spec 10.9)*
- **T-INST-95**: Empty tarball (valid `.tar.gz` with no entries) → error, exit code 1. *(Spec 10.9)*
- **T-INST-96**: Successful single-workflow git install → installed workflow is runnable via `loopx run <name>`. *(Spec 10)*
- **T-INST-97a**: Single-workflow install failure cleanup. Simulate a single-workflow install that fails after the target directory `.loopx/<name>/` has been partially created (e.g., by serving a tarball that extracts successfully but fails post-download validation). Assert: (a) exit code 1, (b) the partially created `.loopx/<name>/` directory is removed, and (c) `.loopx/` is left clean (no partial workflow directory remains). *(Spec 10.9)*
- **T-INST-97b**: Successful install does not create `.loopx/package.json`. Run a successful single-workflow git install into a project. Assert: (a) exit code 0, (b) the workflow is installed at `.loopx/<name>/`, and (c) `.loopx/package.json` does not exist. There is no `.loopx/`-level manifest — version authority lives only in the project root `package.json` and each workflow's own `package.json`. *(Spec 10.6)*

#### Global Install Smoke Test

- **T-INST-GLOBAL-01**: Full global install lifecycle. `npm pack` the built loopx package, install the resulting tarball into an isolated global prefix, create a fixture project with a `.loopx/ralph/index.ts` script, run `<tempdir>/bin/loopx run -n 1 ralph` against the fixture project, and assert the script ran. *(Spec 3.1)*
- **T-INST-GLOBAL-01a**: `[Bun]` Full global install lifecycle under Bun. Same workflow as T-INST-GLOBAL-01 but run via Bun. *(Spec 3.1, 3.3)*

### 4.11 Signal Handling

**Spec refs:** 7.3

Signal tests use the `signal-ready-then-sleep`, `signal-trap-exit`, `signal-trap-ignore`, and `spawn-grandchild` fixtures inside workflows. All signal fixtures follow the ready-protocol.

- **T-SIG-01**: Send SIGINT to loopx while a script is running. Assert loopx exits with code 130. *(Spec 7.3)*
- **T-SIG-02**: Send SIGTERM to loopx while a script is running. Assert exit code 143. *(Spec 7.3)*
- **T-SIG-03**: After SIGINT, the child script process is no longer running. *(Spec 7.3)*
- **T-SIG-04**: Grace period: child traps SIGTERM and exits within 2 seconds → no SIGKILL needed. *(Spec 7.3)*
- **T-SIG-05**: Grace period exceeded: child traps SIGTERM and hangs → SIGKILL after ~5 seconds. *(Spec 7.3)*
- **T-SIG-06**: Process group signal: script spawns a grandchild. Both terminated after SIGTERM. *(Spec 7.3)*
- **T-SIG-07**: Between-iterations signal. Assert loopx exits immediately. `@flaky-retry(3)`. *(Spec 7.3)*
- **T-SIG-08**: Signal identity preserved (SIGINT forwarded as SIGINT, SIGTERM as SIGTERM). *(Spec 7.3)*

### 4.12 CLI Delegation

**Spec refs:** 3.2

#### Setup

Delegation tests create the following structure:
```
/tmp/test-project/
  package.json            ← declares loopx as dependency
  node_modules/
    .bin/
      loopx → symlink or wrapper script pointing to a "local" build
  .loopx/
    ralph/
      index.sh → script that writes LOOPX_BIN to a file
```

The "global" binary is the primary build. The "local" binary is a separate build or a wrapper that sets a marker.

#### Tests

- **T-DEL-01**: When `node_modules/.bin/loopx` exists in CWD and project-root `package.json` declares `loopx` in `dependencies`, the global binary delegates to it. Verify by having the local binary write a marker file. *(Spec 3.2)*
- **T-DEL-02**: Delegation checks CWD only, not ancestor directories. Create a parent directory with a `package.json` that declares `loopx` as a dependency and a corresponding `node_modules/.bin/loopx`. Run loopx from a child directory (which has no `node_modules/.bin/loopx` and no `package.json`). Assert the global binary runs (no delegation). The parent must have a `package.json` declaring `loopx` so the test proves ancestor traversal was actually removed — without it, the test could pass for the weaker reason that the parent binary is undeclared (per T-DEL-16), not because ancestor traversal is not performed. *(Spec 3.2)*
- **T-DEL-03**: Delegation works before `.loopx/` exists. Run `loopx version` from a project root that has `package.json` declaring loopx and `node_modules/.bin/loopx`. Assert the local binary handles the command. *(Spec 3.2)*
- **T-DEL-04**: `LOOPX_DELEGATED=1` in environment prevents delegation. Even if `node_modules/.bin/loopx` exists, the global binary runs. *(Spec 3.2)*
- **T-DEL-05**: After delegation, `LOOPX_BIN` contains the resolved realpath of the local binary (not the global one, not a symlink). *(Spec 3.2)*
- **T-DEL-06**: After delegation, `import from "loopx"` in scripts resolves to the **local (delegated-to) version's** package. *(Spec 3.2)*
- **T-DEL-07**: Delegation sets `LOOPX_DELEGATED=1` in the delegated process. *(Spec 3.2)*
- **T-DEL-08**: Delegation happens before command handling. Run global binary with `version` → local binary handles it. *(Spec 3.2)*
- **T-DEL-09**: `LOOPX_DELEGATED=""` (empty string) prevents delegation. *(Spec 3.2)*
- **T-DEL-10**: Delegation preserves SIGINT exit code (130). *(Spec 3.2, 7.3, 12)*
- **T-DEL-11**: Delegation preserves SIGTERM exit code (143). *(Spec 3.2, 7.3, 12)*

#### Project-Root `package.json` Failure Modes

- **T-DEL-12**: No `package.json` at project root → no delegation. Global install runs. No warning. *(Spec 3.2)*
- **T-DEL-13**: Unreadable `package.json` → warning on stderr. Delegation skipped, global runs. **Conditional on `process.getuid() !== 0`.** *(Spec 3.2)*
- **T-DEL-14**: Invalid JSON in `package.json` → warning on stderr. Delegation skipped, global runs. *(Spec 3.2)*
- **T-DEL-15**: `loopx` declared in `package.json` but `node_modules/.bin/loopx` does not exist → warning on stderr. Delegation skipped, global runs. *(Spec 3.2)*
- **T-DEL-16**: `node_modules/.bin/loopx` exists but `loopx` not declared in any dependency field → no delegation, no warning. The binary is undeclared. *(Spec 3.2)*
- **T-DEL-17**: Project-root `package.json` declares `loopx` in `optionalDependencies` (not `dependencies` or `devDependencies`) and `node_modules/.bin/loopx` exists → delegation occurs. `optionalDependencies` is checked at the project root level for locating a local binary. *(Spec 3.2)*
- **T-DEL-18**: Project-root `package.json` declares `loopx` in `devDependencies` (not `dependencies` or `optionalDependencies`) and `node_modules/.bin/loopx` exists → delegation occurs. `devDependencies` is checked at the project root level for locating a local binary. *(Spec 3.2)*
- **T-DEL-19**: Delegation is presence-based, not range-based. Project-root `package.json` declares `loopx` in `dependencies` with a semver range NOT satisfied by the local binary's actual version (e.g., `"loopx": "^99.0.0"`), and `node_modules/.bin/loopx` exists → delegation still occurs. The global binary delegates based on declaration presence and binary existence, without comparing the declared range against the local binary's version. Verify by having the local binary write a marker file. *(Spec 3.2)*
- **T-DEL-20**: Workflow-local `package.json` and `node_modules/.bin/loopx` do not trigger delegation. Create a project root with no `package.json`. Create `.loopx/ralph/package.json` declaring `loopx` in `dependencies` and place a marker-writing binary at `.loopx/ralph/node_modules/.bin/loopx`. Create `.loopx/ralph/index.sh`. Run `loopx run -n 1 ralph`. Assert: (a) the global binary runs (marker file is NOT created), and (b) execution succeeds normally. Delegation is based on the project-root `package.json` only — workflow-level version declarations are not used for delegation. *(Spec 3.2)*

### 4.13 Workflow-Level Version Checking

**Spec refs:** 3.2

- **T-VER-01**: Workflow `package.json` declares a loopx range satisfied by the running version → execution proceeds, no warning. *(Spec 3.2)*
- **T-VER-02**: Workflow `package.json` declares a loopx range NOT satisfied → warning on stderr, execution continues (non-fatal). *(Spec 3.2)*
- **T-VER-03**: Warning occurs only on first entry to a workflow. Re-entering the same workflow (via loop reset or goto) does not repeat the warning. *(Spec 3.2)*
- **T-VER-04**: Cross-workflow first-entry warning. Starting workflow has no version declaration. Goto to a second workflow that declares an unsatisfied range → warning emitted on first entry to second workflow. *(Spec 3.2)*
- **T-VER-05**: Starting workflow checked before first iteration. *(Spec 3.2)*
- **T-VER-06**: `-n 0` skips workflow version warnings. Set up workflow with unsatisfied version range. Assert no warning on stderr. *(Spec 3.2)*
- **T-VER-07**: Workflow `package.json` unreadable → warning, execution continues. **Conditional on `process.getuid() !== 0`.** *(Spec 3.2)*
- **T-VER-07a**: Runtime `package.json` failure warning follows "first entry only" dedupe. Create a workflow with invalid JSON in its `package.json`. Run a loop that re-enters the workflow multiple times (e.g., via loop reset). Assert that the `package.json` failure warning appears exactly once on stderr, not on each re-entry. This locks down the same "first entry only" rule that T-VER-03 tests for version mismatch warnings, applied to `package.json` failure warnings (unreadable, invalid JSON, invalid semver range). *(Spec 3.2)*
- **T-VER-07b**: Runtime `package.json` failure warning follows "first entry only" dedupe for invalid semver ranges. Create a workflow with a valid `package.json` containing an invalid semver range for `loopx` (e.g., `"loopx": "not-a-range"`). Run a loop that re-enters the workflow multiple times. Assert that the invalid-semver warning appears exactly once on stderr. This is the invalid-semver counterpart to T-VER-07a (invalid JSON). *(Spec 3.2)*
- **T-VER-07c**: Runtime `package.json` failure warning follows "first entry only" dedupe for unreadable workflow `package.json`. Create a workflow with an unreadable `package.json` (e.g., mode 000). Run a loop that re-enters the workflow multiple times (e.g., via loop reset). Assert that the unreadable-file warning appears exactly once on stderr, not on each re-entry. This is the unreadable-file counterpart to T-VER-07a (invalid JSON) and T-VER-07b (invalid semver). **Conditional on `process.getuid() !== 0`.** *(Spec 3.2)*
- **T-VER-08**: Workflow `package.json` invalid JSON → warning, execution continues. *(Spec 3.2)*
- **T-VER-09**: Workflow `package.json` invalid semver range → warning, execution continues. *(Spec 3.2)*
- **T-VER-10**: `dependencies` range wins over `devDependencies` when both are present. *(Spec 3.2)*
- **T-VER-11**: `optionalDependencies` ignored at workflow level. Workflow `package.json` declares `loopx` only in `optionalDependencies` with an unsatisfied range → no version warning at runtime. *(Spec 3.2)*
- **T-VER-12**: Install-time version checking: `dependencies` range wins over `devDependencies` when both are present in a workflow's `package.json`. Set up `dependencies.loopx` with a satisfied range and `devDependencies.loopx` with an unsatisfied range → install succeeds (no version mismatch error). Reverse the ranges → install fails. *(Spec 3.2, 10.6)*
- **T-VER-13**: Install-time version checking: `optionalDependencies.loopx` is ignored at the workflow level. Workflow `package.json` declares `loopx` only in `optionalDependencies` with an unsatisfied range → install succeeds (no version check performed). *(Spec 3.2, 10.6)*
- **T-VER-14**: Runtime version checking: `devDependencies.loopx` only (no `dependencies.loopx`). Workflow `package.json` declares `loopx` only in `devDependencies` with an unsatisfied range → warning on stderr, execution continues. This proves the `devDependencies`-only path works independently of the `dependencies`-over-`devDependencies` precedence rule tested in T-VER-10. *(Spec 3.2)*
- **T-VER-15**: Install-time version checking: `devDependencies.loopx` only (no `dependencies.loopx`). Workflow `package.json` declares `loopx` only in `devDependencies` with an unsatisfied range → install refused with version mismatch error. This proves the `devDependencies`-only install path works independently of the precedence rule tested in T-VER-12. *(Spec 3.2, 10.6)*
- **T-VER-16**: Runtime: workflow has a valid `package.json` with no `loopx` declared in any dependency field (e.g., `{ "name": "my-workflow", "version": "1.0.0" }`) → no version check is performed, no warning emitted. Execution proceeds normally. This explicitly tests the "valid JSON, no `loopx` dependency declared → no version check" rule from Spec 3.2. *(Spec 3.2)*
- **T-VER-17**: Install-time: workflow source has a valid `package.json` with no `loopx` declared in any dependency field → no version check is performed, install succeeds without version-related errors or warnings. *(Spec 3.2, 10.6)*
- **T-VER-18**: Unentered sibling workflows are not version-checked. Create `.loopx/good/index.sh` (the starting workflow, no `package.json`) and `.loopx/sibling/index.sh` with a `package.json` declaring a loopx range NOT satisfied by the running version. Run `loopx run -n 1 good` (the starting workflow completes without ever entering `sibling`). Assert: (a) exit code 0, and (b) no version mismatch warning on stderr for `sibling`. Version checks are entry-scoped — only workflows actually entered during the loop have their `package.json` checked. *(Spec 3.2)*
- **T-VER-19**: `loopx run -h` does not perform workflow version or `package.json` checks. Create `.loopx/ralph/index.sh` with a `package.json` declaring a loopx range NOT satisfied by the running version. Run `loopx run -h`. Assert: (a) help output is displayed, (b) exit code 0, and (c) stderr contains no version mismatch warnings. Version checking is entry-scoped — `run -h` performs discovery and validation (names, collisions) but does not enter any workflow, so version checks do not run. *(Spec 3.2, 11.2)*
- **T-VER-20**: Workflow `package.json` is not re-read after first entry (mutation test). Create `.loopx/ralph/index.sh` with a `package.json` declaring a loopx range SATISFIED by the running version. Set up a multi-iteration loop where the script mutates its own `package.json` to an UNSATISFIED range after the first iteration (e.g., rewrites the loopx version field to `">=999.0.0"`), then re-enters the workflow (via loop reset). Assert: no version mismatch warning appears on any iteration, proving the file was not re-read after first entry. This goes beyond T-VER-03 (which proves the warning is not repeated) by proving the file itself is not re-checked — if the implementation re-read `package.json` on re-entry, the mutated range would trigger a new warning. *(Spec 3.2)*
- **T-VER-21**: Workflow with no `package.json` runs with no version-check warning. Create `.loopx/ralph/index.sh` with no `package.json` in the workflow directory. Run `loopx run -n 1 ralph`. Assert: (a) exit code 0, (b) stderr contains no version-related warnings or `package.json`-related warnings. This locks down the "normal case" from Spec 3.2: absent `package.json` means no version check is performed and no warnings are emitted. An implementation that wrongly warns on missing `package.json` would fail this test. *(Spec 3.2)*
- **T-VER-22**: Workflow with no `package.json` installs with no version-related warning. Set up a single-workflow install source with no `package.json`. Run `loopx install <source>`. Assert: (a) exit code 0, (b) stderr contains no version-related warnings or `package.json`-related warnings, (c) the workflow is installed in `.loopx/`. This is the install-time counterpart to T-VER-21. *(Spec 3.2, 10.6)*
- **T-VER-23**: A stray `.loopx/package.json` is ignored for runtime version checking. Create `.loopx/package.json` containing `{ "dependencies": { "loopx": ">=999.0.0" } }` (an unsatisfied range). Create `.loopx/ralph/index.sh` with no workflow-level `package.json`. Run `loopx run -n 1 ralph`. Assert: (a) exit code 0, and (b) no version mismatch warning on stderr. The `.loopx/package.json` file is not a recognized manifest — version authority lives only in the project root `package.json` (for delegation) and each workflow's own `package.json` (for runtime/install-time validation). *(Spec 3.2)*

### 4.14 Exit Codes (Cross-Cutting)

**Spec refs:** 12

- **T-EXIT-01**: Clean exit via `stop: true` → code 0. *(Spec 12)*
- **T-EXIT-02**: Clean exit via `-n` limit reached → code 0. *(Spec 12)*
- **T-EXIT-03**: Clean exit via `-n 0` → code 0. *(Spec 12)*
- **T-EXIT-04**: Successful subcommand (`loopx version`) → code 0. *(Spec 12)*
- **T-EXIT-05**: Script exits non-zero → code 1. *(Spec 12)*
- **T-EXIT-06**: Validation failure (name collision) → code 1. *(Spec 12)*
- **T-EXIT-07**: Invalid goto target → code 1. *(Spec 12)*
- **T-EXIT-08**: Missing workflow → code 1. *(Spec 12)*
- **T-EXIT-09**: Missing `.loopx/` directory → code 1. *(Spec 12)*
- **T-EXIT-10**: Usage error (invalid `-n`) → code 1. *(Spec 12)*
- **T-EXIT-11**: Missing `-e` file → code 1. *(Spec 12)*
- **T-EXIT-12**: SIGINT → code 130. *(Spec 12)*
- **T-EXIT-13**: SIGTERM → code 143. *(Spec 12)*
- **T-EXIT-14**: `loopx run` with no target → code 1 (usage error). *(Spec 12)*
- **T-EXIT-15**: `loopx ralph` (unrecognized subcommand) → code 1 (usage error). *(Spec 12)*
- **T-EXIT-16**: `loopx --unknown` → code 1 (usage error). *(Spec 12)*
- **T-EXIT-17**: Invalid target string (e.g., `":script"`) → code 1. *(Spec 12)*

---

## 5. Fuzz Testing

Fuzz tests use `fast-check` for property-based testing. They are designed to find edge cases that manual test enumeration misses.

### 5.1 Structured Output Fuzzer

**File:** `tests/fuzz/output-parsing.fuzz.test.ts`

**Approach:** Generate random strings and feed them as the stdout of a script in a workflow. Verify invariants hold for all inputs.

#### Generators

| Generator | Description |
|-----------|-------------|
| `arbitraryJSON` | Random valid JSON values (objects, arrays, strings, numbers, booleans, null) |
| `arbitraryString` | Random strings including unicode, control characters, empty, very long |
| `arbitraryOutputObject` | Random objects with `result`, `goto`, `stop` fields of various types |
| `arbitraryMalformedJSON` | Strings that look like JSON but are malformed |

#### Properties

- **F-PARSE-01: No crashes.** For any string written to stdout, loopx does not crash. Exits with code 0 or code 1. Never any other exit code for non-signal cases.
- **F-PARSE-02: Deterministic parsing.** Same stdout → same behavior.
- **F-PARSE-03: Type safety of parsed output.** `result` is always string, `goto` is always string, `stop` is always `true`.
- **F-PARSE-04: Raw fallback consistency.** Non-structured stdout → entire stdout becomes `result`.
- **F-PARSE-05: Non-ASCII safe.** UTF-8 with NUL bytes, control characters, high Unicode does not cause crashes.

**Iterations:** At least 1000 at unit-parser level (via `parseOutput` seam), 50–100 at E2E level.

### 5.2 Env File Fuzzer

**File:** `tests/fuzz/env-parsing.fuzz.test.ts`

#### Properties

- **F-ENV-01: No crashes.**
- **F-ENV-02: Deterministic parsing.**
- **F-ENV-03: Keys and values are strings.**
- **F-ENV-04: Last-wins for duplicates.**
- **F-ENV-05: Comment lines never produce variables.**

**Iterations:** At least 1000 at unit-parser level (via `parseEnvFile` seam), 50–100 at E2E level.

---

## 6. Supplementary Unit Tests

### 6.1 Output Parsing Unit Tests

**File:** `tests/unit/parse-output.test.ts`

Uses the `parseOutput` internal seam (section 1.4). Tests the parser function directly with valid JSON objects, type coercion cases, edge cases, non-object JSON values, and malformed JSON.

### 6.2 Env Parsing Unit Tests

**File:** `tests/unit/parse-env.test.ts`

Uses the `parseEnvFile` internal seam (section 1.4). Tests standard KEY=VALUE pairs, comments, blank lines, quoted values, duplicate keys, and edge cases.

### 6.3 Source Detection Unit Tests

**File:** `tests/unit/source-detection.test.ts`

Test the source classification logic (section 10.1) in isolation:

- `org/repo` → git (github)
- Various URLs → correct source type (`"git"` or `"tarball"`)
- URLs that would be single-file → throws (single-file URL install removed)
- Edge cases: URLs with ports, auth, paths, query strings

### 6.4 Compile-Time Type Tests

**File:** `tests/unit/types.test.ts`

**Required execution method:** Vitest typecheck mode, `tsc --noEmit`, or `tsd`.

- **T-TYPE-01**: `import type { Output, RunOptions } from "loopx"` compiles without error. *(Spec 9.5)*
- **T-TYPE-02**: `Output` has optional `result?: string`, `goto?: string`, `stop?: boolean` fields. *(Spec 9.5)*
- **T-TYPE-03**: `RunOptions` has optional `maxIterations?: number`, `envFile?: string`, `signal?: AbortSignal`, `cwd?: string` fields. *(Spec 9.5)*
- **T-TYPE-04**: `run()` returns `AsyncGenerator<Output>`. *(Spec 9.1, 9.5)*
- **T-TYPE-05**: `runPromise()` returns `Promise<Output[]>`. *(Spec 9.2, 9.5)*
- **T-TYPE-06**: `run()` and `runPromise()` accept an optional `RunOptions` second argument. *(Spec 9.1, 9.2, 9.5)*
- **T-TYPE-07**: `run()` and `runPromise()` require `target` as the first argument (`string`). Omitting `target` is a static type error. *(Spec 9.1, 9.2, 9.5)*

---

## 7. Edge Cases & Boundary Tests

- **T-EDGE-01**: Very long result string (~1 MB). Handled without truncation or hang. *(Spec 2.3)*
- **T-EDGE-02**: Result containing JSON-special characters. Correct serialization/deserialization. *(Spec 2.3)*
- **T-EDGE-03**: Script that writes stdout in multiple `write()` calls. Full output captured. *(Spec 2.3)*
- **T-EDGE-04**: Script that writes to both stdout and stderr. No interleaving issues. *(Spec 6.2, 6.3)*
- **T-EDGE-05**: Unicode in result values and env values preserved. Unicode in workflow/script names rejected (ASCII-only pattern). *(Spec 2.3, 5.3, 8.1)*
- **T-EDGE-06**: Deeply nested goto chain (A → B → C → ... → Z) including cross-workflow hops. Correct execution order and iteration counting. *(Spec 7.1)*
- **T-EDGE-07**: Script that produces output on stdout but also reads from stdin when no input is available. No deadlock. *(Spec 6.7)*
- **T-EDGE-11**: `-n` with very large value (e.g., `999999`). No integer overflow. *(Spec 4.2)*
- **T-EDGE-12**: Empty `.loopx/` directory (exists but no workflows). `loopx run ralph` → error. `loopx run -h` → run help with no workflows listed. *(Spec 4.1, 11.2)*
- **T-EDGE-14**: Env file with no newline at end of file. Last line still parsed. *(Spec 8.1)*
- **T-EDGE-15**: Env file that is completely empty (0 bytes). No error, no variables loaded. *(Spec 8.1)*

---

## 8. CI Configuration

### 8.1 Runtime Matrix

| Runtime | Versions |
|---------|----------|
| Node.js | 20.6 (minimum), latest LTS, latest current |
| Bun | 1.0 (minimum), latest |

### 8.2 Pipeline Stages

1. **Build**: Compile/bundle loopx.
2. **Phase 0 (Harness)**: Run `tests/harness/`. Fail the pipeline if any fail.
3. **Typecheck**: Run `tsc --noEmit` or `vitest typecheck` on `tests/unit/types.test.ts`.
4. **Unit Tests**: Run `tests/unit/`.
5. **E2E Tests**: Run `tests/e2e/`. Parameterized over runtime matrix.
6. **Fuzz Tests**: Run `tests/fuzz/` with CI-appropriate iteration count (e.g., 5000).
7. **Stub Validation** (optional, periodic): Run spec tests against stub binary.

### 8.3 Timeouts

| Suite | Timeout per test |
|-------|-----------------|
| Harness | 10s |
| Unit | 5s |
| E2E | 30s |
| E2E (signals) | 60s |
| Fuzz | 120s |

### 8.4 Parallelism

- Vitest runs test files in parallel by default. Each test file uses isolated temp directories.
- Signal tests should run serially within their file.
- Install tests that start local servers should share a single server instance per file.

---

## 9. Pending Spec Decisions

All previously identified spec problems (SP-15 through SP-31) have been resolved.

**Currently pending:**
- SP-32 (SSH/SCP URL classification — SPEC.md section 10.1 does not mention SSH or SCP-style URLs. No tests added until resolved.)

---

## Appendix A: Spec Requirement Traceability Matrix

Maps each SPEC.md section to the test IDs that verify it.

| Spec Section | Description | Test IDs |
|-------------|-------------|----------|
| 1 | Overview (ESM-only) | T-MOD-22 |
| 2.1 | Workflow and Script | T-DISC-01–20c, T-DISC-21a, T-DISC-15a–15b, T-DISC-25–38, T-EXEC-15–16a, T-MOD-03a |
| 2.2 | Loop (state machine, goto) | T-LOOP-01–05, T-LOOP-15a, T-LOOP-16–19, T-LOOP-19a–19b, T-LOOP-30–43, T-LOOP-31a, T-EXEC-16b |
| 2.3 | Structured Output | T-PARSE-01–29, T-PARSE-12a, T-PARSE-20a, F-PARSE-01–05 |
| 3.1 | Global Install | T-INST-GLOBAL-01, T-INST-GLOBAL-01a |
| 3.2 | Local Version Pinning & Delegation | T-DEL-01–20, T-VER-01–23, T-VER-07a–07c, T-CLI-119, T-CLI-119c, T-API-08b, T-API-08g |
| 3.3 | Module Resolution | T-MOD-01–03, T-MOD-03a |
| 3.4 | Bash Script Binary Access | T-MOD-19–21 |
| 4.1 | Running Scripts (run subcommand, target validation) | T-CLI-11–13, T-CLI-27–33, T-CLI-59–60, T-CLI-64–66, T-CLI-78a–78b, T-CLI-80–81, T-CLI-85, T-CLI-96, T-CLI-107–118, T-CLI-114a, T-CLI-119a–119b, T-DISC-33–37, T-API-08c–08d, T-API-14f–14g, T-API-20j–20k, T-API-35a–35c, T-API-40–48, T-LOOP-31a, T-LOOP-38–42 |
| 4.2 | Options (-n, -e, run -h, install -h, top-level -h) | T-CLI-02–06, T-CLI-07b–07c, T-CLI-07e–07g, T-CLI-07j, T-CLI-14–22e, T-CLI-19a, T-CLI-20a–20b, T-CLI-28, T-CLI-34–100, T-CLI-78a–78b, T-CLI-101–102, T-CLI-104–106, T-CLI-119–119c, T-ENV-25b–25c, T-INST-40–49, T-INST-40a–40c, T-INST-49a–49d, T-INST-41a, T-INST-42a–42c, T-INST-43a–43b, T-INST-57a, T-INST-59a, T-API-08e–08g |
| 4.3 | Subcommands | T-SUB-01–19, T-SUB-02a–02d, T-SUB-06a–06b, T-SUB-14a–14k, T-CLI-66, T-CLI-80–81 |
| 5.1 | Discovery | T-DISC-01–16, T-DISC-10a–10b, T-DISC-38–42a, T-DISC-39a, T-DISC-48, T-CLI-42–43, T-CLI-104–104b |
| 5.2 | Name Collision | T-DISC-21–24, T-DISC-21a, T-CLI-22b, T-CLI-43, T-CLI-43a |
| 5.3 | Name Restrictions | T-DISC-15a–15b, T-DISC-25–32, T-DISC-47a, T-DISC-47b, T-CLI-44, T-CLI-22d–22e, T-CLI-102, T-CLI-120, T-LOOP-40–42, T-EDGE-05 |
| 5.4 | Validation Scope | T-DISC-43–47, T-DISC-47a, T-DISC-47b, T-SUB-06, T-SUB-13, T-SUB-19, T-CLI-28, T-CLI-114a, T-API-35c |
| 6.1 | Working Directory | T-EXEC-01–03, T-EXEC-16, T-EXEC-16b, T-API-07a |
| 6.2 | Bash Scripts | T-EXEC-05–07 |
| 6.3 | JS/TS Scripts | T-EXEC-08–14 |
| 6.4 | output() Function | T-MOD-04–14a, T-MOD-13a–13h |
| 6.5 | input() Function | T-MOD-15–18 |
| 6.6 | Input Piping | T-LOOP-11–15, T-LOOP-15a |
| 6.7 | Initial Input | T-LOOP-14 |
| 7.1 | Basic Loop | T-LOOP-01–10, T-LOOP-25, T-CLI-119a–119b |
| 7.2 | Error Handling | T-LOOP-18–24, T-LOOP-18a, T-LOOP-19a, T-LOOP-34–42, T-DISC-42a |
| 7.3 | Signal Handling | T-SIG-01–08 |
| 8.1 | Global Env Storage | T-ENV-01–15f, T-ENV-05a–05e, T-ENV-25–25c, T-CLI-22c, F-ENV-01–05 |
| 8.2 | Local Env Override | T-ENV-16–19, T-ENV-17a, T-ENV-25a |
| 8.3 | Env Injection Precedence | T-ENV-20–24, T-ENV-20a, T-ENV-21a, T-ENV-21b, T-ENV-24a, T-ENV-24b, T-EXEC-04–04b, T-DISC-39a |
| 9.1 | run() | T-API-01–09c, T-API-08a–08e, T-API-08g, T-API-10–10c, T-API-20h–20i, T-API-20j–20k, T-API-30–37, T-API-35a–35c, T-TYPE-04, T-TYPE-06–07 |
| 9.2 | runPromise() | T-API-08f, T-API-11–14g, T-API-14a–14a3, T-API-25–25b, T-API-38–48, T-TYPE-05–07 |
| 9.3 | API Error Behavior | T-API-15–19, T-API-20a–20k, T-API-21c–21d |
| 9.4 | output() and input() (script-side) | *(Same as 6.4/6.5)* |
| 9.5 | Types / RunOptions | T-API-07–08, T-API-07a, T-API-08b–08g, T-API-10–10c, T-API-14f–14g, T-API-20d–20e, T-API-21–21b, T-API-22–25b, T-API-23a, T-API-24a–24b, T-TYPE-01–07 |
| 10.1 | Source Detection | T-INST-01–01a, T-INST-02–08f |
| 10.2 | Source Type Details | T-INST-81–89, T-INST-85a, T-INST-86a |
| 10.3 | Workflow Classification | T-INST-50–56, T-INST-52a, T-INST-55a, T-INST-56a, T-INST-80g |
| 10.4 | Install-time Validation | T-INST-52a, T-INST-61–64, T-INST-80h–80i |
| 10.5 | Collision Handling | T-INST-65–71, T-INST-70a, T-INST-97 |
| 10.6 | Version Checking on Install | T-INST-72–76, T-INST-97b, T-VER-12–13, T-VER-15, T-VER-17, T-VER-22, T-INST-80d–80f |
| 10.7 | Install Atomicity | T-INST-77–80i |
| 10.8 | Selective Workflow Installation | T-INST-57–60, T-INST-57a, T-INST-59a |
| 10.9 | Common Rules | T-INST-90–96, T-INST-97a |
| 11.1 | Top-Level Help | T-CLI-02–06, T-CLI-07e–07g, T-CLI-07j, T-CLI-28, T-CLI-39, T-CLI-61, T-CLI-65, T-CLI-90–91 |
| 11.2 | Run Help | T-CLI-40–43a, T-CLI-62, T-CLI-67–78, T-CLI-84, T-CLI-92–95, T-CLI-101–102, T-CLI-104–106, T-CLI-104a–104b, T-CLI-120, T-DISC-15b, T-DISC-38, T-VER-19 |
| 11.3 | Install Help | T-INST-41–42, T-INST-41a, T-INST-42a–42c, T-INST-49a–49d |
| 12 | Exit Codes | T-EXIT-01–17 |
| 13 | Summary of Special Values | *(Summary-only section — LOOPX_BIN: T-MOD-19–21, T-ENV-20, T-ENV-20a, T-DEL-05; LOOPX_PROJECT_ROOT: T-EXEC-03, T-ENV-21, T-ENV-21a; LOOPX_WORKFLOW: T-EXEC-04–04b, T-ENV-21b; LOOPX_DELEGATED: T-DEL-04, T-DEL-07, T-DEL-09, T-ENV-24a)* |
