# loopx — Test Harness

This repository contains the complete test harness for loopx, ready to validate production implementations.

## Test Suite Status

The test harness is **fully implemented** per [TEST-SPEC.md](./TEST-SPEC.md). All 461 specified test IDs are present across harness, unit, fuzz, E2E, and type-check suites. The harness infrastructure (Phase 0) passes without any loopx implementation.

Once the loopx package is implemented, tests will transition from failing to passing as features are built.

## Running Tests

```bash
npm install

# Run all tests
npx vitest run

# Run by suite
npx vitest run tests/harness/   # Phase 0: infrastructure validation
npx vitest run tests/unit/       # Unit tests (requires loopx/internal)
npx vitest run tests/e2e/        # End-to-end tests
npx vitest run tests/fuzz/       # Property-based fuzz tests
```

## Test Architecture

| Suite | Files | Purpose | Timeout |
|-------|-------|---------|---------|
| harness | `tests/harness/` | Infrastructure validation (Phase 0) | 10s |
| unit | `tests/unit/` | Parser and type tests | 5s |
| e2e | `tests/e2e/` | Black-box CLI and API tests | 30s |
| signals | `tests/e2e/signals.test.ts` | Signal handling (serial) | 60s |
| fuzz | `tests/fuzz/` | Property-based parser tests | 120s |
| typecheck | `tests/unit/types.test.ts` | Compile-time type verification | - |

See [TEST-SPEC.md](./TEST-SPEC.md) for the full specification and [SPEC.md](./SPEC.md) for the product specification.
