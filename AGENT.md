# Agent Notes

## Build & Test Commands

- Install dependencies: `npm install`
- Run all tests: `npx vitest run`
- Run harness tests only: `npx vitest run tests/harness/`
- Run unit tests only: `npx vitest run tests/unit/`
- Run e2e tests only: `npx vitest run tests/e2e/`
- Run fuzz tests only: `npx vitest run tests/fuzz/`
- Run a single e2e test file: `npx vitest run tests/e2e/<name>.test.ts`
- Run a single test by name: `npx vitest run <path> -t "<test-name-or-id>"` (e.g. `-t "T-EXEC-10"`)
- Build loopx package: `npm run build` (compiles src/ to dist/, creates dist/package.json, symlinks node_modules/loopx)
- `npm run build` is required before any test that spawns the loopx CLI or imports from `loopx` (postbuild populates `node_modules/loopx`); rebuild after any src/ changes
- Type check: `npx tsc --noEmit`
- Install/global install & fuzz suites are slow — run them in the background (Bash `run_in_background`) and wait for completion notifications rather than blocking the session.

## Test Harness Notes

- `runCLI` (tests/helpers/cli.ts) has a default 30s per-invocation timeout that rejects with an error; fixtures that loop forever fail as a timeout, not an exit-code mismatch. To assert "exit 1 once implementation catches up," make fixture scripts print `{"stop":true}` or exit 0.
- Workflow fixtures: `createWorkflowScript(project, workflow, script, ext, content)`, `createBashWorkflowScript(project, workflow, script, body)`, `createWorkflowPackageJson(project, workflow, content)`. Legacy `createScript` / `createDirScript` / `createBashScript` were removed with ADR-0003 — do not reintroduce.
- Version-check warning matchers in `tests/e2e/version-check.test.ts` are regex-based and overlap between categories. Keep runtime warning prose free of the mismatch trigger words (`version`, `mismatch`, `range`, `satisf`) for non-mismatch cases; include them only for the actual mismatch warning.
- `tests/helpers/api-driver.ts` spawns `<repo>/node_modules/.bin/tsx` by absolute path, not via `npx`. When the consumer cwd has a `node_modules/` (even one containing only a symlinked package), `npm 11+` / `npx` skips auto-install and exits 127 with "tsx: command not found". Preserve the absolute-path spawn in that helper.

## Runtime Quirks

- Bun's default JSX runtime is "automatic" (imports `react/jsx-runtime`), which breaks workflow scripts that rely on a local `React.createElement` shim. `execution.ts` writes a per-process `bunfig.toml` and passes `--config=<path> --jsx-factory=React.createElement --jsx-fragment=React.Fragment` for `.tsx`/`.jsx` files to force classic transform.
- Bun is liberal about CJS in `.js` — `require()` would succeed even when the workflow tree sets `"type": "module"`. We force SPEC §6.3 rejection by passing `--define require:null` to Bun, so any `require(...)` call fails at parse-time substitution.
- The npm package is named `loop-extender` but scripts import from `loopx`. `execution.ts` creates a per-process `$TMPDIR/loopx-nodepath-shim-<pid>/loopx -> <loopx package root>` symlink and prepends that directory to `NODE_PATH`, so both local and global installs resolve `import "loopx"` under Bun.
- `getVersion()` in `bin.ts` resolves `process.argv[1]`'s adjacent `package.json` before falling back to `__dirname/package.json`. Node's default symlink resolution follows `node_modules/loopx/bin.js` back to `dist/bin.js`, so relying on `__dirname` alone would return the source tree's version rather than the delegated-to local version.
- `scripts/postbuild.mjs` copies the repo `package.json` devDependency range for `tsx` into the published `dist/package.json` under `dependencies.tsx`. `src/execution.ts` spawns `tsx` for every JS/TS script, so removing that declared dep breaks `npm install -g loop-extender` lifecycle tests (T-INST-GLOBAL-01).

## Project Structure

- Test harness code lives in `tests/` with helpers in `tests/helpers/`
- Fixture script factories are in `tests/helpers/fixture-scripts.ts`
- Vitest config uses project-based setup with separate timeouts per suite
- ESM-only (`"type": "module"` in package.json)
