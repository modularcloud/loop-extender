# SPEC Problems

Tracks ambiguities, gaps, and under-specified clauses in `SPEC.md` that prevent `TEST-SPEC.md` from cleanly covering the documented behavior. Each entry names the affected SPEC clause(s), describes the ambiguity, lists candidate interpretations, and is scoped to a specific ADR cycle so resolution can be sequenced with the ADR work that introduced (or surfaced) the gap.

---

## P-0004-04 — Source `package.json` symlink/non-regular entries during install: §3.2 vs §10.11 precedence

**Scope:** ADR-0004
**Affected SPEC clauses:** §3.2 (workflow `package.json` failure modes — non-regular path warning, symlinks not followed), §10.11 (install source symlinks — materialization within selected workflows, rejection of broken / cyclic / out-of-source symlinks), §10.10 (auto-install trigger and malformed-`package.json` skip).

**Problem.** SPEC §3.2 and SPEC §10.11 each describe a rule that applies to a workflow's `package.json` during `loopx install`, but their precedence is not specified for the case where the **install source's** `package.json` entry is a symlink (or other non-regular entry). The rules in tension are:

- **§3.2 (workflow-`package.json` failure modes; runtime + install).** "Non-regular `package.json` path (the entry at the workflow `package.json` path is a directory, symlink, FIFO, socket, or other non-regular entry, as observed via `lstat`): A warning is printed to stderr. The version check is skipped. Symlinks at the `package.json` path are not followed. Execution / installation proceeds."
- **§10.11 (install source symlinks).** Symlinks that are part of a selected workflow are materialized as regular files / directories in the destination during the staging / copy phase; broken, cyclic, or out-of-source symlinks within selected workflows are rejected with a preflight / validation error.
- **§10.10 (auto-install trigger and malformed-`package.json` skip).** Auto-install runs against `.loopx/<workflow-name>/package.json` after commit; the §3.2 failure modes (including non-regular path) are also enumerated as malformed-`package.json` skip cases.

These three rules each refer to a different observation point — §3.2 to an `lstat` of the `package.json` path, §10.11 to source-side symlink classification before commit, and §10.10 to a post-commit check of the committed file — and do not state which observation the install pipeline performs first, or what happens to subsequent observations when an earlier one has already taken a definite branch.

**Why this blocks TEST-SPEC.md cleanly.** TEST-SPEC.md currently sidesteps the source-input `package.json` symlink case by testing committed non-regular `package.json` entries via test seams (`package-json-replace-with-symlink` / `-fifo` / `-socket`) and by testing generic install-source symlink behavior separately. The ordinary case — a source workflow whose `package.json` *is itself a symlink in the install source* — cannot be pinned down to a single conforming outcome until the SPEC states which rule wins. The unresolved sub-cases are:

1. **In-source `package.json` symlink to a regular file** (`package.json -> valid-package-json-file` inside the source root):
   - Does §3.2's "non-regular `package.json` path" warning + skip apply because `lstat(package.json)` sees a symlink at preflight, with `package.json` then committed as a symlink (and a second §3.2 warning + skip recorded by §10.10's auto-install pass)?
   - Does §10.11's source-symlink materialization apply first, replacing the symlink with a regular copy in staging, so the committed `package.json` is regular, the §3.2 warning never fires, and §10.10's auto-install runs version-checked?
   - If §3.2 warns during preflight but §10.11 materializes before auto-install, does the install also warn-and-skip auto-install based on the preflight observation, or run auto-install based on the committed regular file?
2. **Broken / cyclic / out-of-source `package.json` symlink** (`package.json -> /nonexistent` or `package.json -> ../outside`):
   - Does §3.2's "non-regular `package.json` path" warning apply (with installation proceeding without version check)?
   - Or does §10.11's selected-workflow bad-symlink rejection apply (preflight failure, no commit)?

A test written against any one interpretation would falsely fail a conforming implementation that picked another. The runtime-only counterparts (a workflow's `package.json` becoming a symlink post-commit through some external action) are partially covered through test seams, but the source-input precedence is the gap.

**Candidate resolutions** (for the follow-up cycle):

- **Resolution A — §10.11 wins for source-input `package.json` symlinks.** Materialize source `package.json` symlinks during staging. The committed `package.json` is a regular file; §3.2 and §10.10 then apply against the materialized regular file as in the non-symlink case. Broken / cyclic / out-of-source `package.json` symlinks are rejected per §10.11's selected-workflow bad-symlink rule (preflight failure, no commit, no §3.2 warning). This treats `package.json` as ordinary content under the §10.11 materialization rule.
- **Resolution B — §3.2 wins for source-input `package.json` symlinks.** §3.2's "symlinks at the `package.json` path are not followed" rule applies at preflight: a source `package.json` that is a symlink is observed as non-regular by `lstat`, fires the §3.2 warning, and skips version check. The symlink is preserved (not materialized) into the committed workflow; §10.10's auto-install pass observes the same non-regular committed `package.json` and skips auto-install with no second warning. Broken / cyclic / out-of-source `package.json` symlinks fire the same §3.2 non-regular warning and install proceeds without rejection. This treats `package.json` as a special case carved out of §10.11 materialization.
- **Resolution C — Hybrid: §10.11 rejection wins for bad symlinks; materialization carves out `package.json`.** Broken / cyclic / out-of-source `package.json` symlinks are rejected per §10.11; in-source-resolving `package.json` symlinks fall under §3.2 (warning + preserved symlink + auto-install skip). This combines §10.11's safety guarantee for bad symlinks with §3.2's "do not follow `package.json` symlinks" rule for the resolvable case.

**Suggested next step.** Choose one of resolutions A / B / C in a follow-up ADR-0004 cycle, update SPEC §3.2 / §10.10 / §10.11 to spell out the precedence explicitly (and any cross-references between them), then add the corresponding TEST-SPEC.md tests for source-workflow `package.json` symlink fixtures (in-source target, broken, cyclic, out-of-source) under the chosen resolution.
