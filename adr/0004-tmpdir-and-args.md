# ADR-0004: Run-Scoped Temporary Directory and Script Arguments

**Status:** Proposed

---

## Context

As workflows in `.loopx/` have accumulated (`ralph`, `review-adr`, `apply-adr`, `spec-test-adr`), two recurring pain points have emerged:

1. **Passing intermediate data between scripts during a loop run.** `review-adr`, `apply-adr`, and `spec-test-adr` stash hand-off files like `.feedback.tmp`, `.claude-output.tmp`, `.answer.tmp`, and `.prompt.tmp` directly inside their workflow directories. Each script deletes files it consumes via `rm -f` along the happy path. There is no cleanup on script error, SIGINT/SIGTERM, or unexpected termination, so leaked files accumulate in the workflow directory — where they are indistinguishable from legitimate workflow content. The `ralph` workflow has a related issue: it maintains an iteration counter at `.loopx/.iteration.tmp` by hand, with cleanup only in the success branch. That counter is intra-run state — it carries no meaning across separate `loopx run` invocations — and has been leaking into the workflow directory because there is no per-run scratch space to hold it.

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

- **Created:** once per `loopx run` invocation, immediately before the first iteration's child process is spawned. Errors that occur before the first child process is spawned — including discovery errors, starting-target resolution failures, env-file loading failures, and `-n 0` / `maxIterations: 0` — do not create a `LOOPX_TMPDIR`, and no cleanup is needed for these cases.
- **Shared:** a single directory serves the entire run. All scripts — the starting target, scripts reached via intra-workflow `goto`, scripts reached via cross-workflow `goto`, and re-executions of the starting target on loop reset — observe the same `LOOPX_TMPDIR` value.
- **Persisted within the run:** the directory is not cleared between iterations. Files written by one script remain visible to subsequent scripts for the remainder of the run.
- **Removed when the loop ends**, in all of the following cases:
  - Normal completion via `stop: true`.
  - Normal completion via `-n` / `maxIterations` reached.
  - Error exit: non-zero script exit, invalid `goto` target, missing workflow or script in a `goto` resolution.
  - SIGINT / SIGTERM: cleanup runs after the active child process group has exited (per the grace period in SPEC §7.3) and before loopx itself exits with the signal's exit code.
  - Programmatic `AbortSignal` abort: if a child process group is active, loopx first terminates it using the cancellation behavior defined in SPEC §9.1; cleanup runs only after the child process group has exited or been killed, and before the generator throws or the promise rejects.
  - Programmatic consumer-driven cancellation (`break` out of a `for await`, `generator.return()`): if a child process group is active, loopx first terminates it using the cancellation behavior defined in SPEC §9.1; cleanup runs only after the child process group has exited or been killed, and before the generator completes.
- **Cleanup failure:** if the recursive removal fails (e.g., `EBUSY`, `EACCES`), loopx prints a single warning to stderr and proceeds. The loop's exit code is not changed by a cleanup failure. Under the programmatic API, cleanup failure does not change the generator or promise outcome; the original success, error, or abort result is preserved.
- **SIGKILL to loopx itself, and host crash:** no cleanup is performed. Leaked directories in `os.tmpdir()` are expected to be reaped by OS temp-cleaning policy (e.g., `systemd-tmpfiles`, tmpfs reboot). loopx does not attempt to reap stale tmpdirs at startup. This case is distinct from loopx sending `SIGKILL` to a child process group after the `SIGTERM` grace period (SPEC §7.3): in that case, loopx itself is still alive and performs cleanup after the process group exits.

#### Creation failure

If loopx fails to create or secure the temporary directory (e.g., `mkdtemp` fails with `EACCES`, `ENOSPC`, or `EMFILE`; the mode change to `0700` fails), **no child process is spawned**. Under the CLI, loopx prints an error to stderr and exits with code `1`. Under `run()`, the generator throws on the first iteration; under `runPromise()`, the promise rejects. If a directory was partially created before the failure, loopx attempts best-effort cleanup of the partial directory; if that best-effort cleanup itself fails, loopx prints a single additional warning to stderr but the original creation-failure error is the one surfaced — cleanup-of-partial-directory failure does not mask the tmpdir-creation error and does not change the exit code, thrown error, or promise rejection reason.

Because tmpdir creation is a required runtime facility for all iterations, a creation failure prevents loopx from faithfully executing any accepted spec behavior that depends on `LOOPX_TMPDIR` being present in the script environment. Scripts must not be spawned in a state where that invariant is violated.

Pre-spawn validation failures that precede tmpdir creation (including invalid `RunOptions.args`, invalid `RunOptions.maxIterations`, invalid `target`, discovery errors, starting-target resolution failures, env-file loading failures, and `-n 0` / `maxIterations: 0`) do **not** create a tmpdir, and do not reach the tmpdir-creation step. This is consistent with the "no tmpdir for pre-spawn failures" rule stated under Scope and lifecycle above.

#### Concurrent runs

Each `loopx run` invocation receives its own distinct `LOOPX_TMPDIR`. Two concurrent runs — including two runs of the same workflow — do not share temporary state.

#### Env precedence

`LOOPX_TMPDIR` is a loopx-injected variable and participates in the injection precedence defined in SPEC §8.3: it overrides any value of the same name in the inherited system environment, the global loopx env file, or a local env file (`-e`).

#### `-n 0` behavior

With `-n 0`, no iterations run and no child process is spawned. loopx does not create a `LOOPX_TMPDIR` under `-n 0`, and does not inject the variable into any environment. This is consistent with `-n 0` skipping workflow-level version checks (SPEC §3.2): no runtime work is performed beyond target validation and env loading.

#### Programmatic API

Under `run()` / `runPromise()`, tmpdir creation is lazy: the directory is created immediately before the first iteration's child process is spawned, not when `run()` or `runPromise()` is called. If iteration never begins (e.g., the `AbortSignal` is aborted before the first `next()` call, or the caller never iterates), no tmpdir is created and no cleanup is needed. Once created, the tmpdir is cleaned up when the generator completes (normally, via error, or via consumer-driven cancellation) or when the promise settles.

**Generator cleanup is guaranteed only when the generator is driven to completion, throws, or is explicitly closed.** For `run()`, this includes: normal completion of a `for await` loop, `break` out of a `for await` (which closes the generator via `.return()`), explicit `generator.return()`, explicit `generator.throw()`, an error raised during iteration, and `AbortSignal` abort (which loopx surfaces as a throw from the generator). In each of these cases, cleanup runs before the generator settles.

**Manual abandonment is an exception.** If a caller manually consumes one or more `next()` results and then abandons the generator without calling `.return()` or driving it to completion, the generator is left suspended and cleanup is not reliably observable until the generator is garbage-collected (if ever). This is a limitation of JavaScript async generators, not a behavior loopx can enforce. Callers that consume `run()` via `for await (...)` or who always pair manual `next()` calls with a final `.return()` will observe cleanup as specified; callers that keep references to suspended generators without resuming or closing them may observe a leaked tmpdir. This caveat does not apply to `runPromise()`, which always drives its underlying generator to completion.

### 2. Positional arguments

The `run` subcommand accepts positional arguments after the target. These are forwarded to each script as `argv`.

#### Grammar

```
loopx run [options] <target> [args...]
loopx run [options] <target> -- [args...]
```

#### Parsing algorithm

Run-level CLI parsing is normatively defined by the following two-phase algorithm. The Parsing rules that follow describe derived cases in human-readable form; where the rules and the algorithm appear to conflict, the algorithm is authoritative.

**Phase 1 — help short-circuit scan.** Scan the run-level tokens left-to-right, one token at a time. At each position, apply the first matching rule:

1. **Help trigger.** If the current token is `-h` or `--help`, **run help is triggered**: loopx prints help to stdout and exits with code `0`. This rule always takes precedence, including over any "consume as flag value" intent from a preceding `-n` or `-e`. **A `-h` or `--help` token is never consumed as the value of `-n` or `-e`;** it always triggers help when it is encountered before the first unconsumed `--`.
2. **Value-taking flag.** If the current token is `-n` or `-e`:
   - If the **next** token is `-h` or `--help`, do **not** mark it as a consumed flag value. Advance past only the current token; the next iteration will reach the `-h` / `--help` token and rule §1 will fire.
   - Otherwise, mark the next token (if any) as "consumed as a flag value" and advance past both. If no next token exists, do not raise an error in this phase — Phase 2 will report the missing value.
3. **Unconsumed `--`.** If the current token is `--` and has **not** been marked as a consumed flag value by a preceding `-n` or `-e`, this is the first unconsumed `--` — stop scanning.
4. **Otherwise.** Advance to the next token.

If the scan ends (end of input or first unconsumed `--`) without encountering `-h` or `--help`, proceed to Phase 2.

**Phase 2 — main parse.** Scan left-to-right again. Flag parsing is initially enabled. `-h` and `--help` cannot be encountered in this phase (Phase 1 would have short-circuited).

While flag parsing is enabled:

- `-n` and `-e` consume the immediately following token as their value, regardless of that token's content (including `--`, an arg-looking token, or a would-be target). If no following token exists, this is a usage error (missing flag value).
- A `--` token that is not consumed as a flag value disables flag parsing and is itself discarded (not passed to the script).
- A bare `-` (a single hyphen with no other characters) is treated as a non-flag token (see rule §8 below).
- Any other token that begins with `-` and is not a recognized flag is an unrecognized-flag usage error.
- Any non-flag, non-consumed token is assigned as the target if no target has been consumed yet, otherwise appended to the arg vector.
- If a value-taking flag (`-n`, `-e`) is specified more than once, this is a duplicate-flag usage error.

After flag parsing is disabled, all remaining tokens are appended to the arg vector in order, including tokens beginning with `-`.

If the first unconsumed `--` appears before any target has been consumed (e.g., `loopx run -- 0003`), this is a missing-target usage error.

**Worked examples.** Concrete outcomes that follow from the algorithm:

- `loopx run --unknown -h` → run help, exit `0`. Phase 1 encounters `-h` before Phase 2 ever runs, so `--unknown` is never rejected.
- `loopx run foo -e -h` → run help, exit `0`. Phase 1 does not consume `-h` as `-e`'s value.
- `loopx run foo -e -- -h` → run help, exit `0`. Phase 1: `-e` marks the `--` as a consumed flag value; `-h` is then encountered before any unconsumed `--`, so help triggers.
- `loopx run foo -e -- -- -h` → `-e = "--"`, the second `--` is the separator, `args = ["-h"]`. Phase 1: `-e` marks the first `--` as consumed; the second `--` is the first unconsumed `--` and Phase 1 stops without finding help.
- `loopx run foo -- -h` → `target = foo`, `args = ["-h"]`. No help.
- `loopx run foo -n -- -h` → run help, exit `0`. Phase 1: `-n` marks `--` as consumed; `-h` then triggers help. The parser-time usage error for `-n = "--"` is never reached because help short-circuits first.
- `loopx run foo -n -- 5` → parser-time usage error. Phase 1: `-n` marks `--` as consumed; `5` is neither help nor `--`; scan ends without help. Phase 2: `-n = "--"` fails `-n`'s non-negative-integer validation.
- `loopx run foo -n` → missing-value usage error (Phase 2).
- `loopx run foo -e` → missing-value usage error (Phase 2).
- `loopx run -- 0003` → missing-target usage error (Phase 2: first unconsumed `--` appears before any target).

#### Parsing rules

The following rules restate and summarize the algorithm above; where a rule and the algorithm appear to conflict, the algorithm governs.

1. **Flags may appear anywhere before an explicit `--` separator.** Recognized run-scoped flags (`-n`, `-e`, `-h`, `--help`) are consumed as flags regardless of whether they appear before or after the target. This preserves the current SPEC's "options and the target may appear in any order" rule.
2. **The first non-flag token is the target.** Unchanged from the current SPEC. The target must appear before the first explicit `--`. If `--` appears before any target token (e.g., `loopx run -- 0003`), all following tokens are args, no target is consumed, and the command is a missing-target usage error.
3. **Subsequent non-flag tokens are args.** The current SPEC's "more than one positional argument is a usage error" rule is removed. Tokens after the target that are not recognized run-scoped flags (and not consumed as the value of a run-scoped flag like `-n <count>` or `-e <path>`) are appended to the arg vector in the order they appear.
4. **The `--` separator ends all flag parsing.** Every token after `--` is an arg, including tokens that begin with `-`. The `--` token itself is consumed and not passed to the script. A literal `--` can be passed as an arg by using `--` twice: `loopx run foo -- -- bar` → args = `["--", "bar"]`.
5. **Unrecognized flags before `--` remain usage errors** (exit code 1). To pass a token that begins with `-` as an arg, use `--`: `loopx run foo -- --anything`.
6. **Duplicate run-scoped flags remain usage errors.** `loopx run -n 5 -n 10 foo 0003` is still a usage error for duplicate `-n`, independent of whether args are present.
7. **The `-h` / `--help` short-circuit is preserved, is position-sensitive, and takes precedence over all other run-level parsing.** When `-h` or `--help` appears **before** an explicit, unconsumed `--` separator (at any position), it triggers run help and exits 0, ignoring all other run-level tokens (target, other flags, args, and the would-be values of value-taking flags). The help scan takes precedence over value-taking flag consumption (rule §9): `loopx run foo -e -h`, `loopx run foo -n --help`, and `loopx run foo -e --help` all trigger run help; `-h` / `--help` is **not** bound as the value of `-e` / `-n`. When `-h` or `--help` appears **after** `--`, it is an arg with no special behavior.
8. **Bare `-`** (a single hyphen with no other characters) is a non-flag token. It is treated as the target if no target has been consumed yet, otherwise as an arg. (In practice, `-` fails the workflow/script name restriction pattern and would cause a target-validation error if used as a target.)
9. **Run-scoped flags that take values** (`-n`, `-e`) consume the next token as their value, with one exception: if the next token is `-h` or `--help`, the help short-circuit (rule §7) takes precedence and that token is not consumed as a flag value. Outside that exception, value capture can absorb a would-be arg: `loopx run foo -e 0003` binds `-e = "0003"` (a path that will likely fail env-file loading), not `args = ["0003"]`. To force `0003` as an arg, place it before `-e` or use `--`. A value-taking flag consumes the next token as its value even if that token is `--`: `loopx run foo -n -- 5` binds `-n = "--"`, which then fails `-n`'s non-negative-integer validation as a parser-time usage error. `loopx run foo -e -- bar` binds `-e = "--"`; `--` is consumed as the env-file path, not as the separator, and the path is then validated/loaded like any other `-e` value (a file literally named `--`, if it exists and is a valid env file, would load normally; otherwise the failure surfaces as a runtime env-file error rather than a parser usage error). The `--` token acts as the flag-parsing separator only when it is not consumed as a flag value.

#### Exposure to scripts

Args are passed as real command-line arguments:

- **Bash scripts:** available via `$1`, `$2`, …, `$#`, `$@`, `$*`.
- **JS/TS scripts:** appended to `process.argv` after the script path. `process.argv.slice(2)` returns the arg vector. Behavior is identical under `tsx` and Bun.

#### Propagation

For the CLI, the arg vector is captured when `loopx run` parses its input. For the programmatic API, `RunOptions.args` is snapshotted when `run()` or `runPromise()` is called. The captured vector is immutable for the duration of the run.

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
- **Validation runs regardless of `maxIterations: 0`.** `args` validation is a pre-spawn check: it runs during the same lazy pre-iteration validation step that already rejects invalid `maxIterations`, invalid `target`, and invalid `envFile`. It runs whether or not the loop would actually spawn a child. In particular, `run(target, { maxIterations: 0, args: "nope" as any })` still throws on first iteration and `runPromise(target, { maxIterations: 0, args: [1, 2] as any })` still returns a rejected promise — the options are rejected before the `maxIterations: 0` early return takes effect, and no tmpdir is created.

## Consequences

- **Workflow directories stop accumulating temp files.** Existing workflows can migrate `.feedback.tmp`, `.claude-output.tmp`, `.answer.tmp`, `.prompt.tmp`, and similar hand-off files to `$LOOPX_TMPDIR/feedback`, etc. Manual `rm -f` calls along happy paths can be removed. Workflow directories contain only version-controlled scripts and static assets.
- **Cleanup is automatic on failure.** Loops that abort via signals, error exits, or aborted `AbortSignal` no longer leak temp files. Users who previously relied on lingering `.tmp` files for post-mortem inspection must write those artifacts outside `$LOOPX_TMPDIR` (for example, under `$LOOPX_PROJECT_ROOT`).
- **Cross-run state is the caller's responsibility.** `LOOPX_TMPDIR` never persists across runs. A workflow that genuinely needs cross-run state (e.g., a long-lived counter or cache that must survive across separate `loopx run` invocations) must use `$LOOPX_PROJECT_ROOT`-relative storage. The existing `ralph` `.iteration.tmp` is **not** an example of cross-run state — it is intra-run state that has been leaking into the workflow directory, and it should migrate to `$LOOPX_TMPDIR` (see migration note below).
- **Concurrent runs are safe.** Parallel `loopx run` invocations of the same workflow do not clobber each other's temp files, which was previously possible with in-workflow `.tmp` files.
- **One-off per-input workflows collapse into parameterized ones.** The current per-ADR duplication (`review-adr` implicitly scoped to ADR-0002, etc.) can be replaced by a single parameterized workflow: `loopx run review-adr 0003`. Script authors decide the arg contract.
- **Breaking change: multi-positional is no longer a usage error.** Under the current SPEC, `loopx run foo bar` is a usage error. After this ADR, it is `target = foo, args = ["bar"]`. Tooling that relied on the error case must adapt.
- **Breaking change: `goto` arg propagation.** Scripts reached via `goto` now receive the starting target's arg vector in `argv`. Scripts that previously assumed empty `argv` and accessed `$1` / `process.argv[2]` as sentinels may now see unexpected values. Existing workflows in this repository do not read `argv` and are unaffected.
- **Breaking change: run-scoped flag values can capture would-be args.** `loopx run foo -e 0003` binds `-e = "0003"` and produces `args = []`, not `args = ["0003"]`. This is a natural consequence of "flags anywhere" parsing and matches standard CLI conventions, but authors should prefer flag-first ordering or `--` to avoid ambiguity.
- **No first-class iteration counter.** Workflows that need an iteration counter maintain one themselves in `$LOOPX_TMPDIR/iteration` (or similar). A first-class counter may be introduced in a later ADR if this pattern proves insufficient.
- **Migration of existing workflows is manual but straightforward.** No automated migration tooling is provided. The existing `review-adr`, `apply-adr`, and `spec-test-adr` workflows can be refactored to (a) replace in-workflow `.tmp` paths with `$LOOPX_TMPDIR/…`, (b) remove manual `rm -f` cleanup, and (c) parameterize ADR references via `$1`. The `ralph` workflow's `.loopx/.iteration.tmp` counter is intra-run leaked state and should migrate to `$LOOPX_TMPDIR/iteration` (or similar), allowing its manual cleanup branch to be removed.

## Affected SPEC Sections

When this ADR is accepted, the following SPEC sections require updates:

- **3.2 (Local Version Pinning, `-n 0` behavior)** — Update the `-n 0` paragraph to note that no `LOOPX_TMPDIR` is created and no `LOOPX_TMPDIR` is injected into any environment under `-n 0`, consistent with `-n 0` not entering any workflow for execution.
- **4.1 (Running Scripts)** — Update grammar to `loopx run [options] <target> [args...]` with `--` separator documented. Remove the "more than one positional argument is a usage error" rule. Add the normative two-phase parsing algorithm (§2 above) and the arg parsing rules derived from it, including `--` semantics, flags-anywhere behavior, the rule that the target must appear before the first explicit `--`, and the `-h` / `--help` short-circuit's position-sensitive interaction with `--` (including its precedence over value-taking flag consumption).
- **4.2 (Options)** — Document that the `-h` / `--help` short-circuit applies only to `-h` / `--help` occurrences before an explicit `--`. Clarify that unknown-flag rejection applies only before `--`. Clarify that run-scoped flags with values (`-n`, `-e`) continue to consume the next token, even when that token could otherwise have been an arg, and even when that token is `--` (in which case `--` is consumed as the flag value, not as the separator; any subsequent failure is the flag's own validation or loading failure — parser-time for `-n`, runtime for `-e`). The one exception to value-taking flag consumption is when the next token is `-h` or `--help`: the help short-circuit takes precedence and that token is not consumed as the flag's value.
- **4.3 (Subcommands / `loopx run`)** — Update grammar summary to match §4.1.
- **6.2 (Bash Scripts)** — Note that args are available as `$1`, `$2`, …, `$@`, `$*`.
- **6.3 (JS/TS Scripts)** — Note that args are appended to `process.argv`; `process.argv.slice(2)` is the arg vector. Behavior is identical under `tsx` and Bun.
- **6.7 (Initial Input)** — Clarify that the `argv` arg vector is a separate channel from stdin. The first script invocation still receives empty stdin (unchanged); the arg vector, if any, is always delivered via `argv` regardless of iteration position or stdin state. For clarity, §6.6 (Input Piping) may also be updated to reiterate that `result` piping via stdin on `goto` and `argv` arg delivery are independent mechanisms.
- **7.1 (Basic Loop)** — Add: the arg vector is captured at loop start from CLI positional args (or `RunOptions.args`) and is passed unchanged to every script executed during the run, including scripts reached via `goto` and the starting target on loop reset.
- **7.2 (Error Handling)** — Note that on each error case listed (non-zero script exit, invalid `goto` target, missing workflow / missing script during a `goto` resolution), `LOOPX_TMPDIR` cleanup runs after the error is detected and before loopx exits with code 1. The full lifecycle definition lives in the new §8.4.
- **7.3 (Signal Handling)** — Add: on SIGINT / SIGTERM, `LOOPX_TMPDIR` cleanup runs after the active child process group has exited (which may be immediately, or after the grace period including the `SIGKILL` escalation to the process group if required) and before loopx itself exits with the signal's exit code.
- **8. Environment Variables** — Add a new subsection (e.g., "8.4 Temporary Directory") documenting `LOOPX_TMPDIR`: creation timing (including non-creation for pre-spawn failures), location, mode, scope, lifecycle, cleanup cases, cleanup-failure handling, concurrency, and `-n 0` behavior.
- **8.3 (Injection)** — Add `LOOPX_TMPDIR` to the injected variables table. Note that `LOOPX_TMPDIR` is not injected under `-n 0` or when pre-spawn failures prevent any iteration from starting.
- **9.1 / 9.2 (Programmatic API)** — Document the `args` option and its lazy validation semantics for `run()` and `runPromise()`, including that `args` validation runs during pre-spawn validation regardless of `maxIterations: 0`. Also document `LOOPX_TMPDIR` cleanup behavior under programmatic cancellation: for `AbortSignal` abort and consumer-driven cancellation (`break`, `generator.return()`), if a child process group is active, loopx first terminates it per §9.1's cancellation semantics; cleanup runs after the child process group has exited or been killed and before the generator settles (completes or throws) or the promise settles. Cleanup failure prints a warning to stderr and does not change the generator or promise outcome. Document the manual-abandonment caveat: cleanup is guaranteed only when the generator is driven to completion, throws, or is explicitly closed with `generator.return()` (including `for await` completion and `break` from `for await`); a caller that manually consumes `next()` results and then abandons the generator without calling `.return()` may leave cleanup unobserved. Document tmpdir creation-failure behavior: `run()` throws on first iteration and `runPromise()` rejects; no script is spawned.
- **9.3 (Error Behavior)** — Add: when a `LOOPX_TMPDIR` has been created for the run, cleanup of the tmpdir runs before the generator throws or the promise rejects. The original error is preserved; a tmpdir-cleanup failure produces a single warning on stderr but does not replace or mask the original error's identity or message. When no tmpdir was created (pre-spawn failures, `-n 0` / `maxIterations: 0`, aborted before first iteration), no cleanup is needed and errors are thrown/rejected directly.
- **9.5 (Types)** — Add `args?: string[]` to the `RunOptions` interface. Document the default (no args), non-string/non-array rejection, and call-time snapshotting.
- **11.2 (Run Help)** — Replace the current statement that "`loopx run <target> -h` is equivalent to `loopx run -h`": after this ADR, that equivalence holds only when `-h` or `--help` appears before an explicit `--`. `loopx run foo -- -h` does not trigger run help; `-h` is passed to the script as an arg. Also document that the help short-circuit takes precedence over value-taking flag consumption: `loopx run foo -e -h` shows run help rather than binding `-e = "-h"`. Update the **displayed run-help syntax** shown to users to reflect the new grammar:
  ```
  loopx run [options] <target> [args...]
  loopx run [options] <target> -- [args...]
  ```
  The existing `-n` / `-e` option documentation is unchanged.
- **12 (Exit Codes)** — Remove `loopx run ralph bar` from the list of usage-error examples: after this ADR it parses as `target = ralph, args = ["bar"]` and is no longer a usage error. Add new usage errors introduced by this ADR: `loopx run -- 0003` (missing target) and `loopx run -n -- 5` (value-taking flag consumed `--`, which then fails `-n`'s non-negative-integer validation at parse time). Note: `loopx run -e -- path` is **not** a new parser usage error — `-e = "--"` is a valid string at the parser layer, and the resulting env-file load is handled like any other `-e` value; if the file does not exist or fails to parse it surfaces as the same runtime env-file error that any other `-e` value would produce, not as a usage error.
- **13 (Summary of Reserved and Special Values)** — Add a row for `LOOPX_TMPDIR` env var. Add `--` as a reserved `run`-subcommand separator token.

## Test Recommendations

These highlight edge cases that are easy to overlook. They are not an exhaustive test plan.

### Temporary directory

- Verify the same `LOOPX_TMPDIR` value is observed across the starting target, scripts reached via intra-workflow `goto`, scripts reached via cross-workflow `goto`, and the starting target on loop reset.
- Verify the directory is created with mode `0700`.
- Verify the directory is removed after SIGINT/SIGTERM once the active child process group has exited, including the case where loopx escalates to SIGKILL after the 5-second grace period defined in SPEC §7.3.
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
- Verify a discovery error (e.g., missing `.loopx/` directory) does not create a `LOOPX_TMPDIR`.
- Verify a starting-target resolution failure (e.g., non-existent workflow or missing script) does not create a `LOOPX_TMPDIR`.
- Verify an env-file loading failure (`-e` pointing to a missing or invalid file) does not create a `LOOPX_TMPDIR`.
- Verify cleanup runs after the child process group has exited for programmatic `AbortSignal` abort mid-iteration (i.e., the tmpdir is not removed while a child is still running).
- Verify cleanup runs after the child process group has exited for programmatic consumer-driven cancellation (`break` / `generator.return()`) mid-iteration.
- Verify cleanup failure under the programmatic API prints a warning to stderr but does not change the generator's success/error/abort outcome.
- Verify cleanup failure (simulate via making the tmpdir contents non-removable) prints a warning to stderr but does not change the loop's exit code.
- Verify a workflow's own `node_modules/`, `.loopx/`, or other non-tmpdir state is not affected by cleanup.
- Verify that scripts can write subdirectories, binary files, and Unix sockets/FIFOs under `$LOOPX_TMPDIR` without loopx interference.
- Verify `$LOOPX_TMPDIR` lives under `os.tmpdir()` and its basename begins with `loopx-`.
- Verify that if tmpdir creation fails (simulate `mkdtemp` or mode-chmod failure), no child process is spawned: the CLI exits `1` with a stderr error, `run()` throws on first iteration, and `runPromise()` rejects.
- Verify that a tmpdir-creation failure after a partial directory has been created triggers best-effort cleanup of the partial directory, and that failure of that best-effort cleanup does not mask the original creation error (the surfaced error/exit reflects the creation failure).
- Verify that invalid `RunOptions.args` (non-array, non-string elements) rejects without creating a tmpdir, even when the options would otherwise reach the iteration loop.
- Verify that `run(target, { maxIterations: 0, args: "nope" as any })` rejects on first iteration and `runPromise(target, { maxIterations: 0, args: [1, 2] as any })` returns a rejected promise — args validation runs before the `maxIterations: 0` early return, and no tmpdir is created.
- Verify that a caller that consumes one or more `next()` results and then abandons the generator without calling `.return()` may leave the tmpdir uncleaned (document-only — this is a JS-language limitation, not a loopx guarantee). Verify that the same scenario under `for await` (which calls `.return()` on loop exit, including `break`) always cleans up.

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
- Verify `loopx run foo -n -- 5` binds `-n = "--"` and fails `-n` validation (not a non-negative integer); `--` is consumed as the flag value, not as the separator.
- Verify `loopx run foo -e -- bar` binds `-e = "--"`; `--` is consumed as the env-file path, not as the separator. The resulting env-file load proceeds like any other `-e` value, and any failure surfaces as a runtime env-file error rather than a parser usage error.
- Verify `loopx run foo --unknown` is a usage error.
- Verify `loopx run foo -- --unknown` is not a usage error; args = `["--unknown"]`.
- Verify `loopx run -n 5 -n 10 foo 0003` remains a usage error (duplicate `-n`), regardless of the trailing arg.
- Verify `loopx run -h foo 0003` shows run help and exits 0 (short-circuit; args ignored).
- Verify `loopx run foo -h 0003` shows run help and exits 0.
- Verify `loopx run foo 0003 -h` shows run help and exits 0.
- Verify `loopx run foo -e -h` shows run help and exits 0 (help short-circuit takes precedence over `-e` value consumption; `-e` is **not** bound to `"-h"`).
- Verify `loopx run foo -n --help` shows run help and exits 0 (help short-circuit takes precedence over `-n` value consumption).
- Verify `loopx run foo -e --help` shows run help and exits 0.
- Verify `loopx run foo -- -e -h` does **not** show run help; `args = ["-e", "-h"]` (help short-circuit only applies before `--`).
- Verify `loopx run foo -` sets `target = "foo"`, `args = ["-"]` (bare hyphen after the target is an arg).
- Verify `loopx run -` treats `-` as the target and fails target validation because `-` does not match the name pattern.
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
- Verify `loopx run foo --` (bare `--` with no following args) is valid and produces `target = foo`, `args = []`.
- Verify `loopx run foo -- -n -n` produces `args = ["-n", "-n"]` and does **not** raise a duplicate-`-n` usage error (flags-anywhere does not apply after `--`).
- Verify `loopx run --unknown -h` shows run help and exits `0` (Phase 1 short-circuits before Phase 2 rejects the unknown flag).
- Verify `loopx run foo -e -- -h` shows run help and exits `0` (Phase 1 marks `--` as consumed by `-e`; `-h` triggers help before the first unconsumed `--`).
- Verify `loopx run foo -e -- -- -h` binds `-e = "--"` and produces `args = ["-h"]` (first `--` consumed as `-e` value, second `--` is the separator).
- Verify `loopx run foo -n` is a missing-value usage error.
- Verify `loopx run foo -e` is a missing-value usage error.
