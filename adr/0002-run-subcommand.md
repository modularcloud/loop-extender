# ADR-0002: Introduce `run` Subcommand and Remove Default Script

**Status:** Spec Updated

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

`run` accepts exactly one positional argument, the `<script-name>`:

- The script name is required — there is no default script concept.
- Zero positional arguments (e.g., `loopx run` or `loopx run -n 5`) is a usage error (exit code 1).
- More than one positional argument (e.g., `loopx run foo bar`) is a usage error (exit code 1).

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
- `loopx run -h` / `loopx run --help`: Run-specific help — options (`-n`, `-e`) and dynamically discovered scripts in `.loopx/`. This is the only help form that performs script discovery and non-fatal validation:
  - If `.loopx/` does not exist, run help is still displayed with a warning that the directory was not found. The discovered-scripts section is omitted.
  - If `.loopx/` exists but contains validation issues, run help is displayed with warnings for the problematic entries. All existing non-fatal discovery warnings from the current SPEC (section 5.1) are preserved in this mode — this includes name collisions, name restriction violations, invalid or unreadable `package.json`, missing or non-string `main` field, unsupported `main` extension, `main` path escaping the script directory, and `main` pointing to a nonexistent file.
- `loopx` (no arguments): Shows top-level help (same as `loopx -h`). No script discovery.
- Unrecognized subcommands (e.g., `loopx foo`) are a usage error — there is no implicit fallback to `run`.

### 5. Command parsing and precedence

- The only recognized top-level flag is `-h` / `--help`. Any other flag at top level — including `-n`, `-e`, and any unrecognized flag (e.g., `loopx --unknown`) — is a usage error (exit code 1).
- `loopx` with no arguments is equivalent to `loopx -h`.
- `-n` and `-e` are valid only after `run`. Within `run`, options and `<script-name>` may appear in any order.
- Duplicate `-n` or `-e` within `run` (e.g., `loopx run -n 5 -n 10`) is a usage error (exit code 1), consistent with the current SPEC — unless `-h` / `--help` is present (see below).
- Unrecognized flags within `run` (e.g., `loopx run --unknown myscript`) are usage errors (exit code 1) — unless `-h` / `--help` is present (see below).
- `loopx run` with no `<script-name>` is a usage error (exit code 1) and does not inspect `.loopx/` or perform any discovery — except when `-h` / `--help` is present, which triggers run help instead.
- `loopx run -n 0 <script-name>` is valid: discovery and validation run normally, zero iterations are executed, and the process exits 0. This preserves the current `-n 0` semantics.
- Within `run`, `-h` / `--help` is a full short-circuit: when present, loopx shows run help, exits 0, and ignores all other run-level arguments unconditionally. This means:
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
- Top-level `-h` takes precedence over everything that follows: `loopx -h run foo` shows top-level help (no discovery), not run help.
- Conversely, an unrecognized token in the subcommand position is an error regardless of what follows: `loopx foo -h` is an unrecognized subcommand error (exit code 1), not top-level help. The top-level `-h` short-circuit only applies when `-h` appears before subcommand dispatch (i.e., as the first argument to `loopx`).

### 6. Programmatic API

`scriptName` becomes a required parameter:

```typescript
run(scriptName: string, options?: RunOptions): AsyncGenerator<Output>
runPromise(scriptName: string, options?: RunOptions): Promise<Output[]>
```

In TypeScript, omitting `scriptName` is a static type error. In JavaScript, or when the type check is bypassed, runtime-invalid `scriptName` values (e.g., `undefined`, `null`, `42`, or any non-string) are rejected lazily: `run()` still returns a generator without throwing, and the error is raised on first iteration (first `next()` call). `runPromise(undefined as any)` returns a rejected promise rather than throwing synchronously — the call itself always returns a promise, and the validation error surfaces as a rejection. This is consistent with the current SPEC's error timing semantics (section 9.1).

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
- **5.1 (Discovery)** — Update the discovery timing statement. The current text says discovery runs "during `--help`," which is no longer accurate: discovery now runs only during `loopx run -h`, not during top-level `loopx -h` / `loopx --help`.
- **5.2 (Name Collision)** — Distinguish fatal validation (`loopx run <script>`: refuses to start) from non-fatal validation (`loopx run -h`: collisions are reported as warnings, help is still displayed).
- **5.3 (Reserved Names)** — Remove entirely. Scripts may now use any name that passes name restriction rules.
- **5.4 (Name Restrictions)** — Update the "run mode" vs "help mode" distinction to reference `loopx run <script>` and `loopx run -h` specifically, rather than the generic terms.
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
- Verify `loopx run -h` with no `.loopx/` directory shows run help with a warning (not an error).
- Verify `loopx run -h` with name collisions in `.loopx/` shows run help with warnings for the collisions.
- Verify programmatic `run(undefined as any)` returns a generator that throws on first iteration (lazy error).
- Verify programmatic `runPromise(undefined as any)` returns a rejected promise (not a synchronous throw).
- Verify `loopx -n 5 myscript` is a usage error (top-level `-n` rejected).
- Verify `loopx -e .env myscript` is a usage error (top-level `-e` rejected).
- Verify `loopx run foo bar` is a usage error (more than one positional).
- Verify `loopx run -n 5 -n 10 myscript` is a usage error (duplicate `-n`).
- Verify `loopx run -h foo` shows run help and exits 0 (script name ignored).
- Verify `loopx run -h -e missing.env` shows run help and exits 0 (env file not validated).
- Verify `loopx run -h -n 5 -n 10` shows run help and exits 0 (duplicate `-n` not rejected under help).
- Verify `loopx run -h foo bar` shows run help and exits 0 (extra positional not rejected under help).
- Verify `loopx run -h --unknown` shows run help and exits 0 (unknown flag not rejected under help).
- Verify `loopx -h run foo` shows top-level help and exits 0 (not run help).
- Verify `loopx run` with no script name exits 1 without inspecting `.loopx/`.
- Verify `loopx --unknown` is a usage error (exit code 1).
- Verify `loopx run --unknown myscript` is a usage error (exit code 1).
- Verify `loopx foo -h` is a usage error (unrecognized subcommand, exit code 1 — not top-level help).
- Verify `loopx run myscript -h` shows run help and exits 0 (`-h` after script name triggers help short-circuit).
- Verify `loopx run -h` with a directory script that has an invalid `main` field shows run help with a non-fatal discovery warning (not just collisions/name restrictions).
- Verify `loopx run -n 0 myscript` performs discovery/validation, executes zero iterations, and exits 0.
