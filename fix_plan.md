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

- [ ] **Rewrite tests/e2e/discovery.test.ts** for workflow discovery semantics (T-DISC-*). Target IDs include T-DISC-10a–g (workflow detection), T-DISC-15a–b, T-DISC-20a–c, T-DISC-21a, T-DISC-26a–b, T-DISC-39a, T-DISC-40a–i (9 cases), T-DISC-42a–c, T-DISC-47a–b, T-DISC-48a. Current file has 78 T- refs, all flat-model.
- [ ] **Rewrite tests/e2e/loop-state.test.ts** for cross-workflow goto semantics (T-LOOP-30–43, T-LOOP-31a–c, T-LOOP-19a–b, etc.). Current 52 T- refs all assume intra-`.loopx/` script transitions.
- [ ] **Rewrite tests/e2e/execution.test.ts** for workflow-directory cwd semantics (T-EXEC-03a, T-EXEC-04a–c, T-EXEC-16a–b, LOOPX_WORKFLOW env var).
- [ ] **Rewrite tests/e2e/cli-basics.test.ts** for new invocation grammar (`loopx run [opts] <workflow>[:<script>]`), covering name-restriction ordering tests (T-CLI-114a, T-CLI-118b, T-CLI-120a/b, T-CLI-109a) and the remaining ~54 missing T-CLI IDs.
- [ ] **Rewrite tests/e2e/programmatic-api.test.ts** for `run(target)` / `runPromise(target)` signature (renamed from `scriptName`), new `RunOptions.cwd` (project root, not script cwd) semantics, and ~117 missing T-API IDs including T-API-20p2/p3/q/q2, T-API-35c/f, T-API-44b/c, T-API-45a.
- [ ] **Rewrite tests/e2e/install.test.ts** for workflow-based install (T-INST-*): multi-workflow repos, `-w`/`--workflow`, `-y` override, preflight-atomic writes, single-file-URL removal, and ~172 missing T-INST IDs including T-INST-42k/l, T-INST-52d, T-INST-54d, T-INST-56a/e, T-INST-63b/e, T-INST-64, T-INST-70d, T-INST-72a/73a, T-INST-74–76, T-INST-79, T-INST-80b/c/d.
- [ ] **Rewrite tests/e2e/subcommands.test.ts** — `loopx output --goto` now accepts qualified targets (T-SUB-* and companions).
- [ ] **Rewrite tests/e2e/delegation.test.ts** — project-root-only delegation per ADR-0003 §5. Drops ancestor traversal tests, adds project-root package.json failure modes (T-DEL-14b and ~18 missing IDs).
- [ ] **Rewrite tests/e2e/env-vars.test.ts** — add `LOOPX_WORKFLOW` injection tests (T-ENV-20b, T-ENV-21d, and 6 missing IDs).
- [ ] **Rewrite tests/e2e/module-resolution.test.ts** — workflow-local `node_modules/loopx` precedence (T-MOD-*, 13 missing).

### ✅ P0 — New test files

- [x] **Created tests/e2e/version-check.test.ts** — covers all 66 T-VER-* IDs. Runs 132 cases (66 × two runtimes), ~126 fail against the pre-ADR-0003 implementation as expected per PROMPT.md; the remaining ~6 pass incidentally (`run -h` path already skips version checking; `loopx install` already rejects unrecognized workflow layouts). Assertion style: name-scoped regex matchers over stderr lines — tolerant of specific warning wording while pinning down shape, workflow attribution, and per-workflow dedupe counts.

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
