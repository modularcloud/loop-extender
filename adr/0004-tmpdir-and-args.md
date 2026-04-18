# ADR-0004: Run-Scoped Temporary Directory and Script Arguments

**Status:** Proposed

---

## Context

As workflows in `.loopx/` have accumulated (`ralph`, `review-adr`, `apply-adr`, `spec-test-adr`), two recurring pain points have emerged:

1. **Passing intermediate data between scripts during a loop run.** `review-adr`, `apply-adr`, and `spec-test-adr` stash hand-off files like `.feedback.tmp`, `.claude-output.tmp`, `.answer.tmp`, and `.prompt.tmp` directly inside their workflow directories. Each script deletes files it consumes via `rm -f` along the happy path. There is no cleanup on script error, SIGINT/SIGTERM, or unexpected termination, so leaked files accumulate in the workflow directory — where they are indistinguishable from legitimate workflow content. The `ralph` workflow has a related issue: it maintains `.loopx/.iteration.tmp` by hand and cleans up in the success branch only.

2. **Per-invocation parameterization.** Scripts have no mechanism to receive parameters from `loopx run`. Workflows that need to operate on a specific input (e.g., review ADR-0002 vs. ADR-0003) currently hardcode the input inside the script, forcing the user to edit the script or fork the workflow for each new input. The existing `review-adr`, `apply-adr`, and `spec-test-adr` workflows all hardcode `adr/0001-adr-process.md` and `adr/0002-run-subcommand.md` paths for exactly this reason.

A generic session-state mechanism (e.g., a first-class iteration counter or a key-value store) was considered but intentionally deferred. Scripts that need their own state can maintain it inside the temporary directory introduced by this ADR — including an iteration counter, which is a trivial read/increment/write against a file in `$LOOPX_TMPDIR`. A dedicated state API may be added later if that pattern proves insufficient.

## Decision

Two independent mechanisms, both scoped to a single `loopx run` invocation.

### 1. `LOOPX_TMPDIR` — run-scoped temporary directory

loopx creates a unique temporary directory at the start of each `loopx run` invocation and injects its absolute path into every script's environment as `LOOPX_TMPDIR`.

#### Location and naming

The directory is created under the OS temporary directory (Node's `os.tmpdir()`). The directory name begins with `loopx-` and contains a random component sufficient to guarantee uniqueness across concurrent runs on the same host (e.g., via `mkdtemp`). The full name format beyond the `loopx-` prefix is an implementation detail and must not be relied upon by scripts.

#### Mode

The directory is created with mode `0700` (owner read/write/execute only).

#### Scope and lifecycle

- **Created:** once per `loopx run` invocation, immediately before the first iteration's child process is spawned. The directory is not created if no iteration will execute (see `-n 0` below).
- **Shared:** a single directory serves the entire run. All scripts — the starting target, scripts reached via intra-workflow `goto`, scripts reached via cross-workflow `goto`, and re-executions of the starting target on loop reset — observe the same `LOOPX_TMPDIR` value.
- **Persisted within the run:** the directory is not cleared between iterations. Files written by one script remain visible to subsequent scripts for the remainder of the run.
- **Removed when the loop ends**, in all of the following cases:
  - Normal completion via `stop: true`.
  - Normal completion via `-n` / `maxIterations` reached.
  - Error exit: non-zero script exit, invalid `goto` target, missing workflow or script in a `goto` resolution.
  - SIGINT / SIGTERM: cleanup runs after the active child process group has exited (per the grace period in SPEC §7.3) and before loopx itself exits with the signal's exit code.
  - Programmatic `AbortSignal` abort: cleanup runs before the generator throws or the promise rejects.
  - Programmatic consumer-driven cancellation (`break` out of a `for await`, `generator.return()`): cleanup runs before the generator completes.
- **Cleanup failure:** if the recursive removal fails (e.g., `EBUSY`, `EACCES`), loopx prints a single warning to stderr and proceeds. The loop's exit code is not changed by a cleanup failure.
- **SIGKILL and host crash:** no cleanup is performed. Leaked directories in `os.tmpdir()` are expected to be reaped by OS temp-cleaning policy (e.g., `systemd-tmpfiles`, tmpfs reboot). loopx does not attempt to reap stale tmpdirs at startup.

#### Concurrent runs

Each `loopx run` invocation receives its own distinct `LOOPX_TMPDIR`. Two concurrent runs — including two runs of the same workflow — do not share temporary state.

#### Env precedence

`LOOPX_TMPDIR` is a loopx-injected variable and participates in the injection precedence defined in SPEC §8.3: it overrides any value of the same name in the inherited system environment, the global loopx env file, or a local env file (`-e`).

#### `-n 0` behavior

With `-n 0`, no iterations run and no child process is spawned. loopx does not create a `LOOPX_TMPDIR` under `-n 0`, and does not inject the variable into any environment. This is consistent with `-n 0` skipping workflow-level version checks (SPEC §3.2): no runtime work is performed beyond target validation and env loading.

#### Programmatic API

Under `run()` / `runPromise()`, tmpdir creation is lazy: the directory is created immediately before the first iteration's child process is spawned, not when `run()` or `runPromise()` is called. If iteration never begins (e.g., the `AbortSignal` is aborted before the first `next()` call, or the caller never iterates), no tmpdir is created and no cleanup is needed. Once created, the tmpdir is cleaned up when the generator completes (normally, via error, or via consumer-driven cancellation) or when the promise settles.

### 2. Positional arguments

The `run` subcommand accepts positional arguments after the target. These are forwarded to each script as `argv`.

#### Grammar

```
loopx run [options] <target> [args...]
loopx run [options] <target> -- [args...]
```

#### Parsing rules

1. **Flags may appear anywhere before an explicit `--` separator.** Recognized run-scoped flags (`-n`, `-e`, `-h`, `--help`) are consumed as flags regardless of whether they appear before or after the target. This preserves the current SPEC's "options and the target may appear in any order" rule.
2. **The first non-flag token is the target.** Unchanged from the current SPEC.
3. **Subsequent non-flag tokens are args.** The current SPEC's "more than one positional argument is a usage error" rule is removed. Tokens after the target that are not recognized run-scoped flags (and not consumed as the value of a run-scoped flag like `-n <count>` or `-e <path>`) are appended to the arg vector in the order they appear.
4. **The `--` separator ends all flag parsing.** Every token after `--` is an arg, including tokens that begin with `-`. The `--` token itself is consumed and not passed to the script. A literal `--` can be passed as an arg by using `--` twice: `loopx run foo -- -- bar` → args = `["--", "bar"]`.
5. **Unrecognized flags before `--` remain usage errors** (exit code 1). To pass a token that begins with `-` as an arg, use `--`: `loopx run foo -- --anything`.
6. **Duplicate run-scoped flags remain usage errors.** `loopx run -n 5 -n 10 foo 0003` is still a usage error for duplicate `-n`, independent of whether args are present.
7. **The `-h` / `--help` short-circuit is preserved and is position-sensitive.** When `-h` appears **before** `--` (at any position), it triggers run help and exits 0, ignoring all other run-level tokens (target, other flags, and args). When `-h` appears **after** `--`, it is an arg with no special behavior.
8. **Bare `-`** (a single hyphen with no other characters) is a non-flag token. It is treated as the target if no target has been consumed yet, otherwise as an arg. (In practice, `-` fails the workflow/script name restriction pattern and would cause a target-validation error if used as a target.)
9. **Run-scoped flags that take values** (`-n`, `-e`) consume the next token as their value. This can capture a would-be arg: `loopx run foo -e 0003` binds `-e = "0003"` (a path that will likely fail env-file loading), not `args = ["0003"]`. To force `0003` as an arg, place it before `-e` or use `--`.

#### Exposure to scripts

Args are passed as real command-line arguments:

- **Bash scripts:** available via `$1`, `$2`, …, `$#`, `$@`, `$*`.
- **JS/TS scripts:** appended to `process.argv` after the script path. `process.argv.slice(2)` returns the arg vector. Behavior is identical under `tsx` and Bun.

#### Propagation

The arg vector is captured at loop start (when `loopx run` parses its input, or when `RunOptions.args` is snapshotted in the programmatic API) and is immutable for the duration of the run.

- **Starting target:** receives the full arg vector.
- **Scripts reached via `goto`** (intra-workflow or cross-workflow): receive the same arg vector.
- **Loop reset to the starting target:** the starting target receives the same arg vector on each reset.

There is no v1 mechanism for a `goto` to override, append to, or suppress the arg vector. A script that needs to pass different data to a downstream script should use `result` (which is piped via stdin on `goto`) or write to `$LOOPX_TMPDIR`.

#### No declaration or validation

Workflows do not declare expected args in `package.json` or elsewhere. loopx does not enforce required args, types, arity, or defaults. Scripts validate their own args.

#### No environment exposure

Args are exposed only via `argv`. No `LOOPX_ARG_*` environment variables are injected. Scripts that need to propagate args to sub-processes (e.g., `claude`, `codex`) must do so explicitly.

#### Programmatic API

`RunOptions` gains an optional `args` field:

```typescript
interface RunOptions {
  maxIterations?: number;
  envFile?: string;
  signal?: AbortSignal;
  cwd?: string;
  args?: string[];
}
```

- **Omitted, `undefined`, or an empty array:** scripts receive no extra `argv` entries (equivalent to CLI `loopx run <target>` with no positional args).
- **Type:** `string[]`. Non-array values and arrays containing non-string elements are validation errors, surfaced lazily per SPEC §9.1 (on first iteration for `run()`, as a rejection for `runPromise()`).
- **Snapshotting:** the `args` array is snapshotted at call time, consistent with how other `RunOptions` fields are captured. Mutating the array after `run()` returns does not affect the running loop.

## Consequences

- **Workflow directories stop accumulating temp files.** Existing workflows can migrate `.feedback.tmp`, `.claude-output.tmp`, `.answer.tmp`, `.prompt.tmp`, and similar hand-off files to `$LOOPX_TMPDIR/feedback`, etc. Manual `rm -f` calls along happy paths can be removed. Workflow directories contain only version-controlled scripts and static assets.
- **Cleanup is automatic on failure.** Loops that abort via signals, error exits, or aborted `AbortSignal` no longer leak temp files. Users who previously relied on lingering `.tmp` files for post-mortem inspection must write those artifacts outside `$LOOPX_TMPDIR` (for example, under `$LOOPX_PROJECT_ROOT`).
- **Cross-run state is the caller's responsibility.** `LOOPX_TMPDIR` never persists across runs. A workflow that needs cross-run state (e.g., the existing `ralph` `.iteration.tmp` pattern) must use `$LOOPX_PROJECT_ROOT`-relative storage. That pattern continues to work unchanged.
- **Concurrent runs are safe.** Parallel `loopx run` invocations of the same workflow do not clobber each other's temp files, which was previously possible with in-workflow `.tmp` files.
- **One-off per-input workflows collapse into parameterized ones.** The current per-ADR duplication (`review-adr` implicitly scoped to ADR-0002, etc.) can be replaced by a single parameterized workflow: `loopx run review-adr 0003`. Script authors decide the arg contract.
- **Breaking change: multi-positional is no longer a usage error.** Under the current SPEC, `loopx run foo bar` is a usage error. After this ADR, it is `target = foo, args = ["bar"]`. Tooling that relied on the error case must adapt.
- **Breaking change: `goto` arg propagation.** Scripts reached via `goto` now receive the starting target's arg vector in `argv`. Scripts that previously assumed empty `argv` and accessed `$1` / `process.argv[2]` as sentinels may now see unexpected values. Existing workflows in this repository do not read `argv` and are unaffected.
- **Breaking change: run-scoped flag values can capture would-be args.** `loopx run foo -e 0003` binds `-e = "0003"` and produces `args = []`, not `args = ["0003"]`. This is a natural consequence of "flags anywhere" parsing and matches standard CLI conventions, but authors should prefer flag-first ordering or `--` to avoid ambiguity.
- **No first-class iteration counter.** Workflows that need an iteration counter maintain one themselves in `$LOOPX_TMPDIR/iteration` (or similar). A first-class counter may be introduced in a later ADR if this pattern proves insufficient.
- **Migration of existing workflows is manual but straightforward.** No automated migration tooling is provided. The existing `review-adr`, `apply-adr`, and `spec-test-adr` workflows can be refactored to (a) replace in-workflow `.tmp` paths with `$LOOPX_TMPDIR/…`, (b) remove manual `rm -f` cleanup, and (c) parameterize ADR references via `$1`. The `ralph` workflow can adopt `$LOOPX_TMPDIR` for intra-run state if desired; its cross-run iteration counter is a separate pattern that does not change.

## Affected SPEC Sections

When this ADR is accepted, the following SPEC sections require updates:

- **4.1 (Running Scripts)** — Update grammar to `loopx run [options] <target> [args...]` with `--` separator documented. Remove the "more than one positional argument is a usage error" rule. Add the arg parsing rules (§2 above), including `--` semantics, flags-anywhere behavior, and the `-h` short-circuit's position-sensitive interaction with `--`.
- **4.2 (Options)** — Document that the `-h` / `--help` short-circuit applies only to `-h` occurrences before an explicit `--`. Clarify that unknown-flag rejection applies only before `--`. Clarify that run-scoped flags with values (`-n`, `-e`) continue to consume the next token, even when that token could otherwise have been an arg.
- **4.3 (Subcommands / `loopx run`)** — Update grammar summary to match §4.1.
- **6.2 (Bash Scripts)** — Note that args are available as `$1`, `$2`, …, `$@`, `$*`.
- **6.3 (JS/TS Scripts)** — Note that args are appended to `process.argv`; `process.argv.slice(2)` is the arg vector. Behavior is identical under `tsx` and Bun.
- **7.1 (Basic Loop)** — Add: the arg vector is captured at loop start from CLI positional args (or `RunOptions.args`) and is passed unchanged to every script executed during the run, including scripts reached via `goto` and the starting target on loop reset.
- **8. Environment Variables** — Add a new subsection (e.g., "8.4 Temporary Directory") documenting `LOOPX_TMPDIR`: creation timing, location, mode, scope, lifecycle, cleanup cases, cleanup-failure handling, concurrency, and `-n 0` behavior.
- **8.3 (Injection)** — Add `LOOPX_TMPDIR` to the injected variables table. Note that `LOOPX_TMPDIR` is not injected under `-n 0`.
- **9.1 / 9.2 (Programmatic API)** — Document the `args` option and its lazy validation semantics for `run()` and `runPromise()`.
- **9.5 (Types)** — Add `args?: string[]` to the `RunOptions` interface. Document the default (no args), non-string/non-array rejection, and call-time snapshotting.
- **13 (Summary of Reserved and Special Values)** — Add a row for `LOOPX_TMPDIR` env var. Add `--` as a reserved `run`-subcommand separator token.

## Test Recommendations

These highlight edge cases that are easy to overlook. They are not an exhaustive test plan.

### Temporary directory

- Verify the same `LOOPX_TMPDIR` value is observed across the starting target, scripts reached via intra-workflow `goto`, scripts reached via cross-workflow `goto`, and the starting target on loop reset.
- Verify the directory is created with mode `0700`.
- Verify the directory is removed after SIGINT/SIGTERM, specifically after the 5-second grace period defined in SPEC §7.3.
- Verify the directory is removed after a script exits non-zero.
- Verify the directory is removed after an invalid `goto` target is produced.
- Verify programmatic `break` out of a `for await` triggers cleanup before the generator completes.
- Verify `generator.return()` triggers cleanup.
- Verify aborting the `AbortSignal` mid-iteration triggers cleanup before the generator throws.
- Verify aborting the `AbortSignal` before the first `next()` call does not leave a tmpdir behind (either because none was created or because cleanup ran).
- Verify two concurrent `loopx run` invocations receive distinct `LOOPX_TMPDIR` values and distinct directories.
- Verify a user-supplied `LOOPX_TMPDIR` in the inherited environment is overridden by the injected value.
- Verify a user-supplied `LOOPX_TMPDIR` in the global env file is overridden by the injected value.
- Verify a user-supplied `LOOPX_TMPDIR` in the `-e` local env file is overridden by the injected value.
- Verify under `-n 0`, no tmpdir is created and no child process is spawned (and therefore no `LOOPX_TMPDIR` is observed).
- Verify cleanup failure (simulate via making the tmpdir contents non-removable) prints a warning to stderr but does not change the loop's exit code.
- Verify a workflow's own `node_modules/`, `.loopx/`, or other non-tmpdir state is not affected by cleanup.
- Verify that scripts can write subdirectories, binary files, and Unix sockets/FIFOs under `$LOOPX_TMPDIR` without loopx interference.
- Verify `$LOOPX_TMPDIR` lives under `os.tmpdir()` and its basename begins with `loopx-`.

### Positional arguments

- Verify `loopx run foo 0003` sets `$1 == "0003"`, `$# == 1`.
- Verify `loopx run foo 0003 bar baz` sets `$1 == "0003"`, `$2 == "bar"`, `$3 == "baz"`, `$# == 3`.
- Verify `loopx run foo` (no args) sets `$# == 0`.
- Verify `loopx run foo -- 0003` sets `$1 == "0003"`.
- Verify `loopx run foo -- --not-a-flag` sets `$1 == "--not-a-flag"` and does not error.
- Verify `loopx run foo -- -h` sets `$1 == "-h"` and does **not** trigger the `-h` short-circuit.
- Verify `loopx run foo -- -- bar` sets `$1 == "--"`, `$2 == "bar"` (only the first `--` is consumed as a separator).
- Verify `loopx run -n 5 foo 0003` sets `-n = 5` and `$1 == "0003"`.
- Verify `loopx run foo 0003 -n 5` sets `-n = 5` and `$1 == "0003"` ("flags anywhere" — `-n 5` after the arg is still consumed as a flag).
- Verify `loopx run foo 0003 -- -n 5` sets no `-n` flag and produces `args = ["0003", "-n", "5"]`.
- Verify `loopx run foo -e 0003` binds `-e = "0003"` (and fails if no such env file exists), not `args = ["0003"]`.
- Verify `loopx run foo --unknown` is a usage error.
- Verify `loopx run foo -- --unknown` is not a usage error; args = `["--unknown"]`.
- Verify `loopx run -n 5 -n 10 foo 0003` remains a usage error (duplicate `-n`), regardless of the trailing arg.
- Verify `loopx run -h foo 0003` shows run help and exits 0 (short-circuit; args ignored).
- Verify `loopx run foo -h 0003` shows run help and exits 0.
- Verify `loopx run foo 0003 -h` shows run help and exits 0.
- Verify `loopx run foo -` (bare hyphen) treats `-` as the target and fails target validation because `-` does not match the name pattern.
- Verify `loopx run foo 0003 -` sets `target = foo`, `args = ["0003", "-"]`.
- Verify JS/TS scripts observe args via `process.argv.slice(2)` under both `tsx` and Bun runtimes.
- Verify args are not exposed via any `LOOPX_*` environment variable.
- Verify scripts reached via intra-workflow `goto` receive the same arg vector as the starting target.
- Verify scripts reached via cross-workflow `goto` receive the same arg vector as the starting target.
- Verify loop reset to the starting target passes the same arg vector on each reset.
- Verify programmatic `run(target, { args: ["0003"] })` produces `process.argv.slice(2) == ["0003"]`.
- Verify programmatic `run(target, { args: undefined })` and `run(target, {})` produce empty `process.argv.slice(2)`.
- Verify programmatic `run(target, { args: "nope" as any })` rejects lazily on first iteration.
- Verify programmatic `run(target, { args: [1, 2] as any })` rejects lazily on first iteration (non-string elements).
- Verify programmatic `runPromise(target, { args: "nope" as any })` returns a rejected promise.
- Verify mutating the `args` array after `run()` returns does not affect the running loop (call-time snapshot).
- Verify `loopx run -- 0003` (no target) is a usage error for missing target.
