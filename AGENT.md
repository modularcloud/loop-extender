# Agent Notes

## Build & Test Commands

- Install dependencies: `npm install`
- Run all tests: `npx vitest run`
- Run harness tests only: `npx vitest run tests/harness/`
- Run unit tests only: `npx vitest run tests/unit/`
- Run e2e tests only: `npx vitest run tests/e2e/`
- Run fuzz tests only: `npx vitest run tests/fuzz/`
- Build loopx package: `npm run build` (compiles src/ to dist/, creates dist/package.json, symlinks node_modules/loopx)
- Rebuild is needed after any src/ changes before running tests
- Type check: `npx tsc --noEmit`

## Project Structure

- Test harness code lives in `tests/` with helpers in `tests/helpers/`
- Fixture script factories are in `tests/helpers/fixture-scripts.ts`
- Vitest config uses project-based setup with separate timeouts per suite
- ESM-only (`"type": "module"` in package.json)
