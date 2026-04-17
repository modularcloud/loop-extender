# Agent Notes

## Build & Test Commands

- Install dependencies: `npm install`
- Run all tests: `npx vitest run`
- Run harness tests only: `npx vitest run tests/harness/`
- Run unit tests only: `npx vitest run tests/unit/`
- Run e2e tests only: `npx vitest run tests/e2e/`
- Run fuzz tests only: `npx vitest run tests/fuzz/`
- Run a single e2e test file: `npx vitest run tests/e2e/<name>.test.ts`
- Build loopx package: `npm run build` (compiles src/ to dist/, creates dist/package.json, symlinks node_modules/loopx)
- `npm run build` is required before any test that spawns the loopx CLI or imports from `loopx` (postbuild populates `node_modules/loopx`); rebuild after any src/ changes
- Type check: `npx tsc --noEmit`

## Test Harness Notes

- `runCLI` (tests/helpers/cli.ts) has a default 30s per-invocation timeout that rejects with an error; fixtures that loop forever fail as a timeout, not an exit-code mismatch. To assert "exit 1 once implementation catches up," make fixture scripts print `{"stop":true}` or exit 0.

## Project Structure

- Test harness code lives in `tests/` with helpers in `tests/helpers/`
- Fixture script factories are in `tests/helpers/fixture-scripts.ts`
- Vitest config uses project-based setup with separate timeouts per suite
- ESM-only (`"type": "module"` in package.json)
