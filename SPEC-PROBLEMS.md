## T-INST-GLOBAL-01a: Bun global install `import "loopx"` resolution

The npm package is named `loop-extender` (not `loopx`). For local installs, a symlink `node_modules/loopx → dist/` makes `import "loopx"` work via NODE_PATH. For global installs (`npm install -g`), the package is installed as `<prefix>/lib/node_modules/loop-extender/` — there is no `loopx` symlink.

Under Node.js, the custom module loader (`--import` with `module.register()`) intercepts the bare specifier `"loopx"` regardless of directory names. Under Bun, the only resolution mechanism is NODE_PATH, which requires a directory named `loopx` somewhere in the search path.

**Impact**: T-INST-GLOBAL-01a (Bun global install with `import { output } from "loopx"`) cannot work until the package is either renamed to `loopx` or a postinstall hook creates a `loopx` symlink in the global node_modules. The test currently uses a bash script instead of a TS script with imports.

**Resolution**: Rename the npm package to `loopx`, or add a `postinstall` script that creates a symlink from the package directory to a `loopx` entry in the parent node_modules directory.

## T-PARSE-20a: Ambiguous spec wording about "first iteration"

TEST-SPEC says: "the generator throws an error on the first iteration." This is misleading — the generator yields the first iteration's Output (which contains `{goto: ""}`) and then throws on the *next* `.next()` call when it tries to resolve the empty goto target. The `iterationCount` is 1 (one yield) before the error, not 0. The spec wording should say "throws an error after the first iteration yields" or "throws during goto resolution following the first iteration."
