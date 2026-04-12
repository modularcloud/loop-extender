# Implementation Plan for loopx

**Status: Test Harness Complete — Ready for Production Implementation**

The test harness is fully implemented and verified against TEST-SPEC.md. 1068 total tests: 807 pass, 261 fail + 1 type error. All failures are expected — they test ADR-0002 `run` subcommand behavior not yet implemented in production code.

## Completed This Round

- [x] Removed 3 SSH/SCP URL tests from source-detection.test.ts that violated SP-32 (pending spec decision)
- [x] Fixed T-SIG-04 delay parameter: changed from 1 to 2 to match spec's `signal-trap-exit(markerPath, 2)`
- [x] Added iteration count assertion to T-PARSE-20a (iterationCount === 1, first yield then goto error)
- [x] Strengthened weak stderr assertions in cli-basics.test.ts (T-CLI-42, T-CLI-44, T-CLI-46, T-CLI-47, T-CLI-55, T-CLI-55a-d)
- [x] Added missing "very long values" tests in parse-env.test.ts (1MB unquoted + 500KB quoted)
- [x] Documented T-PARSE-20a spec ambiguity in SPEC-PROBLEMS.md

## Next Step

Implement ADR-0002 in production code (`src/`). All 261 failing tests + 1 type error should pass once the `run` subcommand is added.
