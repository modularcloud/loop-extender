# ADR-0004: Run-Scoped Temporary Directory and Programmatic Env Option

**Status:** Proposed

---

## Decision Summary

- **`LOOPX_TMPDIR`.** Each `loopx run` gets a private `os.tmpdir()`-based directory (mode `0700`), injected into every script's env. Shared across iterations, cleaned up on terminal outcomes (normal completion, error exit, signal, abort).
- **`RunOptions.env`.** A new optional `Record<string, string>` field on `RunOptions`, shallow-merged into the child env between env-file loading and loopx protocol variable injection.
- **No CLI named-argument syntax.** CLI callers who want to pass a per-run value use the standard shell env-var prefix (`key=value loopx run …`), which already flows through loopx's env inheritance. `-e` and `loopx env set` remain available for file-based config.
- **Cleanup safety.** Path-based best-effort: loopx does not follow symlinks and does not delete files or directories that replaced the tmpdir after creation. Not a sandbox against actively racing same-user processes.

A later ADR may revisit a first-class CLI named-argument surface, a named-argument schema, or stronger race-resistant cleanup (e.g., `openat` / `unlinkat`) if evidence of need accumulates.

---

## Context

Two pain points have emerged as workflows have grown.

1. **Passing intermediate data between scripts during a loop run.** Workflows like `review-adr`, `apply-adr`, and `spec-test-adr` stash hand-off files (`.feedback.tmp`, `.claude-output.tmp`, `.answer.tmp`, `.prompt.tmp`) directly inside their workflow directories, with `rm -f` on the happy path and no cleanup on error, signal, or unexpected termination. Leaked files accumulate and are indistinguishable from legitimate workflow content. The `ralph` workflow has the same issue with its hand-maintained `.loopx/.iteration.tmp` counter — intra-run state that has been leaking into the workflow directory because there is no per-run scratch space to hold it.

2. **Per-run parameterization from programmatic callers.** Callers of `run()` / `runPromise()` currently have no way to inject per-invocation env vars without mutating `process.env` globally, which is racy under concurrent calls. The CLI already handles the parameterization case natively — `adr=0003 loopx run review-adr` works today because `src/env.ts` spreads inherited `process.env` into the child — but the programmatic API has no equivalent.

An earlier draft of this ADR proposed a `loopx run … -- name=value` CLI surface with its own precedence tier and dedicated parser. It is intentionally not adopted: for the identified use case (passing a parameter like an ADR number into a script), shell env-var prefixing on the CLI is already sufficient, and the parser surface would add substantial implementation complexity (two-phase parsing, name grammar, duplicate detection, `LOOPX_*` reservation, precedence tier reordering) without matching value for v1. Scripts that need to validate a required value do so themselves (`: "${adr:?need adr}"` in Bash; `if (!process.env.adr) throw …` in TS).

A generic session-state mechanism (first-class iteration counter, key-value store) was considered but deferred. Scripts that need such state maintain it inside `$LOOPX_TMPDIR` — including the iteration counter, which is a trivial read/increment/write against a file there.

## Decision

### 1. `LOOPX_TMPDIR` — run-scoped temporary directory

For each `loopx run` (CLI) or `run()` / `runPromise()` (programmatic) invocation that reaches execution, loopx creates a unique temporary directory before the first child process spawns and injects its absolute path into every script's environment as `LOOPX_TMPDIR`.

#### Location, naming, and mode

The directory is created under Node's `os.tmpdir()` via `mkdtemp` with a `loopx-` prefix. Mode is `0700` (owner read/write/execute only). The exact name format beyond the prefix is implementation-defined and must not be relied on by scripts.

#### Scope and lifecycle

- **Created:** once per run, after pre-iteration validation (discovery, env loading, target resolution, version check) and immediately before the first child spawns. Pre-spawn failures, `-n 0` / `maxIterations: 0` early exits, and aborts observed before tmpdir creation do not create a tmpdir.
- **Shared across iterations.** All scripts in the run — the starting target, scripts reached via intra-workflow `goto`, scripts reached via cross-workflow `goto`, and re-executions of the starting target on loop reset — observe the same `LOOPX_TMPDIR` value.
- **Persisted within the run.** The directory is not cleared between iterations. Files written by one script remain visible to later scripts in the same run.
- **Concurrent runs are isolated.** Each `loopx run` invocation receives its own distinct directory. Parallel runs of the same workflow do not share temporary state.
- **Not created under `-n 0` / `maxIterations: 0`.** No child process is spawned, so no tmpdir is created and `LOOPX_TMPDIR` is not injected into any environment.

#### Cleanup

loopx runs cleanup of the tmpdir on every terminal outcome of a run that reached tmpdir creation:

- **Normal completion:** `stop: true` from a script, or `-n` / `maxIterations` reached.
- **Error exit:** non-zero script exit, invalid `goto` target, missing workflow or missing script during a `goto` resolution.
- **SIGINT / SIGTERM to loopx:** if a child process group is active, cleanup runs after the process group exits (per SPEC §7.3, including `SIGKILL` escalation to the process group if required) and before loopx exits with the signal's exit code. If no child is active when the signal arrives (including the window after tmpdir creation but before the first child spawns, and the window between one child exiting and the next spawning), cleanup runs immediately.
- **Programmatic `AbortSignal` abort:** if a child process group is active, loopx first terminates it per SPEC §9.1; cleanup runs after the process group exits, before the generator throws or the promise rejects. If the abort fires while no child is active, cleanup runs eagerly from loopx's signal listener and the next generator interaction (or the outstanding `runPromise()` promise) settles with the abort error as soon as cleanup completes.
- **Consumer-driven cancellation under `run()`** (`break` from `for await`, explicit `generator.return()`, explicit `generator.throw(err)` after the first `next()`): loopx terminates any active child per SPEC §9.1, runs cleanup, then settles the generator (`{ done: true }` for `break` / `.return()`; throws `err` for `.throw(err)`).

Cleanup does **not** run when loopx itself is killed via SIGKILL or the host crashes; leaked tmpdirs are expected to be reaped by OS temp-cleaning policy (`systemd-tmpfiles`, tmpfs reboot). loopx does not attempt to reap stale tmpdirs at startup.

If cleanup fails, loopx prints a single warning to stderr. The CLI exit code, generator outcome, and promise rejection reason are unchanged.

#### Cleanup safety

Cleanup is path-based and best-effort — not a sandbox against actively racing same-user processes. loopx captures the created directory's device/inode pair at creation time, before any child is exposed to the directory. At cleanup time loopx `lstat`s the `LOOPX_TMPDIR` path and dispatches:

1. **Path no longer exists:** no-op.
2. **Path is a symlink:** unlink the symlink entry; do not traverse or follow the target. Unlinking a symlink affects only the symlink entry itself.
3. **Path is a regular file, FIFO, socket, or other non-directory non-symlink:** leave in place with a single stderr warning. Unlinking such replacements is unsafe because a hard link would decrement a shared inode's `nlink`, and data renamed into the path has `nlink == 1` — in both cases `unlink` would mutate unrelated data.
4. **Path is a directory with matching device/inode identity:** recursively remove. Symlink entries encountered during the walk are unlinked but not traversed, so symlinks pointing outside the tmpdir do not collateral-delete their targets.
5. **Path is a directory whose identity does not match the recorded identity:** leave in place with a single stderr warning. loopx does not recursively remove a directory it did not create.

A script that removes or renames its tmpdir during the run defeats automatic cleanup of the moved directory; loopx does not chase renamed tmpdirs.

This guarantee covers script-introduced replacements that are quiescent by the time cleanup begins. It is not a race-resistant guarantee against a same-user process that mutates the path during cleanup itself; a stronger guarantee (fd-relative `openat` / `unlinkat` with `AT_SYMLINK_NOFOLLOW`) is out of scope for v1.

#### Creation failure

If the underlying `mkdtemp`, identity-capture, or mode-securing operation fails (e.g., `EACCES`, `ENOSPC`, `EMFILE`), loopx does not spawn any child. The CLI exits `1` with a stderr error; `run()` throws on the first iteration; `runPromise()` rejects.

If a partial directory exists when the failure is detected, loopx attempts best-effort cleanup of it subject to the safety rules above (recursive cleanup requires a recorded identity; if identity capture itself failed, cleanup is limited to non-traversing actions). Failure of that best-effort cleanup prints an additional stderr warning but does not mask the original creation-failure error.

If a SIGINT/SIGTERM or `AbortSignal` abort arrives concurrently with a creation failure, the signal/abort wins — the creation failure is not surfaced as the terminal outcome — and any partial directory is cleaned up under the same rules.

#### Programmatic API (`run()` / `runPromise()`)

Tmpdir creation is lazy under both APIs. Neither creates a tmpdir at the call site of `run()` or `runPromise()`. The pre-iteration sequence (field validation, discovery, env loading, target resolution, version check) runs on the first `next()` call for `run()` and asynchronously after return for `runPromise()`; tmpdir creation follows that sequence immediately before the first child spawns.

A generator returned by `run()` that is never iterated (no `next()`, no `.return()`, no `.throw()`) performs no pre-iteration work and creates no tmpdir. Pre-first-`next()` `generator.return(value)` or `generator.throw(err)` settles the generator immediately per standard JS async-generator semantics without creating a tmpdir.

Once created, the tmpdir is cleaned up whenever the generator settles terminally or the promise settles. Callers who drive `run()` via `for await (...)` or who use `runPromise()` observe cleanup automatically. Callers who manually consume `next()` and then abandon the generator without calling `.return()` or driving it to completion may leak a tmpdir until the generator is garbage-collected — a JS-language limitation, not a loopx guarantee.

### 2. `RunOptions.env`

`RunOptions` gains an optional `env` field:

```typescript
interface RunOptions {
  maxIterations?: number;
  envFile?: string;
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
}
```

- **Shape.** `env` must be omitted, `undefined`, or a non-null, non-array object whose own enumerable string-keyed entries all have string values. Invalid shapes (null, array, non-object, or an entry with a non-string value) are rejected via the standard pre-iteration error path: `run()` throws on the first `next()`; `runPromise()` rejects. Symbol-keyed, non-enumerable, and inherited properties are ignored — not iterated, not validated, not forwarded.
- **Merge position.** `env` entries are merged into the child environment *after* global and local env-file loading and *before* loopx-injected protocol variables (`LOOPX_BIN`, `LOOPX_PROJECT_ROOT`, `LOOPX_WORKFLOW`, `LOOPX_TMPDIR`). A `RunOptions.env` entry therefore overrides same-named values from `-e`, the global loopx env file, and inherited `process.env`, and is itself overridden by protocol variables. This slots into the existing merge in `src/execution.ts` between the merged-env layer and the loopx-injected layer.
- **Lifetime.** Entries are captured at call time via `Object.keys(env)` as a shallow copy. Mutating the original object after `run()` / `runPromise()` returns has no effect on the running loop.
- **Applies to every script in the run.** The starting target, `goto` destinations (intra- and cross-workflow), and loop resets to the starting target all receive the same `env` additions.
- **No CLI surface.** `env` is programmatic-only. CLI callers pass per-run values via the shell env prefix (`key=value loopx run …`), which flows through inherited `process.env`, or via `-e` / `loopx env set` for file-based config.
- **No name validation beyond "must be a string-to-string entry."** loopx does not enforce the POSIX `[A-Za-z_][A-Za-z0-9_]*` env-name pattern, does not reject `LOOPX_*` keys, and does not reject NUL-byte values. A key the OS rejects surfaces as a spawn failure; a `LOOPX_*` key that collides with a protocol variable is silently overridden by protocol injection (which runs after `env`).

## Consequences

- **Workflow directories stop accumulating temp files.** Existing workflows migrate `.feedback.tmp` / `.claude-output.tmp` / `.answer.tmp` / `.prompt.tmp` / `ralph`'s `.iteration.tmp` into `$LOOPX_TMPDIR/…` and drop their manual `rm -f` branches. Workflow directories contain only version-controlled scripts and static assets.
- **Cleanup is automatic on failure.** Loops that error out, are signaled, or are aborted no longer leak scratch files. Callers who relied on lingering `.tmp` files for post-mortem inspection must write those outside `$LOOPX_TMPDIR` (for example, under `$LOOPX_PROJECT_ROOT`).
- **Cross-run state is the caller's responsibility.** `LOOPX_TMPDIR` never persists across runs. A workflow that genuinely needs cross-run state (a long-lived counter, a cache surviving across invocations) uses `$LOOPX_PROJECT_ROOT`-relative storage. `ralph`'s `.iteration.tmp` is **not** an example of cross-run state — it is intra-run state leaking into the workflow directory, and should migrate to `$LOOPX_TMPDIR/iteration`.
- **Concurrent runs are safe.** Parallel `loopx run` invocations of the same workflow do not clobber each other's scratch files, which was previously possible with in-workflow `.tmp` files.
- **Programmatic callers get per-run env without mutating `process.env`.** Previously the only way to inject a per-run value programmatically was to mutate `process.env` before calling `run()`, which is racy under concurrent calls. `RunOptions.env` is a clean shallow copy scoped to the call.
- **CLI parameterization uses existing shell idioms.** `adr=0003 loopx run review-adr` works today and continues to work. Users who want override precedence over `-e` or global env for a single CLI invocation use `-e` or `loopx env set` explicitly; loopx does not provide a CLI-level override tier for one-shot values.
- **No named-argument schema.** Workflows do not declare expected input names, types, defaults, or requiredness. Scripts validate their own inputs. A schema mechanism may be introduced in a later ADR if the unchecked-input model proves insufficient.
- **No first-class iteration counter.** Workflows maintain one in `$LOOPX_TMPDIR/iteration` if needed. A first-class counter may be introduced later.
- **Migration is manual but straightforward.** Existing `review-adr`, `apply-adr`, and `spec-test-adr` workflows replace in-workflow `.tmp` paths with `$LOOPX_TMPDIR/…`, drop `rm -f` cleanup, and take their per-run parameter via shell env prefix (e.g., `adr=0003 loopx run review-adr`). No automated migration tooling is provided.

## Affected SPEC Sections

When this ADR is accepted, the following SPEC sections require updates:

- **§3.2 / §7.1 — Pre-iteration sequence.** Insert `LOOPX_TMPDIR` creation between the starting workflow version check and the first child spawn. Under `-n 0` / `maxIterations: 0`, no tmpdir is created.
- **§7.2 — Error Handling.** On non-zero script exit or invalid / missing `goto` target, `LOOPX_TMPDIR` cleanup runs after the error is detected and before loopx exits `1`.
- **§7.3 — Signal Handling.** On SIGINT / SIGTERM, `LOOPX_TMPDIR` cleanup runs after any active child process group has exited (per the existing grace period) and before loopx exits with the signal's code. When no child is active when the signal arrives, cleanup runs immediately. Signals that arrive before tmpdir creation require no cleanup.
- **§8 — Environment Variables.** Add `LOOPX_TMPDIR` to the injected-variables table. Document that `RunOptions.env` merges after env files (global + local) and before loopx-injected protocol variables.
- **§9.1 / §9.2 — Programmatic API.** Document the new `env` option: its call-time shallow-copy, its merge position, its rejection on invalid shape, and that it is ignored when omitted. Document `LOOPX_TMPDIR` creation timing (lazy — on first `next()` for `run()`, asynchronous after return for `runPromise()`) and cleanup under abort and consumer-driven cancellation.
- **§9.5 — Types.** Add `env?: Record<string, string>` to `RunOptions`.
- **§13 — Reserved Values.** Add `LOOPX_TMPDIR` as a reserved env var name.

## Test Recommendations

Non-exhaustive — these highlight edge cases that are easy to overlook.

### `LOOPX_TMPDIR`

- `LOOPX_TMPDIR` is injected with an absolute path; its basename begins with `loopx-` and lives under `os.tmpdir()`.
- Same value is observed across the starting target, intra-workflow `goto`, cross-workflow `goto`, and loop reset to the starting target.
- Files written by one script are visible to subsequent scripts in the same run.
- Parallel `loopx run` invocations receive distinct paths and distinct directories.
- Directory mode is `0700`.
- Cleanup runs on each terminal outcome: normal completion (`stop: true` and `maxIterations` reached), non-zero script exit, invalid `goto` target, SIGINT/SIGTERM (including between iterations and between tmpdir creation and first spawn), `AbortSignal` abort (including mid-iteration, between iterations, and after the final yield but before `{ done: true }`), `break` from `for await`, explicit `generator.return()` after first `next()`, explicit `generator.throw(err)` after first `next()`.
- Cleanup of a symlink inside `$LOOPX_TMPDIR` pointing outside: symlink entry is unlinked, target is untouched.
- Cleanup when the tmpdir path has been replaced: symlink replacement is unlinked (target untouched); regular-file / FIFO / socket replacement is left in place with a warning; mismatched-identity directory replacement is left in place with a warning; renamed-away tmpdir is left at its new path without being chased.
- Hard-link safety: a script that creates a hard link at the tmpdir path to unrelated data leaves the link count of the shared inode unchanged after cleanup, and the unrelated target file is untouched.
- Rename-into-path safety: a script that renames an unrelated file into the tmpdir path leaves the file's data intact after cleanup.
- Cleanup failure prints a single stderr warning and does not change the CLI exit code, generator outcome, or promise rejection reason.
- Under `-n 0` / `maxIterations: 0`, no tmpdir is created.
- When pre-spawn validation fails (discovery error, env-file error, target-resolution error) or an `AbortSignal` is already aborted before tmpdir creation, no tmpdir is created.
- When tmpdir creation itself fails after producing a partial directory, best-effort cleanup runs on the partial directory without masking the original creation error.
- A user-supplied `LOOPX_TMPDIR` in inherited env, the `-e` local env file, the global env file, or `RunOptions.env` is overridden by the injected protocol value.

### `RunOptions.env`

- `run(target, { env: { adr: "0003" } })` results in `process.env.adr === "0003"` inside the script, and `$adr == "0003"` in a Bash script.
- Same `env` applied to every iteration, every `goto` destination, and every loop reset.
- Overrides same-named entries from `-e` local env file, global loopx env file, and inherited `process.env`.
- Overridden by loopx protocol variables: `env: { LOOPX_TMPDIR: "/fake" }` is not observable in the child.
- `run(target, { env: undefined })`, `run(target, { env: {} })`, and `run(target, {})` all inject no additional entries.
- Invalid shapes reject on first iteration (for `run()`) or via promise rejection (for `runPromise()`): `env: null`, `env: []`, `env: "nope"`, `env: 42`, `env: { x: 42 }` (non-string value).
- Mutating the original `env` object after `run()` / `runPromise()` returns does not affect the running loop (call-time shallow copy).
- Symbol-keyed, non-enumerable, and inherited properties of `env` are ignored — neither validated nor forwarded.
