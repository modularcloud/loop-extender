# SPEC Problems

Tracks ambiguities, gaps, and under-specified clauses in `SPEC.md` that prevent `TEST-SPEC.md` from cleanly covering the documented behavior. Each entry names the affected SPEC clause(s), describes the ambiguity, lists candidate interpretations, and is scoped to a specific ADR cycle so resolution can be sequenced with the ADR work that introduced (or surfaced) the gap.

---

## P-0004-03 — Non-regular `package.json` entries in committed workflow directories

**Scope:** ADR-0004
**Affected SPEC clauses:** §3.2 (workflow `package.json` failure modes), §10.10 (auto-install trigger and malformed-`package.json` skip).

**Problem.** SPEC §10.10 specifies the auto-install trigger as "Workflows whose top-level `package.json` exists at `.loopx/<workflow-name>/package.json`" and the malformed-`package.json` skip as "When the workflow's `package.json` is unreadable, contains invalid JSON, or has an invalid `loopx` semver range (the section 3.2 failure modes), the existing section 3.2 warning is emitted and auto-install **skips that workflow silently**." The §3.2 failure modes enumerate content-based failures (absent / unreadable / invalid JSON / invalid semver), but neither §10.10 nor §3.2 enumerates **non-regular** entries at the `package.json` path:

- a directory named `package.json`,
- a FIFO or socket named `package.json`,
- a symlink named `package.json` (e.g., introduced by a script or by an installer outside loopx; SPEC §10.11 materializes source symlinks before commit, but a workflow's `package.json` could plausibly become a symlink post-commit through a runtime `node_modules` toolchain or user action).

This contrasts with the parallel SPEC §10.10 `.gitignore` safeguard clause, which explicitly enumerates non-regular entries (directory, symlink, FIFO, socket, or other non-regular entry) and treats them as a safeguard failure with aggregate-report recording.

**Why this blocks TEST-SPEC.md cleanly.** TEST-SPEC.md cannot pin down a single conforming outcome for a non-regular `package.json` without choosing one of multiple plausible interpretations:

1. **"Not a `package.json` *file*" → treated as absent → no warning, no auto-install.** Reads "exists at `.loopx/<workflow-name>/package.json`" as requiring a regular file.
2. **"Present but unreadable / unparseable" → §3.2 warning, version check skipped, auto-install skipped.** Folds non-regular into the existing malformed-`package.json` branch.
3. **Symlink-followed (a symlink to a regular file) treated as a regular file** vs. **symlink-not-followed treated as non-regular.** Open under interpretations 1 and 2, with implementation-defined symlink-following behavior diverging across regimes.

A test written against any one of these interpretations would falsely fail a conforming implementation that picked another. Until the SPEC clarifies, the auto-install trigger and malformed-`package.json` skip behavior on non-regular entries cannot be tested cleanly.

**Candidate resolutions** (for the follow-up cycle):

- **Resolution A** — Adopt `.gitignore`-parallel enumeration: extend §10.10 to enumerate non-regular `package.json` entries (directory / FIFO / socket / symlink) as a new failure category, possibly recorded in the aggregate report alongside the safeguard / npm-exit / spawn-failure categories.
- **Resolution B** — Fold non-regular into the existing §3.2 malformed-`package.json` branch: add "non-regular file at `package.json` path" to §3.2's failure-modes enumeration, with the existing single warning + skip semantics.
- **Resolution C** — Treat non-regular as absent: clarify §10.10's "exists" wording to mean "exists as a regular file", with non-regular entries falling under "no top-level `package.json`" (no warning, silent skip).

**Suggested next step.** Choose one of resolutions A / B / C in a follow-up ADR-0004 cycle (or a successor ADR if the resolution is non-trivial), update SPEC §10.10 / §3.2 accordingly, then add the corresponding TEST-SPEC.md tests.
