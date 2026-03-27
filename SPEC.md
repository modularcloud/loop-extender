# Loop Extender (loopx) — Specification

## 1. Overview

loopx is a CLI tool that automates repeated execution ("loops") of scripts, primarily designed to wrap agent CLIs. It provides a scriptable loop engine with structured output, control flow between scripts, environment variable management, and a script installation mechanism.

**Package name:** `loopx`
**Implementation language:** TypeScript
**Target runtimes:** Node.js ≥ 18, Bun ≥ 1.0
**Platform support:** POSIX-only (macOS, Linux) for v1. Windows is not supported.

---

## 2. Concepts

### 2.1 Script

A script is an executable unit located in the `.loopx/` directory relative to the current working directory. Scripts come in two forms:

#### File Scripts

A single file with a supported extension:

- Bash (`.sh`)
- JavaScript (`.js` / `.jsx`)
- TypeScript (`.ts` / `.tsx`)

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

Directory scripts allow scripts to have their own dependencies managed via standard `npm install` or `bun install` within the directory. **loopx does not auto-install dependencies.** If `node_modules/` is missing and the script fails to import a package, the resulting error is a normal Node.js module resolution error.

A directory in `.loopx/` is only recognized as a script if it contains a `package.json` with a `main` field. Directories without this are ignored (and may exist for other purposes such as shared utilities).

### 2.2 Loop

A loop is a repeated execution cycle modeled as a **state machine**. Each iteration runs a script, examines its structured output, and transitions:

- **`goto` another script:** transition to that script for the next iteration.
- **No `goto`:** the cycle ends and the loop restarts from the **starting script** (the script originally specified or `default`).
- **`stop`:** the machine halts.

The `goto` mechanism is a **state transition, not a permanent reassignment.** When a target script finishes without its own `goto`, execution returns to the starting script — not the script that issued the `goto`. The loop always resets to its initial state after a transition chain completes.

**Example:**
```
Starting script: A

Iteration 1: A runs → outputs goto:"B"
Iteration 2: B runs → outputs goto:"C"
Iteration 3: C runs → outputs (no goto)
Iteration 4: A runs → (back to starting script)
```

### 2.3 Structured Output

Every script iteration produces an output conforming to:

```typescript
interface Output {
  result?: string;
  goto?: string;
  stop?: boolean;
}
```

**Stdout is reserved for the structured output payload.** Any human-readable logs, progress messages, or debug output from scripts must go to stderr.

**Parsing rules:**

- If stdout is valid JSON containing at least one known field (`result`, `goto`, `stop`), it is parsed as structured output.
- If stdout is not valid JSON, or is valid JSON but contains none of the known fields, the entire stdout content is treated as `{ result: <raw output> }`.
- Extra JSON fields beyond `result`, `goto`, and `stop` are silently ignored.
- If `result` is present but not a string, it is coerced via `String(value)`.
- If `goto` is present but not a string, it is treated as absent.
- If `stop` is present, any truthy value is treated as `true`.

**Field precedence:**

- `stop: true` takes priority over `goto`. If both are set, the loop halts.
- `goto` with no `result` is valid: the target script receives empty stdin.

---

## 3. Installation & Module Resolution

### 3.1 Primary Install Mode

loopx is installed **globally**:

```
npm install -g loopx
```

### 3.2 Local Version Pinning

A project may optionally pin a specific loopx version by installing it as a local dependency:

```
npm install --save-dev loopx
```

When the globally installed `loopx` binary starts, it checks whether the current working directory (or an ancestor) has a local `node_modules/.bin/loopx`. If a local installation is found, the global instance delegates execution to the local version's binary. This ensures project-level version consistency when needed.

### 3.3 Module Resolution for Scripts

A globally installed npm package is on PATH but its modules are **not** automatically importable from arbitrary scripts. To make `import { output } from "loopx"` work regardless of install location, loopx sets the `NODE_PATH` environment variable to include its own package directory when spawning JS/TS scripts.

### 3.4 Bash Script Binary Access

loopx injects a `LOOPX_BIN` environment variable into every script's execution environment. This variable contains the absolute path to the loopx binary, allowing bash scripts to call loopx subcommands reliably regardless of PATH:

```bash
#!/bin/bash
# Always works, regardless of PATH configuration
$LOOPX_BIN output --result "done" --goto "next-step"
```

---

## 4. CLI Interface

### 4.1 Running Scripts

```
loopx [options] [script-name]
```

- If `script-name` is provided, loopx looks for a script with that base name in `.loopx/`.
- If `script-name` is omitted, loopx looks for a script named `default` in `.loopx/`.
- If no `default` script exists and no script name is given, loopx exits with an error message instructing the user to create a script (e.g., "No default script found. Create `.loopx/default.ts` or specify a script name.").
- If `script-name` does not match any script in `.loopx/`, loopx exits with an error.

### 4.2 Ad-hoc Command Mode

loopx can wrap an arbitrary command in a loop using the `--` separator:

```
loopx [options] -- <command> [args...]
```

The `--` separator is **required** for ad-hoc mode. Everything after `--` is treated as a command and its arguments. The command is executed via direct process spawn (`spawn(command, args)`), not shell evaluation. Shell features (pipes, redirects, globbing) are not available directly — use `bash -c "..."` as the command if shell evaluation is needed.

Structured output rules apply identically to ad-hoc commands. If the command outputs valid structured JSON with a `goto` field, loopx honors it and jumps to the named script in `.loopx/`.

The `.loopx/` directory does not need to exist for ad-hoc mode, unless a `goto` in the command's output references a script.

### 4.3 Options

| Flag | Description |
|------|-------------|
| `-n <count>` | Maximum number of loop iterations. After this many iterations, exit cleanly. `-n 0` means zero iterations (exit immediately with code 0). |
| `-e <path>` | Path to a local env file (standard `.env` format). Variables are merged with global env vars; local values take precedence on conflict. |
| `-h`, `--help` | Print usage information. Dynamically lists available scripts discovered in `.loopx/`. If `.loopx/` is missing or contains invalid scripts, help is still displayed with warnings appended. |

### 4.4 Subcommands

#### `loopx version`

Prints the installed version of loopx and exits.

#### `loopx output`

A helper for bash scripts to emit structured output:

```bash
loopx output [--result <value>] [--goto <script-name>] [--stop]
```

Prints the corresponding JSON to stdout. Example usage in a bash script:

```bash
#!/bin/bash
# do work...
$LOOPX_BIN output --result "done" --goto "next-step"
exit 0
```

#### `loopx env set <name> <value>`

Sets a global environment variable stored in the loopx global config directory.

**Validation:** The variable name must match `[A-Za-z_][A-Za-z0-9_]*`.

#### `loopx env remove <name>`

Removes a global environment variable.

#### `loopx env list`

Lists all currently set global environment variables and their values.

#### `loopx install <source>`

Installs a script into the `.loopx/` directory. See section 10 for full details. Supports:

- **File URL** — downloads a single script file.
- **Git URL** — clones a repository as a directory script.
- **Tarball URL** — extracts an archive as a directory script.
- **`org/repo` shorthand** — expands to `https://github.com/org/repo` and clones as a directory script.

Creates the `.loopx/` directory if it does not exist.

---

## 5. Script Discovery and Validation

### 5.1 Discovery

Scripts are discovered by scanning the `.loopx/` directory in the current working directory:

- **File scripts:** Top-level files with supported extensions (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`). The script name is the base name (filename without extension).
- **Directory scripts:** Top-level directories containing a `package.json` with a `main` field pointing to a file with a supported extension. The script name is the directory name. The `main` field must point to a file within the directory with a supported extension; otherwise the directory is ignored with a warning.

Nested directories that do not contain a valid `package.json` with `main` are ignored.

**Discovery is performed once at loop start and the result is cached for the duration of the loop.** Scripts added, removed, or modified during loop execution are not detected until the next invocation of loopx.

### 5.2 Name Collision

If multiple entries share the same script name — whether file-to-file (e.g., `example.sh` and `example.js`), or file-to-directory (e.g., `example.ts` and `example/`) — loopx refuses to start and displays an error message listing the conflicting entries.

### 5.3 Reserved Names

The following script names are reserved and cannot be used:

- `output`
- `env`
- `install`
- `version`

If any script in `.loopx/` uses a reserved name, loopx refuses to start and displays an error message.

### 5.4 Name Restrictions

- Script names must not begin with `-`.
- Script names must match the pattern `[a-zA-Z0-9_][a-zA-Z0-9_-]*` (start with alphanumeric or underscore, followed by alphanumerics, underscores, or hyphens).

### 5.5 Validation Scope

Not all commands require `.loopx/` to exist or be valid:

| Command | Requires `.loopx/` | Validates scripts |
|---------|--------------------|--------------------|
| `loopx version` | No | No |
| `loopx env *` | No | No |
| `loopx output` | No | No |
| `loopx -h` / `--help` | No (shows warnings if missing/invalid) | No (shows warnings) |
| `loopx install <url>` | No (creates if needed) | No |
| `loopx [script-name]` | Yes | Yes |
| `loopx -- <command>` | No (unless `goto` targets a script) | Deferred until `goto` resolution |

---

## 6. Script Execution

### 6.1 Bash Scripts

Bash scripts (`.sh`) are executed as child processes via `/bin/bash`. The script's stdout is captured as its structured output. Stderr is passed through to the user's terminal.

### 6.2 JS/TS Scripts

JavaScript and TypeScript scripts are executed as child processes using `tsx`, which handles `.js`, `.jsx`, `.ts`, and `.tsx` files uniformly. `tsx` is a dependency of loopx and does not need to be installed separately by the user.

- Stdout is captured as structured output.
- Stderr is passed through to the user's terminal.

When running under Bun, loopx uses Bun's native TypeScript/JSX support instead of `tsx`.

### 6.3 Directory Scripts

For directory scripts, loopx reads the `main` field from the directory's `package.json` to determine the entry point file. The entry point is then executed using the same rules as file scripts — bash for `.sh`, tsx/bun for JS/TS extensions.

The script's working directory is set to the directory script's directory (e.g., `.loopx/my-pipeline/`), so relative imports and `node_modules/` resolve naturally.

### 6.4 `output()` Function (JS/TS)

When imported from `loopx`, the `output()` function writes structured JSON to stdout and immediately terminates the process (`process.exit(0)`).

```typescript
import { output } from "loopx";

output({ result: "hello", goto: "next-step" });
// process exits here — no code after this line runs
```

Since `output()` calls `process.exit()`, calling it multiple times is not possible — only the first call takes effect.

If `output()` is called with a value that does not conform to the `Output` interface (e.g., a plain string), the value is serialized as `{ result: String(value) }`.

### 6.5 `input()` Function (JS/TS)

When imported from `loopx`, the `input()` function reads the input piped from the previous script via stdin:

```typescript
import { input, output } from "loopx";

const data = await input(); // Returns the input string, or empty string if no input

output({ result: `processed: ${data}` });
```

`input()` returns a `Promise<string>`. On the first iteration (when no input is available), it resolves to an empty string.

### 6.6 Input Piping

When a script's output includes `result` and the next script is determined by `goto`, the `result` value is delivered to the next script via **stdin** — the `result` string is written to the next script's stdin.

### 6.7 Initial Input

The first script invocation in a loop receives **no input**. Stdin is empty.

---

## 7. Loop Execution Flow

### 7.1 Basic Loop

1. If running in script mode, validate the `.loopx/` directory (check for name collisions, reserved names, name restrictions). Cache the discovery results.
2. Load environment variables (global + local via `-e`). Cache the resolved set for the duration of the loop.
3. Determine the starting script (named argument or `default`) or ad-hoc command.
4. Execute the script/command with no input (first iteration).
5. Capture stdout. Parse it as structured output per section 2.3.
6. Increment the iteration counter.
7. If `stop` is `true`: exit with code 0.
8. If `-n` was specified and the iteration count has been reached: exit with code 0.
9. If `goto` is present:
   a. Validate that the named script exists in `.loopx/` (performing discovery first if not yet done, e.g., in ad-hoc mode). If not found, print an error and exit with code 1.
   b. Execute the `goto` script with `result` piped via stdin (or empty stdin if `result` is absent).
   c. Return to step 5 with the new script's output.
10. If `goto` is absent:
    a. Re-run the **starting script** (not the most recently executed script) with no input.
    b. Return to step 5.

**The CLI does not print `result` to its own stdout at any point.** All human-readable output from scripts should go to stderr, which passes through to the terminal. Structured results are accessed via the programmatic API (section 9).

### 7.2 Error Handling

- **Non-zero exit code from a script:** The loop **stops immediately**. loopx exits with code 1. The script's stderr has already been passed through to the terminal. Any stdout produced by the script before it failed is not parsed as structured output.
- **Invalid `goto` target:** If `goto` references a script name that does not exist in `.loopx/`, loopx prints an error message to stderr and exits with code 1.
- **Missing `.loopx/` directory:** When running a named or default script, if `.loopx/` does not exist, loopx exits with an error instructing the user to create it.

---

## 8. Environment Variables

### 8.1 Global Storage

Global environment variables are stored in the loopx configuration directory at:

```
~/.config/loopx/env
```

The file uses standard `.env` format (`KEY=VALUE`, one per line, `#` comments, blank lines ignored).

If the directory or file does not exist, loopx treats it as having no global variables. The directory is created on first `loopx env set`.

**Environment variables are loaded once at loop start and cached for the duration of the loop.** Changes to env files during loop execution are not picked up until the next invocation.

### 8.2 Local Override (`-e`)

When `-e <path>` is specified, the file at `<path>` is read (standard `.env` format) and its variables are merged with global env vars. Local values take precedence on conflict.

### 8.3 Injection

All resolved environment variables (global + local overrides) are injected into the script's execution environment alongside the inherited system environment. loopx env vars take precedence over inherited system env vars of the same name.

loopx also injects the following variables into every script execution:

| Variable | Value |
|----------|-------|
| `LOOPX_BIN` | Absolute path to the loopx binary |

---

## 9. Programmatic API

loopx can be imported and used from TypeScript/JavaScript:

### 9.1 `run(scriptName?: string)`

```typescript
import { run } from "loopx";

const loop = run("myscript");

for await (const output of loop) {
  console.log(output.result);
  // each yielded value is an Output from one iteration
}
// loop has ended (stop: true or max iterations reached)
```

Returns an `AsyncGenerator<Output>` that yields the `Output` from each loop iteration. The generator completes when the loop ends via `stop: true` or when `maxIterations` is reached.

Options can be passed as a second argument:

```typescript
import { run } from "loopx";

for await (const output of run("myscript", { maxIterations: 10, envFile: ".env" })) {
  // ...
}
```

### 9.2 `runPromise(scriptName?: string)`

```typescript
import { runPromise } from "loopx";

const outputs: Output[] = await runPromise("myscript");
```

Returns a `Promise<Output[]>` that resolves with an array of all `Output` values when the loop ends. Accepts the same options object as `run()`.

### 9.3 Error Behavior

The programmatic API has different behavior from the CLI:

- **The library never prints `result` to stdout.** All results are returned as structured `Output` objects.
- **Errors throw/reject.** Any condition that would cause the CLI to exit with code 1 (non-zero script exit, invalid `goto`, validation failures) causes `run()` to throw from the generator and `runPromise()` to reject.
- **Partial outputs are preserved.** When `run()` throws, all previously yielded outputs have already been consumed by the caller. When `runPromise()` rejects, partial outputs are not available (use `run()` if partial results matter).
- **Stderr passes through.** Script stderr is still forwarded to the parent process's stderr, same as in CLI mode.

### 9.4 `output(value)` and `input()`

These functions are documented in sections 6.4 and 6.5. They are designed for use **inside scripts**, not in application code that calls `run()` / `runPromise()`.

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
}
```

---

## 10. `loopx install`

```
loopx install <source>
```

Installs a script into the `.loopx/` directory, creating it if necessary. The source format determines the install behavior:

### 10.1 Source Types

#### File URL

A URL pointing to a single file (e.g., `https://example.com/scripts/myscript.ts`).

- The filename is derived from the URL's last path segment, with query strings and fragments stripped.
- The file must have a supported extension (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`); otherwise an error is displayed.
- The script name is the base name of the downloaded file.

#### Git URL

A URL ending in `.git` or recognized as a git remote (e.g., `https://github.com/org/repo.git`).

- The repository is cloned with `--depth 1` (shallow clone) into `.loopx/<repo-name>/`.
- The script name is derived from the repository name (last path segment, minus `.git` suffix).
- The cloned directory must contain a `package.json` with a `main` field pointing to a supported extension. If not, the clone is removed and an error is displayed.

#### Tarball URL

A URL pointing to a `.tar.gz` or `.tgz` archive.

- The archive is downloaded and extracted into `.loopx/<archive-name>/`, where `archive-name` is the filename minus archive extensions.
- The extracted directory must contain a `package.json` with a `main` field pointing to a supported extension. If not, the directory is removed and an error is displayed.

#### `org/repo` Shorthand

A source matching the pattern `<org>/<repo>` (no protocol, no slashes beyond the single separator) is expanded to `https://github.com/<org>/<repo>.git` and installed as a git source.

```
loopx install myorg/my-agent-script
# equivalent to: loopx install https://github.com/myorg/my-agent-script.git
```

### 10.2 Common Rules

All install sources share these rules:

- If a script with the same **name** (regardless of whether it's a file or directory script) already exists in `.loopx/`, loopx displays an error and does not overwrite. The user must manually remove the existing script first.
- The script name is validated against reserved name and name restriction rules before being saved.
- **loopx does not run `npm install` or `bun install` after cloning/extracting.** For directory scripts with dependencies, the user must install them manually (e.g., `cd .loopx/my-script && npm install`).

---

## 11. Help

`loopx -h` / `loopx --help` prints usage information including:

- General usage syntax
- Available options and subcommands
- A dynamically generated list of scripts discovered in the current `.loopx/` directory (name and file type)

If `.loopx/` does not exist, help is still displayed without the script list. If `.loopx/` exists but contains validation errors (name collisions, reserved names), help is still displayed with warnings about the invalid scripts.

---

## 12. Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Clean exit: loop ended via `stop: true`, `-n` limit reached, or successful subcommand execution. |
| 1 | Error: script exited non-zero, validation failure, invalid `goto` target, missing script, or missing `.loopx/` directory. |

Note: A non-zero exit code from any script causes loopx to exit with code 1. Scripts that need error resilience should handle errors internally and exit 0.

---

## 13. Summary of Reserved and Special Values

| Name | Context | Purpose |
|------|---------|---------|
| `output` | Script name | Reserved for `loopx output` subcommand |
| `env` | Script name | Reserved for `loopx env` subcommand |
| `install` | Script name | Reserved for `loopx install` subcommand |
| `version` | Script name | Reserved for `loopx version` subcommand |
| `default` | Script name | The script run when no name is provided |
| `LOOPX_BIN` | Env variable | Absolute path to the loopx binary, injected into every script |
