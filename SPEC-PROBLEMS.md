# SPEC Problems (open ambiguities scoped to ADR-0004)

This file tracks ambiguities, gaps, or under-specified clauses in SPEC.md that prevent TEST-SPEC.md from cleanly covering ADR-0004 behavior. Each entry should be resolved by a SPEC.md edit in a follow-up cycle. Once all entries here are resolved, this file should be deleted.

## P-0004-01: Non-regular pre-existing `.gitignore` behavior

**SPEC reference:** Section 10.10 (`.gitignore` safeguard for `node_modules/`).

**Problem.** SPEC 10.10 says:

- if no top-level `.gitignore` exists in a workflow directory, loopx creates one containing the single line `node_modules`;
- if a `.gitignore` already exists, loopx leaves it unchanged.

It does not specify what happens when a top-level entry named `.gitignore` exists but is **not a regular file** — for example a directory, symlink (broken or live), FIFO, socket, or a regular file whose mode prevents loopx from reading or evaluating it (e.g., mode `000` or owned by another user).

The SPEC 10.10 safeguard's stated rationale is "populating `node_modules/` without a covering `.gitignore` is exactly the hazard the safeguard is designed to prevent". A pre-existing directory named `.gitignore`, a symlink that points outside the workflow, or a FIFO does not establish that safeguard — yet under the literal reading "if a `.gitignore` already exists, loopx leaves it unchanged", an implementation could detect the entry's existence and skip both safeguard creation and `npm install` (or proceed with `npm install`) without a defined contract.

**Why this blocks TEST-SPEC.** Without a SPEC decision, TEST-SPEC cannot pin down:

- whether a pre-existing non-regular `.gitignore` entry causes loopx to skip `npm install` and contribute to the SPEC 10.10 aggregate-failure-report exit `1` (the safeguard-failure path), or whether it causes loopx to proceed with `npm install` (treating any filesystem entry as "exists"), or whether some third behavior (a warning + skip, a warning + proceed) is conformant;
- whether a symlink resolving to a regular file with `node_modules` content satisfies the safeguard contract or is treated as a non-regular entry;
- whether broken / cyclic symlinks at the `.gitignore` path are equivalent to "not exists" (and therefore loopx synthesizes a fresh `.gitignore`) or are equivalent to "exists" (and therefore loopx leaves them in place).

**Possible future SPEC resolutions.**

1. **Treat any existing filesystem entry as "exists".** Leave unchanged and proceed with `npm install`. Lowest implementation overhead; relies on workflow-author / installer hygiene to not have a non-regular `.gitignore`.
2. **Require a regular file (or a symlink resolving to a regular file).** If `.gitignore` exists but is not a regular file (or a symlink resolving to one), treat as a safeguard failure: skip `npm install` for that workflow, contribute to aggregate exit `1`. Aligns with the safeguard's hazard-prevention rationale.
3. **Require an `lstat`-regular file specifically (no symlink resolution).** If the entry is anything other than a regular file (including a symlink even when its target is a regular file with appropriate content), treat as a safeguard failure. Strictest reading; mirrors the cleanup-safety rule in SPEC 7.4 that `lstat`s and dispatches per entry type.

Given the safeguard's stated hazard-prevention rationale (option 2 or 3 prevents `node_modules/` from being populated under a non-functional safeguard), option 2 or 3 appears safer than option 1, but the choice between options 2 and 3 (whether to traverse symlinks) requires a SPEC decision before TEST-SPEC can add tests.
