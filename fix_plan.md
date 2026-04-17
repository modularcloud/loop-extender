# Implementation Plan for loopx Test Harness

**Status: Test Harness Significantly Out of Sync with TEST-SPEC.md (ADR-0003)**

## Audit Results (2026-04-17)

Prior "Production Ready — All 1068 tests pass" claim was **incorrect**.

- TEST-SPEC.md defines **970 unique test IDs** (post-ADR-0003).
- tests/ directory implements **534 unique test IDs** → **~436 IDs missing**.
- **0 test files reference "workflow"** — tests still encode the pre-ADR-0003 flat-script / directory-script model.
- tests/helpers/fixtures.ts lacks the TEST-SPEC §2.3 workflow helpers (`createWorkflow`, `createWorkflowScript`, `createBashWorkflowScript`, `createWorkflowPackageJson`).
- src/ still uses the pre-ADR-0003 model (`src/discovery.ts` scans flat files and directory scripts; `src/validate-dir-script.ts` remains).
- The 1068 currently-passing tests pass because **tests and implementation are consistently pre-ADR-0003**, but TEST-SPEC has moved on.

Per PROMPT.md: goal is to implement the test harness **first**; some tests are expected to fail until the implementation catches up. We are building the test harness to the workflow model per TEST-SPEC.md.

## Priority Ordering

### ✅ P0 — Workflow fixture helpers (landed, commit 7cbe556)

All four workflow helpers in `tests/helpers/fixtures.ts` are implemented and exported via `tests/helpers/index.ts`: `createWorkflow`, `createWorkflowScript`, `createBashWorkflowScript`, `createWorkflowPackageJson`. Matches TEST-SPEC §2.3 lines 134-159.

### P0 — Test suite rewrite (workflow-model alignment)

Every implemented test currently uses the flat-script model. Samples confirmed: `T-CLI-01` creates `.loopx/myscript.sh`; `T-DISC-01`/`T-LOOP-01` follow the same pattern. TEST-SPEC has these under the workflow model (`.loopx/myscript/index.sh` for bare targets, `workflow:script` for nested). The tests must be rewritten rather than augmented.

- [ ] **Rewrite tests/e2e/cli-basics.test.ts** for new invocation grammar (`loopx run [opts] <workflow>[:<script>]`), covering name-restriction ordering tests (T-CLI-114a, T-CLI-118b, T-CLI-120a/b, T-CLI-109a) and the remaining ~54 missing T-CLI IDs.
- [ ] **Rewrite tests/e2e/programmatic-api.test.ts** for `run(target)` / `runPromise(target)` signature (renamed from `scriptName`), new `RunOptions.cwd` (project root, not script cwd) semantics, and ~117 missing T-API IDs including T-API-20p2/p3/q/q2, T-API-35c/f, T-API-44b/c, T-API-45a.
- [ ] **Rewrite tests/e2e/install.test.ts** for workflow-based install (T-INST-*): multi-workflow repos, `-w`/`--workflow`, `-y` override, preflight-atomic writes, single-file-URL removal, and ~172 missing T-INST IDs including T-INST-42k/l, T-INST-52d, T-INST-54d, T-INST-56a/e, T-INST-63b/e, T-INST-64, T-INST-70d, T-INST-72a/73a, T-INST-74–76, T-INST-79, T-INST-80b/c/d.
- [ ] **Rewrite tests/e2e/subcommands.test.ts** — `loopx output --goto` now accepts qualified targets (T-SUB-* and companions).
- [ ] **Rewrite tests/e2e/delegation.test.ts** — project-root-only delegation per ADR-0003 §5. Drops ancestor traversal tests, adds project-root package.json failure modes (T-DEL-14b and ~18 missing IDs).
- [ ] **Rewrite tests/e2e/env-vars.test.ts** — add `LOOPX_WORKFLOW` injection tests (T-ENV-20b, T-ENV-21d, and 6 missing IDs).
- [ ] **Rewrite tests/e2e/module-resolution.test.ts** — workflow-local `node_modules/loopx` precedence (T-MOD-*, 13 missing).

### ✅ P0 — Completed rewrites

- [x] **Rewrote tests/e2e/discovery.test.ts** — covers every T-DISC-* ID documented in TEST-SPEC §4.3, grouped by subsection (Workflow Discovery, Script Discovery Within Workflows, Default Entry Point, Name Collisions Within Workflows, Workflow and Script Naming, Previously Reserved Names, Symlinks, Discovery Caching, Validation Scope, Discovery Scope). Concretely: T-DISC-01–11, 10a–10g, 12, 13, 14, 14a, 14b, 15, 15a, 15b, 16, 17, 18, 19, 20, 20a, 20b, 20c, 21, 21a, 22, 23, 24, 25, 26, 26a, 26b, 27, 28, 29, 30, 30a, 30b, 31, 32, 33, 34, 35, 36, 37, 38, 39, 39a, 40, 40a–40i, 41, 42, 42a, 42b, 42c, 43, 44, 45, 46, 47, 47a, 47b, 48, 48a — 83 cases total. Uses only the workflow helpers (`createWorkflow`, `createWorkflowScript`, `createBashWorkflowScript`, `createWorkflowPackageJson`) from tests/helpers/fixtures.ts; legacy `createScript`/`createDirScript`/`createBashScript` are not referenced and remain for other tests per the P1 cleanup phase. Current pass/fail against the still-pre-ADR-0003 src/ implementation: 25 pass, 58 fail — matches PROMPT.md's expectation that tests ahead of implementation should fail. Full suite runs in ~4s (previously ~94s on first draft; trimmed 90s of timeouts by making fixture scripts in T-DISC-10a/20b/20c exit 0 immediately so pre-ADR-0003 dir-script interpretation does not hang). Structural "no migration-warning category" check in T-DISC-10a and T-DISC-20c uses a helper `hasWarningCategoryFor(stderr, subject)` that flags any line starting with warning/notice/advisory/migration/deprecation that names the given subject path — no prose-level phrase blacklisting. T-DISC-48a uses `runAPIDriver("node", ...)` from tests/helpers/api-driver.ts to exercise the programmatic `runPromise` + `{cwd}` API. T-DISC-47 uses `startLocalGitServer` from tests/helpers/servers.ts for the install source, since ADR-0003 removed single-file URL install.
- [x] **Created tests/e2e/version-check.test.ts** — covers all 66 T-VER-* IDs. Runs 132 cases (66 × two runtimes), ~126 fail against the pre-ADR-0003 implementation as expected per PROMPT.md; the remaining ~6 pass incidentally (`run -h` path already skips version checking; `loopx install` already rejects unrecognized workflow layouts). Assertion style: name-scoped regex matchers over stderr lines — tolerant of specific warning wording while pinning down shape, workflow attribution, and per-workflow dedupe counts.
- [x] **Rewrote tests/e2e/loop-state.test.ts** — covers all 48 T-LOOP-* IDs from TEST-SPEC §4.6, grouped by subsection: T-LOOP-01–05 (basic loop behavior), T-LOOP-06–10 (`-n` counting), T-LOOP-11–15 plus T-LOOP-15a (input piping, including the new cross-workflow stdin piping case), T-LOOP-16–19 plus T-LOOP-18a/19a/19b (intra-workflow goto semantics with the new ADR-0003 bare-goto-vs-workflow-name disambiguation tests), T-LOOP-30–43 plus T-LOOP-30a/31a/31b/31c/32a (cross-workflow goto semantics — the entire post-ADR-0003 section), T-LOOP-20–24 (error handling), and T-LOOP-25 (final iteration output). Uses workflow helpers exclusively (`createWorkflowScript`, `createBashWorkflowScript`); does NOT reference `createScript` or `createDirScript` (legacy helpers kept pending the P1 cleanup commit). Starting targets use `workflow:script` form — `ralph` (meaning `ralph:index`), `alpha`, and `ralph:check` for the explicit script start in T-LOOP-43. Current pass/fail against the still-pre-ADR-0003 src/ implementation: 32 pass, 64 fail (96 total = 48 × node/bun). The passing tests are those whose expectations (exit 1 on script-not-found) incidentally align with the pre-ADR-0003 "flat-script not discovered" error path — e.g., T-LOOP-18a/19/19a/20/21/34/35/36/37/38/39/40/41/42. Once src/ migrates to ADR-0003, the remaining tests should pass for the right reasons. Tests compile cleanly (vitest reports "Type Errors: no errors"); `npx tsc --noEmit` passes.
- [x] **Rewrote tests/e2e/execution.test.ts** — covers every T-EXEC-* ID documented in TEST-SPEC §4.4, grouped by subsection: T-EXEC-01, 02, 03, 03a, 04, 04a, 04b, 04c (Working Directory / Environment — workflow-directory cwd semantics, `LOOPX_WORKFLOW` env var injection, cross-workflow cwd switching); T-EXEC-05, 06, 07 (Bash Scripts — shebang, `chmod +x`, exit-code propagation); T-EXEC-08, 09, 10, 11, 12, 13, 13a, 13b, 14 (JS/TS Scripts — ESM imports, workflow-local `package.json`, Node vs Bun runtime selection, TS-only-in-Bun); T-EXEC-15, 16, 16a, 16b (Workflow-Local Dependencies — `node_modules` resolution, missing-dep failures, cross-workflow dep isolation). Uses only the workflow helpers from tests/helpers/fixtures.ts (`createWorkflow`, `createWorkflowScript`, `createBashWorkflowScript`, `createWorkflowPackageJson`); does NOT reference the legacy `createScript` / `createDirScript` / `createBashScript` (legacy helpers kept pending the P1 cleanup commit). The obsolete pre-ADR-0003 T-EXEC-17, T-EXEC-18, T-EXEC-18a directory-script tests are removed as they are orphans in TEST-SPEC §4.4. Runtime parameterization: tests without a runtime marker in TEST-SPEC use `forEachRuntime` (runs once per available runtime — Node and Bun); T-EXEC-13 is explicitly `[Node]` (outside `forEachRuntime`); T-EXEC-13b and T-EXEC-14 are explicitly `[Bun]` (guarded with `it.skipIf(!isRuntimeAvailable("bun"))`). Cross-workflow fixtures (T-EXEC-03a, 04b, 04c, 16b): the target script emits `{"stop":true}` after writing its marker so the chain ends cleanly; T-EXEC-04c uses a bare no-goto `beta:step` to trigger loop reset and verifies `alpha-marker` contains `"alphaalpha"` (alpha runs on iterations 1 and 3) and `beta-marker` contains `"beta"` with `-n 3`. T-EXEC-15 creates a workflow-local `node_modules/my-local-lib/` manually (via `mkdir`+`writeFile` under `.loopx/with-deps/`) since the helpers only create one file each — consistent with how other workflow-model tests install deps. Current pass/fail against the still-pre-ADR-0003 src/ implementation: 4 pass, 41 fail (45 total). The 4 passing tests are T-EXEC-13a (CJS `require()` fails) and T-EXEC-16a (missing-dep fails) across Node + Bun — both assert exit != 0, which happens to match the pre-ADR-0003 "workflow not found" error path. Once src/ migrates to ADR-0003, the remaining 41 should pass for the right reasons. Tests compile cleanly (vitest reports "Type Errors: no errors"); `npx tsc --noEmit` passes.

### P1 — Cleanup

- [ ] **Delete tests/helpers/fixtures.ts `createScript` and `createDirScript`** once all tests migrate. ADR-0003 §"Consequences" forbids legacy compatibility; these helpers must not persist once their last caller is converted.
- [ ] **Audit 81 orphan test IDs** in tests/ that do not appear in TEST-SPEC.md — likely renumbered; decide rename vs delete.

### Runtime seam / internal test seams

- [ ] Confirm `LOOPX_TEST_INSTALL_FAULT=commit-fail-after:<n>` seam is tested once install tests land (TEST-SPEC §1.4).
- [ ] Verify `loopx/internal` barrel still exposes `parseOutput`, `parseEnvFile`, `classifySource` after refactor.

## Work-order strategy

1. Land workflow fixture helpers (P0 blockers) with no behavior change to existing tests — ship a commit that adds helpers without removing the old ones.
2. Incrementally migrate each e2e test file to workflow helpers in separate commits, one test file at a time. Each commit expected to introduce test failures against the un-updated src/ implementation (that is the intended design per PROMPT.md step 5).
3. Once all tests compile against the new helpers, delete `createScript` / `createDirScript` in one final cleanup commit.

## Notes

- Do NOT touch src/ in this phase. The test harness is the immediate deliverable. src/ migration to the workflow model is a separate follow-up (ADR-0003 is still Test Specified, not Implemented).
- `.loopx/.iteration.tmp` appears in `git status` — left by a prior loopx run, not part of this work. Not tracked.
