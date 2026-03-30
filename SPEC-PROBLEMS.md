# Spec Problems

This document tracks ambiguities, gaps, and underspecified behaviors in SPEC.md that affect testability or implementation correctness.

## Resolved

### SP-31: Install name-collision behavior across different destination paths

**Status:** Resolved

**Problem:** Section 10.3 rejects installs when a filesystem entry already exists at the destination path. This was broadened by SP-30 to cover non-script entries too. However, it did not address what happens when the destination path is *different* but the derived script name would collide with an existing discovered script.

**Resolution:** `loopx install` always rejects when the derived script name would collide with any existing discovered script in `.loopx/`, even if the destination filesystem path is different. This includes non-script utility directories — if `.loopx/foo/` exists as a utility directory (no `package.json`) and the user installs `foo.ts`, the install is rejected because the destination-path collision check (which covers all filesystem entries) catches it.

**SPEC.md change:** Added explicit "script-name collision" rule to section 10.3 alongside the existing "destination-path collision" rule.

### SP-28: Mid-loop removed/renamed script behavior

**Status:** Resolved

**Problem:** Section 5.1 says scripts added, removed, or renamed during loop execution are not detected until the next invocation. But it also says script files are read from disk each time they are spawned. This leaves unclear what happens if a discovered script's underlying file/path disappears before a later iteration.

**Resolution:** Discovery caching freezes the set of script names and their resolved entry paths for the duration of the loop. Execution uses the cached entry path. If the underlying file/directory/entry point later disappears, execution fails at execution time as a normal child-process launch error (non-zero exit from the spawn attempt), which causes loopx to exit with code 1 per section 7.2.

**SPEC.md change needed:** Add clarifying language to section 5.1 under the discovery caching bullet points.

### SP-29: CommonJS is not supported — hard or soft?

**Status:** Resolved

**Problem:** Sections 2.1 and 6.3 say JS/TS scripts must be ESM and must use `import`, not `require`. But the spec does not explicitly state what happens when a script uses CommonJS syntax (`require`, `module.exports`, `exports`).

**Resolution:** Using CommonJS script syntax (`require`, `module.exports`, `exports`) in loopx JS/TS scripts is invalid and must fail when execution is attempted. This is tested by T-EXEC-13a.

**SPEC.md change needed:** Add explicit statement to section 6.3 that CommonJS usage is an execution error.

### SP-30: Install collision with existing non-script entries

**Status:** Resolved

**Problem:** Section 10.3 says install refuses when a script with the same name already exists. But section 2.1 explicitly allows non-script directories in `.loopx/` for shared utilities. If `.loopx/foo/` exists as a shared utility directory (no `package.json`) and the user runs `loopx install ...` whose derived destination is `foo`, the behavior is unspecified.

**Resolution:** `loopx install` must refuse to overwrite any existing filesystem entry at the destination path, whether or not that entry is a discovered script. This is safer and more consistent.

**SPEC.md change needed:** Broaden section 10.3's collision check from "script with the same name" to "any existing filesystem entry at the destination path."

---

## Previously Resolved (SP-15 through SP-27)

See TEST-SPEC.md section 9 for the full list of previously resolved spec problems.
