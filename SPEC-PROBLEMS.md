# SPEC Problems

This file tracks ambiguities, gaps, or under-specified clauses in `SPEC.md` that were identified during TEST-SPEC review and could not be resolved within the originating ADR cycle. Each entry is scoped to the ADR that surfaced it; resolution happens in a follow-up cycle (either a SPEC clarification or a deliberate decision that the existing SPEC text is sufficient).

## P-0004-01: Auto-install commit-order observability (ADR-0004)

**SPEC reference:** SPEC 10.10 ("Auto-install runs ... sequentially in commit order"), SPEC 10.7 (Install Atomicity / commit phase).

**Problem.** SPEC 10.10 says the post-commit auto-install pass runs "sequentially in commit order" across the committed workflows. SPEC 10.7 defines the commit phase (stage-then-commit, with renames into `.loopx/`) but does not expose or define a user-observable commit order across workflows in a multi-workflow source. As a result, the relation "auto-install order equals file-level commit order" — which is normative text in SPEC 10.10 — is not externally observable through black-box install fixtures: file mtimes are unreliable across filesystems, no SPEC-required commit-order log exists, and `.loopx/<workflow>/` directory existence is a binary outcome that does not reveal ordering.

TEST-SPEC's T-INST-110 currently pins down the **sequentiality** half of "sequentially in commit order" (no overlapping `npm install` children; each workflow invoked exactly once) but explicitly characterizes the **order** half as a scope choice rather than a known testability gap, because no seam-free conformance test can drive it.

**Question for SPEC.** Is the "same as commit order" relation intended as:

- (a) an **internal implementation invariant** that requires a test-only seam to verify (matching the section 1.4 fault-injection-seam pattern already used elsewhere in the suite), or
- (b) an **external conformance contract** that requires SPEC 10.7 to expose / define a user-observable commit order (e.g., "alphabetic by workflow name" or "as enumerated in the source's directory order"), so the ordering relation can be pinned by ordinary black-box assertions, or
- (c) **non-normative guidance** — i.e., external conformance only requires sequential, once-per-committed-workflow processing, and the "in commit order" wording is descriptive of the implementation's internal sequencing without imposing a testable cross-workflow order?

**Resolution path.** A SPEC clarification on this question would let TEST-SPEC either (i) add a commit-order test seam and pin the relation directly (case a), (ii) drop the T-INST-110 scope-choice prose in favor of a name-keyed ordering assertion (case b), or (iii) keep T-INST-110 as-is but reframe the SPEC text so the gap is no longer a question (case c).

**Surfaced by.** TEST-SPEC review of ADR-0004 (post-acceptance feedback cycle).
