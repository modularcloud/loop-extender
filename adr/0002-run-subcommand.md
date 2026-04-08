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

### 3. Remove the `default` script concept

`default` is no longer a special script name. Running `loopx run` with no script name is an error.

- A script named `default` is still allowed — it is an ordinary script with no special behavior.
- `loopx default` is shorthand for `loopx run default` (since `default` does not conflict with any built-in command).

### 4. Remove reserved script names

Scripts may now use any name that passes the existing name restriction rules (section 5.4). The reserved names list (`output`, `env`, `install`, `version`) is eliminated.

Scripts with those names must be invoked via `loopx run <name>` since the shorthand resolves to the built-in command.

### 5. Help restructuring

- `loopx -h` / `loopx --help`: Top-level help — lists subcommands (`run`, `version`, `output`, `env`, `install`) and general syntax.
- `loopx run -h` / `loopx run --help`: Run-specific help — options (`-n`, `-e`) and dynamically discovered scripts in `.loopx/`.
- `loopx` (no arguments): Shows top-level help (same as `loopx -h`).

### 6. Programmatic API

`scriptName` becomes a required parameter:

```typescript
run(scriptName: string, options?: RunOptions): AsyncGenerator<Output>
runPromise(scriptName: string, options?: RunOptions): Promise<Output[]>
```

Calling `run()` or `runPromise()` without a script name is a type error (compile time) and a runtime error if bypassed.

## Consequences

- Scripts named after built-in commands are now possible, eliminating a class of user-facing restrictions.
- The CLI structure is more conventional — clear separation between subcommands and user scripts.
- The `default` script concept is removed, making invocation always explicit.
- Existing `loopx myscript` invocations continue to work via the shorthand, so migration impact is low for scripts that don't conflict with built-in names.
- Users relying on `loopx` (no arguments) to run a `default` script must switch to `loopx default` or `loopx run default`.
- The programmatic API has a breaking change: `scriptName` goes from optional to required.

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
