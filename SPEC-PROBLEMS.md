# SPEC-PROBLEMS

This file tracks open SPEC.md ambiguities, gaps, and under-specified clauses identified during TEST-SPEC.md development. Each entry describes a problem that prevents a behavior from being covered cleanly in TEST-SPEC.md and proposes a direction for a SPEC.md clarification in a follow-up cycle.

Entries are scoped to a specific ADR. ADR scope is recorded in each entry's header. Cross-cycle resolution: when a problem is resolved by a SPEC.md clarification, the corresponding entry is removed from this file and the previously-tracked status is recorded in TEST-SPEC.md §9 ("Pending Spec Decisions") so the resolution is auditable.

---

## P-0004-02 — Signal handling during auto-install when no `npm install` child is active (SPEC 10.10)

**ADR scope:** ADR-0004.

**SPEC sections:** 10.10 ("Signals during `npm install`"), 7.3 ("Signal Handling").

**Problem.** SPEC 10.10's "Signals during `npm install`" bullet specifies signal behavior only for the case where an `npm install` child is currently active:

> SIGINT / SIGTERM received while an `npm install` child is active propagates to the child's process group. loopx waits for the child to exit (the section 7.3 grace period and SIGKILL escalation rules apply by analogy) and then exits with the signal's code. Remaining committed workflows are not processed (no further `.gitignore` synthesis or `npm install` invocations). Partial `node_modules/` state produced before interruption is not cleaned up by loopx.

The clause is silent on what happens when SIGINT / SIGTERM is observed during the post-commit auto-install pass at moments when **no** `npm install` child is currently active. Concretely, four such windows exist:

1. **Between sequential `npm install` invocations** — after one workflow's `npm install` child has exited and before the next workflow's safeguard `lstat` begins.
2. **During `.gitignore` safeguard work, before spawning `npm install`** — while loopx is performing the per-workflow `lstat` dispatch, synthesizing a missing `.gitignore`, or recording a safeguard failure.
3. **After one npm child exits and before the next workflow begins processing** — overlaps with (1) but specifically captures the gap between exit notification and the start of the next workflow's auto-install steps.
4. **After a `.gitignore` safeguard failure but before the next workflow** — the failure-recording window when the current workflow's safeguard has failed and loopx has not yet advanced to the next workflow.

SPEC 7.3 covers signal handling generally ("When no child is active, cleanup runs immediately" and "Between iterations: If no child process is running ..., loopx exits immediately with the appropriate signal exit code"), but SPEC 7.3 frames its rules around iteration-level scripts, not the auto-install pass. Whether SPEC 7.3's "no child active" rules implicitly extend to the auto-install pass is itself ambiguous — the auto-install pass is post-iteration and is governed by SPEC 10.10's distinct rules.

**Why this prevents clean coverage.** TEST-SPEC currently covers signals **while an `npm install` child is active** (T-INST-116, T-INST-116a, T-INST-116b, T-INST-116c, T-INST-116d, T-INST-116e, T-INST-116f, T-INST-116g) but does not cover any of the four no-active-child windows above. A conformance test for these windows would have to choose an outcome (exit code, whether the next workflow's auto-install runs, whether `.gitignore` is synthesized, whether committed workflow files are rolled back), and SPEC 10.10 does not pin any of those outcomes. Adding executable tests now would encode an interpretation that SPEC.md does not require.

**Proposed direction for SPEC clarification.** A future SPEC.md clarification at SPEC 10.10 (or via a cross-reference from SPEC 10.10 to SPEC 7.3) could specify, for example:

- Exit with `128 + signal` immediately when SIGINT / SIGTERM is observed and no `npm install` child is active during the auto-install pass.
- Stop processing remaining workflows.
- Do not synthesize further `.gitignore` files.
- Do not start further `npm install` children.
- Do not roll back committed workflow files (consistent with SPEC 10.10's "Committed workflow files are not rolled back" clause for safeguard failures and `npm install` failures).
- Emit any partial aggregate-failure report accumulated up to the signal observation, or omit it; this is a sub-decision for the clarification.

The exact set of guarantees is for the SPEC author to decide. The clarification should specify behavior in **all four** sub-windows above (or define a single rule covering all of them) rather than addressing them piecemeal.

**Until the clarification lands.** TEST-SPEC.md does not assert conformance for the no-active-child auto-install signal windows. T-INST-116 / T-INST-116a / T-INST-116b / T-INST-116c / T-INST-116d / T-INST-116e / T-INST-116f / T-INST-116g remain as the conformance pins for the active-child case. No test in TEST-SPEC.md should be added to cover the no-active-child windows until SPEC 10.10 is clarified.
