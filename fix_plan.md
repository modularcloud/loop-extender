# Implementation Plan for loopx Test Harness

**Status: open P0 harness gaps as of 2026-05-05.**

The 2026-04-17 breadth audit of `tests/` against TEST-SPEC.md found 0 unconditional skips of spec-required tests, 0 placeholder assertions, and 0 TODO/FIXME markers; all 42 conditional skips map to spec-documented conditions; 30/30 sampled spec IDs were located in test files. Per-file ADR-0003 migration state is recorded in git history and does not need to live here.

## P0 — Open

- **Bash execution edges.** Missing T-EXEC-07a and T-EXEC-07b.
- **CJS rejection matrix.** Missing T-EXEC-13c..13m.
- **No runtime auto-install.** Missing T-EXEC-15a/T-EXEC-15b/T-EXEC-15c.

## P2 — Follow-ups (non-blocking)

- **Permission-000 coverage under root.** Several tests use `it.skipIf(IS_ROOT)` for unreadable-file paths; if CI ever runs as non-root these activate automatically.
- **Tarball fixtures via `python3`** in `install.test.ts` — external-tool dependency; consider a JS-only implementation if the Python assumption becomes inconvenient.

## Notes

- `.loopx/.iteration.tmp` appears in `git status` — left by a prior loopx run, not part of this work. Not tracked.

## Recent

**2026-05-05 — Bun global-install harness bin path plus ESM fallback.** Resolved and verified: while implementing the `LOOPX_WORKFLOW_DIR` tests, T-INST-GLOBAL-01a first failed because the harness hardcoded the installed CLI JS path as `bin.js`, while the published `package.json` declares `bin.loopx` as `./dist/bin.js`. The test now derives the executable JS path from the installed package's `package.json` `bin` field. After that focused fix, T-INST-GLOBAL-01a exposed a real packed/global-style Bun ESM fallback issue: Bun 1.3.11 did not honor the `NODE_PATH` shim for `import "loopx"`. Bun JS/TS `import "loopx"` now works in packed/global-style execution through the resolver changes in `packages/loop-extender/src/execution.ts`. Verification passed with `npm run test:e2e`, `npm run test:unit`, `npm run test:harness`, `npm run test:typecheck`, and `npm run test:fuzz`.

**2026-05-05 — execution cwd / workflow-dir env mismatch.** Resolved: T-WFDIR-01..14 plus variants were implemented in `apps/tests/tests/e2e/execution.test.ts`, and `packages/loop-extender/src/execution.ts` now runs scripts with project-root `cwd` while injecting `LOOPX_WORKFLOW_DIR` pointing at the workflow directory.

**2026-04-17 — T-INST-GLOBAL-01 / 01a conformance + tsx runtime dep + api-driver npx trap.** TEST-SPEC §4.10 was tightened to forbid `process.env` / unchanged `PATH` leakage and to require a symlink-liveness assertion on the installed package root. Both global-install smoke tests in `tests/e2e/install.test.ts` were updated to spawn with a scrubbed env (only `HOME`, `TMPDIR`, `GIT_CONFIG_GLOBAL`, and an explicit `PATH` of `${globalPrefix}/bin:${dirname(runtime)}:/usr/local/bin:/usr/bin:/bin`) and to `lstat` the installed package root. Landing the scrubbed-PATH version surfaced a real `spawn tsx ENOENT` failure — `src/execution.ts` spawns `tsx` for every `.ts`/`.js`/`.jsx`/`.tsx` script but `loop-extender` did not declare `tsx` as a runtime dependency. Resolved on the src side: `scripts/postbuild.mjs` now injects `tsx` into the published package's `dependencies` (version sourced from the repo `package.json` devDependencies so test and runtime stay in lockstep), and `src/execution.ts` prepends two bin dirs to `PATH` — `<__dirname>/node_modules/.bin` (nested layout, the `npm install -g` case) and `<__dirname>/../node_modules/.bin` (flat layout, the dev-tree dist/ case) — via `LOOPX_NESTED_BIN_DIR` + `LOOPX_FLAT_BIN_DIR`, de-duplicated against the incoming PATH. A separate pre-existing bug in `tests/helpers/api-driver.ts` was also resolved: under npm 11+, `npx tsx` exits 127 ("tsx: command not found") when the cwd has a `node_modules/` directory, even if that directory only contains a symlinked package — the helper now spawns `<repo>/node_modules/.bin/tsx` by absolute path for Node. Full suite green: e2e 1818/1818, fuzz 48/48, unit+harness 172/172.
