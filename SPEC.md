# Loop Extender (loopx) — Specification

## 1. Overview

loopx is a CLI tool that automates repeated execution ("loops") of scripts, primarily designed to wrap agent CLIs. It provides a scriptable loop engine with structured output, control flow between scripts, environment variable management, and a script installation mechanism.

**Package name:** `loopx`
**Implementation language:** TypeScript
**Target runtimes:** Node.js (default), Bun

---

## 2. Concepts

### 2.1 Script

A script is a single executable unit located in the `.loopx/` directory relative to the current working directory. Scripts can be written in:

- Bash (`.sh`)
- JavaScript (`.js` / `.jsx`)
- TypeScript (`.ts` / `.tsx`)

A script is identified by its **base name** (filename without extension). For example, `.loopx/myscript.ts` is identified as `myscript`.

Only top-level files in `.loopx/` are considered scripts. Nested directories within `.loopx/` are ignored by the script discovery mechanism (but may exist for other purposes such as shared utilities).

### 2.2 Loop

A loop is a repeated execution cycle. Each iteration runs a script, examines its structured output, and decides what to do next (re-run, goto another script, or stop).

### 2.3 Structured Output

Every script iteration produces an output conforming to:

```typescript
interface Output {
  result?: string;
  goto?: string;
  stop?: boolean;
}
```

If a script's output does not conform to this schema (i.e., is not valid JSON with at least one of these fields), the entire output is treated as the `result` field, with `goto` and `stop` unset.

---

## 3. CLI Interface

### 3.1 Running Scripts

```
loopx [options] [script-name]
```

- If `script-name` is provided, loopx looks for a script with that base name in `.loopx/`.
- If `script-name` is omitted, loopx looks for a script named `default` in `.loopx/`.
- If no `default` script exists and no script name is given, loopx exits with an error message instructing the user to create a script (e.g., "No default script found. Create `.loopx/default.ts` or specify a script name.").

### 3.2 Ad-hoc Command Mode

loopx can also wrap an arbitrary shell command in a loop:

```
loopx [options] <command...>
```

**Disambiguation:** When arguments are provided, loopx first checks if the first argument matches a script name in `.loopx/`. If a match is found, it runs that script. Otherwise, the entire argument string is treated as a shell command to execute in a loop.

In ad-hoc mode, the command's stdout is captured and parsed using the same structured output rules as scripts — including `goto`, `stop`, and `result`. If an ad-hoc command outputs valid structured JSON with a `goto` field, loopx honors it and jumps to the named script in `.loopx/`. A simple command that doesn't output structured JSON will have its output treated as `result`, the loop will restart with no input, and continue indefinitely (or until `-n` is reached).

### 3.3 Options

| Flag | Description |
|------|-------------|
| `-n <count>` | Maximum number of loop iterations. After this many iterations, exit cleanly. |
| `-e <path>` | Path to a local env file (standard `.env` format). Variables are merged with global env vars; local values take precedence on conflict. The file must not contain a `LOOPX_INPUT` key — if it does, loopx exits with a fatal error. |
| `-h`, `--help` | Print usage information. Dynamically lists all available scripts discovered in `.loopx/`. |

### 3.4 Subcommands

#### `loopx version`

Prints the installed version of loopx and exits.

#### `loopx output`

A helper for bash scripts to emit structured output:

```bash
loopx output [--result <value>] [--goto <script-name>] [--stop]
```

Prints the corresponding JSON to stdout. The bash script should capture or relay this output and then exit. Example usage in a bash script:

```bash
#!/bin/bash
# do work...
loopx output --result "done" --goto "next-step"
exit 0
```

#### `loopx env set <name> <value>`

Sets a global environment variable stored in the loopx global config directory. Setting `LOOPX_INPUT` is a fatal error — this variable is reserved by loopx.

#### `loopx env remove <name>`

Removes a global environment variable.

#### `loopx env list`

Lists all currently set global environment variables and their values.

#### `loopx install <url>`

Downloads a remote script file into the `.loopx/` directory.

- The filename is derived from the URL (last path segment).
- The file must have a supported extension (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`); otherwise an error is displayed.
- If a file with the same name already exists in `.loopx/`, loopx displays an error and does not overwrite.
- Creates the `.loopx/` directory if it does not exist.

---

## 4. Script Discovery and Validation

### 4.1 Discovery

Scripts are discovered by scanning the `.loopx/` directory in the current working directory. Only top-level files with supported extensions (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`) are considered. Nested directories and files within them are ignored.

### 4.2 Name Collision

If multiple files share the same base name but differ in extension (e.g., `example.sh` and `example.js`), loopx refuses to start and displays an error message listing the conflicting files.

### 4.3 Reserved Names

The following script names are reserved and cannot be used:

- `output`
- `env`
- `install`
- `version`

If any script in `.loopx/` uses a reserved name, loopx refuses to start and displays an error message.

### 4.4 Name Restrictions

- Script names must not begin with `-`.
- Script names must match the pattern `[a-zA-Z0-9_][a-zA-Z0-9_-]*` (start with alphanumeric or underscore, followed by alphanumerics, underscores, or hyphens).

---

## 5. Script Execution

### 5.1 Bash Scripts

Bash scripts (`.sh`) are executed as child processes via the system shell (`/bin/bash`). The script's stdout is captured as its structured output. Stderr is passed through to the user's terminal.

### 5.2 JS/TS Scripts

JavaScript and TypeScript scripts are executed as child processes using `tsx`, which handles `.js`, `.jsx`, `.ts`, and `.tsx` files uniformly. `tsx` is a dependency of loopx and does not need to be installed separately by the user.

- Stdout is captured as structured output.
- Stderr is passed through to the user's terminal.

When running under Bun, loopx uses Bun's native TypeScript/JSX support instead of `tsx`.

### 5.3 TypeScript/JavaScript `output()` Function

When imported from `loopx`, the `output()` function writes structured JSON to stdout and immediately terminates the process (`process.exit(0)`).

```typescript
import { output } from "loopx";
import type { Output } from "loopx";

output({ result: "hello", goto: "next-step" });
// process exits here — no code after this line runs
```

Since `output()` calls `process.exit()`, calling it multiple times is not possible — only the first call takes effect.

If `output()` is called with a value that does not conform to the `Output` interface (e.g., a plain string), the value is serialized as `{ result: String(value) }`.

### 5.4 Input Piping

When a previous script's output includes both `result` and `goto`, the `result` value is delivered to the next script via **two mechanisms simultaneously**:

1. **stdin** — the `result` string is written to the next script's stdin.
2. **`LOOPX_INPUT` environment variable** — the `result` string is set as the `LOOPX_INPUT` env var in the next script's execution environment.

This dual delivery allows scripts to consume input via whichever mechanism is most convenient (e.g., bash scripts can read stdin, while JS/TS scripts may prefer `process.env.LOOPX_INPUT`).

**`LOOPX_INPUT` is a reserved variable.** It cannot be set via `loopx env set` (fatal error) or included in a `-e` env file (fatal error). loopx owns this variable exclusively.

### 5.5 Initial Input

The first script invocation in a loop receives **no input**. Stdin is empty and `LOOPX_INPUT` is not set.

---

## 6. Loop Execution Flow

### 6.1 Basic Loop

1. Validate the `.loopx/` directory (check for name collisions, reserved names, name restrictions).
2. Determine the starting script (named argument, ad-hoc command, or `default`).
3. Execute the script with no input (first iteration) or with piped input (subsequent iterations via `goto`).
4. Capture stdout. Parse it as structured JSON. If parsing fails, treat the entire output as `{ result: <raw output> }`.
5. Increment the iteration counter.
6. If `stop` is `true`: print `result` (if present) and exit with code 0.
7. If `-n` was specified and the iteration count has been reached: print `result` (if present) and exit with code 0.
8. If `goto` is present:
   a. Validate that the named script exists. If not, print an error and exit with code 1.
   b. Print `result` to the loopx process's own stdout (if present).
   c. Execute the `goto` script with `result` piped as input (stdin + `LOOPX_INPUT`).
   d. Return to step 4 with the new script's output.
9. If `goto` is absent:
   a. Print `result` to the loopx process's own stdout (if present).
   b. Re-run the starting script with no input.
   c. Return to step 4.

### 6.2 Error Handling

- **Non-zero exit code from a script:** The loop **continues**. The script's stdout is still parsed for structured output as normal. If no valid output was produced, the iteration is treated as `{ result: undefined }` and the loop continues from the starting script.
- **Invalid `goto` target:** If `goto` references a script name that does not exist in `.loopx/`, loopx prints an error message and exits with code 1.
- **Missing `.loopx/` directory:** When running a named or default script, if `.loopx/` does not exist, loopx exits with an error instructing the user to create it.

---

## 7. Environment Variables

### 7.1 Global Storage

Global environment variables are stored in the loopx configuration directory at:

```
~/.config/loopx/env
```

The file uses standard `.env` format (`KEY=VALUE`, one per line, `#` comments, blank lines ignored).

If the directory or file does not exist, loopx treats it as having no global variables. The directory is created on first `loopx env set`.

### 7.2 Local Override (`-e`)

When `-e <path>` is specified, the file at `<path>` is read (standard `.env` format) and its variables are merged with global env vars. Local values take precedence on conflict.

**Validation:** If the local env file contains a `LOOPX_INPUT` key, loopx exits with a fatal error.

### 7.3 Reserved Variables

`LOOPX_INPUT` is reserved by loopx for piping `result` between scripts. It cannot be set in:

- Global env vars (`loopx env set LOOPX_INPUT ...` is a fatal error)
- Local env files (`-e` file containing `LOOPX_INPUT` is a fatal error)

### 7.4 Injection

All resolved environment variables (global + local overrides + `LOOPX_INPUT` when applicable) are injected into the script's execution environment alongside the inherited system environment. loopx env vars take precedence over inherited system env vars of the same name.

---

## 8. Programmatic API

loopx can be imported and used from TypeScript/JavaScript:

### 8.1 `run(scriptName?: string)`

```typescript
import { run } from "loopx";

const loop = run("myscript");

for await (const output of loop) {
  console.log(output.result);
  // each yielded value is an Output from one iteration
}
// loop has ended (stop: true or natural completion)
```

Returns an `AsyncGenerator<Output>` that yields the `Output` from each loop iteration. The generator completes when the loop ends (via `stop: true`).

Options (such as `-n` and `-e` equivalents) can be passed as a second argument:

```typescript
import { run } from "loopx";

for await (const output of run("myscript", { maxIterations: 10, envFile: ".env" })) {
  // ...
}
```

### 8.2 `runPromise(scriptName?: string)`

```typescript
import { runPromise } from "loopx";

const outputs: Output[] = await runPromise("myscript");
```

Returns a `Promise<Output[]>` that resolves with an array of all `Output` values when the loop ends (via `stop: true` or max iterations reached). Accepts the same options object as `run()`.

### 8.3 `output(value)`

```typescript
import { output } from "loopx";

output({ result: "data", goto: "next" });
// process.exit(0) is called — execution stops here
```

Used inside scripts to emit structured output. Writes JSON to stdout and exits the process.

### 8.4 Types

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

## 9. `loopx install`

```
loopx install <url>
```

- Downloads the file at `<url>` into the `.loopx/` directory, creating it if necessary.
- The filename is derived from the last path segment of the URL.
- The file must have a supported extension (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`); otherwise an error is shown.
- If a file with the same base name already exists in `.loopx/`, loopx displays an error and does not overwrite. The user must manually remove the existing script first.
- The downloaded script is validated against reserved name and name restriction rules before being saved.

---

## 10. Help

`loopx -h` / `loopx --help` prints usage information including:

- General usage syntax
- Available options and subcommands
- A dynamically generated list of scripts discovered in the current `.loopx/` directory (name and file type)

---

## 11. Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Clean exit: loop ended via `stop: true`, `-n` limit reached, or successful subcommand execution. |
| 1 | Error: validation failure (name collision, reserved name, invalid `goto`, missing script, `LOOPX_INPUT` violation, etc.). |

Note: Non-zero exit codes from individual scripts do **not** cause loopx itself to exit with a non-zero code. The loop continues and loopx exits 0 when the loop ends normally.

---

## 12. Summary of Reserved and Special Values

| Name | Context | Purpose |
|------|---------|---------|
| `output` | Script name | Reserved for `loopx output` subcommand |
| `env` | Script name | Reserved for `loopx env` subcommand |
| `install` | Script name | Reserved for `loopx install` subcommand |
| `version` | Script name | Reserved for `loopx version` subcommand |
| `default` | Script name | The script run when no name is provided |
| `LOOPX_INPUT` | Env variable | Reserved for inter-script result piping |
