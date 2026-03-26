# Loop Extender (loopx) — Specification

## 1. Overview

loopx is a CLI tool that automates repeated execution ("loops") of scripts, primarily designed to wrap agent CLIs. It provides a scriptable loop engine with structured output, control flow between scripts, environment variable management, and a script installation mechanism.

**Package name:** `loopx`
**Implementation language:** TypeScript
**Target runtime:** Node.js

---

## 2. Concepts

### 2.1 Script

A script is a single executable unit located in the `.loopx/` directory relative to the current working directory. Scripts can be written in:

- Bash (`.sh`)
- JavaScript (`.js` / `.jsx`)
- TypeScript (`.ts` / `.tsx`)

A script is identified by its **base name** (filename without extension). For example, `.loopx/myscript.ts` is identified as `myscript`.

Only top-level files in `.loopx/` are considered. Subdirectories are ignored during script discovery.

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

If a script's output does not conform to this schema (i.e., is not valid JSON or does not contain at least one of these fields), the entire stdout is treated as the `result` field, with `goto` and `stop` unset.

---

## 3. CLI Interface

### 3.1 Running Scripts

```
loopx [options] [script-name]
```

- If `script-name` is provided, loopx looks for a script with that base name in `.loopx/`.
- If `script-name` is omitted, loopx looks for a script named `default` in `.loopx/`.
- If no `default` script exists and no script name is given, loopx exits with an error message instructing the user to create a script in `.loopx/`.

### 3.2 Ad-hoc Command Mode

loopx can wrap an arbitrary shell command in a loop:

```
loopx [options] <command...>
```

**Disambiguation:** loopx first checks whether the first positional argument matches a script in `.loopx/`. If a matching script exists, it runs that script. Otherwise, the arguments are treated as a shell command to execute in a loop.

Example:
```bash
loopx cat PROMPT.md | claude --dangerously-skip-permissions -p
```

In ad-hoc mode, the command's stdout is captured and parsed as structured output using the same rules as scripts. If parsing fails, the raw output becomes the `result`.

### 3.3 Options

| Flag | Description |
|------|-------------|
| `-n <count>` | Maximum number of loop iterations. After this many iterations, exit cleanly (exit code 0). |
| `-e <path>` | Path to a local `.env` file. Variables are merged with global env vars; local values take precedence on conflict. The file must not contain `LOOPX_INPUT` — if it does, loopx exits with a fatal error. |
| `-h`, `--help` | Print usage information. Dynamically lists all available scripts discovered in `.loopx/`. |

### 3.4 Subcommands

#### `loopx version`

Prints the installed version of loopx and exits.

#### `loopx output`

A helper for bash scripts to emit structured output:

```bash
loopx output [--result <value>] [--goto <script-name>] [--stop]
```

Prints the corresponding JSON to stdout. The bash script should call this as the last stdout-producing command and then exit. loopx captures the script's full stdout and parses it, so the `loopx output` JSON should be the only thing written to stdout (or at least the complete stdout should parse as valid structured output).

#### `loopx env set <name> <value>`

Sets a global environment variable. The name `LOOPX_INPUT` is reserved — attempting to set it produces a fatal error.

#### `loopx env remove <name>`

Removes a global environment variable.

#### `loopx env list`

Lists all currently set global environment variables and their values.

#### `loopx install <url>`

Downloads a remote script file into the `.loopx/` directory.

- The filename is derived from the URL's path.
- The file must have a supported extension (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`); otherwise an error is displayed.
- If a file with the same base name already exists in `.loopx/`, loopx displays an error and does not overwrite it.

---

## 4. Script Discovery and Validation

### 4.1 Discovery

Scripts are discovered by scanning the `.loopx/` directory in the current working directory. Only **top-level files** with supported extensions (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`) are considered. Subdirectories and files with unsupported extensions are ignored.

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

Script names must not begin with `-`.

---

## 5. Script Execution

### 5.1 Bash Scripts

Bash scripts (`.sh`) are executed as child processes via the system shell. Stdout is captured and parsed as structured output. Stderr is passed through to the user's terminal.

### 5.2 JS/TS Scripts

JavaScript and TypeScript scripts are executed as child processes using `tsx`, which handles `.js`, `.jsx`, `.ts`, and `.tsx` files uniformly. `tsx` must be available in the environment (either installed globally or as a project dependency). Stdout is captured and parsed as structured output. Stderr is passed through to the user's terminal.

### 5.3 TypeScript/JavaScript `output()` Function

When imported from `loopx`, the `output()` function writes the structured JSON to stdout and immediately terminates the process via `process.exit(0)`. Since it exits, any code after an `output()` call is unreachable — calling `output()` twice is not possible.

```typescript
import { output } from "loopx";
import type { Output } from "loopx";

// Writes JSON to stdout and exits the process
output({ result: "hello", goto: "next-step" });
// unreachable
```

If a script does not call `output()`, its raw stdout is captured and parsed using the standard rules (valid structured JSON or treated as `result`).

### 5.4 Input Delivery

When a previous script's output includes both `result` and `goto`, the `result` value is delivered to the next script via **two mechanisms simultaneously**:

1. **stdin** — the `result` string is written to the next script's stdin.
2. **`LOOPX_INPUT` environment variable** — the `result` string is set as the `LOOPX_INPUT` env var in the next script's execution environment.

This dual delivery allows scripts to consume input in whichever way is most convenient for their use case.

#### `LOOPX_INPUT` Protection

`LOOPX_INPUT` is a reserved environment variable managed exclusively by loopx. It cannot be set by users:

- `loopx env set LOOPX_INPUT ...` produces a fatal error.
- If a file provided via `-e` contains `LOOPX_INPUT`, loopx exits with a fatal error before running any scripts.

### 5.5 Initial Input

The first script invocation in a loop receives **no input** — stdin is empty and `LOOPX_INPUT` is not set.

### 5.6 Script Failure

If a script exits with a non-zero exit code, the loop **continues**. The script's stdout is still captured and parsed using the standard rules. This allows scripts to signal partial failure through exit codes while still participating in the loop via structured output.

---

## 6. Loop Execution Flow

### 6.1 Algorithm

```
1. Validate .loopx/ directory (check for name collisions, reserved names, name restrictions).
2. Determine the starting script S (named argument, or "default").
3. Set iteration_count = 0.
4. Set input = <empty> (no input for first iteration).

LOOP:
5. Execute S with input delivered via stdin and LOOPX_INPUT (if input is non-empty).
6. Capture stdout. Stderr passes through to the terminal.
7. Increment iteration_count.
8. Parse stdout as structured JSON.
   - If valid JSON with at least one of {result, goto, stop}: use as Output.
   - Otherwise: Output = { result: <raw stdout> }.
9. Print result to the terminal (if result is present).
10. If stop is true → exit with code 0.
11. If -n was specified and iteration_count >= n → exit with code 0.
12. If goto is present:
    a. If the named script does not exist → exit with code 1 and print an error.
    b. Set S = the goto script.
    c. Set input = result (if present), otherwise input = <empty>.
    d. Go to LOOP.
13. If goto is absent:
    a. Set S = the original starting script.
    b. Set input = <empty>.
    c. Go to LOOP.
```

### 6.2 Error Conditions

| Condition | Behavior |
|-----------|----------|
| Script exits with non-zero code | Loop continues; stdout is parsed normally |
| `goto` names a non-existent script | Fatal error; loop exits with code 1 and an error message |
| `.loopx/` directory missing | Error message; exit code 1 |
| No matching script and no ad-hoc command | Error message; exit code 1 |

---

## 7. Environment Variables

### 7.1 Global Storage

Global environment variables are stored in `~/.loopx/env` as a standard `.env` file (one `KEY=VALUE` per line).

The `~/.loopx/` directory is created automatically if it does not exist when `loopx env set` is first used.

### 7.2 Local Override (`-e`)

When `-e <path>` is specified, the file at `<path>` is parsed as a standard `.env` file and merged with global env vars. Local values take precedence on conflict. If the file contains `LOOPX_INPUT`, loopx exits with a fatal error.

### 7.3 Resolution Order

Environment variables are resolved in this order (later overrides earlier):

1. Global env vars (`~/.loopx/env`)
2. Local env vars (from `-e` file)
3. `LOOPX_INPUT` (set by loopx when piping result between scripts)

### 7.4 Injection

All resolved environment variables are injected into each script's execution environment alongside the inherited system environment.

---

## 8. Programmatic API

loopx can be imported and used from TypeScript/JavaScript:

### 8.1 `run(scriptName?: string)`

Returns an `AsyncGenerator<Output>` that yields each iteration's output.

```typescript
import { run } from "loopx";

for await (const result of run("myscript")) {
  console.log(result.result);
}
```

If `scriptName` is omitted, runs the `default` script.

### 8.2 `runPromise(scriptName?: string)`

Returns a `Promise<Output[]>` that resolves when the loop ends (via `stop: true` or `-n` limit), with an array of all outputs from every iteration.

```typescript
import { runPromise } from "loopx";

const outputs: Output[] = await runPromise("myscript");
```

### 8.3 `output(value: Partial<Output> | string)`

Used inside scripts to emit structured output. Writes JSON to stdout and calls `process.exit(0)`.

If called with a string, it is treated as `{ result: value }`.

```typescript
import { output } from "loopx";

output({ result: "data", goto: "next" });
// process exits here
```

### 8.4 Types

```typescript
export interface Output {
  result?: string;
  goto?: string;
  stop?: boolean;
}
```

---

## 9. Help

`loopx -h` / `loopx --help` prints usage information including:

- General usage syntax
- Available options and subcommands
- A dynamically generated list of scripts discovered in the current `.loopx/` directory

---

## 10. Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Clean exit: `stop: true`, `-n` limit reached, or `version`/`help` commands |
| 1 | Error: invalid `goto` target, validation failure, missing script, missing `.loopx/` directory, reserved name conflict, `LOOPX_INPUT` violation |
