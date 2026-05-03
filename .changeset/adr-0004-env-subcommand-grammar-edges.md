---
"loop-extender": patch
---

SPEC 4.3 / 8.1 / 12: `loopx env list` now prints parser warnings to stderr, and `loopx env set / remove / list` reject extra positionals as usage errors.

Previously:
- `loopx env list` parsed the global env file with `parseEnvFile` (which produces warnings for invalid lines) but discarded the returned warnings array, so a malformed line like `1BAD=val` was silently dropped from the listing with no diagnostic. SPEC 8.1 specifies invalid lines are "ignored with a warning to stderr."
- `loopx env list extra`, `loopx env set FOO bar extra`, and `loopx env remove FOO extra` all silently ignored the trailing positional and proceeded with the leading well-formed grammar — a buggy impl that committed `FOO=bar` despite an unrecognized 4th argument. SPEC 4.3 enumerates the env subcommand grammar as exactly `set <name> <value>` / `remove <name>` / `list` (no operands), and SPEC 12's usage-error contract requires exit 1 + a stderr usage error for parser-level surface failures.

After the fix:
- `loopx env list` emits `Warning: Line N: invalid key name: <key>` (or `Warning: Line N: missing '=' separator: <line>`) to stderr per malformed line — the same warning class as `loopx run` already emits when loading the global env file. Well-formed entries are still listed on stdout, the listing is still sorted, and exit code is still 0 (warnings are non-fatal).
- `loopx env list extra` / `loopx env set FOO bar extra` / `loopx env remove FOO extra` exit 1 with `Error: loopx env <subcmd>: unexpected extra positional '<arg>'` on stderr; no env-file mutation occurs (the failure short-circuits before `envSet` / `envRemove` / `envList` is invoked).
- `loopx env` (no subcommand), `loopx env set` / `set FOO` (missing operands), `loopx env remove` (missing name), and `loopx env unknown` (unrecognized subcommand) continue to be usage errors (unchanged).
