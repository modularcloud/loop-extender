# Agent Notes

## Build & Test Commands

- Install dependencies: `npm install` (can wipe out `node_modules/loopx` symlink; turbo's build cache may then report a hit without re-creating it. If `Cannot find module '.../node_modules/loopx/dist/bin.js'` appears, run `node packages/loop-extender/scripts/postbuild.mjs`.)
- Run all tests: `npm run test`
- Run harness tests only: `npm run test:harness`
- Run unit tests only: `npm run test:unit`
- Run e2e tests only: `npm run test:e2e`
- Run fuzz tests only: `npm run test:fuzz`
- Run a single e2e test file: `cd apps/tests && npx vitest run --project e2e tests/e2e/<name>.test.ts`
- Run a single test by name: `cd apps/tests && npx vitest run <path> -t "<test-name-or-id>"` (e.g. `-t "T-EXEC-10"`)
- Build loopx package: `npm run build` (turbo runs `tsc` in `packages/loop-extender/` then postbuild, which chmods `dist/bin.js`, copies README into `dist/`, and refreshes the `node_modules/loopx` symlinks at the repo root and under `apps/tests/`)
- `npm run build` is required before any test that spawns the loopx CLI or imports from `loopx` (postbuild populates `node_modules/loopx`); rebuild after any src/ changes. Turbo wires `^build` into the test tasks so `npm run test:*` rebuilds automatically; bypassing turbo (`cd apps/tests && npx vitest …`) does not.
- Type check: `npx tsc --noEmit -p packages/loop-extender/tsconfig.build.json`
- Install/global install & fuzz suites are slow — run them in the background (Bash `run_in_background`) and wait for completion notifications rather than blocking the session.

## Test Harness Notes

- `runCLI` (`apps/tests/tests/helpers/cli.ts`) has a default 30s per-invocation timeout that rejects with an error; fixtures that loop forever fail as a timeout, not an exit-code mismatch. To assert "exit 1 once implementation catches up," make fixture scripts print `{"stop":true}` or exit 0.
- Workflow fixtures: `createWorkflowScript(project, workflow, script, ext, content)`, `createBashWorkflowScript(project, workflow, script, body)`, `createWorkflowPackageJson(project, workflow, content)`. Legacy `createScript` / `createDirScript` / `createBashScript` were removed with ADR-0003 — do not reintroduce.
- Version-check warning matchers in `apps/tests/tests/e2e/version-check.test.ts` are regex-based and overlap between categories. Keep runtime warning prose free of the mismatch trigger words (`version`, `mismatch`, `range`, `satisf`) for non-mismatch cases; include them only for the actual mismatch warning.
- `apps/tests/tests/helpers/api-driver.ts` spawns `<repo>/node_modules/.bin/tsx` by absolute path (computed from an `import.meta.url`-derived `REPO_ROOT`, not `process.cwd()` — vitest now runs from `apps/tests/`), not via `npx`. When the consumer cwd has a `node_modules/` (even one containing only a symlinked package), `npm 11+` / `npx` skips auto-install and exits 127 with "tsx: command not found". Preserve the absolute-path spawn in that helper.

## Runtime Quirks

- Bun's default JSX runtime is "automatic" (imports `react/jsx-runtime`), which breaks workflow scripts that rely on a local `React.createElement` shim. `execution.ts` writes a per-process `bunfig.toml` and passes `--config=<path> --jsx-factory=React.createElement --jsx-fragment=React.Fragment` for `.tsx`/`.jsx` files to force classic transform.
- Bun is liberal about CJS in `.js` — `require()` would succeed even when the workflow tree sets `"type": "module"`. We force SPEC §6.3 rejection by passing `--define require:null` to Bun, so any `require(...)` call fails at parse-time substitution.
- The npm package is named `loop-extender` but scripts import from `loopx`. `execution.ts` creates a per-process `$TMPDIR/loopx-nodepath-shim-<pid>/loopx -> <loopx package root>` symlink (the package root is `resolve(__dirname, "..")` — `__dirname` is the compiled `dist/`, and the `package.json` with `exports` lives one level up) and prepends that directory to `NODE_PATH`, so both local and global installs resolve `import "loopx"` under Bun.
- `getVersion()` in `bin.ts` walks `dirname(process.argv[1])` and `__dirname`, then each of their parents, looking for `package.json`. Walking the parents is required because the canonical `package.json` now sits next to `dist/`, not inside it; relying on `__dirname` alone would miss it.
- `packages/loop-extender/package.json` declares `tsx` as a runtime `dependency` — `src/execution.ts` spawns `tsx` for every JS/TS script, so removing that dep breaks `npm install -g loop-extender` lifecycle tests (T-INST-GLOBAL-01).

## Project Structure

- Published package code lives in `packages/loop-extender/` (`src/` compiled to `dist/`)
- Test harness code lives in `apps/tests/tests/` with helpers in `apps/tests/tests/helpers/`
- Fixture script factories are in `apps/tests/tests/helpers/fixture-scripts.ts`
- Vitest config at `apps/tests/vitest.config.ts` uses project-based setup with separate timeouts per suite
- ESM-only (`"type": "module"` in every package.json)
