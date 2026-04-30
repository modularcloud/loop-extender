# SPEC-PROBLEMS

Open ADR-0004-scoped problems in `SPEC.md` that prevent `TEST-SPEC.md` from cleanly covering observed behavior. Each entry documents an ambiguity, gap, or under-specified clause to be resolved by a follow-up SPEC clarification cycle. Resolved entries are removed from this file; if no entries remain, this file is deleted.

ID convention: `P-<adr>-<seq>` where `<adr>` is the ADR number (e.g., `0004`) and `<seq>` continues the per-ADR sequence (P-0004-01 through P-0004-12 were opened and resolved in prior cycles; new entries start at P-0004-13).

---

## P-0004-13: Install-source symlink targets that resolve in-source but are neither regular files nor directories

**Status:** Open

**Scope:** ADR-0004 (install source symlinks — SPEC §10.11).

**Problem.** SPEC §10.11 specifies the install-source symlink contract along three axes: it requires symlink targets to resolve to existing paths within the install source root, it enumerates materialization behavior for two target kinds (file and directory), and it rejects three failure classes (broken, cyclic, out-of-source). The relevant text:

- **Materialization clauses** (selected workflow content): "A selected top-level workflow entry that is a symlink to a directory is installed as a real directory at `.loopx/<workflow-name>/`, containing a copy of the symlink target's workflow contents. A selected script entry that is a symlink to a file is installed as a real file at the corresponding destination script path, containing a copy of the symlink target's file contents. Symlinked non-script files or directories inside a selected workflow's copied content are likewise materialized as real files or directories."
- **Rejection clause:** "loopx must reject the install with a preflight / validation error when a symlink that is part of a selected workflow is broken, forms a cycle, or resolves outside the source root."
- **`package.json` source symlink precedence paragraph** (added when P-0004-04 was resolved): "A source `package.json` symlink that resolves to an existing in-source regular file is materialized as a regular committed `package.json`... A source `package.json` symlink that resolves to an in-source directory is materialized as a directory and then falls under the non-regular `package.json` path behavior in section 3.2 / section 10.10. Broken, cyclic, or out-of-source `package.json` symlinks are rejected as preflight / validation errors under this section."

Neither the materialization clauses nor the rejection clause specifies what happens when a selected workflow's symlink resolves **inside** the install source root but to an entry that is neither a regular file nor a directory — for example, a FIFO, socket, block device, or character device. Cases such as `ralph/asset -> ../shared/socket`, `ralph/package.json -> ../shared/fifo`, or a top-level `alias -> in-source-fifo` are not broken (the target exists), not cyclic, and not out-of-source, so the rejection clause does not fire; but the materialization clauses enumerate only "file" and "directory" target kinds, so the materialization behavior is unspecified for the other entry types.

The §10.11 "`package.json` source symlink precedence" paragraph has the same gap: it specifies in-source-regular-file and in-source-directory targets explicitly but is silent on in-source non-file / non-directory targets.

**Why this matters for TEST-SPEC.md.** This prevents TEST-SPEC from adding clean conformance tests for cases such as:

- `ralph/asset -> ../shared/socket` (top-level workflow content symlink to in-source non-script socket)
- `ralph/package.json -> ../shared/fifo` (workflow `package.json` symlink to in-source FIFO — unspecified under both the §10.11 main rules and the `package.json` precedence paragraph)
- top-level `alias -> in-source-fifo` (top-level workflow-entry symlink to in-source FIFO — unspecified for the workflow-entry layer)

Without a SPEC ruling, the test suite cannot pin the expected outcome (rejection vs. materialization vs. per-target-type dispatch) for these cases. The currently-conforming tests (T-INST-55l, T-INST-55m, T-INST-55s, T-INST-55l2, T-INST-55y, T-INST-55zd) cover only the broken / cyclic / out-of-source rejection axis and the in-source file / directory materialization axis; the in-source non-file / non-directory target axis is uncovered.

**Resolution paths.**

- **Resolution A (preferred — extend rejection rule to in-source non-file / non-directory targets):** Amend SPEC §10.11's rejection clause to add explicit rejection wording for selected workflow symlinks whose targets resolve in-source to entries that are neither regular files nor directories, e.g.: "loopx must reject the install with a preflight / validation error when a symlink that is part of a selected workflow is broken, forms a cycle, resolves outside the source root, **or resolves to a non-file non-directory entry (FIFO, socket, block device, character device, or other non-regular non-directory entry)**." Mirror the same rejection wording in the `package.json` source symlink precedence paragraph for the `package.json`-named source symlink case. With this clarification, TEST-SPEC can add conformance tests under the same preflight-rejection contract used for broken / cyclic / out-of-source cases (e.g., parallel sub-cases inside T-INST-55l, T-INST-55m, T-INST-55s, T-INST-55y, T-INST-55zd).

- **Resolution B (per-target-type materialization):** Amend SPEC §10.11 to specify per-target-type materialization for in-source non-file / non-directory targets — e.g., FIFO and socket targets materialized in some defined way, device targets rejected. This is more complex and increases the implementation surface; loopx's source-copy implementation would need explicit handling for each non-file / non-directory entry type, and the install-time test surface would need parallel coverage across each materialization branch.

- **Resolution C (status quo + explicit-deferral note):** Amend SPEC §10.11 to explicitly state that the behavior for in-source non-file / non-directory symlink targets is implementation-defined and not externally specified. This makes the gap normative-by-omission but at least makes the "implementation-defined" status explicit rather than implicit. TEST-SPEC then formalizes a known-gap entry rather than adding conformance tests for these cases.

Resolution A is consistent with the existing rejection-rule structure, mirrors the cleanup-safety / non-regular-`.gitignore` / non-regular-`package.json` "non-regular entry types are surfaced as failures" pattern used elsewhere in the SPEC, and minimizes the implementation surface (one preflight rejection branch rather than per-type materialization). Resolution B preserves more user-supplied symlink topologies but increases the complexity and the test surface. Resolution C ratifies the gap rather than closing it.

**Surfaced by.** TEST-SPEC review of ADR-0004 (post-acceptance feedback cycle, post-P-0004-04 / P-0004-12 resolution).
