# SPEC Problems

This file tracks ambiguities, gaps, or under-specified clauses in `SPEC.md`
that have surfaced during `TEST-SPEC.md` development. Each entry names the
SPEC clause involved, describes the ambiguity, records the interpretation
`TEST-SPEC.md` currently encodes (so the test suite remains coherent in
the meantime), and identifies what `SPEC.md` would need to say to fully
resolve the problem.

When a problem is resolved (`SPEC.md` is tightened to match the encoded
interpretation, or a different interpretation is chosen and the affected
test is updated), remove the entry. When this file becomes empty, delete
it.

## SPEC 10.9 — HTTP 3xx redirects during tarball download

**Clause:** "Any pre-commit install failure (download error, HTTP non-2xx,
git clone failure, extraction failure, post-download validation failure)
... exits with code 1."

**Ambiguity:** A 3xx response (e.g., 302) is non-2xx by status class, but
SPEC 10.9 does not specify whether the HTTP client must reject 3xx
outright or may transparently follow `Location:` headers and operate on
the resulting 2xx response. Both readings are plausible.

**Encoded interpretation (T-INST-92b):** A 3xx response is a non-2xx
install failure and `Location:` is **not** followed. The test serves a
302 pointing at a working tarball and asserts the install fails with
exit 1, with no request reaching the redirect target.

**Resolution needed:** SPEC 10.9 should explicitly state whether HTTP 3xx
redirects are followed. Recommended phrasing: either "HTTP 3xx responses
are treated as install failures and `Location:` is not followed" or
"HTTP 3xx redirects are followed up to N hops, with the final response
classified by its status class."

## SPEC 9.5 — duck-typed signal with missing or non-boolean `aborted` property

**Clause:** A compatible signal must expose "a readable `aborted`
property" and "an `addEventListener('abort', listener)` method".

**Ambiguity:** SPEC requires a "readable `aborted` property" but does not
explicitly say how to handle a duck-typed object that has
`addEventListener` but lacks an own `aborted` property entirely (so
reading `obj.aborted` returns `undefined`), nor how to handle an
`aborted` property whose value is non-boolean. One reading: missing or
non-boolean violates the contract and surfaces as an option-snapshot
error. A more permissive reading: coerce missing/non-boolean to "not
aborted" and proceed.

**Encoded interpretation (T-API-64j / T-API-64j2):** Missing or
non-readable / non-boolean `aborted` means the object is not
AbortSignal-compatible and is rejected as an option-snapshot error,
distinct from `aborted: false`.

**Resolution needed:** SPEC 9.5 should clarify that a missing or
non-readable / non-boolean `aborted` property means the object is not
AbortSignal-compatible and must be rejected as an option-snapshot
error.

## SPEC 10.10 — meaning of "After the commit phase ... completes"

**Clause:** "After the commit phase (section 10.7) completes, unless
`--no-install` is present, loopx performs a post-commit auto-install
pass over the committed workflows."

**Ambiguity:** Does "completes" mean "finishes execution" (auto-install
runs even when commit phase reports per-workflow failures via the
aggregate report) or "completes successfully" (auto-install is
short-circuited if any commit-phase failure occurred, even on workflows
that committed before the failure)?

**Encoded interpretation (T-INST-80c2):** A commit-phase failure gates
the auto-install pass entirely — no committed-before-failure workflow
receives auto-install or `.gitignore` synthesis.

**Resolution needed:** SPEC 10.10 should explicitly state whether
auto-install runs on workflows committed before a commit-phase failure.

## SPEC 9.1 / 9.3 — abort precedence × `maxIterations: 0`

**Clause:** Section 9.3 establishes that an aborted signal at call time
displaces all other pre-iteration failure modes. Section 9.1 / 9.5
establish that `maxIterations: 0` validates and exits without executing
any iterations.

**Ambiguity:** When both apply (pre-aborted signal AND
`maxIterations: 0`), neither clause directly states which wins.

**Encoded interpretation (T-API-10c2 / T-API-10c3):** Abort observation
is invariant under iteration count — a pre-aborted signal displaces the
zero-iteration short-circuit. The call rejects (or first `next()`
throws) with the abort error rather than resolving with `[]` or
`{ done: true }`.

**Resolution needed:** SPEC 9.1 or 9.3 should explicitly state how
`maxIterations: 0` interacts with a pre-aborted signal — specifically,
that abort precedence applies even to the zero-iteration short-circuit.

## SPEC 8.1 — whitespace-only env-file lines

**Clause:** "Blank lines are ignored" (env-file parsing rules).

**Ambiguity:** SPEC 8.1 does not define "blank". A line containing only
spaces, tabs, or a mix has two plausible classifications: (a) blank
(silently ignored, like an empty line), (b) malformed non-key (ignored
with a warning, like other lines without `=`).

**Encoded interpretation (T-ENV-08a):** The test pins only the
no-bogus-key / no-poisoning invariant that holds under either reading
and intentionally does not assert which behavior is required. The
warning-vs-silent choice is currently implementation-defined.

**Resolution needed:** SPEC 8.1 should state whether whitespace-only
lines are treated as blank (silent) or as malformed (warnable). Once
resolved, T-ENV-08a can be tightened to assert the chosen behavior
directly.
