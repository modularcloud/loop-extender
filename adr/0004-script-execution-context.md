# ADR-0004: Run-Scoped Temporary Directory, Programmatic Env, and Project-Root CWD

**Status:** Proposed

---

## Decision Summary

- **`LOOPX_TMPDIR`.** Each `loopx run` gets a private `os.tmpdir()`-based directory (mode `0700`), injected into every script's env. Shared across iterations, cleaned up on terminal outcomes (normal completion, error exit, signal, abort).
- **`RunOptions.env`.** A new optional `Record<string, string>` field on `RunOptions`, shallow-merged into the child env between env-file loading and loopx protocol variable injection.
- **Project-root cwd.** Every script runs with `LOOPX_PROJECT_ROOT` as its child-process working directory — not the workflow directory. Scripts that need the workflow directory read `$LOOPX_WORKFLOW_DIR` (see next bullet) and remain free to `cd` / `process.chdir()` mid-run. The CLI's project root is the invocation cwd (SPEC §3.2, unchanged); the programmatic API's project root is `RunOptions.cwd` or `process.cwd()` at call time (SPEC §9.5, unchanged). Supersedes SPEC §6.1's current "workflow directory as cwd" rule.
- **`LOOPX_WORKFLOW_DIR`.** A new injected protocol variable holding the absolute path of the currently-spawned script's workflow directory (e.g., `/project/.loopx/review-adr`). Refreshes per-spawn like `LOOPX_WORKFLOW`, so cross-workflow `goto` destinations, intra-workflow `goto` destinations, and loop resets each observe their own containing workflow's directory. Gives scripts a one-token reference to workflow-local assets (`cat "$LOOPX_WORKFLOW_DIR/prompt.md"`) without `$(dirname "$0")` tricks or `dirname(fileURLToPath(import.meta.url))` in JS/TS.
- **No CLI named-argument syntax.** CLI callers who want to pass a per-run value use the standard shell env-var prefix (`key=value loopx run …`), which already flows through loopx's env inheritance. This reuses the existing inherited-environment tier — the lowest user-controlled tier in SPEC §8.3 — and does **not** introduce a new CLI override-precedence level above `-e` or the global env file. `-e` and `loopx env set` remain available for file-based config.
- **Cleanup safety.** Path-based best-effort. loopx never follows symlinks during cleanup. If the tmpdir path was replaced after creation, loopx only recursively removes it when the path still names the originally created directory (matching device/inode). A symlink replacement is unlinked without following its target. Non-symlink file replacements (regular file, FIFO, socket, etc.) and mismatched-identity directory replacements are left in place with a warning. Not a sandbox against actively racing same-user processes.

A later ADR may revisit a first-class CLI named-argument surface, a named-argument schema, or stronger race-resistant cleanup (e.g., `openat` / `unlinkat`) if evidence of need accumulates.

---

## Context

Three pain points have emerged as workflows have grown.

1. **Passing intermediate data between scripts during a loop run.** Workflows like `review-adr`, `apply-adr`, and `spec-test-adr` stash hand-off files (`.feedback.tmp`, `.claude-output.tmp`, `.answer.tmp`, `.prompt.tmp`) either inside their own workflow directory or in a sibling `.loopx/shared/` directory — the latter so scripts reached via cross-workflow `goto` can find them at `$ROOT/.loopx/$LOOPX_WORKFLOW/…` after the goto. Both patterns rely on `rm -f` on the happy path with no cleanup on error, signal, or unexpected termination; leaked files accumulate and are indistinguishable from legitimate workflow content. The `ralph` workflow has the same issue with its hand-maintained `.loopx/.iteration.tmp` counter — intra-run state that has been leaking into the `.loopx/` directory because there is no per-run scratch space to hold it.

2. **Per-run parameterization from programmatic callers.** Callers of `run()` / `runPromise()` currently have no way to inject per-invocation env vars without mutating `process.env` globally, which is racy under concurrent calls. The CLI already handles the parameterization case natively — `adr=0003 loopx run review-adr` works today because `src/env.ts` spreads inherited `process.env` into the child — but the programmatic API has no equivalent.

3. **`$LOOPX_PROJECT_ROOT`-prefix boilerplate in every script.** SPEC §6.1 currently sets each script's cwd to its workflow directory (e.g., `.loopx/review-adr/`), so relative paths in scripts resolve against workflow-local files — almost never what a script wants. Nearly every script in `.loopx/` opens with `ROOT="$LOOPX_PROJECT_ROOT"` and prefixes every reference — `$ROOT/SPEC.md`, `$ROOT/adr/…`, `$ROOT/.loopx/shared/…` — to reach project files. Tools invoked from scripts (`git`, `claude`, `codex`) also want project-root cwd to operate on the whole repo rather than a workflow subdir. Scripts that forget to prefix silently read or write against the workflow directory, producing confusing failures. The §6.1 justification — "ensures relative imports and `node_modules/` resolve naturally" — is inaccurate: Node's ESM resolver, tsx, and Bun all resolve bare specifiers and relative imports from the importing file's directory, not cwd, so changing cwd does not affect module resolution.

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
- **Child launch / spawn failure after tmpdir creation:** the discovered script has been removed or renamed between discovery and spawn (per SPEC §5.1), the OS rejects a `RunOptions.env` entry (malformed name, embedded NUL, etc.), `exec` itself fails, or any other pre-first-line-of-user-code spawn-path error. Cleanup runs before loopx exits with code `1`, the generator throws, or the promise rejects. This applies equally to the starting target and to scripts reached via `goto`.
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
- **Merge position.** `env` entries are merged into the child environment *after* global and local env-file loading and *before* loopx-injected protocol variables (`LOOPX_BIN`, `LOOPX_PROJECT_ROOT`, `LOOPX_WORKFLOW`, `LOOPX_WORKFLOW_DIR`, `LOOPX_TMPDIR`). A `RunOptions.env` entry therefore overrides same-named values from `-e`, the global loopx env file, and inherited `process.env`, and is itself overridden by protocol variables. This slots into the existing merge in `src/execution.ts` between the merged-env layer and the loopx-injected layer.
- **Lifetime.** Entries are captured at call time via `Object.keys(env)` as a shallow copy. Mutating the original object after `run()` / `runPromise()` returns has no effect on the running loop. Any exception raised during this snapshot — for example, a `Proxy` `ownKeys` trap that throws, or a throwing enumerable getter on the supplied object — is captured and surfaced through the standard pre-iteration error path rather than escaping synchronously. `run()` still returns a generator without throwing, and the error is raised on the first `next()`; `runPromise()` still returns a promise and rejects. This preserves SPEC §9.1's guarantee that `run()` never throws at the call site.
- **Applies to every script in the run.** The starting target, `goto` destinations (intra- and cross-workflow), and loop resets to the starting target all receive the same `env` additions.
- **No CLI surface.** `env` is programmatic-only. CLI callers pass per-run values via the shell env prefix (`key=value loopx run …`), which flows through inherited `process.env`, or via `-e` / `loopx env set` for file-based config.
- **No name validation beyond "must be a string-to-string entry."** loopx does not enforce the POSIX `[A-Za-z_][A-Za-z0-9_]*` env-name pattern, does not reject `LOOPX_*` keys, and does not reject NUL-byte values. A key the OS rejects surfaces as a spawn failure; a `LOOPX_*` key that collides with a protocol variable is silently overridden by protocol injection (which runs after `env`).

### 3. Project-root cwd

Every child process loopx spawns for script execution uses `LOOPX_PROJECT_ROOT` as its working directory. This replaces SPEC §6.1's current rule that scripts run with the workflow directory as cwd.

- **CLI.** The CLI's invocation cwd is the project root (SPEC §3.2: "For loopx, the project root is always the invocation cwd"). The spawned script cwd becomes the same path — unchanged from the CLI user's terminal perspective, but different from what the child script observes, which was previously `.loopx/<workflow>/`.
- **Programmatic.** `RunOptions.cwd` (or `process.cwd()` at call time when omitted) specifies both the project root and the script execution cwd. These were previously distinguished: `RunOptions.cwd` set the project root (used for `.loopx/` resolution and `LOOPX_PROJECT_ROOT`) while scripts ran with the workflow directory as cwd. With this change they coincide, and SPEC §9.5's "cwd does not control script execution cwd" disclaimer is dropped.
- **Applies to every script in the run.** The starting target, intra-workflow `goto` destinations, cross-workflow `goto` destinations, and loop resets to the starting target all receive the same cwd. No per-target or per-workflow cwd variation.
- **Scripts remain free to change directory.** A script that needs to run in its own workflow dir (for example, to invoke a workflow-local `npm run …` whose `package.json` sits next to the script) does so with `cd "$LOOPX_WORKFLOW_DIR"` in bash or `process.chdir(process.env.LOOPX_WORKFLOW_DIR)` in JS/TS. Such changes are scoped to that child process and do not propagate to later script spawns — loopx always spawns the next script with project-root cwd regardless.
- **Module resolution is unaffected.** Node's ESM resolver, tsx, and Bun resolve bare specifiers and relative imports from the importing module's file path, not cwd. A workflow with its own `node_modules/loopx` still takes precedence over the CLI-provided resolution because the resolver walks up from the script file, which remains rooted inside the workflow directory regardless of cwd. SPEC §3.3's current claim that closer-`node_modules` precedence is "a natural consequence of running scripts with the workflow directory as cwd" is incorrect and is retired by this ADR.
- **`$LOOPX_PROJECT_ROOT` remains available.** The env var is still injected into every script's environment. Scripts that `cd` elsewhere and later need an absolute-path anchor back to the project root continue to use `$LOOPX_PROJECT_ROOT`. Scripts that never change directory may simply use relative paths like `SPEC.md` or `adr/0004-script-execution-context.md`.
- **`$LOOPX_TMPDIR` interaction.** Scripts writing scratch files have two ergonomic options: `$LOOPX_TMPDIR/…` (preferred for intra-run state; auto-cleaned) or project-root-relative paths (for files that should persist after the run). Previously, project-root-relative writes required the `$LOOPX_PROJECT_ROOT` prefix because relative paths resolved against the workflow dir.
- **Breaking change vs. current SPEC §6.1.** A script that previously relied on cwd to reach workflow-local files (`./helper.sh`, `readFileSync("./config.json")`) now resolves those relative paths against the project root, which almost certainly fails. Migration is by inspection of existing workflow scripts: switch to `"$LOOPX_WORKFLOW_DIR/helper.sh"` (bash) or `resolve(process.env.LOOPX_WORKFLOW_DIR, "config.json")` (JS/TS). This is acceptable at the current pre-1.0 stage; no automated migration tooling is provided.

### 4. `LOOPX_WORKFLOW_DIR` injection

loopx injects `LOOPX_WORKFLOW_DIR` into every script's environment, set to the absolute path of the workflow directory containing the currently-executing script. This is the companion to §3's project-root cwd: scripts reach project files via project-root-relative paths or `$LOOPX_PROJECT_ROOT`, and reach workflow-local assets via `$LOOPX_WORKFLOW_DIR` — no `$(dirname "$0")` or `import.meta.url` gymnastics required.

- **Value.** The absolute path of the workflow's own directory. In v1's layout, this is `"$LOOPX_PROJECT_ROOT/.loopx/$LOOPX_WORKFLOW"`, but the injected form is authoritative; scripts should prefer it over re-deriving the path so they remain stable if loopx's layout evolves.
- **Per-spawn refresh — cross-workflow `goto` semantics.** `LOOPX_WORKFLOW_DIR` tracks the currently-spawned script's containing workflow, not the starting target's workflow. This matches `LOOPX_WORKFLOW` and is the same refresh rule that already applies to `LOOPX_WORKFLOW` per SPEC §8.
  - Starting target spawn: `LOOPX_WORKFLOW_DIR` points at the starting workflow's directory.
  - Intra-workflow `goto` spawn: unchanged (same workflow, same directory).
  - Cross-workflow `goto` spawn: `LOOPX_WORKFLOW_DIR` updates to the destination workflow's directory before the child spawns. The destination script's `$LOOPX_WORKFLOW_DIR` points at its own containing workflow, not the caller's.
  - Deeper chains (A → B → C via successive cross-workflow gotos): each spawn observes its own workflow's directory.
  - Loop reset to the starting target: `LOOPX_WORKFLOW_DIR` restores the starting workflow's directory.
- **Stable across helper files within a single script execution.** A top-level workflow script and a sibling helper it sources or imports both read the same `LOOPX_WORKFLOW_DIR` value, because the env var is injected once per child spawn and inherited by the whole process. This is more robust than `import.meta.url` (which changes per file) or `$0` (which refers only to the top-level script).
- **Symlink behavior — matches discovery-time path.** If a workflow directory is reached through a symlink (SPEC §5 follows symlinks during discovery), `LOOPX_WORKFLOW_DIR` is the symlinked path (`<project>/.loopx/<name>`), not the symlink's realpath target. This keeps `LOOPX_WORKFLOW_DIR` in agreement with `$(dirname "$0")` and with any cross-workflow `goto` target string the user wrote.
- **Reserved — protocol-variable tier.** `LOOPX_WORKFLOW_DIR` joins `LOOPX_BIN`, `LOOPX_PROJECT_ROOT`, `LOOPX_WORKFLOW`, and `LOOPX_TMPDIR` in the top precedence tier of SPEC §8.3. A user-supplied value in inherited env, `-e` local env file, global env file, or `RunOptions.env` is silently overridden by the injected value.
- **Relationship to cross-workflow state.** Scripts that need to hand data across a cross-workflow `goto` continue to use `$LOOPX_TMPDIR` (preferred) or a shared fixed location like `$LOOPX_PROJECT_ROOT/.loopx/shared/…`. `LOOPX_WORKFLOW_DIR` is deliberately not a cross-workflow rendezvous path — a script in workflow B cannot use `$LOOPX_WORKFLOW_DIR` to read a file written by workflow A because it points at B's own directory after the cross-workflow spawn.

## Consequences

- **Workflow directories stop accumulating temp files.** Existing workflows migrate `.feedback.tmp` / `.claude-output.tmp` / `.answer.tmp` / `.prompt.tmp` / `ralph`'s `.iteration.tmp` into `$LOOPX_TMPDIR/…` and drop their manual `rm -f` branches. Workflow directories contain only version-controlled scripts and static assets.
- **Cleanup is automatic on failure.** Loops that error out, are signaled, or are aborted no longer leak scratch files. Callers who relied on lingering `.tmp` files for post-mortem inspection must write those outside `$LOOPX_TMPDIR` (for example, under `$LOOPX_PROJECT_ROOT`).
- **Cross-run state is the caller's responsibility.** `LOOPX_TMPDIR` never persists across runs. A workflow that genuinely needs cross-run state (a long-lived counter, a cache surviving across invocations) uses `$LOOPX_PROJECT_ROOT`-relative storage. `ralph`'s `.iteration.tmp` is **not** an example of cross-run state — it is intra-run state leaking into the workflow directory, and should migrate to `$LOOPX_TMPDIR/iteration`.
- **Concurrent runs are safe.** Parallel `loopx run` invocations of the same workflow do not clobber each other's scratch files, which was previously possible with in-workflow `.tmp` files.
- **Scripts drop `$LOOPX_PROJECT_ROOT`-prefix boilerplate.** Existing workflows can replace `ROOT="$LOOPX_PROJECT_ROOT"; cat "$ROOT/SPEC.md"` with `cat SPEC.md`, and invoke sibling helpers as `.loopx/shared/resolve-adr.sh` instead of `"$ROOT/.loopx/shared/resolve-adr.sh"`. `$LOOPX_PROJECT_ROOT` remains injected for scripts that `cd` elsewhere and need an absolute anchor back, or for scripts constructing paths to hand to tools that don't inherit cwd.
- **Tools invoked from scripts get project-root context by default.** `git`, `claude`, `codex`, and similar tools that use cwd to locate their workspace now operate against the whole project repo without scripts having to `cd` first. Scripts that want workflow-scoped tool behavior `cd "$LOOPX_WORKFLOW_DIR"` explicitly.
- **`RunOptions.cwd` semantics simplify.** Previously, `RunOptions.cwd` specified the project root but explicitly did not control script execution cwd. Now it specifies both. The `RunOptions` type is unchanged; only the documented meaning changes.
- **Workflow-local cwd-relative references break.** Any script currently using `./foo` or `readFileSync("./foo")` to reach a file next to itself now resolves those paths against the project root. Migration is `"$LOOPX_WORKFLOW_DIR/foo"` (bash) or `resolve(process.env.LOOPX_WORKFLOW_DIR, "foo")` (JS/TS). In this repo, no existing workflow script uses this pattern — they all already prefix with `$LOOPX_PROJECT_ROOT` — so migration in-tree is a simplification, not a rewrite.
- **Workflow-local assets reachable in one token.** Workflows with bundled prompt files, schemas, or fixtures next to their scripts (`.loopx/review-adr/prompt.md`, `.loopx/spec-test-adr/schema.json`, etc.) read them as `cat "$LOOPX_WORKFLOW_DIR/prompt.md"` or `readFileSync(resolve(process.env.LOOPX_WORKFLOW_DIR, "schema.json"))`. The `$(dirname "$0")` / `import.meta.url` patterns continue to work but are not required.
- **Programmatic callers get per-run env without mutating `process.env`.** Previously the only way to inject a per-run value programmatically was to mutate `process.env` before calling `run()`, which is racy under concurrent calls. `RunOptions.env` is a clean shallow copy scoped to the call.
- **CLI parameterization uses existing shell idioms.** `adr=0003 loopx run review-adr` works today and continues to work. Users who want override precedence over `-e` or global env for a single CLI invocation use `-e` or `loopx env set` explicitly; loopx does not provide a CLI-level override tier for one-shot values.
- **No named-argument schema.** Workflows do not declare expected input names, types, defaults, or requiredness. Scripts validate their own inputs. A schema mechanism may be introduced in a later ADR if the unchecked-input model proves insufficient.
- **No first-class iteration counter.** Workflows maintain one in `$LOOPX_TMPDIR/iteration` if needed. A first-class counter may be introduced later.
- **Migration is manual but straightforward.** Existing `review-adr`, `apply-adr`, and `spec-test-adr` workflows (1) replace in-workflow `.tmp` paths with `$LOOPX_TMPDIR/…` and drop their `rm -f` cleanup, (2) take their per-run parameter via shell env prefix (e.g., `adr=0003 loopx run review-adr`), and (3) optionally drop the `ROOT="$LOOPX_PROJECT_ROOT"` header and `$ROOT/` prefixes, writing project-root-relative paths directly (e.g., `cat SPEC.md`, `cat adr/0004-script-execution-context.md`). No automated migration tooling is provided.

## Affected SPEC Sections

When this ADR is accepted, the following SPEC sections require updates:

- **§3.2 / §7.1 — Pre-iteration sequence.** Insert `LOOPX_TMPDIR` creation between the starting workflow version check and the first child spawn. Under `-n 0` / `maxIterations: 0`, no tmpdir is created.
- **§3.3 — Module Resolution for Scripts.** Rewrite the sentence "This is a natural consequence of running scripts with the workflow directory as cwd (section 6.1)" to describe the actual mechanism: closer-`node_modules/loopx` wins because Node's ESM resolver, tsx, and Bun all walk up from the importing module's file path (which is rooted inside the workflow directory) to locate `node_modules/`, independent of cwd.
- **§6.1 — Working Directory.** Replace "All scripts run with the workflow directory as their working directory" with "All scripts run with `LOOPX_PROJECT_ROOT` as their working directory". Drop the "ensures relative imports and `node_modules/` resolve naturally" rationale — it is inaccurate, since module resolution is file-relative rather than cwd-relative. Note that scripts remain free to `cd` / `process.chdir()` themselves, that such changes are scoped to the individual child process, and that later script spawns always start at project-root cwd.
- **§7.2 — Error Handling.** On non-zero script exit, invalid / missing `goto` target, or child launch / spawn failure after tmpdir creation (discovered script removed or renamed before spawn per §5.1, OS rejection of a `RunOptions.env` entry, `exec` failure), `LOOPX_TMPDIR` cleanup runs after the error is detected and before loopx exits `1`.
- **§7.3 — Signal Handling.** On SIGINT / SIGTERM, `LOOPX_TMPDIR` cleanup runs after any active child process group has exited (per the existing grace period) and before loopx exits with the signal's code. When no child is active when the signal arrives, cleanup runs immediately. Signals that arrive before tmpdir creation require no cleanup.
- **§8 — Environment Variables.** Add `LOOPX_TMPDIR` and `LOOPX_WORKFLOW_DIR` to the injected-variables table. `LOOPX_WORKFLOW_DIR` is the absolute path of the currently-spawned script's workflow directory and refreshes per-spawn alongside `LOOPX_WORKFLOW` across intra-workflow `goto`, cross-workflow `goto`, and loop reset. Document that `RunOptions.env` merges after env files (global + local) and before loopx-injected protocol variables. Rewrite the §8.3 precedence list (highest wins) to the five tiers:
  1. loopx-injected protocol variables (`LOOPX_BIN`, `LOOPX_PROJECT_ROOT`, `LOOPX_WORKFLOW`, `LOOPX_WORKFLOW_DIR`, `LOOPX_TMPDIR`)
  2. `RunOptions.env`
  3. Local env file (`-e`)
  4. Global loopx env file (`$XDG_CONFIG_HOME/loopx/env`)
  5. Inherited system environment
- **§9.1 / §9.2 — Programmatic API.** Document the new `env` option: its call-time shallow-copy, its merge position, its rejection on invalid shape, and that it is ignored when omitted. Document `LOOPX_TMPDIR` creation timing (lazy — on first `next()` for `run()`, asynchronous after return for `runPromise()`) and cleanup under abort and consumer-driven cancellation.
- **§9.5 — Types.** Add `env?: Record<string, string>` to `RunOptions`. Update the `cwd?: string` prose: `cwd` now specifies both the project root (used for `.loopx/` resolution and `LOOPX_PROJECT_ROOT`) and the script execution cwd. Drop the prior disclaimer that `cwd` does not control script execution cwd.
- **§13 — Reserved Values.** Add `LOOPX_TMPDIR` and `LOOPX_WORKFLOW_DIR` as reserved env var names.

## Test Recommendations

Non-exhaustive — these highlight edge cases that are easy to overlook.

### `LOOPX_TMPDIR`

- `LOOPX_TMPDIR` is injected with an absolute path; its basename begins with `loopx-` and lives under `os.tmpdir()`.
- Same value is observed across the starting target, intra-workflow `goto`, cross-workflow `goto`, and loop reset to the starting target.
- Files written by one script are visible to subsequent scripts in the same run.
- Parallel `loopx run` invocations receive distinct paths and distinct directories.
- Directory mode is `0700`.
- Cleanup runs on each terminal outcome: normal completion (`stop: true` and `maxIterations` reached), non-zero script exit, invalid `goto` target, child launch / spawn failure after tmpdir creation (discovered script removed or renamed before spawn, OS rejection of a `RunOptions.env` entry, `exec` failure), SIGINT/SIGTERM (including between iterations and between tmpdir creation and first spawn), `AbortSignal` abort (including mid-iteration, between iterations, and after the final yield but before `{ done: true }`), `break` from `for await`, explicit `generator.return()` after first `next()`, explicit `generator.throw(err)` after first `next()`.
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
- Snapshot-time exceptions on exotic `env` values (a `Proxy` whose `ownKeys` trap throws, a throwing enumerable getter, etc.) do not escape `run()` / `runPromise()` synchronously — they surface via the standard pre-iteration error path.

### Project-root cwd

- `process.cwd()` inside a starting-target JS/TS script equals `LOOPX_PROJECT_ROOT`.
- `$PWD` (or `pwd`) inside a starting-target bash script equals `LOOPX_PROJECT_ROOT`.
- The same cwd is observed across the starting target, intra-workflow `goto` destinations, cross-workflow `goto` destinations, and loop reset to the starting target.
- A project-root-relative reference like `cat SPEC.md` or `readFileSync("adr/0001-adr-process.md")` resolves successfully from inside a script, with no `$LOOPX_PROJECT_ROOT` prefix required.
- A script that calls `cd /some/other/dir` (bash) or `process.chdir("/some/other/dir")` (JS/TS) does not affect the cwd of the next script in the run: the next spawn still starts at `LOOPX_PROJECT_ROOT`.
- Programmatic: `run("ralph", { cwd: projectDir })` makes `process.cwd()` inside the script equal `projectDir`, and makes `LOOPX_PROJECT_ROOT` equal `projectDir` — the two coincide.
- Programmatic: `run("ralph")` (no `cwd` option) uses `process.cwd()` at call time as both the project root and the script execution cwd. Mutating the caller's cwd after the call does not retroactively change the run's cwd (snapshot at call time, per existing §9.5 semantics).
- Module resolution is independent of cwd: a workflow with its own `node_modules/loopx` still resolves `import "loopx"` to the workflow-local version despite project-root cwd, because the resolver walks up from the script's file path. Mirror of T-INST-GLOBAL-01 that explicitly asserts cwd-vs-resolution independence.
- A script whose source file uses `$(dirname "$0")` (bash) or `fileURLToPath(import.meta.url)` (JS/TS) computes its own workflow directory correctly under project-root cwd, and the computed value equals `LOOPX_WORKFLOW_DIR`.

### `LOOPX_WORKFLOW_DIR`

- `LOOPX_WORKFLOW_DIR` is injected into every script's environment as an absolute path.
- The path exists and is a directory.
- For a top-level workflow script, `LOOPX_WORKFLOW_DIR` equals `$(dirname "$0")` (bash) and equals `dirname(fileURLToPath(import.meta.url))` (JS/TS).
- For the `ralph` workflow under project root `/p`, `LOOPX_WORKFLOW_DIR` equals `/p/.loopx/ralph` in v1's layout.
- **Intra-workflow `goto`:** destination script observes the same `LOOPX_WORKFLOW_DIR` as the caller (same workflow).
- **Cross-workflow `goto` (A → B):** the B-side script observes `LOOPX_WORKFLOW_DIR` pointing at B's directory, not A's. A file written to `$LOOPX_WORKFLOW_DIR/foo` in A is not visible via `$LOOPX_WORKFLOW_DIR/foo` in B — the two paths are different directories.
- **Deep cross-workflow chains (A → B → C):** each spawn observes its own workflow's directory; B's spawn sees B's directory even though it was reached from A, and C's spawn sees C's directory.
- **Loop reset to starting target:** `LOOPX_WORKFLOW_DIR` restores the starting workflow's directory on the re-entry spawn.
- A helper file sourced from bash (`source "$LOOPX_WORKFLOW_DIR/lib/helpers.sh"`) or imported from JS/TS observes the same `LOOPX_WORKFLOW_DIR` as the top-level script that invoked it — the env var is inherited through the child process, not recomputed per source file.
- **Symlinked workflow directory:** a workflow reached via a symlink (`.loopx/foo` → `/elsewhere/foo`) has `LOOPX_WORKFLOW_DIR` equal to `<project>/.loopx/foo`, not `/elsewhere/foo` — the symlinked discovery-time path, matching `$(dirname "$0")` behavior.
- A user-supplied `LOOPX_WORKFLOW_DIR` in inherited env, the `-e` local env file, the global env file, or `RunOptions.env` is overridden by the injected protocol value.
