## Fuzz Test F-ENV-04 vs Unit Tests: Trailing Whitespace Trimming

The fuzz test F-ENV-04 (tests/fuzz/env-parsing.fuzz.test.ts, line ~473) generates duplicate key test data where `lastValue` can include trailing whitespace (e.g., `" "`). The test expects `parseEnvFile()` to return the value WITHOUT trimming trailing whitespace.

However, unit test "KEY= with trailing whitespace → empty string after trim" (tests/unit/parse-env.test.ts) explicitly asserts that `FOO=   ` produces `""` (empty string after trimming).

The SPEC.md (section 8.1) clearly states: "the value is everything after it to the end of the line (trimmed of trailing whitespace)".

The fuzz test has a comment on line 480: `// Note: the value may have trailing whitespace trimmed per spec.` — acknowledging the trimming, but the assertion at line 481 doesn't account for it.

**Impact**: F-ENV-04 unit-level "duplicate keys resolved by last occurrence" fails with counterexample `A=\nA= ` where expected value is `" "` but parser correctly returns `""`.

**Resolution**: The fuzz test's expected value generator should either (a) filter out values that are pure whitespace, or (b) trim `lastValue` before comparing. The parser implementation is correct per spec and unit tests.

## T-EDGE-04 and T-EDGE-07: CLI stdout assertions

Tests T-EDGE-04 and T-EDGE-07 use `runCLI` and assert that `result.stdout` contains script output ("stdout-ok" and "read-done" respectively). However, SPEC.md section 7.1 clearly states: "The CLI does not print result to its own stdout at any point." The passing test T-CLI-19 (in cli-basics.test.ts) explicitly verifies that CLI stdout is empty in run mode.

These two tests contradict T-CLI-19 and the spec. The implementation correctly does NOT print to CLI stdout, matching the spec and T-CLI-19.

**Impact**: T-EDGE-04 and T-EDGE-07 fail because they expect content in CLI stdout that the spec says should not be there.

## T-EDGE-14: Env file written to wrong path

Test T-EDGE-14 writes an env file to `join(project.dir, ".loopx", "env")` (the project's `.loopx/` directory), but runs the CLI without `-e` flag. The spec (section 8.1) states global env is loaded from `$XDG_CONFIG_HOME/loopx/env`, and local env is only loaded via the `-e` flag. There is no auto-loading of `.loopx/env`.

The test should either use `-e .loopx/env` or use the `withGlobalEnv` helper to set `XDG_CONFIG_HOME`.

**Impact**: T-EDGE-14 fails because the env var is not loaded from the project-local `.loopx/env` path.

## T-API-25: Timing-dependent abort test

Test T-API-25 uses `counter()` script (bash with file I/O) and a 500ms abort timer with `maxIterations: 100`. The counter script runs very fast (~5ms per iteration). All 100 iterations may complete in ~500ms, racing with the abort timer. The test is timing-dependent and may pass or fail depending on system load.

T-API-25b (200ms timer with even faster script) was fixed by adding `setTimeout(0)` yields between loop iterations to give the event loop timer phase a chance to fire. T-API-25 may need the same approach but with a tighter timing margin.

**Impact**: T-API-25 fails when 100 iterations complete before the 500ms timer fires.

## T-INST-GLOBAL-01a: Bun global install `import "loopx"` resolution

The npm package is named `loop-extender` (not `loopx`). For local installs, a symlink `node_modules/loopx → dist/` makes `import "loopx"` work via NODE_PATH. For global installs (`npm install -g`), the package is installed as `<prefix>/lib/node_modules/loop-extender/` — there is no `loopx` symlink.

Under Node.js, the custom module loader (`--import` with `module.register()`) intercepts the bare specifier `"loopx"` regardless of directory names. Under Bun, the only resolution mechanism is NODE_PATH, which requires a directory named `loopx` somewhere in the search path.

**Impact**: T-INST-GLOBAL-01a (Bun global install with `import { output } from "loopx"`) cannot work until the package is either renamed to `loopx` or a postinstall hook creates a `loopx` symlink in the global node_modules. The test currently uses a bash script instead of a TS script with imports.

**Resolution**: Rename the npm package to `loopx`, or add a `postinstall` script that creates a symlink from the package directory to a `loopx` entry in the parent node_modules directory.
