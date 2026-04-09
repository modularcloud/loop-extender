# ADR-0002: Introduce `run` Subcommand and Remove Default Script

**Status:** Proposed

---

## Context

Currently, `loopx [script-name]` is the primary invocation form, and the CLI uses positional argument parsing to distinguish between subcommands (`version`, `output`, `env`, `install`) and script names. This requires a "reserved names" mechanism (section 5.3) that prevents scripts from being named after built-in subcommands. Additionally, when no script name is provided, loopx implicitly runs a `default` script — adding complexity for marginal convenience.

As the CLI grows, the ambiguity between subcommands and script names becomes a maintenance burden. Adding new subcommands requires updating the reserved names list and potentially breaking existing scripts.

## Decision

### 1. Add `run` subcommand

The primary way to execute scripts becomes:

```
loopx run [options] <script-name>
```

The script name is required — there is no default script concept.

Options `-n` and `-e` are scoped to the `run` subcommand:

```
loopx run -n 5 -e .env myscript
loopx run -h
```

### 2. Shorthand (permanent convenience)

If the first non-option argument does not match a built-in command, it is treated as shorthand for `loopx run`:

```
loopx myscript          → loopx run myscript
loopx -n 5 myscript     → loopx run -n 5 myscript
```

Built-in commands that take precedence over the shorthand:

- `run`
- `version`
- `output`
- `env`
- `install`

If a script shares a name with a built-in command, it must be invoked via `loopx run <name>`. This shorthand is a permanent convenience, not a deprecated form.

#### Shorthand parsing rules

The top-level parser only recognizes `-h` / `--help` as its own flags. The flags `-n` and `-e` are run-only flags, accepted before the script name only in shorthand mode (i.e., when the invocation is implicitly resolved to `loopx run`).

Parsing proceeds as follows:

1. Consume any leading `-h` / `--help` → top-level help, exit.
2. Consume any leading run-only flags (`-n <value>`, `-e <path>`).
3. Read the next positional token.
4. If that token matches a built-in command **and** run-only flags were consumed in step 2, it is a **usage error** (e.g., `loopx -n 5 version` is an error, not a request to run a script named `version` five times).
5. If that token matches a built-in command **and** no run-only flags were consumed, dispatch to that built-in.
6. If that token does not match a built-in command, treat the entire invocation as `loopx run [consumed flags] <token> [remaining args]`.
7. If no positional token is present after consuming run-only flags, it is a **usage error** (e.g., `loopx -n 5` with no script name).

This ensures that run-only flags never silently attach to built-in commands, and that missing script names in shorthand mode are caught early.

### 3. Remove the `default` script concept

`default` is no longer a special script name. Running `loopx run` with no script name is an error.

- A script named `default` is still allowed — it is an ordinary script with no special behavior.
- `loopx default` is shorthand for `loopx run default` (since `default` does not conflict with any built-in command).

### 4. Remove reserved script names

Scripts may now use any name that passes the existing name restriction rules (section 5.4). The reserved names list (`output`, `env`, `install`, `version`) is eliminated.

Scripts with those names must be invoked via `loopx run <name>` since the shorthand resolves to the built-in command.

### 5. Help restructuring

- `loopx -h` / `loopx --help`: Top-level help — lists subcommands (`run`, `version`, `output`, `env`, `install`) and general syntax. **Does not inspect `.loopx/` or perform script discovery.**
- `loopx run -h` / `loopx run --help`: Run-specific help — options (`-n`, `-e`) and dynamically discovered scripts in `.loopx/`. This is the only help form that performs script discovery and non-fatal validation (warnings for invalid scripts, missing `.loopx/`, etc.).
- `loopx` (no arguments): Shows top-level help (same as `loopx -h`). No script discovery.

### 6. Programmatic API

`scriptName` becomes a required parameter:

```typescript
run(scriptName: string, options?: RunOptions): AsyncGenerator<Output>
runPromise(scriptName: string, options?: RunOptions): Promise<Output[]>
```

Calling `run()` or `runPromise()` without a script name is a type error (compile time). If the type check is bypassed (e.g., `run(undefined as any)`), the existing lazy error behavior is preserved: `run()` still returns a generator without throwing, and the error is raised on first iteration (first `next()` call). `runPromise()` rejects in the normal async path. This is consistent with the current SPEC's error timing semantics (section 9.1).

## Consequences

- Scripts named after built-in commands are now possible, eliminating a class of user-facing restrictions. Discovery and installation no longer reject these names.
- The CLI structure is more conventional — clear separation between subcommands and user scripts.
- The `default` script concept is removed, making invocation always explicit.
- Existing `loopx myscript` invocations continue to work via the shorthand, so migration impact is low for scripts that don't conflict with built-in names.
- Users relying on `loopx` (no arguments) to run a `default` script must switch to `loopx default` or `loopx run default`.
- The programmatic API has a breaking change: `scriptName` goes from optional to required.
- **Shorthand is not a stability guarantee.** `loopx run <name>` is the future-proof, unambiguous invocation form. Shorthand (`loopx <name>`) is a permanent convenience, but if a future built-in command is added with the same name as an existing script, the built-in will take precedence in shorthand form. The script remains accessible via `loopx run <name>`. Users and tooling that need guaranteed stability should use the explicit `run` form.

## Affected SPEC Sections

When this ADR is accepted, the following SPEC sections require updates. This list is intended to make the SPEC update mechanical rather than interpretive.

- **2.2 (Loop)** — Remove "or the `default` script" from the definition of starting target. The starting target is always an explicitly named script.
- **4.1–4.3 (CLI Interface)** — New CLI grammar with `run` subcommand. `loopx [options] [script-name]` becomes `loopx run [options] <script-name>` as the primary form, with shorthand rules. Remove default script fallback. Add `run` to the subcommands table.
- **5.3 (Reserved Names)** — Remove entirely. Scripts may now use any name that passes name restriction rules.
- **5.5 (Validation Scope)** — Update the table with new command forms: `loopx run <script>`, `loopx run -h`, `loopx <script>` (shorthand). Top-level `loopx -h` no longer performs discovery.
- **7.1 / 7.2 (Loop Execution Flow)** — Starting target is always explicit (no `default` fallback). Add error case for missing script name.
- **9.1 / 9.2 (Programmatic API)** — `run(scriptName?: string)` and `runPromise(scriptName?: string)` become required-name APIs: `run(scriptName: string)` and `runPromise(scriptName: string)`. Lazy error behavior preserved for type-bypassed calls.
- **10.3 (Install Common Rules)** — Remove validation against reserved names. Install should still validate against name restrictions (section 5.4).
- **11 (Help)** — Split help behavior: top-level help shows CLI structure only (no script discovery); `loopx run -h` performs discovery and lists scripts with non-fatal validation.
- **13 (Summary of Reserved and Special Values)** — Remove reserved script name rows (`output`, `env`, `install`, `version`). Remove `default` as a special script name. Add note that `loopx run <name>` is the unambiguous form for scripts sharing names with built-ins.

## Test Recommendations

- Verify `loopx run myscript` executes the correct script.
- Verify shorthand `loopx myscript` works for non-conflicting names.
- Verify shorthand resolves to built-in when name conflicts (e.g., `loopx version` prints version, not a script named `version`).
- Verify `loopx run version` runs a script named `version` (not the built-in).
- Verify `loopx run` with no script name is an error.
- Verify `loopx` with no arguments shows top-level help.
- Verify `loopx run -h` shows discovered scripts.
- Verify `loopx run run` executes a script named `run`.
- Verify script names previously reserved (`output`, `env`, `install`, `version`) now pass discovery validation.
- Verify programmatic API rejects calls without `scriptName`.
- Verify `loopx -n 5 version` is a usage error (run-only flags before a built-in command).
- Verify `loopx -e .env env list` is a usage error.
- Verify `loopx -n 5` (no script name) is a usage error.
- Verify `loopx -e .env` (no script name) is a usage error.
- Verify `loopx -h` does not inspect `.loopx/` or list scripts.
- Verify `loopx run -h` performs script discovery and lists available scripts.
- Verify programmatic `run(undefined as any)` returns a generator that throws on first iteration (lazy error).
