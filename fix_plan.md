# Implementation Plan for loopx

**Status: Production Ready — All Tests Passing**

All 1068 tests pass. 0 type errors. Full conformance audit completed against SPEC.md with no behavioral discrepancies found.

## Completed

- [x] Rewrite `src/bin.ts` CLI argument parsing to add explicit `run` subcommand
- [x] Remove `RESERVED_NAMES` from `src/discovery.ts` and `src/install.ts`
- [x] Make `scriptName` required in `src/run.ts` (fixes T-TYPE-07)
- [x] Update `.loopx/` missing error message (remove "default" reference)
- [x] Add `.loopx/` missing warning in help mode (fixes T-CLI-42)
- [x] Add `no-main` warning for directory scripts missing main field (fixes T-CLI-55a)
- [x] Fix install tests to specify script name (T-INST-GLOBAL-01, T-INST-GLOBAL-01a)
- [x] Update ADR-0002 status to Implemented
- [x] Full spec conformance audit — no behavioral discrepancies
- [x] Test harness fully implemented and verified against TEST-SPEC.md
