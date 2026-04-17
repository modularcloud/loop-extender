# Implementation Plan for loopx Test Harness

**Status: Test harness substantially conformant with TEST-SPEC.md as of 2026-04-17. One concrete test-side gap outstanding — see P0 below.**

## Audit Results (2026-04-17)

Breadth audit of `tests/` against TEST-SPEC.md covering skip markers, placeholder assertions, TODO/FIXME comments, and a 30-ID sample of recently-added spec IDs:

- **Unconditional skips of spec-required tests:** 0. (The single `it.skip` in `tests/helpers/runtime.ts:63` is a defensive no-runtime-detected fallback inside the `forEachRuntime` helper, not a gap.)
- **Conditional skips:** 42, all legitimate (`!isRuntimeAvailable("bun")`, `IS_ROOT`, `process.getuid?.() === 0`). Each maps to a spec-documented condition.
- **Placeholder assertions (`expect(true).toBe(true)`, `expect.fail`, etc.):** 0.
- **TODO/FIXME markers in test files:** 0.
- **30-ID spec sample located in test files:** 30/30. IDs sampled include T-VER-24d, T-API-20q2, T-INST-74a, T-CLI-120b, T-LOOP-31c, T-DISC-48a, T-API-08ab, T-API-14r, T-INST-80c, T-VER-27c, T-CLI-119k, T-DISC-10g, T-API-48a, T-SUB-02k, T-SUB-14k, T-INST-63e, T-VER-26c, T-API-44c, T-DISC-40i, T-LOOP-19b, T-EXEC-16b, T-MOD-13p, T-ENV-21d, T-INST-86a, T-CLI-78d, T-INST-97a, T-API-35f, T-PARSE-12a, T-API-14j8, T-DISC-26b.

Per-file state (unchanged from prior audit; migration to the ADR-0003 workflow model is complete):

- `tests/e2e/cli-basics.test.ts` — ADR-0003-aligned; 154 IDs × Node/Bun.
- `tests/e2e/delegation.test.ts` — ADR-0003 §5 project-root-only delegation behaviors; 29 IDs.
- `tests/e2e/discovery.test.ts` — Two-level workflow/script discovery; 83 cases.
- `tests/e2e/execution.test.ts` — Workflow-directory cwd, LOOPX_WORKFLOW injection, ESM-forced JS/TS, Bun classic-JSX config.
- `tests/e2e/env-vars.test.ts` — 96 cases; LOOPX_* injection + LOOPX_DELEGATED pass-through.
- `tests/e2e/install.test.ts` — 386 cases covering workflow classification, selective `-w`, `-y` override, preflight atomicity, version checking. **Global install smoke tests have a known gap — see P0.**
- `tests/e2e/loop-state.test.ts` — 96 cases; cross-workflow `goto` + starting-target reset.
- `tests/e2e/module-resolution.test.ts` — 80 cases; workflow-local `node_modules/loopx` precedence + NODE_PATH shim.
- `tests/e2e/output-parsing.test.ts` — 62 cases; all parser IDs exercise real subjects.
- `tests/e2e/programmatic-api.test.ts` — 346 cases; `run()` / `runPromise()` with workflow-shape targets.
- `tests/e2e/subcommands.test.ts` — 86 cases; qualified-target serialization + `env` subcommands.
- `tests/e2e/version-check.test.ts` — 132 cases against `src/version-check.ts`.
- `tests/e2e/edge-cases.test.ts`, `tests/e2e/exit-codes.test.ts`, `tests/e2e/signals.test.ts` — migrated to workflow helpers.
- `tests/harness/smoke.test.ts`, `tests/fuzz/*` — migrated to workflow helpers.
- `tests/unit/source-detection.test.ts` — classifier-throw contract encoded.

## P0 — Bring T-INST-GLOBAL-01 / 01a into conformance with updated TEST-SPEC §4.10 Global Install Smoke Test

TEST-SPEC.md:1555-1556 was tightened on 2026-04-17 after discovering that both global-install smoke tests silently pass against the current published package even though `loop-extender` ships with no declared dependency on `tsx`, which `src/execution.ts:173` spawns to run every `.ts`/`.js`/`.jsx`/`.tsx` workflow script. The tests mask the defect via three leakage paths; the spec now forbids all three. Only the Global Install block at `tests/e2e/install.test.ts:4022-4156` is affected. Production code is out of scope for this plan — we are only bringing the existing tests into compliance with the tightened spec.

### Gaps

- **PATH leakage (both tests).** `tests/e2e/install.test.ts:4077` (Node) and `:4147` (Bun) set `PATH: \`${join(globalPrefix, "bin")}:${process.env.PATH}\``. When vitest is invoked via `npm run test:*` or `npx vitest`, `process.env.PATH` already carries the loopx repo's `./node_modules/.bin` at its front, which exports `tsx`, `bun`, and every other devDependency binary into the spawned `loopx` child. Spec forbids passing `process.env.PATH` through unchanged.
- **Full-`process.env` leakage (both tests).** The same two lines spread `...process.env` into the child env. Other dev-tree-derived variables (e.g. `npm_config_*`, `NODE_PATH` if set by the shell, `INIT_CWD`) can also influence module resolution. Spec implicitly excludes these by requiring the spawn env to simulate a clean consumer install.
- **No symlink-liveness assertion (both tests).** Neither test `lstat`s the installed `loop-extender` package root to verify it is a real directory. The motivating failure mode — `npm install -g .` from a local same-filesystem path creating a symlink into the dev `dist/` — would currently slip through. (The tests already install from `npm pack` output so they happen to be safe today, but spec now requires the explicit assertion so regressions can't silently reintroduce the leak.)

### Conformance changes (tests only — do not touch `src/`)

1. **Build a scrubbed spawn env in both tests.** Replace `...process.env` + `PATH: "...${process.env.PATH}"` with an explicit env object containing only: `HOME`, `TMPDIR` (if set), `GIT_CONFIG_GLOBAL` (if set by the test scaffolding), and a `PATH` constructed as `${globalPrefix}/bin:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`. For T-INST-GLOBAL-01a, substitute the Bun interpreter's directory (resolved via `which bun` or the existing Bun availability helper) in place of `dirname(process.execPath)`.
2. **Assert real-directory install.** After `npm install -g --prefix ...`, `lstatSync(join(globalPrefix, "lib", "node_modules", pkgName))` and `expect(stat.isSymbolicLink()).toBe(false)` in both tests. `pkgName` is already resolved in T-INST-GLOBAL-01a (line 4134); hoist that resolution to T-INST-GLOBAL-01 too. `lstatSync` is already imported at line 7.
3. **Land both tests as currently-failing** before any `src/` fix, per standard TDD flow. Once landed, they will fail with `Error: spawn tsx ENOENT` exactly as reproduced during the 2026-04-17 investigation, proving they now catch the defect.

### Suggested helper extraction (optional but recommended)

The scrubbed-env construction is non-trivial and will be needed by any future spec that validates end-user install behavior (e.g., dependency-hoisting tests, post-install hook tests, path-independence tests). Add a `buildIsolatedSpawnEnv({ globalPrefix, runtime }): Record<string, string>` utility to `tests/helpers/cli.ts` alongside the existing `runCLI`. Do **not** modify `runCLI` itself — most tests legitimately want the dev environment. A companion `assertRealDirectory(path)` one-liner in `tests/helpers/fixtures.ts` would reduce duplication between the Node and Bun variants. Only extract after both inline implementations have landed and failed; don't invent the abstraction before the second call site exists.

### Acceptance criteria

- `env -i HOME=$HOME PATH=/usr/bin:/usr/local/bin ./node_modules/.bin/vitest run tests/e2e/install.test.ts -t "T-INST-GLOBAL-01"` produces the same pass/fail verdict as `npx vitest run ...`. (Today the two diverge: the scrubbed-PATH run fails, the npm-invoked run passes. After conformance they must agree.)
- Symlink-installed `loop-extender` roots (simulated by manually running `npm install -g /path/to/dist` before the test) cause the test to fail with an assertion error, not to silently pass.

## P1 — None outstanding

The prior P1 cleanup (legacy helper deletion, orphan-ID audit, fixture corrections) is complete and unchanged.

## P2 — Follow-ups (non-blocking)

- **Re-run full suite under both Node and Bun** to confirm no environment-sensitive flakes in cross-workflow fixtures that rely on counter-file sequencing (T-API-08ab, T-API-14r, T-EXEC-04c).
- **Permission-000 coverage under root.** Several tests use `it.skipIf(IS_ROOT)` for unreadable-file paths; if CI ever runs as non-root these activate automatically.
- **Tarball fixtures via `python3`** in `install.test.ts` — external-tool dependency; consider a JS-only implementation if the Python assumption becomes inconvenient.
- **`loopx` NODE_PATH shim under `$TMPDIR`** — per-process directory; verify abnormal-exit cleanup stays acceptable.

## Notes

- `.loopx/.iteration.tmp` appears in `git status` — left by a prior loopx run, not part of this work. Not tracked.
- The P0 item above was surfaced by a 2026-04-17 investigation into why the README quick-start example fails against a freshly installed published package. TEST-SPEC.md:1555-1556 was the minimal spec edit to prevent regression. This fix_plan.md item is the test-side follow-through; the `src/` fix (adding `tsx` as a declared dependency or replacing the `tsx` spawn with an alternative) is tracked separately and is not part of this plan.
