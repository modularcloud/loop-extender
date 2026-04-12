# Implementation Plan for loopx

**Status: ADR-0002 Implemented — All Tests Passing**

All 1068 tests pass. 0 type errors.

## Completed

- [x] Rewrite `src/bin.ts` CLI argument parsing to add explicit `run` subcommand
  - Two-level parsing: top-level (subcommand dispatch) and run-level (flags + script name)
  - Top-level: only `-h`/`--help` and subcommand names recognized; everything else is error
  - Run-level: `-n`, `-e`, `-h`/`--help`, script-name positional
  - Run `-h` short-circuit: ignores all other args
  - Help split: top-level (no discovery, no -n/-e) vs run (with discovery, with -n/-e)
- [x] Remove `RESERVED_NAMES` from `src/discovery.ts` and `src/install.ts`
- [x] Make `scriptName` required in `src/run.ts` (fixes T-TYPE-07)
- [x] Update `.loopx/` missing error message (remove "default" reference)
- [x] Add `.loopx/` missing warning in help mode (fixes T-CLI-42)
- [x] Add `no-main` warning for directory scripts missing main field (fixes T-CLI-55a)
- [x] Fix install tests to specify script name (T-INST-GLOBAL-01, T-INST-GLOBAL-01a)
- [x] Test harness fully implemented and verified against TEST-SPEC.md
