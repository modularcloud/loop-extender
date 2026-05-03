---
"loop-extender": patch
---

SPEC 4.1 / 4.2 / 11.2 / 12: `loopx run` now rejects `--` as an unrecognized token wherever it appears, instead of silently consuming it as an end-of-options marker.

Previously, the `run` parser accepted `--` as a separator and treated the next argv as the target — so `loopx run -- ralph`, `loopx run -n 1 -- ralph`, and `loopx run ralph --` all succeeded (or failed only because of unrelated reasons). SPEC 4.1 explicitly states that `--` is **not** an end-of-options marker for `run` and is rejected wherever it appears outside the `-h` / `--help` short-circuit, and SPEC 12 enumerates several `--` forms (`loopx run -- ralph`, `loopx run -n 1 -- ralph`, `loopx run ralph -- name=value`) as usage errors.

After the fix:
- `loopx run -- ralph`, `loopx run -n 1 -- ralph`, `loopx run ralph -- name=value`, `loopx run --`, `loopx run ralph --` — all exit 1 with `Error: unrecognized token '--' …` on stderr.
- `loopx run -e -- ralph`, `loopx run ralph -e --`, `loopx run -n -- ralph`, `loopx run ralph -n --` — all exit 1 citing `--` as the offending token. Previously these would either consume `--` as the `-e` operand (loading a file literally named `--` as the env file) or surface an "invalid `-n` operand" error treating `--` as a non-integer value; both behaviors violated SPEC 4.1's "wherever it appears" rule.
- `loopx run -h -- ralph`, `loopx run -- -h`, `loopx run -- --help` — help short-circuit still fires (unchanged).
- The shell env prefix (`adr=0003 loopx run ralph`) remains the sole CLI surface for per-run parameterization, as documented in SPEC 11.2 / 13.
