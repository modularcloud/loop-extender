# Test Harness Implementation Plan

Items sorted by priority and dependency order. The goal is to implement the **test harness only** (not the loopx product), as defined in TEST-SPEC.md.

---

## Active Issues

1. ~~**Delegation tests pass without loopx implementation**~~ — **RESOLVED.** Restructured delegation tests to use the real loopx binary (via `withDelegationSetup`). Fixed `runGlobal()` to spawn the actual global binary instead of delegating to `runCLI`. All 8 delegation tests now correctly fail without the loopx implementation.

2. ~~**Types tests pass without loopx implementation**~~ — **RESOLVED.** Added `not.toBeAny()` guards to all type assertions. Configured vitest typecheck project with `typecheck.include` to actually type-check the file (default pattern only matches `*-d.ts` files). Added `ignoreSourceErrors: true` to avoid failing on unrelated source files. Excluded `types.test.ts` from the "unit" project. All 7 type tests now correctly fail in typecheck mode without the loopx package.

3. **~155 E2E tests pass coincidentally** — Tests that only assert `exitCode === 1` pass because the binary-not-found error also returns exit 1. Some tests match stderr patterns coincidentally (e.g., T-CLI-09 matches "default" from Node's `defaultResolveImpl` stack trace). This is expected per TEST-SPEC §3.2 (stub allowlist) and these tests will work correctly once loopx is implemented. No action needed beyond documenting the allowlist.

---

## Completed Items

All items below were previously completed.

---

### P0 — Project Scaffolding

Initialize `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, and directory structure per TEST-SPEC §2.2.

---

### P0 — Helper Library (`tests/helpers/`)

- `tests/helpers/fixtures.ts` — `createTempProject`, `createScript`, `createDirScript`, `createBashScript` (TEST-SPEC §2.3, §2.4)
- `tests/helpers/cli.ts` — `runCLI`, `runCLIWithSignal` (TEST-SPEC §2.3)
- `tests/helpers/api-driver.ts` — `runAPIDriver` (TEST-SPEC §2.3)
- `tests/helpers/env.ts` — `createEnvFile`, `writeEnvFileRaw`, `withGlobalEnv`, `withIsolatedHome` (TEST-SPEC §2.3)
- `tests/helpers/servers.ts` — `startLocalHTTPServer`, `startLocalGitServer`, `withGitURLRewrite` (TEST-SPEC §2.3, §2.6)
- `tests/helpers/runtime.ts` — `forEachRuntime`, runtime detection (TEST-SPEC §2.3, §2.5)
- `tests/helpers/delegation.ts` — `withDelegationSetup` (TEST-SPEC §2.3)
- Fixture script factory functions: `emit-result`, `emit-goto`, `emit-stop`, `emit-result-goto`, `emit-raw`, `emit-raw-ln`, `exit-code`, `cat-stdin`, `write-stderr`, `sleep-then-exit`, `write-env-to-file`, `observe-env`, `write-cwd-to-file`, `write-value-to-file`, `stdout-writer`, `ts-output`, `ts-input-echo`, `ts-import-check`, `signal-ready-then-sleep`, `signal-trap-exit`, `signal-trap-ignore`, `spawn-grandchild`, `write-pid-to-file`, `counter` (TEST-SPEC §2.4)

---

### P0 — Phase 0 Harness Validation (`tests/harness/smoke.test.ts`)

H-01 through H-15: Temp project lifecycle, script fixture creation, env file creation, process spawning (exit code, stdout, stderr, cwd, env), signal delivery, HTTP server, git server, runtime detection, global env isolation. (TEST-SPEC §3.1)

---

### P0 — E2E Test Files (Core Functionality)

- `tests/e2e/cli-basics.test.ts` — T-CLI-01 through T-CLI-23: Version, help, default script, named script, `-n` counting, `-e` env file, validation errors. (TEST-SPEC §4.1)
- `tests/e2e/subcommands.test.ts` — T-SUB-01 through T-SUB-19: `loopx output` subcommand, `loopx env set/remove/list`. (TEST-SPEC §4.2)
- `tests/e2e/discovery.test.ts` — T-DISC-01 through T-DISC-50: File/directory script discovery, name collisions, reserved names, name restrictions, symlinks, caching, validation scope, discovery scope. (TEST-SPEC §4.3)
- `tests/e2e/execution.test.ts` — T-EXEC-01 through T-EXEC-18a: Working directory, bash/JS/TS execution, directory scripts. (TEST-SPEC §4.4)
- `tests/e2e/output-parsing.test.ts` — T-PARSE-01 through T-PARSE-29: Structured output, raw fallback, type coercion, whitespace, mixed fields. (TEST-SPEC §4.5)
- `tests/e2e/loop-state.test.ts` — T-LOOP-01 through T-LOOP-25: Basic loop, `-n` counting, input piping, goto behavior, error handling. (TEST-SPEC §4.6)
- `tests/e2e/env-vars.test.ts` — T-ENV-01 through T-ENV-25a: Global env, env parsing, local env override, injection precedence, caching. (TEST-SPEC §4.7)
- `tests/e2e/module-resolution.test.ts` — T-MOD-01 through T-MOD-22: `import from "loopx"`, `output()`, `input()`, `LOOPX_BIN`, ESM-only contract. (TEST-SPEC §4.8)
- `tests/e2e/programmatic-api.test.ts` — T-API-01 through T-API-25b: `run()` async generator, `runPromise()`, error behavior, envFile option, maxIterations validation, AbortSignal. (TEST-SPEC §4.9)
- `tests/e2e/install.test.ts` — T-INST-01 through T-INST-GLOBAL-01: Source detection, single-file/git/tarball install, common rules, post-validation, global install. (TEST-SPEC §4.10)
- `tests/e2e/signals.test.ts` — T-SIG-01 through T-SIG-07: SIGINT, SIGTERM, child cleanup, grace period, process group, between-iterations. (TEST-SPEC §4.11)
- `tests/e2e/delegation.test.ts` — T-DEL-01 through T-DEL-08: Global-to-local delegation, ancestor delegation, LOOPX_DELEGATED, LOOPX_BIN, import resolution. (TEST-SPEC §4.12)

---

### P1 — E2E Cross-Cutting & Edge Cases

- `tests/e2e/exit-codes.test.ts` — T-EXIT-01 through T-EXIT-13: Success/error/signal exit codes. (TEST-SPEC §4.13)
- Edge cases — T-EDGE-01 through T-EDGE-15: Large result, JSON-special chars, partial writes, stdout/stderr separation, unicode, deep goto chains, stdin deadlock, large `-n`, empty `.loopx/`, env file edge cases. (TEST-SPEC §7)

---

### P2 — Fuzz Tests

- `tests/fuzz/output-parsing.fuzz.test.ts` — F-PARSE-01 through F-PARSE-05: Output parsing fuzz with arbitrary JSON/strings. (TEST-SPEC §5.1)
- `tests/fuzz/env-parsing.fuzz.test.ts` — F-ENV-01 through F-ENV-05: Env parsing fuzz with arbitrary env content. (TEST-SPEC §5.2)

---

### P2 — Unit Tests

- `tests/unit/parse-output.test.ts` — `parseOutput` internal seam tests. (TEST-SPEC §6.1)
- `tests/unit/parse-env.test.ts` — `parseEnvFile` internal seam tests. (TEST-SPEC §6.2)
- `tests/unit/source-detection.test.ts` — `classifySource` internal seam tests. (TEST-SPEC §6.3)
- `tests/unit/types.test.ts` — T-TYPE-01 through T-TYPE-07: Type surface tests via vitest typecheck. (TEST-SPEC §6.4)

---

### P3 — Stub Validation (TEST-SPEC §3.2)

Minimal stub binary, stub allowlist, validation procedure.

---

### P3 — CI Configuration (TEST-SPEC §8)

Runtime matrix, pipeline stages, timeouts, parallelism config, `--bail` for Phase 0.

---

## Implementation Notes

- **No product code** — this plan covers only the test harness. The loopx implementation does not exist yet.
- **Internal seams** — unit and fuzz tests depend on `parseOutput`, `parseEnvFile`, and `classifySource` being importable from `loopx/internal`. These are implementation requirements that must be fulfilled by the product code before unit/fuzz tests can pass against real logic.
- **Test categorization** — use `describe("HARNESS: ...")`, `describe("SPEC: ...")`, and `describe("FUZZ: ...")` blocks per §3.3.
- **Self-cleaning** — all helpers must clean up temp dirs, servers, env mutations via afterEach hooks or explicit cleanup.
- **`runAPIDriver` import resolution** — driver must create a temp consumer dir with `node_modules/loopx` symlinked to build output, exercising real package exports.
