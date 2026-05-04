---
"loop-extender": patch
---

SPEC 4.3 / 11 / 12: `loopx version` now rejects extra arguments as a usage error instead of silently ignoring them.

Previously, `loopx version extra`, `loopx version --help`, and `loopx version -h` all printed the version string and exited 0, treating any trailing arguments as if they had not been supplied. This was inconsistent with the parsing of other fixed-grammar subcommands — for example, `loopx run ralph bar` is rejected as a usage error per SPEC 12, and SPEC 11 documents help forms only for the top-level / run / install surfaces (no version-scoped help). The non-exhaustive usage-error enumeration in SPEC 12 combined with the consistent grammar pattern makes the natural reading "extra arguments to a no-argument subcommand are usage errors", which subsumes `--help` / `-h` as unrecognized arguments at the version-subcommand parser level.

After the fix:
- `loopx version` (no args) — still prints the version + newline, exits 0 (unchanged).
- `loopx version extra` / `loopx version --help` / `loopx version -h` — exits 1 with `Error: loopx version takes no arguments (got '<extra>'). Run 'loopx -h' for usage.` on stderr; the version short-circuit does not fire, so stdout is empty.
- `loopx -h version` and `loopx --help version` — top-level help short-circuit still fires first; unaffected.
