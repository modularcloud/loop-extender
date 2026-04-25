# SPEC Problems

Tracked SPEC ambiguities, gaps, or under-specified clauses that prevent
TEST-SPEC.md from covering the behavior cleanly. Each entry is intended to be
resolved in a follow-up cycle via a SPEC.md edit; once resolved, the entry can
be removed.

## Open

### `loopx version` argument grammar (`extra`, `--help`, `-h`)

**Where:** SPEC 4.3 (`loopx version`), SPEC §11 (Help), SPEC 12 (Exit Codes /
usage errors).

**Problem.** SPEC 4.3 defines `loopx version` as "Prints the installed version
of loopx to stdout and exits." The SPEC does not define what happens when the
subcommand is invoked with extra arguments:

- `loopx version extra` (extra positional)
- `loopx version --help` / `loopx version -h`

SPEC §11 enumerates exactly three help forms — Top-level Help (11.1), Run Help
(11.2), Install Help (11.3) — with no "Version Help" section. The deliberate
omission, combined with SPEC 12's non-exhaustive usage-error enumeration
("Usage errors (exit code 1) include: …") and the consistent pattern that
extra positionals to fixed-grammar subcommands are usage errors, make the
most natural reading "extra arguments to `version` are usage errors." The
SPEC, however, does not say so explicitly.

**Impact on TEST-SPEC.md.** T-CLI-01a (`loopx version extra` → usage error)
and T-CLI-01b (`loopx version --help` / `-h` → usage error) are written
against the most-natural reading of the SPEC. If the SPEC genuinely intends a
different behavior for either case (e.g., silently ignore extra args and
print the version, or treat `--help` as a top-level help short-circuit), the
tests need to be revised. Without an explicit SPEC clause, both interpretations
are defensible and the test suite is pinning down implementation-defined
behavior.

**Suggested resolution.** Add a sentence to SPEC 4.3 (or SPEC 11) explicitly
stating that `loopx version` accepts no additional arguments and that any
extra argument (positional, short flag, or long flag including `--help` /
`-h`) is a usage error. This aligns with the rest of the subcommand grammar
and removes the ambiguity that T-CLI-01a / T-CLI-01b currently navigate.

If the SPEC is changed to instead permit `loopx version --help` / `-h` (e.g.,
to expose a version-scoped help form), §11 would need a new "Version Help"
subsection, and T-CLI-01b would need to be revised to assert the help-form
behavior rather than usage-error.
