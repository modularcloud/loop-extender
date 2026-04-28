# SPEC Problems

This file tracks ambiguities, gaps, or under-specified clauses in SPEC.md that prevent TEST-SPEC.md from covering the behavior cleanly. Each entry is scoped to a specific ADR cycle. Resolve in a follow-up cycle by updating SPEC.md and removing the entry; delete the file when no entries remain.

## ADR-0004

### P-0004-01 — Abort-after-final-yield vs. already-observed consumer `.return()` / `.throw()` before settlement

**Where.** SPEC §9.3 ("Abort after final yield") and §7.2 ("Terminal-outcome precedence"). ADR-0004 §"Programmatic API · Termination" line "Abort after the final yielded `Output` still wins until generator settlement."

**Problem.** SPEC §9.3 says: "An `AbortSignal` that aborts after the final `Output` has been yielded ... but before the generator settles via `{ done: true }` produces the abort error on the next generator interaction — `g.next()`, `.return()`, or `.throw()`." This text is clear when the abort is observed *before* the next consumer interaction begins. It is not clear what wins when the consumer has *already* invoked `.return()` / `.throw()` after the final yield, loopx has observed that interaction first and entered the cleanup routine, and abort then arrives during cleanup before the generator settles.

Two readings are reasonable:

1. **§9.3 is an explicit precedence rule that holds until settlement.** Abort after final yield wins over any non-settlement outcome until `{ done: true }`, including an already-observed but not-yet-settled consumer `.return()` / `.throw()`. ADR-0004's phrasing — "abort still wins until generator settlement" — supports this reading.

2. **§9.3 only applies when abort precedes the next interaction.** Once a consumer interaction has been observed first, the §7.2 first-observed-wins residual rule applies and the consumer interaction's outcome (silent clean completion under §9.1's no-active-child swallow rule) survives a later abort that races during cleanup.

The SPEC text alone does not disambiguate.

**Impact on TEST-SPEC.** T-TMP-38d2 (post-final-yield consumer `.throw()` observed first × racing abort during cleanup) currently picks reading 2 and pins the surfaced outcome to `{ done: true }`. Until SPEC clarifies, the surfaced-outcome assertion is contested; T-TMP-38d2 has been relaxed to assert only the cleanup-idempotence and warning-cardinality contract that *is* pinned by SPEC §7.2. Symmetric concerns apply to a corresponding `.return()`-first × abort-second post-final-yield variant, should one be added.

**Resolution requested.** Either:
- Amend §9.3 to state explicitly that the abort-after-final-yield precedence rule holds until settlement and displaces any already-observed but not-yet-settled consumer `.return()` / `.throw()` outcome, or
- Amend §9.3 / §7.2 to state explicitly that once a post-final-yield `.return()` / `.throw()` is observed first, later aborts before settlement fall back to the §7.2 first-observed-wins residual rule.

Either resolution unblocks pinning the surfaced-outcome axis for T-TMP-38d2 (and any symmetric `.return()` variant).

---

### P-0004-02 — Outer `RunOptions` inherited-field semantics

**Where.** SPEC §9.5 (`RunOptions` shape), §9.1 / §9.2 ("Option-snapshot timing"). ADR-0004 §"Programmatic API · `RunOptions.env`".

**Problem.** SPEC §9.5 explicitly specifies own-enumerable-only semantics for `options.env` ("Symbol-keyed, non-enumerable, and inherited properties are ignored"). It is silent on whether the *outer* `options` object's recognized fields (`signal`, `cwd`, `envFile`, `maxIterations`, `env`) are read via ordinary JS property access (which honors inherited properties) or via own-enumerable-only access matching the inner `env` rule.

Existing behavior implied by adjacent rules pulls in opposite directions:

- The duck-typed signal compatibility check honors prototype-inherited `aborted` / `addEventListener` (T-API-64n / T-API-64n2 already pin this), suggesting ordinary property access is the convention.
- SPEC §9.5's own-enumerable-only rule for `env` is *explicit*, suggesting the outer options would have been similarly explicit if the same restriction applied.

But the SPEC does not state which rule applies for the outer options' fields, and TEST-SPEC has no direct coverage of prototype-inherited `cwd` / `envFile` / `maxIterations` / `env` / `signal` on the outer options object.

**Impact on TEST-SPEC.** No tests can be added for the inherited-field semantics on the outer options without picking an interpretation. T-API-61i / T-API-61k cover null-prototype and class-instance options *with own properties*; T-API-61l covers `Map` (no recognized field names appear as own properties). None test inherited fields on the outer options.

**Resolution requested.** Amend SPEC §9.5 (or the §9.1 / §9.2 option-snapshot-timing paragraphs) to state explicitly whether the outer `options` object's recognized fields are read via:

1. Ordinary JS property access (honoring inherited fields), matching the duck-typed signal precedent, or
2. Own-enumerable-only access, matching the inner `options.env` rule.

Either resolution unblocks adding the corresponding test coverage (inherited `maxIterations` / `cwd` / `envFile` / `signal` / `env` honored or ignored).
