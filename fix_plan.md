# Implementation Plan for loopx

**Status: ADR-0002 Test Migration Complete -- All Audit Items Resolved (tag 0.1.19)**

ADR-0002 ("Introduce `run` Subcommand and Remove Default Script") has been accepted. SPEC.md and TEST-SPEC.md have been updated. Test harness has been fully audited and aligned with the spec. 1069 total tests: 808 pass, 261 fail + 1 type error (all failures are expected -- they test `run` subcommand behavior not yet implemented).

## No Remaining Items

All test harness issues identified during the comprehensive audit have been resolved.

## Completed

- **Priority 1 -- Programmatic API scriptName-required tests:** T-API-09, T-API-14a, T-API-20h, T-API-20i, T-API-14a2, T-API-14a3, T-TYPE-07 (7 items)
- **Priority 2 -- Incorrect test assertions:** T-CLI-22d, T-DISC-42, T-DISC-45 (3 items)
- **Priority 3 -- Weak/missing assertions:** T-CLI-44, T-CLI-22, T-CLI-19, T-CLI-19a, T-CLI-42, T-CLI-59/60, T-DISC-20, T-EDGE-12b, T-PARSE-03/04, T-PARSE-20a, T-ENV-03, T-ENV-20/20a, T-ENV-24, T-EDGE-04 (14 items)
- **Priority 4 -- Missing fixtures:** `emit-raw-ln(text)`, `ts-output(fields)`, `ts-input-echo()`, `ts-import-check()` (4 items)
- **Priority 5 -- Extra tests not in spec:** T-API-20j/20k/20l removed; T-INST-31a kept (2 items)
- **Priority 6 -- Minor issues:** T-SIG-04 delay value noted; SSH URL tests noted (2 items)
- **Phases A-E:** CLI syntax migration, semantic changes, new tests, other file updates, verification all complete
- **Subcommands/module-resolution:** No reserved name tests remain; 3 old-syntax calls fixed in module-resolution.test.ts
