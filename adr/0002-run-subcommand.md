# ADR-0002: Introduce `run` Subcommand and Remove Default Script

**Status:** Proposed

---

## Context

Currently, `loopx [script-name]` is the primary invocation form, and the CLI uses positional argument parsing to distinguish between subcommands (`version`, `output`, `env`, `install`) and script names. This requires a "reserved names" mechanism (section 5.3) that prevents scripts from being named after built-in subcommands. Additionally, when no script name is provided, loopx implicitly runs a `default` script — adding complexity for marginal convenience.

As the CLI grows, the ambiguity between subcommands and script names becomes a maintenance burden. Adding new subcommands requires updating the reserved names list and potentially breaking existing scripts.

## Decision

### 1. Add `run` subcommand

The only way to execute scripts becomes:

```
loopx run [options] <script-name>
```

The script name is required — there is no default script concept.

Options `-n` and `-e` are scoped to the `run` subcommand:

```
loopx run -n 5 -e .env myscript
loopx run -h
```

### 2. Remove the `default` script concept

`default` is no longer a special script name. Running `loopx run` with no script name is an error (exit code 1).

- A script named `default` is still allowed — it is an ordinary script with no special behavior.
- `loopx run default` runs the script named `default`.

### 3. Remove reserved script names

Scripts may now use any name that passes the existing name restriction rules (section 5.4). The reserved names list (`output`, `env`, `install`, `version`) is eliminated.

Since scripts are always invoked via `loopx run <name>`, there is no ambiguity with built-in commands.

### 4. Help restructuring

- `loopx -h` / `loopx --help`: Top-level help — lists subcommands (`run`, `version`, `output`, `env`, `install`) and general syntax. **Does not inspect `.loopx/` or perform script discovery.**
- `loopx run -h` / `loopx run --help`: Run-specific help — options (`-n`, `-e`) and dynamically discovered scripts in `.loopx/`. This is the only help form that performs script discovery and non-fatal validation (warnings for invalid scripts, missing `.loopx/`, etc.).
- `loopx` (no arguments): Shows top-level help (same as `loopx -h`). No script discovery.
- Unrecognized subcommands (e.g., `loopx foo`) are a usage error — there is no implicit fallback to `run`.

### 5. Command parsing and precedence

- The only top-level option is `-h` / `--help`. Top-level `-n` and `-e` are usage errors (exit code 1).
- `loopx` with no arguments is equivalent to `loopx -h`.
- `-n` and `-e` are valid only after `run`. Within `run`, options and `<script-name>` may appear in any order.
- `loopx run` with no `<script-name>` is a usage error (exit code 1) and does not inspect `.loopx/` or perform any discovery — except when `-h` / `--help` is present, which triggers run help instead.
- Within `run`, `-h` / `--help` takes precedence over all other arguments: it exits 0, performs non-fatal script discovery, and does not validate env files, require a script name, or execute a script. Specifically:
  - `loopx run -h foo` — shows run help (script name ignored).
  - `loopx run -h -e missing.env` — shows run help (env file not validated).
  - `loopx run -h -n bad` — shows run help (`-n` not validated).
- Top-level `-h` takes precedence over everything that follows: `loopx -h run foo` shows top-level help (no discovery), not run help.

### 6. Programmatic API

`scriptName` becomes a required parameter:

```typescript
run(scriptName: string, options?: RunOptions): AsyncGenerator<Output>
runPromise(scriptName: string, options?: RunOptions): Promise<Output[]>
```

In TypeScript, omitting `scriptName` is a static type error. In JavaScript, or when the type check is bypassed (e.g., `run(undefined as any)`), the existing lazy error behavior is preserved: `run()` still returns a generator without throwing, and the error is raised on first iteration (first `next()` call). `runPromise()` rejects in the normal async path. This is consistent with the current SPEC's error timing semantics (section 9.1).

## Consequences

- Scripts named after built-in commands are now possible, eliminating a class of user-facing restrictions. Discovery and installation no longer reject these names.
- The CLI structure is more conventional — clear separation between subcommands and user scripts. No ambiguity between subcommands and script names.
- The `default` script concept is removed, making invocation always explicit.
- Existing `loopx myscript` invocations must migrate to `loopx run myscript`.
- Users relying on `loopx` (no arguments) to run a `default` script must switch to `loopx run default`.
- The programmatic API has a breaking change: `scriptName` goes from optional to required.
- Adding new built-in subcommands in the future cannot break existing scripts, since `loopx run <name>` is always unambiguous.

## Affected SPEC Sections

When this ADR is accepted, the following SPEC sections require updates. This list is intended to make the SPEC update mechanical rather than interpretive.

- **2.2 (Loop)** — Remove "or the `default` script" from the definition of starting target. The starting target is always an explicitly named script.
- **4.1–4.3 (CLI Interface)** — New CLI grammar with `run` subcommand. `loopx [options] [script-name]` becomes `loopx run [options] <script-name>` as the only invocation form. Remove default script fallback. Add `run` to the subcommands table. Unrecognized subcommands are usage errors.
- **4.2 (Options)** — `-n` and `-e` become `run`-scoped options, not top-level. The only top-level option is `-h` / `--help`. Flag precedence text must be rewritten to reflect the two-level structure (top-level help vs. run help).
- **5.3 (Reserved Names)** — Remove entirely. Scripts may now use any name that passes name restriction rules.
- **5.5 (Validation Scope)** — Update the table with new command forms: `loopx run <script>`, `loopx run -h`, and `loopx` (no arguments) as equivalent to `loopx -h`. Top-level `loopx -h` no longer performs discovery.
- **7.1 / 7.2 (Loop Execution Flow)** — Starting target is always explicit (no `default` fallback). Remove reserved-name validation from step 1. Add error case for missing script name.
- **9.1 / 9.2 (Programmatic API)** — `run(scriptName?: string)` and `runPromise(scriptName?: string)` become required-name APIs: `run(scriptName: string)` and `runPromise(scriptName: string)`. Lazy error behavior preserved for type-bypassed calls. Wording distinguishes TypeScript (static type error) from JavaScript (runtime error).
- **10.3 (Install Common Rules)** — Remove validation against reserved names. Install should still validate against name restrictions (section 5.4).
- **11 (Help)** — Split help behavior: top-level help shows CLI structure only (no script discovery); `loopx run -h` performs discovery and lists scripts with non-fatal validation.
- **12 (Exit Codes)** — Update examples to reflect that `loopx run` with no script name and bare `loopx foo` are usage errors (exit code 1).
- **13 (Summary of Reserved and Special Values)** — Remove reserved script name rows (`output`, `env`, `install`, `version`). Remove `default` as a special script name.

## Test Recommendations

- Verify `loopx run myscript` executes the correct script.
- Verify `loopx run version` runs a script named `version` (not the built-in).
- Verify `loopx run` with no script name is an error (exit code 1).
- Verify `loopx` with no arguments shows top-level help.
- Verify `loopx run -h` shows discovered scripts.
- Verify `loopx run run` executes a script named `run`.
- Verify script names previously reserved (`output`, `env`, `install`, `version`) now pass discovery validation.
- Verify programmatic API rejects calls without `scriptName`.
- Verify `loopx myscript` is a usage error (unrecognized subcommand, no implicit `run` fallback).
- Verify `loopx -h` does not inspect `.loopx/` or list scripts.
- Verify `loopx run -h` performs script discovery and lists available scripts.
- Verify programmatic `run(undefined as any)` returns a generator that throws on first iteration (lazy error).
- Verify `loopx -n 5 myscript` is a usage error (top-level `-n` rejected).
- Verify `loopx -e .env myscript` is a usage error (top-level `-e` rejected).
- Verify `loopx run -h foo` shows run help and exits 0 (script name ignored).
- Verify `loopx run -h -e missing.env` shows run help and exits 0 (env file not validated).
- Verify `loopx -h run foo` shows top-level help and exits 0 (not run help).
- Verify `loopx run` with no script name exits 1 without inspecting `.loopx/`.
