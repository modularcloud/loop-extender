# Implementation Plan for loopx Test Harness

**Status: src/ Implementation Migration to Workflow Model (ADR-0003) — DONE (2026-04-17)**

## Audit Results

The test suite is now substantially green against the migrated src/. Tests and implementation both encode the ADR-0003 workflow model. Per-file current state:

- `tests/e2e/cli-basics.test.ts` — ADR-0003-aligned; 154 IDs × Node/Bun. Substantially green.
- `tests/e2e/delegation.test.ts` — ADR-0003 §5 project-root-only delegation behaviors verified; 29 IDs.
- `tests/e2e/discovery.test.ts` — Two-level workflow/script discovery; 83 cases. Substantially green.
- `tests/e2e/execution.test.ts` — Workflow-directory cwd, LOOPX_WORKFLOW injection, ESM-forced JS/TS, Bun classic-JSX config verified.
- `tests/e2e/env-vars.test.ts` — 96 cases; LOOPX_WORKFLOW / LOOPX_PROJECT_ROOT / LOOPX_BIN injection verified; LOOPX_DELEGATED pass-through verified.
- `tests/e2e/install.test.ts` — 386 cases (193 × Node/Bun) covering workflow classification, selective `-w`, `-y` override, preflight atomicity, version checking.
- `tests/e2e/loop-state.test.ts` — 96 cases (48 × Node/Bun); cross-workflow `goto` + starting-target reset verified.
- `tests/e2e/module-resolution.test.ts` — 80 cases; workflow-local `node_modules/loopx` precedence + NODE_PATH shim verified.
- `tests/e2e/output-parsing.test.ts` — 62 cases (31 × Node/Bun); all parser IDs now exercise real subjects.
- `tests/e2e/programmatic-api.test.ts` — 346 cases (173 × Node/Bun); `run()` / `runPromise()` with workflow-shape targets.
- `tests/e2e/subcommands.test.ts` — 86 cases; `loopx output --goto` qualified-target serialization + `env` subcommands.
- `tests/e2e/version-check.test.ts` — 132 cases (66 × Node/Bun) against the new `src/version-check.ts`.
- `tests/e2e/edge-cases.test.ts`, `tests/e2e/exit-codes.test.ts`, `tests/e2e/signals.test.ts` — migrated to workflow helpers.
- `tests/harness/smoke.test.ts` — migrated to workflow helpers.
- `tests/fuzz/output-parsing.fuzz.test.ts`, `tests/fuzz/env-parsing.fuzz.test.ts` — migrated to workflow helpers.
- `tests/unit/source-detection.test.ts` — single-file URL assertions flipped to `expect(() => classifySource(...)).toThrow()` matching the new classifier contract.

### ✅ P0 — src/ Migration to Workflow Model (completed 2026-04-17)

Summary of what landed:

- `src/discovery.ts` — rewritten for two-level workflow/script discovery per SPEC §5.1; added `Workflow` / `ScriptFile` types and `isWorkflowByStructure(path)` for install collision checks.
- `src/target-validation.ts` — new; `parseTarget` / `parseGoto` with full rejection matrix and name-restriction matching.
- `src/semver.ts` — new minimal range checker (exact, caret, tilde, wildcard, comparators, AND/OR compounds, prerelease ordering).
- `src/version-check.ts` — new; workflow-level `package.json` validation returning typed `VersionCheckResult`; SPEC-conformant warning prose.
- `src/install.ts` — rewritten; workflow-based classification (single/multi/zero), `-w`, `-y`, preflight-atomic staging via tmp-dir + rename commit, version checking, `LOOPX_TEST_INSTALL_FAULT=commit-fail-after:<n>` seam honored, `.git/` excluded, permission-tolerant copy.
- `src/bin.ts` — rewritten; project-root-only delegation with declared-dependency check + failure-mode warnings; new `parseInstallArgs`; `parseRunArgs` emits `target`; distinguishes missing-target usage error from empty-string invalid-target rejection.
- `src/execution.ts` — cwd always workflow dir; injects `LOOPX_BIN` / `LOOPX_PROJECT_ROOT` / `LOOPX_WORKFLOW`; Bun-specific `--config=<tmp bunfig.toml>` + classic-JSX flags + `--define require:null`; per-process `loopx` shim under `$TMPDIR` prepended to `NODE_PATH` for global-install import resolution.
- `src/loop.ts` — cross-workflow `goto` resolution (bare + qualified); per-loop visited-workflow set dedupes version-check warnings; starting target resets on loop reset.
- `src/run.ts` — renamed parameter to `target`; `RunOptions.cwd` now means project root; lazy error surface preserved.
- `src/env.ts` — `mergeEnv` no longer injects per-script vars (execution.ts owns that); `LOOPX_DELEGATED` passed through (not scrubbed).
- `src/parsers/classify-source.ts` — single-file URL fallback replaced with throw; only `"git"` and `"tarball"` valid.
- `src/validate-dir-script.ts` — deleted.
- `src/internal.ts` — exports extended with `parseTarget`, `parseGoto`, `isValidRange`, `satisfies`, `parseVersion`, `checkWorkflowVersion` for unit testing.

### ✅ P1 — Cleanup (completed 2026-04-17)

- [x] **Deleted legacy helpers** `createScript`, `createDirScript`, `createBashScript` from `tests/helpers/fixtures.ts`. All prior callers (`tests/e2e/edge-cases.test.ts`, `tests/e2e/exit-codes.test.ts`, `tests/e2e/signals.test.ts`, `tests/harness/smoke.test.ts`, `tests/fuzz/output-parsing.fuzz.test.ts`, `tests/fuzz/env-parsing.fuzz.test.ts`) now use workflow helpers exclusively. ADR-0003 "no compatibility shims" honored.
- [x] **Orphan test ID audit** — resolved. Stale pre-ADR-0003 directory-script IDs removed during file rewrites; two fixture corrections landed: `T-INST-08a` workflow-name expectation flipped from `.loopx/archive/` (wrapperDir) to `.loopx/main/` (URL archive-name per SPEC §10.2, consistent with T-INST-85a); `T-INST-56b` tarball fixture nests `helpers.ts` one level deeper so `lib/` truly has no top-level scripts (matches TEST-SPEC "nested inside").

## Follow-ups (P2)

None critical. Items to keep on radar:

- **Re-run full suite under both Node and Bun** now that the migration is complete — confirm no environment-sensitive flakes in cross-workflow fixtures that rely on counter-file sequencing (T-API-08ab, T-API-14r, T-EXEC-04c).
- **Permission-000 test coverage under root** — several tests use `it.skipIf(IS_ROOT)` for unreadable-file paths; if CI eventually runs under non-root these will activate automatically. No action needed unless CI plans change.
- **Tarball fixtures via `python3`** in `install.test.ts` — works today but is an external-tool dependency; consider a JS-only implementation if the Python assumption becomes inconvenient.
- **`loopx` NODE_PATH shim** under `$TMPDIR` — per-process directory; verify cleanup on abnormal exit is acceptable (OS-level tmp cleanup suffices today).

## Notes

- `.loopx/.iteration.tmp` appears in `git status` — left by a prior loopx run, not part of this work. Not tracked.
