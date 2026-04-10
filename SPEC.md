# Loop Extender (loopx) — Specification

## 1. Overview

loopx is a CLI tool that automates repeated execution ("loops") of scripts, primarily designed to wrap agent CLIs. It provides a scriptable loop engine with structured output, control flow between scripts, environment variable management, and a script installation mechanism.

**Package name:** `loopx`
**Implementation language:** TypeScript
**Module format:** ESM-only
**Target runtimes:** Node.js ≥ 20.6, Bun ≥ 1.0
**Platform support:** POSIX-only (macOS, Linux) for v1. Windows is not supported.

> **Note:** The Node.js minimum was raised from 18 to 20.6 to support `module.register()`, which is required for the custom module loader used to resolve `import from "loopx"` in scripts (see section 3.3).

---

## 2. Concepts

### 2.1 Script

A script is an executable unit located in the `.loopx/` directory relative to the current working directory. Scripts come in two forms:

#### File Scripts

A single file with a supported extension:

- Bash (`.sh`)
- JavaScript (`.js` / `.jsx`)
- TypeScript (`.ts` / `.tsx`)

`.mjs` and `.cjs` extensions are intentionally unsupported. All JS/TS scripts must be ESM (see section 6.3).

A file script is identified by its **base name** (filename without extension). For example, `.loopx/myscript.ts` is identified as `myscript`.

#### Directory Scripts

A directory containing a `package.json` with a `main` field pointing to a file with a supported extension. The script name is the **directory name**.

```
.loopx/
  my-pipeline/
    package.json    ← { "main": "index.ts", ... }
    index.ts
    node_modules/
    ...
```

Directory scripts allow scripts to have their own dependencies managed via standard `npm install` or `bun install` within the directory. **loopx does not auto-install dependencies.** If `node_modules/` is missing and the script fails to import a package, the resulting error is the active runtime's normal module resolution error.

A directory in `.loopx/` is only recognized as a script if it contains a `package.json` with a `main` field. Directories without this are ignored (and may exist for other purposes such as shared utilities).

**Important:** Directory scripts should not list `loopx` as their own dependency. The loopx helpers (`output`, `input`) are provided automatically by the running CLI via a custom module loader (see section 3.3). However, if a directory script has its own `node_modules/loopx`, standard module resolution applies and the local version will take precedence. This may cause version mismatches between the script's helpers and the running CLI. loopx does not validate or reject this scenario in v1.

### 2.2 Loop

A loop is a repeated execution cycle modeled as a **state machine**. Each iteration runs a **target script**, examines its structured output, and transitions:

- **`goto` another script:** transition to that script for the next iteration.
- **No `goto`:** the cycle ends and the loop restarts from the **starting target**.
- **`stop`:** the machine halts.

The **starting target** is the script explicitly named when loopx was invoked (via `loopx run <script-name>`). The `goto` mechanism is a **state transition, not a permanent reassignment.** When a target finishes without its own `goto`, execution returns to the starting target. The loop always resets to its initial state after a transition chain completes.

**Self-referencing goto:** A script may `goto` itself (e.g., script A outputs `{ goto: "A" }`). This is a normal transition and counts as an iteration.

**Example:**
```
Starting target: A (script)

Iteration 1: A runs → outputs goto:"B"
Iteration 2: B runs → outputs goto:"C"
Iteration 3: C runs → outputs (no goto)
Iteration 4: A runs → (back to starting target)
```

### 2.3 Structured Output

Every iteration produces an output conforming to:

```typescript
interface Output {
  result?: string;
  goto?: string;
  stop?: boolean;
}
```

**Stdout is reserved for the structured output payload.** Any human-readable logs, progress messages, or debug output from scripts must go to stderr.

**Parsing rules:**

- Only a **top-level JSON object** can be treated as structured output. Arrays, primitives (strings, numbers, booleans), and `null` fall back to raw result treatment.
- If stdout is a valid JSON object containing at least one known field (`result`, `goto`, `stop`), it is parsed as structured output.
- If stdout is not valid JSON, is not an object, or is a valid JSON object but contains none of the known fields, the entire stdout content is treated as `{ result: <raw output> }`.
- **Empty stdout** (0 bytes) is treated as `{ result: "" }`. This is the default case for scripts that produce no output, and causes the loop to reset (no `goto`, no `stop`).
- Extra JSON fields beyond `result`, `goto`, and `stop` are silently ignored.
- If `result` is present but not a string, it is coerced via `String(value)`. This includes `null`: `{"result": null}` produces result `"null"`.
- If `goto` is present but not a string, it is treated as absent.
- `stop` must be exactly `true` (boolean). Any other value (including truthy strings like `"true"`, numbers, etc.) is treated as absent. This prevents surprises like `{"stop": "false"}` halting the loop.

**Field precedence:**

- `stop: true` takes priority over `goto`. If both are set, the loop halts.
- `goto` with no `result` is valid: the target script receives empty stdin.
- **`result` is only piped to the next script when `goto` is present.** When the loop resets to the starting target (no `goto`), the starting target receives empty stdin regardless of whether the previous iteration produced a `result`.

---

## 3. Installation & Module Resolution

### 3.1 Global Install

loopx is installed **globally** to provide the `loopx` CLI command:

```
npm install -g loopx
```

A global install is sufficient for all loopx functionality, including JS/TS scripts that `import { output, input } from "loopx"`. loopx uses a custom module loader to make its exports available to scripts regardless of install location (see section 3.3).

### 3.2 Local Version Pinning

A project may pin a specific loopx version by installing it as a local dependency:

```
npm install --save-dev loopx
```

A local install provides two guarantees:

1. **CLI delegation:** When the globally installed `loopx` binary starts, it checks whether the current working directory (or an ancestor) has a local `node_modules/.bin/loopx`. If found, the global instance delegates execution to the local version's binary **before any command handling**. This ensures the entire session — CLI behavior, script helpers, and all — uses the pinned version.

2. **Importable library:** Application code can `import { run, runPromise } from "loopx"` when loopx is a local dependency. This is standard Node.js module resolution — no special mechanism required.

**Delegation rules:**

- **Nearest ancestor wins.** loopx searches from the current working directory upward and delegates to the first `node_modules/.bin/loopx` found.
- **Recursion guard.** The delegated process is spawned with `LOOPX_DELEGATED=1` in its environment. If this variable is set when loopx starts, delegation is skipped. This prevents infinite delegation loops.
- After delegation, `LOOPX_BIN` contains the **resolved realpath** of the effective binary (the local version), not the original global launcher or any intermediate symlinks.

### 3.3 Module Resolution for Scripts

Scripts spawned by loopx (in `.loopx/`) need access to the `output` and `input` helpers via `import { output, input } from "loopx"`.

**For Node.js / tsx:** loopx uses Node's `--import` flag to preload a registration module that installs a custom module resolve hook via `module.register()`. This hook intercepts bare specifier imports of `"loopx"` and resolves them to the running CLI's package exports. This approach works correctly with Node's ESM resolver, which does not support `NODE_PATH`.

**For Bun:** Bun's module resolver supports `NODE_PATH` for both CJS and ESM. loopx sets `NODE_PATH` to include its own package directory when running under Bun.

In both cases, the resolution **points to the post-delegation version** when no closer `node_modules/loopx` exists. If a local install triggered delegation, the helpers resolve to the local version's package. However, if a directory script has its own `node_modules/loopx`, standard module resolution applies and the closer package takes precedence over the CLI-provided one (see section 2.1).

### 3.4 Bash Script Binary Access

loopx injects a `LOOPX_BIN` environment variable into every script's execution environment. This variable contains the **resolved realpath** of the effective loopx binary (post-delegation), allowing bash scripts to call loopx subcommands reliably:

```bash
#!/bin/bash
$LOOPX_BIN output --result "done" --goto "next-step"
```

---

## 4. CLI Interface

### 4.1 Running Scripts

```
loopx run [options] <script-name>
```

Scripts are executed exclusively via the `run` subcommand. `run` accepts exactly one positional argument, the `<script-name>`:

- The script name is required. `loopx run` with no script name (e.g., `loopx run` or `loopx run -n 5`) is a usage error (exit code 1). This does not inspect `.loopx/` or perform discovery.
- More than one positional argument (e.g., `loopx run foo bar`) is a usage error (exit code 1).
- If `script-name` does not match any script in `.loopx/`, loopx exits with an error.
- `loopx` with no arguments shows top-level help (equivalent to `loopx -h`). No script discovery is performed.
- Unrecognized subcommands (e.g., `loopx foo`) are usage errors (exit code 1). There is no implicit fallback to `run`.
- `default` is an ordinary script name with no special behavior. `loopx run default` runs the script named `default`.
- Scripts may be named after built-in subcommands (e.g., `version`, `output`). `loopx run version` runs a script named `version` (not the built-in). `loopx run run` runs a script named `run`.

### 4.2 Options

The CLI has a two-level option structure: top-level options and `run`-scoped options.

#### Top-level options

| Flag | Description |
|------|-------------|
| `-h`, `--help` | Print top-level help (subcommand list, general syntax). Does not inspect `.loopx/` or perform script discovery. |

`-h` / `--help` is the only recognized top-level flag. Any other flag at top level — including `-n`, `-e`, and any unrecognized flag (e.g., `loopx --unknown`, `loopx -n 5 myscript`, `loopx -e .env myscript`) — is a usage error (exit code 1).

**Top-level `-h` precedence:** `loopx -h` takes precedence over everything that follows. `loopx -h run foo` shows top-level help (no discovery), not run help, and exits 0.

An unrecognized token in the subcommand position is an error regardless of what follows: `loopx foo -h` is an unrecognized subcommand error (exit code 1), not top-level help. The top-level `-h` short-circuit only applies when `-h` appears before subcommand dispatch (i.e., as the first argument to `loopx`).

#### `run`-scoped options

| Flag | Description |
|------|-------------|
| `-n <count>` | Maximum number of loop iterations (see section 7.1 for counting semantics). Must be a non-negative integer; negative values or non-integers are usage errors. `-n 0` validates the starting target (script discovery, name resolution, env file loading) but executes zero iterations, then exits with code 0. |
| `-e <path>` | Path to a local env file (`.env` format). The file must exist and is validated during execution; a missing file is an error. Variables are merged with global env vars; local values take precedence on conflict. |
| `-h`, `--help` | Print run help — options (`-n`, `-e`) and dynamically discovered scripts in `.loopx/`. See section 11 for full run help behavior. |

Within `run`, options and `<script-name>` may appear in any order.

**Duplicate flags:** Repeating `-n` or `-e` within `run` (e.g., `loopx run -n 5 -n 10` or `loopx run -e .env1 -e .env2`) is a usage error (exit code 1) — unless `-h` / `--help` is present (see below).

**Unrecognized flags:** Unrecognized flags within `run` (e.g., `loopx run --unknown myscript`) are usage errors (exit code 1) — unless `-h` / `--help` is present (see below).

**`run -h` short-circuit:** Within `run`, `-h` / `--help` is a full short-circuit: when present, loopx shows run help, exits 0, and ignores all other run-level arguments unconditionally. This means:

- Script name requirements are suppressed (zero or multiple positionals are not errors).
- `-n` and `-e` values are not parsed or validated (including duplicates and invalid values).
- Unknown flags are ignored.
- Examples:
  - `loopx run -h foo` — shows run help (script name ignored).
  - `loopx run myscript -h` — shows run help (`-h` after script name still triggers help short-circuit).
  - `loopx run -h -e missing.env` — shows run help (env file not validated).
  - `loopx run -h -n bad` — shows run help (`-n` not validated).
  - `loopx run -h -n 5 -n 10` — shows run help (duplicate `-n` not rejected).
  - `loopx run -h foo bar` — shows run help (extra positional not rejected).
  - `loopx run -h --unknown` — shows run help (unknown flag not rejected).

### 4.3 Subcommands

#### `loopx run`

Executes a script. This is the only way to run scripts — see section 4.1 for the full grammar and section 4.2 for `run`-scoped options.

```
loopx run [options] <script-name>
```

#### `loopx version`

Prints the installed version of loopx to stdout and exits. The output is the bare package version string (e.g., `1.2.3`) followed by a newline, with no additional text or labels.

#### `loopx output`

A helper for bash scripts to emit structured output:

```bash
loopx output [--result <value>] [--goto <script-name>] [--stop]
```

Prints the corresponding JSON to stdout. **At least one flag must be provided;** calling `loopx output` with no flags is an error.

Example usage in a bash script:

```bash
#!/bin/bash
# do work...
$LOOPX_BIN output --result "done" --goto "next-step"
exit 0
```

#### `loopx env set <name> <value>`

Sets a global environment variable stored in the loopx global config directory.

**Validation:** The variable name must match `[A-Za-z_][A-Za-z0-9_]*`. Values containing `\n` or `\r` are rejected, since multiline values are not supported by the env file format.

**Serialization:** `loopx env set` writes the value as `KEY="<literal value>"` followed by a newline. No escape sequences are applied — the value is written literally within double quotes. This ensures reliable round-tripping for values containing spaces, `#`, `=`, quotes, and trailing spaces.

#### `loopx env remove <name>`

Removes a global environment variable. If the variable does not exist, this is a silent no-op (exits with code 0).

#### `loopx env list`

Lists all currently set global environment variables. Output format is one `KEY=VALUE` pair per line, sorted lexicographically by key name. If no variables are set, produces no output.

#### `loopx install <source>`

Installs a script into the `.loopx/` directory. See section 10 for full details. Supports:

- **`org/repo` shorthand** — expands to `https://github.com/org/repo.git` and clones as a directory script.
- **Git URL** — clones a repository as a directory script.
- **Tarball URL** — extracts an archive as a directory script.
- **Single-file URL** — downloads a single script file.

Creates the `.loopx/` directory if it does not exist.

---

## 5. Script Discovery and Validation

### 5.1 Discovery

Scripts are discovered by scanning the `.loopx/` directory in the current working directory. The `.loopx/` directory is only searched in the current working directory — ancestor directories are not searched.

- **File scripts:** Top-level files with supported extensions (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`). The script name is the base name (filename without extension).
- **Directory scripts:** Top-level directories containing a `package.json` with a `main` field pointing to a file with a supported extension. The script name is the directory name. The `main` field must point to a file **within the script's own directory** — paths containing `../` or otherwise escaping the directory are rejected. A directory is ignored and a warning is printed to stderr if any of the following are true: `package.json` is unreadable or invalid JSON; `main` is missing or not a string; `main` points to a file without a supported extension; `main` escapes the directory; or `main` points to a file that does not exist.

Nested directories that do not contain a valid `package.json` with `main` are ignored.

**Symlink policy:** Symlinks within `.loopx/` are followed during discovery. A symlinked file or directory is treated identically to its target. However, the `main` field in a directory script's `package.json` must still resolve to a path within the script's directory after symlink resolution — it must not escape the directory boundary.

**Discovery metadata is cached at loop start for the duration of the loop.** This means:

- Scripts added, removed, or renamed during loop execution are not detected until the next invocation.
- Changes to a `package.json` `main` field are not detected until the next invocation.
- **Edits to the contents of an already-discovered script file take effect on subsequent iterations**, because the child process reads the file from disk each time it is spawned.
- **If a discovered script's underlying file or directory is removed or renamed mid-loop**, execution uses the cached entry path and fails at spawn time as a normal child-process launch error. This is treated as a non-zero exit (section 7.2).

The discovery warnings described above are printed to stderr during discovery. Discovery runs at loop start for `loopx run <script>` and during `loopx run -h`. Discovery does **not** run for top-level help (`loopx -h` / `loopx --help` / bare `loopx`).

### 5.2 Name Collision

If multiple entries share the same script name — whether file-to-file (e.g., `example.sh` and `example.js`), or file-to-directory (e.g., `example.ts` and `example/`) — the behavior depends on the command:

- **`loopx run <script>`:** Collisions are fatal. loopx refuses to start and displays an error message listing the conflicting entries.
- **`loopx run -h`:** Collisions are non-fatal. Run help is displayed with warnings about the conflicting entries.

### 5.3 Name Restrictions

- Script names must not begin with `-`.
- Script names must match the pattern `[a-zA-Z0-9_][a-zA-Z0-9_-]*` (start with alphanumeric or underscore, followed by alphanumerics, underscores, or hyphens).

If any script in `.loopx/` violates these restrictions, the behavior depends on the command:

- **`loopx run <script>`:** Violations are fatal. loopx refuses to start and displays an error message.
- **`loopx run -h`:** Violations are non-fatal. The invalid script is listed with a warning; run help is still displayed.

### 5.4 Validation Scope

Not all commands require `.loopx/` to exist or be valid:

| Command | Requires `.loopx/` | Validates scripts |
|---------|--------------------|--------------------|
| `loopx` (no arguments) | No | No |
| `loopx -h` / `loopx --help` | No | No |
| `loopx version` | No | No |
| `loopx env *` | No | No |
| `loopx output` | No | No |
| `loopx install <source>` | No (creates if needed) | No |
| `loopx run -h` | No | Non-fatal (warnings shown) |
| `loopx run <script>` | Yes | Yes — collisions (5.2), name-restriction violations (5.3), and missing requested script are fatal; invalid directory-script entries (5.1) are ignored with warnings |

---

## 6. Script Execution

### 6.1 Working Directory

The working directory for script execution depends on the script type:

- **File scripts:** Run with the directory where `loopx` was invoked as the working directory.
- **Directory scripts:** Run with the script's own directory as the working directory (e.g., `.loopx/my-pipeline/`), so relative imports and `node_modules/` resolve naturally.

loopx injects `LOOPX_PROJECT_ROOT` into every script's environment, set to the absolute path of the directory where `loopx` was invoked. This is essential for directory scripts that need to reference project files outside their own directory.

### 6.2 Bash Scripts

Bash scripts (`.sh`) are executed as child processes via `/bin/bash`. The script's stdout is captured as its structured output. Stderr is passed through to the user's terminal.

### 6.3 JS/TS Scripts

JavaScript and TypeScript scripts are executed as child processes using `tsx`, which handles `.js`, `.jsx`, `.ts`, and `.tsx` files uniformly. `tsx` is a dependency of loopx and does not need to be installed separately by the user.

**JS/TS scripts must be ESM and must use `import`, not `require`.** CommonJS is not supported. `.mjs` and `.cjs` extensions are intentionally unsupported. Using CommonJS syntax (`require()`, `module.exports`, `exports`) in a loopx script is an error — the script will fail at execution time.

- Stdout is captured as structured output.
- Stderr is passed through to the user's terminal.

When running under Bun, loopx uses Bun's native TypeScript/JSX support instead of `tsx`.

### 6.4 Directory Scripts

For directory scripts, loopx reads the `main` field from the directory's `package.json` to determine the entry point file. The entry point is then executed using the same rules as file scripts — bash for `.sh`, tsx/bun for JS/TS extensions.

### 6.5 `output()` Function (JS/TS)

When imported from `loopx`, the `output()` function writes structured JSON to stdout and terminates the process.

```typescript
import { output } from "loopx";

output({ result: "hello", goto: "next-step" });
// process exits here — no code after this line runs
```

**Behavior:**

- `output()` **flushes stdout** before calling `process.exit(0)`, ensuring the JSON payload is not lost.
- Since `output()` calls `process.exit()`, calling it multiple times is not possible — only the first call takes effect.
- The argument must be an object containing at least one known field (`result`, `goto`, or `stop`) with a defined value. Calling `output({})` (no known fields) throws an error.
- Properties whose value is `undefined` are treated as absent (they are omitted during JSON serialization). For example, `output({ result: "done", goto: undefined })` is equivalent to `output({ result: "done" })`.
- If called with a non-object value (e.g., a plain string, number, or boolean), the value is serialized as `{ result: String(value) }`. Arrays are **not** treated as non-object values (since `typeof [] === 'object'`); an array must contain at least one known field with a defined value, just like any other object — so `output([1,2,3])` throws an error (no known fields).
- If called with `null` or `undefined`, an error is thrown.

### 6.6 `input()` Function (JS/TS)

When imported from `loopx`, the `input()` function reads the input piped from the previous script via stdin:

```typescript
import { input, output } from "loopx";

const data = await input(); // Returns the input string, or empty string if no input

output({ result: `processed: ${data}` });
```

`input()` returns a `Promise<string>`. On the first iteration (when no input is available), it resolves to an empty string.

**The result is cached:** calling `input()` multiple times within the same script execution returns the same string each time.

### 6.7 Input Piping

When a script's output includes both `result` and `goto`, the `result` value is delivered to the next script via **stdin** — the `result` string is written to the next script's stdin.

**`result` is only piped when `goto` is present.** When the loop resets to the starting target (no `goto` in the output), the starting target receives empty stdin, regardless of any `result` value in the previous output.

### 6.8 Initial Input

The first script invocation in a loop receives **no input**. Stdin is empty.

---

## 7. Loop Execution Flow

### 7.1 Basic Loop

1. A `<script-name>` is required. If none was provided, this is a usage error (exit code 1) — see section 4.1. Discover scripts in the `.loopx/` directory per section 5.1 (invalid directory-script entries are ignored with warnings). Validate for name collisions (section 5.2) and name restrictions (section 5.3) — these are fatal in run mode. Cache the discovery results.
2. Load environment variables (global + local via `-e`). Cache the resolved set for the duration of the loop.
3. Resolve the starting target: the script name provided to `loopx run <script-name>`. If the script does not exist in the cached discovery results, exit with an error.
4. If `-n 0` was specified: exit with code 0 (no iterations executed).
5. Execute the starting target with no input (first iteration).
6. Capture stdout. Parse it as structured output per section 2.3.
7. Increment the iteration counter.
8. If `stop` is `true`: exit with code 0.
9. If `-n` was specified and the iteration count has been reached: exit with code 0. The output from this final iteration is still yielded/observed before termination.
10. If `goto` is present:
    a. Validate that the named script exists in the cached discovery results. If not found, print an error and exit with code 1.
    b. Execute the `goto` script with `result` piped via stdin (or empty stdin if `result` is absent).
    c. Return to step 6 with the new script's output.
11. If `goto` is absent:
    a. Re-run the **starting target** with no input.
    b. Return to step 6.

**Iteration counting:** `-n` / `maxIterations` counts **every target execution**, including goto hops — not just returns to the starting target. For example, if script A outputs `goto: "B"` and B outputs `goto: "C"`, that is three iterations (A, B, C).

**The CLI does not print `result` to its own stdout at any point.** All human-readable output from scripts should go to stderr, which passes through to the terminal. Structured results are accessed via the programmatic API (section 9).

### 7.2 Error Handling

- **Non-zero exit code from a script:** The loop **stops immediately**. loopx exits with code 1. The script's stderr has already been passed through to the terminal. Any stdout produced by the script before it failed is not parsed as structured output.
- **Invalid `goto` target:** If `goto` references a script name that does not exist in `.loopx/`, loopx prints an error message to stderr and exits with code 1.
- **Missing `.loopx/` directory:** When executing via `loopx run <script>`, if `.loopx/` does not exist, loopx exits with an error instructing the user to create it.

### 7.3 Signal Handling

loopx handles process signals to ensure clean shutdown:

- **SIGINT / SIGTERM:** The signal is forwarded to the **active child process group** (not just the direct child). This ensures grandchild processes (e.g., agent CLIs spawned by scripts) also receive the signal, preventing orphaned processes.
- **Grace period:** After forwarding the signal, loopx waits **5 seconds** for the child process group to exit. If the process group has not exited after 5 seconds, loopx sends SIGKILL to the process group.
- **Exit code:** After the child exits, loopx exits with code `128 + signal number` (standard POSIX convention, e.g., 130 for SIGINT).
- **Between iterations:** If no child process is running (e.g., between iterations), loopx exits immediately with the appropriate signal exit code.

---

## 8. Environment Variables

### 8.1 Global Storage

Global environment variables are stored in the loopx configuration directory at:

```
$XDG_CONFIG_HOME/loopx/env
```

If `XDG_CONFIG_HOME` is not set, it defaults to `~/.config`, resulting in `~/.config/loopx/env`.

The file uses `.env` format with the following rules:

- One `KEY=VALUE` pair per line.
- **No whitespace is permitted around `=`.** The key extends to the first `=`, and the value is everything after it to the end of the line (trimmed of trailing whitespace).
- Lines starting with `#` are comments. **Inline comments are not supported** — a `#` after a value is part of the value.
- Blank lines are ignored.
- Duplicate keys: **last occurrence wins**.
- Values are single-line strings. Values may be optionally wrapped in double quotes (`"`) or single quotes (`'`), which are stripped. "Wrapped" means the value begins and ends with the same quote character — if quotes are unmatched (e.g., `KEY="hello` or `KEY='world`), the value is treated literally with no quotes stripped. **No escape sequence interpretation** — content inside quotes is treated literally (e.g., `"\n"` is a backslash followed by `n`, not a newline).
- No multiline value support.
- **Key validation:** Only keys matching `[A-Za-z_][A-Za-z0-9_]*` are recognized from env files (both global and local). Non-blank, non-comment lines that do not contain a valid key (e.g., lines without `=`, lines with invalid key names like `1BAD=val` or `KEY WITH SPACES=val`) are ignored with a warning to stderr.

If the directory or file does not exist, loopx treats it as having no global variables. The directory is created on first `loopx env set`. If the file exists but is unreadable (e.g., permission denied), loopx exits with code 1 and an error message.

**Concurrent mutation:** Concurrent writes to the same global env file (e.g., multiple simultaneous `loopx env set` calls) are not guaranteed to be atomic in v1. The result is undefined.

**Environment variables are loaded once at loop start and cached for the duration of the loop.** Changes to env files during loop execution are not picked up until the next invocation.

### 8.2 Local Override (`-e`)

When `-e <path>` is specified during execution (`loopx run <script>` or the programmatic API), the file at `<path>` is read using the same `.env` format rules. If the file does not exist, loopx exits with an error.

**Note:** Under the `loopx run -h` short-circuit, `-e` is not parsed or validated — a missing env file is not an error in that context (see section 4.2).

Local variables are merged with global env vars. Local values take precedence on conflict.

### 8.3 Injection

All resolved environment variables are injected into the script's execution environment alongside the inherited system environment, with the following precedence (highest wins):

1. **loopx-injected variables** (`LOOPX_BIN`, `LOOPX_PROJECT_ROOT`) — always override any user-supplied values of the same name.
2. **Local env file** (`-e`) values.
3. **Global loopx env** (`$XDG_CONFIG_HOME/loopx/env`) values.
4. **Inherited system environment.**

loopx injects the following variables into every script execution:

| Variable | Value |
|----------|-------|
| `LOOPX_BIN` | Resolved realpath of the effective loopx binary (post-delegation) |
| `LOOPX_PROJECT_ROOT` | Absolute path to the directory where `loopx` was invoked |

**Note:** For Node.js/tsx, module resolution for `import from "loopx"` is handled via `--import` and a custom resolve hook (see section 3.3), not via `NODE_PATH`. For Bun, `NODE_PATH` is set internally but is not considered a user-facing injected variable.

---

## 9. Programmatic API

loopx can be imported and used from TypeScript/JavaScript. **This requires loopx to be installed as a local dependency** (`npm install loopx` or `npm install --save-dev loopx`).

### 9.1 `run(scriptName: string, options?: RunOptions)`

```typescript
import { run } from "loopx";

const loop = run("myscript");

for await (const output of loop) {
  console.log(output.result);
  // each yielded value is an Output from one iteration
}
// loop has ended (stop: true or max iterations reached)
```

Returns an `AsyncGenerator<Output>` that yields the `Output` from each loop iteration. The generator completes when the loop ends via `stop: true` or when `maxIterations` is reached. **The output from the final iteration is always yielded before the generator completes.**

`scriptName` is a required parameter. In TypeScript, omitting `scriptName` is a static type error. In JavaScript, or when the type check is bypassed, runtime-invalid `scriptName` values (e.g., `undefined`, `null`, `42`, or any non-string) are rejected lazily: `run()` still returns a generator without throwing, and the error is raised on first iteration (first `next()` call). For example, `run(undefined as any)` returns a generator that throws on first iteration.

**Error timing:** `run()` snapshots its options and `cwd` at call time, but all errors (validation failures, missing scripts, discovery errors, invalid `scriptName`) are surfaced lazily when iteration begins (i.e., on the first `next()` call or equivalent). The `run()` call itself always returns a generator without throwing.

Options can be passed as a second argument:

```typescript
import { run } from "loopx";

for await (const output of run("myscript", { maxIterations: 10, envFile: ".env" })) {
  // ...
}
```

**Early termination:** There are two cancellation mechanisms with different semantics:

- **Consumer-driven (`break`, `generator.return()`):** loopx terminates the active child process group (if one is running — SIGTERM, then SIGKILL after 5 seconds) and ensures no further iterations start. If no child process is active at the time of cancellation (e.g., `break` after a yield, between iterations), the generator simply completes with no further yields. This is a silent, clean completion.

- **AbortSignal:** When the `signal` is aborted, loopx terminates the active child process group (if one is running — SIGTERM, then SIGKILL after 5 seconds) and the generator **throws an abort error**. This applies regardless of whether a child process is active — aborting the signal always produces an error, even if it occurs between iterations or before the first `next()` call. This follows conventional JavaScript `AbortSignal` semantics.

### 9.2 `runPromise(scriptName: string, options?: RunOptions)`

```typescript
import { runPromise } from "loopx";

const outputs: Output[] = await runPromise("myscript");
```

Returns a `Promise<Output[]>` that resolves with an array of all `Output` values when the loop ends. Accepts the same options object as `run()`.

`scriptName` is required, same as `run()`. In JavaScript or when the type check is bypassed, `runPromise(undefined as any)` returns a rejected promise rather than throwing synchronously — the call itself always returns a promise, and the validation error surfaces as a rejection.

### 9.3 Error Behavior

The programmatic API has different behavior from the CLI:

- **The library never prints `result` to stdout.** All results are returned as structured `Output` objects.
- **Errors throw/reject.** Any condition that would cause the CLI to exit with code 1 (non-zero script exit, invalid `goto`, validation failures) causes `run()` to throw from the generator and `runPromise()` to reject.
- **Partial outputs are preserved.** When `run()` throws, all previously yielded outputs have already been consumed by the caller. When `runPromise()` rejects, partial outputs are not available (use `run()` if partial results matter).
- **Stderr passes through.** Script stderr is still forwarded to the parent process's stderr, same as in CLI mode.

### 9.4 `output(value)` and `input()`

These functions are documented in sections 6.5 and 6.6. They are designed for use **inside scripts**, not in application code that calls `run()` / `runPromise()`.

### 9.5 Types

```typescript
import type { Output, RunOptions } from "loopx";

interface Output {
  result?: string;
  goto?: string;
  stop?: boolean;
}

interface RunOptions {
  maxIterations?: number;
  envFile?: string;
  signal?: AbortSignal;
  cwd?: string;
}
```

- When `signal` is provided and aborted, the active child process group is terminated and the generator/promise completes with an abort error.
- `cwd` specifies the working directory for script resolution and execution. Defaults to `process.cwd()` at the time `run()` or `runPromise()` is called. The `.loopx/` directory is resolved relative to this path.
- `maxIterations` counts every target execution, including goto hops. `maxIterations: 0` mirrors CLI `-n 0` behavior: validates and exits without executing any iterations. `maxIterations` must be a non-negative integer; invalid values (negative, non-integer, NaN) cause `run()` to throw on first iteration and `runPromise()` to reject.
- Relative `envFile` paths are resolved against `cwd` if provided, otherwise against `process.cwd()` at call time.

---

## 10. `loopx install`

```
loopx install <source>
```

Installs a script into the `.loopx/` directory, creating it if necessary.

### 10.1 Source Detection

Sources are classified using the following rules, applied in order:

1. **`org/repo` shorthand:** A source matching the pattern `<org>/<repo>` (no protocol prefix, exactly one slash, no additional path segments) is expanded to `https://github.com/<org>/<repo>.git` and treated as a git source. The `<repo>` segment must not end in `.git` — inputs like `org/repo.git` are rejected with an error. Users who want to specify a `.git` URL must provide the full URL (e.g., `https://github.com/org/repo.git`).
2. **Known git hosts:** A URL whose hostname is `github.com`, `gitlab.com`, or `bitbucket.org` is treated as a git source **only when the pathname is exactly `/<owner>/<repo>` or `/<owner>/<repo>.git`**, optionally with a trailing slash. Other URLs on these hosts (e.g., tarball download URLs, raw file URLs, paths with additional segments like `/org/repo/tree/main`) continue through the remaining source-detection rules.
3. **`.git` URL:** Any other URL ending in `.git` is treated as a git source.
4. **Tarball URL:** A URL whose **pathname** (ignoring query string and fragment) ends in `.tar.gz` or `.tgz` is downloaded and extracted as a directory script.
5. **Single-file URL:** Any other URL is treated as a single file download.

```
loopx install myorg/my-agent-script
# equivalent to: loopx install https://github.com/myorg/my-agent-script.git

loopx install https://github.com/myorg/my-agent-script
# also treated as git (github.com host detected)
```

### 10.2 Source Type Details

#### Single-file URL

- The filename is derived from the URL's last path segment, with query strings and fragments stripped.
- The file must have a supported extension (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`); otherwise an error is displayed.
- The script name is the base name of the downloaded file.

#### Git URL

- The repository is cloned with `--depth 1` (shallow clone) into `.loopx/<repo-name>/`.
- The script name is derived from the repository name (last path segment, minus `.git` suffix if present).
- The cloned directory is validated using the same directory-script rules as section 5.1: `package.json` must be readable valid JSON, `main` must be a string with a supported extension, must not escape the directory, and must point to an existing file. If any validation fails, the clone is removed and an error is displayed.

#### Tarball URL

- The archive is downloaded and extracted.
- **If extraction yields a single top-level directory**, that directory is treated as the package root and moved to `.loopx/<archive-name>/`. If extraction yields multiple top-level entries, the extracted contents are placed directly in `.loopx/<archive-name>/`.
- `archive-name` is the URL's last path segment minus archive extensions (`.tar.gz`, `.tgz`), with query strings and fragments stripped (same as single-file URLs).
- The resulting directory is validated using the same directory-script rules as section 5.1: `package.json` must be readable valid JSON, `main` must be a string with a supported extension, must not escape the directory, and must point to an existing file. If any validation fails, the directory is removed and an error is displayed.

### 10.3 Common Rules

All install sources share these rules:

- **Destination-path collision:** If any filesystem entry (file or directory, whether or not it is a discovered script) already exists at the destination path in `.loopx/`, loopx displays an error and does not overwrite. The user must manually remove the existing entry first. This includes non-script directories that may exist for shared utilities (see section 2.1).
- **Script-name collision:** If the derived script name would collide with any existing discovered script in `.loopx/` — even if the destination filesystem path is different — loopx displays an error and does not install. For example, if `.loopx/foo.sh` exists and the install would create `.loopx/foo/`, the install is rejected because both resolve to script name `foo`. This prevents install from creating a state that would fail discovery validation (section 5.2).
- The script name is validated against name restriction rules (section 5.3) before being saved.
- **loopx does not run `npm install` or `bun install` after cloning/extracting.** For directory scripts with dependencies, the user must install them manually (e.g., `cd .loopx/my-script && npm install`).
- **Install failure cleanup:** Any install failure (download error, HTTP non-2xx, git clone failure, extraction failure, post-download validation failure) exits with code 1. Any partially created target file or directory at the destination path is removed before exit.

---

## 11. Help

Help has two forms: top-level help and run help.

### 11.1 Top-level Help

`loopx -h` / `loopx --help` / `loopx` (no arguments) prints top-level usage information:

- General CLI syntax
- Available subcommands (`run`, `version`, `output`, `env`, `install`)

Top-level help does **not** inspect `.loopx/` or perform script discovery.

### 11.2 Run Help

`loopx run -h` / `loopx run --help` prints run-specific usage information:

- `run` syntax and options (`-n`, `-e`)
- A dynamically generated list of scripts discovered in the current `.loopx/` directory (name and file type)

Run help performs **non-fatal discovery and validation**:

- If `.loopx/` does not exist, run help is still displayed with a warning that the directory was not found. The discovered-scripts section is omitted.
- If `.loopx/` exists but contains validation issues (name collisions, name restriction violations, invalid or unreadable `package.json`, missing or non-string `main` field, unsupported `main` extension, `main` path escaping the script directory, `main` pointing to a nonexistent file), run help is displayed with warnings for the problematic entries.

Run help is the only help form that performs script discovery. The `-h` short-circuit within `run` ignores all other run-level arguments (see section 4.2).

---

## 12. Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Clean exit: loop ended via `stop: true`, `-n` limit reached (including `-n 0`), successful subcommand execution, or help display. |
| 1 | Error: script exited non-zero, validation failure, invalid `goto` target, missing script, missing `.loopx/` directory, or usage error. |
| 128+N | Interrupted by signal N (e.g., 130 for SIGINT). |

Usage errors (exit code 1) include: `loopx run` with no script name, `loopx run foo bar` (extra positional), `loopx foo` (unrecognized subcommand), `loopx myscript` (unrecognized subcommand — no implicit fallback to `run`), `loopx --unknown` (unrecognized top-level flag), `loopx -n 5 myscript` (top-level `-n`), `loopx -e .env myscript` (top-level `-e`), `loopx run --unknown myscript` (unrecognized run flag), and `loopx run -n 5 -n 10 myscript` (duplicate run flag).

Note: A non-zero exit code from any script causes loopx to exit with code 1. Scripts that need error resilience should handle errors internally and exit 0.

---

## 13. Summary of Special Values

| Name | Context | Purpose |
|------|---------|---------|
| `LOOPX_BIN` | Env variable | Resolved realpath of the effective loopx binary (post-delegation) |
| `LOOPX_PROJECT_ROOT` | Env variable | Absolute path to the directory where loopx was invoked |
| `LOOPX_DELEGATED` | Env variable | Set to `1` during delegation to prevent recursion |
