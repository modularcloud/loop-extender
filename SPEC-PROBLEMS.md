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

## SPEC 10 — install-source symlink copy semantics

**Clause:** SPEC 10.4 says install-time validation uses the same discovery
rules as runtime (SPEC 5.1). SPEC 5.1's symlink policy covers runtime
discovery, but SPEC 10 does not spell out copy semantics for install
sources that themselves contain symlinks (e.g., a git repo with a
symlinked workflow directory, or a tarball with symlinked entries after
extraction).

**Ambiguity:** When the install source contains a symlinked workflow
subdirectory, or a symlinked entry script inside a workflow, SPEC 10 does
not define whether loopx should follow the symlink and materialize the
target's contents into `.loopx/<name>/` as a copy, preserve the symlink
as a symlink in the destination, reject the symlink as unsupported, or
take some other action. All four readings are plausible.

**Encoded interpretation (T-INST-55f / T-INST-55g):** TEST-SPEC currently
defers coverage as a known gap (section 4.10 "Install Source Symlinks
(Known Gap)"). No interpretation is encoded executable; the gap is
explicitly tracked rather than silently omitted, and any executable
coverage added later must be gated on a SPEC 10 amendment that pins down
the copy semantics.

**Resolution needed:** SPEC 10 should define what install does when the
source contains symlinks — whether install follows, preserves, rejects,
or materializes source symlinks, for both symlinked workflow
subdirectories (T-INST-55f) and symlinked entry scripts inside workflows
(T-INST-55g). Once resolved, T-INST-55f / T-INST-55g can be promoted from
known-gap to executable conformance tests.
