# ADR-0005: OpenTelemetry Observability

**Status:** Proposed

---

## Context

loopx runs are long-lived, multi-iteration, multi-workflow processes that wrap agent CLIs (`claude`, `codex`, etc.). Real-world workflows in this repository show the shapes that need to be observable:

- **`ralph`** — a perpetual agent loop. Each iteration spawns `claude -p`, hand-maintains an iteration counter in a tmp file (predates ADR-0004's `LOOPX_TMPDIR`), and notifies Telegram. Iterations have wildly variable wall-clock times depending on what `claude` is doing; today there is no way to plot duration distribution, exit-code rates, or which agent invocations stalled.
- **`review-adr`** / **`apply-adr`** / **`spec-test-adr`** — multi-step pipelines that cross-workflow `goto` into `shared:dispatch`, which fans out to one of four reviewer backends (`telegram`, `codex`, `api`, `batch`) selected by `LOOPX_REVIEWER`. The cross-workflow chain is invisible: there is no single trace tying "I asked review-adr to review ADR 0005" to "the codex backend took 47 seconds and produced this exit code".
- **Long bash chains** that pipe `claude` / `codex` output through helper scripts. Each stage is a black box from a metrics standpoint.
- **Agent-side token usage.** Workflows that call `claude -p`, the OpenAI / Anthropic APIs, etc. need to record per-call input/output token counts for cost and capacity tracking.

The observability gaps that matter:

1. **Wall-clock duration of runs, iterations, and individual scripts.**
2. **`goto` graph realized at runtime** — which transitions actually fired, in what order, across which workflows.
3. **Exit-code and error-rate distributions** — per workflow, per script, per reviewer backend.
4. **Agent-side spans connected to loopx-side spans.** `claude code` already emits OpenTelemetry. Without trace-context propagation, those spans are orphans; with it, a single trace covers loopx + agent end-to-end.
5. **User-defined instrumentation inside scripts** — counters, histograms, custom spans around expensive sub-steps. Today there is no telemetry surface; users would have to bolt on their own SDK in every script.

Two non-goals:

- **Not a logging system.** Stderr is already the human-readable channel and structured-output JSON on stdout is the protocol with the next iteration. Span events cover the cases where structured logs would have helped.
- **Not a metrics-server.** loopx exports OTLP to a user-provided collector; it does not host its own backend.

## Decision

loopx gains optional OpenTelemetry support, **disabled by default**, configured via a dedicated global config file and a new `loopx otel` subcommand namespace. When enabled, loopx emits traces and metrics describing the run, propagates W3C trace context to every spawned script, and exposes a no-op-when-disabled helper API in both the CLI and the `loopx` JS/TS package.

### 1. Global configuration

A new global config file lives at:

```
$XDG_CONFIG_HOME/loopx/otel
```

Fallback to `$HOME/.config/loopx/otel` when `XDG_CONFIG_HOME` is unset. Same `.env` format and parser as the existing global env file (SPEC §8.1) — same key restrictions, same comment / blank-line / quoting rules, same "last occurrence wins" duplicate behavior, same single-line-value constraint, same concurrent-mutation undefinedness.

**File permissions.** `loopx otel enable` / `set` / `disable` / `remove` create or rewrite the file with mode `0600` because it may contain OTLP credentials. When the file already exists, loopx neither chmods nor warns about its current permissions on read; only writes enforce `0600`.

The config is intentionally separate from `$XDG_CONFIG_HOME/loopx/env`:

- **Lifecycle differs.** Otel config is loopx-process-side first (the parent SDK initializes from these values), and only secondarily injected into children.
- **Surface differs.** Otel config has an explicit on/off toggle; the env file does not.
- **Privacy differs.** OTLP credentials should not leak into every script's environment if the user only wants loopx-side instrumentation. Keeping it in a separate file makes the merging-into-children rule explicit and skippable.

Recognized loopx-specific keys:

| Key | Default | Meaning |
|-----|---------|---------|
| `LOOPX_OTEL_ENABLED` | unset (disabled) | `"true"` or `"1"` enables the SDK; any other value (including absent) keeps it disabled. |
| `LOOPX_OTEL_CAPTURE_RESULT` | `"none"` | `"none"`: record only `result` byte length and sha256. `"truncated"`: also record first N bytes. `"full"`: record entire `result` string as a span attribute. Any other value falls back to `"none"` with a stderr warning. |
| `LOOPX_OTEL_CAPTURE_RESULT_TRUNCATE_BYTES` | `"4096"` | Byte cap for `"truncated"` mode. Must parse as a non-negative integer; invalid value falls back to default with a stderr warning. |
| `LOOPX_OTEL_CAPTURE_STDIN` | `"none"` | Same three values applied to script stdin (the `result` piped from the previous iteration). Same fallback rule on invalid value. |
| `LOOPX_OTEL_CAPTURE_STDIN_TRUNCATE_BYTES` | `"4096"` | Byte cap for stdin truncation. Same validation as the result variant. |
| `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS` | `"true"` | Accepted: `"true"` / `"1"` propagate the otel config file's `OTEL_*` and `LOOPX_OTEL_*` keys into child script environments at the new tier defined in §9; `"false"` / `"0"` propagate `TRACEPARENT` / `TRACESTATE` only. Any other value falls back to the default `"true"` with a stderr warning. Trace linkage holds either way. |

Any key matching `OTEL_*` (the SDK's standard env-var namespace) is also recognized, validated by name pattern only (`[A-Za-z_][A-Za-z0-9_]*`), and passed to the SDK and (per §9) to children when propagation is on. loopx does not validate semantic correctness of `OTEL_*` values — that is the SDK's job. Invalid values produce SDK-side warnings on stderr at startup.

**Effective parent-SDK configuration order** (highest precedence wins):

1. **`options.otel`** fields supplied via `RunOptions` (`enabled`, `parentContext`) — apply only for that run; see §11.
2. **Otel config file** keys (`LOOPX_OTEL_ENABLED`, `LOOPX_OTEL_*`, `OTEL_*`) at snapshot time.
3. **Inherited `process.env` `OTEL_*` variables** at snapshot time. Standard SDK env-var behavior: where the file does not specify a key, the SDK reads `process.env` directly.

The shell environment's `LOOPX_OTEL_ENABLED` is **not consulted** for the parent-SDK enable bit. Only the config file's value or `options.otel.enabled` toggles telemetry on. Inherited shell `OTEL_*` are honored for SDK *configuration* (endpoint, headers, sampler, etc.) once telemetry is enabled.

`RunOptions.env` does not configure the parent SDK; its scope is the child script environment (per SPEC §8.3 / §9.5).

**Failure modes and warning gating** (parallel to SPEC §8.1):

The otel config file is consulted in two distinct phases per run, with different warning rules:

1. **Enable-bit resolution** — runs even when the run will end up with telemetry disabled, because resolving the bit requires reading the file. Only one warning may surface from this phase: a single stderr warning when the file is unreadable. `LOOPX_OTEL_ENABLED` value parsing is silent — `"true"` or `"1"` enables, anything else (or absence) disables.
2. **Full file validation** — runs only when the effective enable bit resolves to `true`. Warnings for invalid env-var-name lines, invalid `LOOPX_OTEL_*` values, and SDK-side invalid `OTEL_*` values surface only here; when telemetry remains disabled, the rest of the file is left silent.

Per-mode:

- **File absent:** silent. Effective enable bit is `false` unless overridden by `options.otel.enabled=true`. When overridden, the SDK initializes using whatever `OTEL_*` configuration is reachable from inherited `process.env`; if none, defaults apply (likely no usable endpoint, but conformant).
- **File unreadable:** single stderr warning, treated as if absent. May fire even when telemetry ultimately remains disabled. Permission-denied on the config file is not a fatal error for a default-off feature.
- **Invalid env-var name** in a non-blank, non-comment line: stderr warning *only when telemetry is enabled*; line ignored either way.
- **Invalid `LOOPX_OTEL_*` value:** stderr warning *only when telemetry is enabled*; fallback to the default value in either case.

**Snapshot timing.** The otel config file is read on the same schedule as the inherited `process.env` snapshot (SPEC §8.1, §9.1, §9.2): pre-iteration for the CLI, lazy first-`next()` for `run()`, eager call-site for `runPromise()`. Mid-run mutations are not picked up.

### 2. CLI subcommand: `loopx otel`

A new top-level subcommand. Like `loopx env`, it manages a config namespace; like `loopx output`, it also exposes runtime helpers.

#### Config management

```
loopx otel enable
loopx otel disable
loopx otel set <name> <value>
loopx otel remove <name>
loopx otel list
loopx otel show
loopx otel test
```

- **`loopx otel enable`** — sets `LOOPX_OTEL_ENABLED=true` in the config file. Idempotent. Creates the config file (mode `0600`) and any missing parent directories on first call.
- **`loopx otel disable`** — sets `LOOPX_OTEL_ENABLED=false`. Idempotent. Does not delete other keys.
- **`loopx otel set <name> <value>`** — mirrors `loopx env set`: same name pattern (`[A-Za-z_][A-Za-z0-9_]*`), same value rules (no `\n` / `\r`), same `KEY="<literal value>"` serialization. Accepts any name matching the pattern (no enforcement of `OTEL_*` / `LOOPX_OTEL_*` prefix, consistent with `loopx env set`); unrecognized names are silently retained but ignored at SDK-init time.
- **`loopx otel remove <name>`** — mirrors `loopx env remove`: silent no-op if absent.
- **`loopx otel list`** — mirrors `loopx env list`: one `KEY=VALUE` per line, sorted lexicographically, no output if empty.
- **`loopx otel show`** — human-readable summary: enabled state, effective endpoint, protocol, sampler, service name, capture-result mode, propagate-to-scripts mode, plus a one-line note for any key whose value is non-default. Distinct from `list` in that it shows *effective* / *default-resolved* state, not raw config.
- **`loopx otel test`** — initializes the SDK from current effective config, emits a single `loopx.otel.test` span with attributes (`loopx.version`, `loopx.test_id` UUID), runs a 5-second flush+shutdown, prints `OK <endpoint>` to stdout and exits 0 on success, prints the underlying SDK error to stderr and exits 1 on failure. When otel is disabled in config, prints ``disabled — run `loopx otel enable` first`` to stderr and exits 1. `loopx otel test` is the **one documented exception** to exporter-failure isolation (§10): SDK / exporter errors are surfaced on stderr and reflected in the exit code, since the command exists to verify connectivity. "OK" means "the SDK exported without raising an error", not "the backend has indexed the span".

  The printed `<endpoint>` is `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` if set, otherwise `OTEL_EXPORTER_OTLP_ENDPOINT`, otherwise the SDK's default OTLP traces endpoint. When traces are disabled (`OTEL_TRACES_EXPORTER=none`) but metrics remain enabled, the corresponding metrics endpoint is printed instead. When both traces and metrics exporters are `none`, the literal string `(no exporter)` is printed.

`loopx otel` with no subcommand is a usage error (exit code 1) and prints help. `loopx otel -h` / `--help` shows help and exits 0.

None of the config-management commands require `.loopx/` to exist or are affected by it.

#### Runtime helpers

```
loopx otel span <name> [--attr k=v]... [--status ok|error] -- <command>...
loopx otel counter <name> <value> [--attr k=v]...
loopx otel histogram <name> <value> [--attr k=v]...
```

These are the only CLI helpers in v1. Inline events / attributes / exception-recording on a parent script's span are not exposed as CLI helpers (they would require IPC to the parent loopx process); JS/TS callers can use the in-process programmatic helpers in §3 instead.

**Config-source split.** Config-management commands (`loopx otel enable` / `disable` / `set` / `remove` / `list` / `show` / `test`) read and (where applicable) write the global otel config file. **Runtime helpers (`loopx otel span` / `counter` / `histogram`) ignore the global otel config file entirely** and initialize only from inherited environment. This makes `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS=false` a real privacy boundary: a child whose env was filtered cannot bypass the filter by shelling out to a runtime helper, because the helper has no path to the credentials except through that same filtered env.

- **`loopx otel span <name> ... -- <command>`** — runs `<command>` as a child process. When otel is enabled and a `TRACEPARENT` is present in the helper's environment, the helper initializes its own SDK from inherited `OTEL_*` env vars, starts a span as a child of the `TRACEPARENT` context, sets the new span's context as `TRACEPARENT` in the spawned command's environment, awaits exit, closes the span (status from `--status` if provided, otherwise derived from exit code: 0 → OK, non-zero → ERROR), force-flushes and shuts down the SDK with the same 5-second deadline as the parent (§10), and exits with the same exit code as `<command>`. When otel is disabled or `TRACEPARENT` is absent, the helper `exec`s `<command>` directly with no span overhead and preserves the exit code byte-for-byte.

  Stdin, stdout, and stderr are inherited from the helper's parent unchanged. SIGINT and SIGTERM received by the helper are forwarded to the wrapped command's process group; the helper waits for the command to exit before closing its span and exiting itself.

- **`loopx otel counter <name> <value>`**, **`histogram <name> <value>`** — record a metric data point. Gated only on `LOOPX_OTEL_ENABLED` (no `TRACEPARENT` requirement). When the helper's environment has both `LOOPX_OTEL_ENABLED=true` and reachable `OTEL_*` configuration, it initializes a short-lived SDK, emits the data point, force-flushes, and shuts down. When disabled or unreachable, exit 0 silently. `<value>` must parse as a finite number; malformed value is a usage error (exit code 1) **regardless of enabled state**.

`--attr k=v` may repeat. The `k` portion is validated against `[A-Za-z_][A-Za-z_0-9.]*`; the `v` portion is recorded as a string attribute (no type inference in v1). Unrecognized flags and missing required arguments are usage errors (exit code 1) regardless of enabled state.

`-h` / `--help` for any helper shows helper-specific help and exits 0.

**Token-usage instrumentation pattern.** A bash script that calls an LLM API records per-call token counts via the metric helpers, e.g. `$LOOPX_BIN otel counter "agent.tokens.input" "$INPUT" --attr provider=claude --attr model=opus-4.7`. For per-call distributions use `histogram`. To attach token counts as attributes on a wrapped span instead, use `loopx otel span` with `--attr "tokens.input=$INPUT"` around a no-op or follow-up command. JS/TS callers use `setAttribute` inside `withSpan` (§3) for the same effect in-process.

**Helpers outside a loopx-spawned context.** A user can run `loopx otel span ... -- cmd` from a plain shell. Without an ambient `TRACEPARENT`, the span helper falls through to a direct `exec` of `<command>` (preserving exit code); `counter` / `histogram` still emit if `LOOPX_OTEL_ENABLED=true` and SDK config is reachable.

### 3. Programmatic helpers (JS/TS package)

The `loopx` package gains additional named exports, available regardless of whether the importing code is running inside a loopx-spawned child or a standalone process:

```typescript
import {
  withSpan,
  addEvent,
  setAttribute,
  recordException,
  counter,
  histogram,
  isOtelEnabled,
} from "loopx";

await withSpan("validate-feedback", async (span) => {
  span.setAttribute("adr.number", 5);
  // work...
}, { attributes: { mode: "review" } });

addEvent("ready", { ready_count: 3 });
setAttribute("custom.label", "value");
recordException(err);

counter("agent.tokens.input", 4521, { provider: "claude", model: "opus-4.7" });
histogram("agent.latency_ms", 4521, { provider: "claude" });
```

Signatures:

```typescript
function withSpan<T>(
  name: string,
  fn: (span: Span) => T | Promise<T>,
  opts?: { attributes?: Record<string, string | number | boolean>; kind?: SpanKind },
): T | Promise<T>;

function addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
function setAttribute(key: string, value: string | number | boolean): void;
function recordException(err: unknown, attributes?: Record<string, string | number | boolean>): void;

function counter(name: string, value: number, attributes?: Record<string, string | number | boolean>): void;
function histogram(name: string, value: number, attributes?: Record<string, string | number | boolean>): void;

function isOtelEnabled(): boolean;
```

`Span` and `SpanKind` are minimal local types that mirror the OTel API surface (`setAttribute`, `setAttributes`, `addEvent`, `recordException`, `setStatus`, `end`). They are deliberately not re-exports of `@opentelemetry/api` to keep the helpers no-op-safe even when the OTel package is not installed in the consuming project.

**No-op semantics when otel is disabled or the SDK is uninitialized:**

- `withSpan(name, fn, opts?)` invokes `fn` directly with a stub `Span` whose methods all return synchronously without effect. `fn`'s return value or returned Promise is passed through unchanged. Exceptions propagate unchanged. There is no measurable wall-clock overhead beyond the function call.
- `addEvent`, `setAttribute`, `recordException`, `counter`, `histogram` return synchronously without doing anything.
- `isOtelEnabled()` returns `false`.

**Recording semantics when enabled:**

- `withSpan` parent context is determined by, in order: (1) the innermost in-progress local `withSpan` in the same process, (2) `TRACEPARENT` (and `TRACESTATE`) in `process.env` if no local active span, (3) otherwise root.
- `addEvent`, `setAttribute`, `recordException` operate on **the innermost in-progress local `withSpan` in the same process**. If no local active span exists, they no-op. They cannot mutate spans owned by a different process (e.g., the parent loopx process's `loopx.script.exec` span), since the OTel SDK does not expose a remote-span-mutation surface.
- `counter` / `histogram` use the SDK's meter; metric instruments are lazily created and cached by instrument name within the process meter (standard OTel behavior). Different attribute sets recorded against the same name share one instrument.
- `isOtelEnabled()` returns `true` when the process-wide SDK has been initialized in this process. It does not reflect per-run gating: a process whose SDK was initialized by an earlier or concurrent run continues to return `true` even while a specific run has telemetry suppressed via `options.otel.enabled=false`. Per-run gating (§11) governs whether loopx emits its own `loopx.*` spans for that run; user-side `withSpan` / `counter` / `histogram` calls in the same process continue to record against the shared SDK regardless.

**`withSpan` lifecycle and error handling (when enabled):**

- The span starts before `fn` is invoked and ends once `fn`'s return value settles. For a synchronous return, the span ends synchronously after `fn` returns. For a returned Promise, the span ends when the Promise settles (resolves or rejects). `withSpan` returns the same Promise identity (no wrapping or `.then`-chained replacement); a caller using `Promise.race` or identity checks observes the original Promise object.
- When `fn` throws synchronously or its returned Promise rejects, `withSpan` automatically calls `recordException(err)` on the span and sets the span status to `ERROR` (with `description` set to the error's `message` when one is available) before ending the span. The thrown / rejected value then propagates unchanged to the caller. An explicit `setStatus` call inside `fn` is preserved — automatic ERROR status is applied only when `fn` did not set its own terminal status before throwing.
- A `withSpan` whose `fn` returns a thenable that never settles never ends its span; this matches OTel SDK behavior and is not a leak loopx introduces.

**Interaction with `output()` (child processes).**

When the child-process OTel SDK has been initialized (because the child observed effective `LOOPX_OTEL_ENABLED=true` in its environment) and a script calls `output()` (SPEC §6.4) — which terminates the process via `process.exit(0)` — `output()` `await`s `forceFlush()` followed by `shutdown()` on the child's SDK with a 5-second deadline (matching §10's parent-process deadline) before exiting. This explicit `await` is necessary because Node disallows asynchronous work in `process.on('exit')` hooks; relying on those would lose pending exports. A shutdown timeout in this path produces a single stderr warning per the §10 warning policy and does not affect the exit code.

When the child-process OTel SDK has not been initialized, `output()` behavior is unchanged — there is no flush step and no measurable overhead.

A standalone `flushOtel()` helper is not provided in v1. The natural flush points are span end (`withSpan` returning) and `output()`. Scripts that exit naturally (returning from `main`) rely on `beforeExit`-driven SDK shutdown installed at process-wide SDK init; scripts that emit telemetry and *then* call `output()` rely on the flush-on-exit path described here.

**SDK initialization timing in the JS API:**

- The SDK is **process-wide and idempotent**. It initializes lazily on the first call to any helper *or* the first `run()` / `runPromise()` invocation that observes effective `LOOPX_OTEL_ENABLED=true` (or `options.otel.enabled=true`) in its option-snapshot pass. Once initialized, it persists for the process lifetime; subsequent inits are no-ops regardless of differing config.
- Concurrent `run()` / `runPromise()` invocations in the same process share the SDK and produce distinct `loopx.run` spans distinguished by `loopx.run.id` (§4).
- A process that imports the helpers but never calls them and never runs a loop pays zero startup cost.

### 4. Span model

When otel is enabled, the loopx process emits the following span hierarchy automatically:

```
loopx.run                                            (root span for one invocation)
├── loopx.iteration[1]  target=ralph:index           (kind=INTERNAL)
│   └── loopx.script.exec  workflow=ralph script=index lang=bash
│       └── (any child-side spans created via helpers / agent OTel SDK)
├── loopx.iteration[2]  target=ralph:check-ready     (entry_kind=goto.intra)
│   └── loopx.script.exec
└── ...
```

A `loopx.iteration` span is created per spawn attempt. The 1-based span ordinal counts every spawn (including failed spawns); the close-time `loopx.run.iteration_count` attribute reflects the SPEC §7.1 counter, which only increments after successful output parsing. The two values diverge only when a run ends in spawn failure or non-zero exit before parse — see the `loopx.iteration` section below.

#### `loopx.run`

Created on entry to the iteration phase, **after the entire pre-iteration sequence completes** (discovery, env-file loading, target resolution, starting-workflow version check, tmpdir creation) and immediately before the first child spawn. Closed on terminal outcome. This is the single, normative ordering.

Pre-iteration failures (discovery error, target resolution error, env-file failure, tmpdir-creation failure) occur before SDK initialization and are not represented in OTel; they remain stderr-only per existing SPEC sections. The non-fatal starting-workflow version-mismatch warning (per SPEC §3.2) is also pre-SDK-init and is not represented in OTel — note that this is a warning, not a failure. The `version_mismatch.warning` event applies only to **cross-workflow** version checks fired during iteration (where the SDK is live); it appears on the `loopx.iteration` span — see below.

**Parent context.** When OTel is enabled and a `TRACEPARENT` is present in the loopx process's `process.env` at SDK init that parses as a valid W3C trace-context string, `loopx.run` is created as a child of that inherited context (and inherits `TRACESTATE` if also present). When no inherited `TRACEPARENT` is present or it is malformed, `loopx.run` is a root span. `options.otel.parentContext` (§11), when supplied, takes precedence over inherited `TRACEPARENT`. For `run()` and `runPromise()`, the relevant `process.env.TRACEPARENT` snapshot follows the option-snapshot schedule defined in SPEC §9.1 / §9.2; for the CLI, it is read once during the pre-iteration sequence alongside other inherited-env reads. A malformed inherited `TRACEPARENT` is silently treated as absent (no warning), matching OTel SDK propagator behavior; only an invalid `options.otel.parentContext` surfaces via the pre-iteration error path (§11).

**Attributes:**

| Attribute | Type | When | Notes |
|---|---|---|---|
| `loopx.run.id` | string | open | UUIDv4 unique per run. Distinguishes concurrent runs sharing the same process (where `service.instance.id` is process-wide). |
| `loopx.version` | string | open | running loopx version |
| `loopx.invocation` | string | open | `cli` \| `programmatic.run` \| `programmatic.runPromise` |
| `loopx.starting_target` | string | open | e.g. `"ralph:index"` |
| `loopx.starting_workflow` | string | open | resolved workflow name |
| `loopx.starting_script` | string | open | resolved script name (always set; defaults to `"index"`) |
| `loopx.project_root` | string | open | absolute path; same string as `LOOPX_PROJECT_ROOT` |
| `loopx.max_iterations` | int | open | only if `-n` / `maxIterations` was supplied |
| `loopx.delegated` | bool | open | `true` if running under the post-delegation binary |
| `loopx.iteration_count` | int | close | SPEC §7.1 iteration counter — count of spawns whose stdout was successfully parsed (the value used for `-n` / `maxIterations` accounting). May be one less than the largest `loopx.iteration` ordinal when the final span ended in a spawn failure or non-zero exit. |
| `loopx.exit_code` | int | close | CLI exit code; 0 on normal completion, 1 on most errors, 128+signal on signal exit. Set only when `loopx.invocation = cli`; omitted on programmatic invocations (`run()` / `runPromise()`). |
| `loopx.terminal_outcome` | string | close | `stop` \| `max_iterations` \| `non_zero_exit` \| `invalid_goto` \| `spawn_failure` \| `signal` \| `abort` \| `consumer_cancellation` |

**Events:**

- `signal.received` — attrs: `signal.name` (`SIGINT` \| `SIGTERM`)
- `abort.received` — for programmatic `AbortSignal`
- `loop.reset` — when a target finishes without `goto` and execution returns to the starting target

**Status:** `OK` on `stop` / `max_iterations` / `consumer_cancellation`. `ERROR` with description on every other terminal outcome.

#### `loopx.iteration`

One span per spawn attempt. Parent: `loopx.run`. Created immediately before child spawn — so a spawn that fails to launch (per SPEC §7.2) still produces a `loopx.iteration` span that records the failure. Closed after structured output parsing **and** transition / terminal-decision resolution — that is, after `goto` validation (target syntax, target workflow / script existence in cached discovery), `goto.transition` event emission, or the determination that the iteration ends without a transition (loop reset or terminal `stop` / `maxIterations`). When a failure prevents parsing (non-zero child exit, spawn failure, termination by signal / abort / consumer cancellation), the iteration span closes after that failure is recorded. This ordering is normative: invalid-`goto` errors, missing target workflow / script during goto resolution, and `goto.transition` events all fire on the iteration span before it closes.

**Iteration ordinal vs. SPEC §7.1 iteration counter.** The `loopx.iteration` span attribute is a 1-based ordinal of spawn attempts within the run, incrementing once per `loopx.iteration` span. The close-time `loopx.run.iteration_count` attribute records the SPEC §7.1 counter — the count of spawns whose stdout was successfully parsed (i.e., the value used for `-n` / `maxIterations` accounting). A run that ends in a final spawn failure or non-zero exit before parse will have `loopx.run.iteration_count` one less than the largest `loopx.iteration` ordinal.

**Attributes:**

| Attribute | Type | Notes |
|---|---|---|
| `loopx.iteration` | int | 1-based |
| `loopx.workflow` | string | current workflow |
| `loopx.script` | string | current script |
| `loopx.target` | string | `workflow:script` |
| `loopx.entry_kind` | string | `start` \| `goto.intra` \| `goto.cross` \| `loop.reset` |
| `loopx.previous_target` | string | absent on first iteration; set on goto / loop.reset |
| `loopx.workflow.first_entry` | bool | `true` if this is the first entry into this workflow during the run (per SPEC §3.2 cross-workflow version-check timing) |
| `loopx.output.has_result` | bool | (close-time) |
| `loopx.output.has_goto` | bool | (close-time) |
| `loopx.output.stop` | bool | (close-time) |
| `loopx.output.goto` | string | (close-time) goto target string if present |
| `loopx.output.result.bytes` | int | (close-time) UTF-8 byte length of the parsed `Output.result` string; 0 for empty/absent |
| `loopx.output.result.sha256` | string | (close-time) hex SHA-256 of those UTF-8 bytes; absent when `bytes == 0` |
| `loopx.output.result.preview` | string | (close-time) only when `LOOPX_OTEL_CAPTURE_RESULT=truncated`; first N UTF-8 bytes of the parsed `Output.result`, decoded back to string with replacement on invalid sequences |
| `loopx.output.result` | string | (close-time) only when `LOOPX_OTEL_CAPTURE_RESULT=full`; the full parsed `Output.result` string |
| `loopx.output.parse_kind` | string | `structured` \| `raw` \| `empty` (per SPEC §2.3 parsing rules) |

**Output attributes when output is not parsed.** When the iteration ends before stdout is parsed — non-zero child exit (per SPEC §7.2), spawn failure, or termination by signal / abort / consumer cancellation — **all `loopx.output.*` attributes are omitted**. The pre-spawn attributes (`loopx.iteration`, `loopx.workflow`, `loopx.script`, `loopx.target`, `loopx.entry_kind`, `loopx.previous_target`, `loopx.workflow.first_entry`) remain set.

**Events:**

- `goto.transition` — emitted just before transitioning. Attrs: `goto.target`, `goto.kind` (`intra` \| `cross`), `goto.from_target`.
- `output.parse_warning` — emitted when stdout was a JSON object that contained no known fields and was therefore treated as raw `result`.
- `version_mismatch.warning` — emitted when a cross-workflow `goto` resolves to a workflow whose declared `loopx` version range is unsatisfied (per SPEC §3.2). Fires only on cross-workflow first-entry, where the SDK is live. Emitted on the **source iteration span** — the iteration that issued the cross-workflow `goto`, since the version check happens during transition resolution (SPEC §7.1 step 12.e), before the destination iteration's span is created. Attrs: `workflow` (the destination workflow), `declared_range`, `running_version`.

**Status:** `OK` if iteration completed and produced parseable output. `ERROR` for non-zero exit, invalid `goto` target, missing target workflow / script during goto resolution, spawn failure, or termination by signal / abort / consumer cancellation. Note that `consumer_cancellation` produces an `OK` `loopx.run` (a clean API outcome) but an `ERROR` `loopx.iteration` (the child was killed mid-execution).

#### `loopx.script.exec`

Wraps the actual child-process spawn-to-exit. Parent: `loopx.iteration`. This is the span whose context is exposed to the child via `TRACEPARENT`.

**Attributes:**

| Attribute | Type | Notes |
|---|---|---|
| `loopx.script.lang` | string | `bash` \| `node` \| `tsx` \| `bun` |
| `loopx.script.path` | string | absolute discovery-time path |
| `loopx.script.workflow_dir` | string | same as `LOOPX_WORKFLOW_DIR` |
| `loopx.script.tmpdir` | string | same as `LOOPX_TMPDIR` |
| `process.pid` | int | child PID, once known |
| `process.exit_code` | int | (close-time) |
| `process.stdin.bytes` | int | byte length of the UTF-8 payload written to child stdin (= the previous iteration's `Output.result` UTF-8 bytes); 0 when stdin is empty |
| `process.stdin.sha256` | string | hex SHA-256 of those bytes; absent when `bytes == 0` |
| `process.stdin.preview` | string | (only when `LOOPX_OTEL_CAPTURE_STDIN=truncated`) first N bytes, UTF-8-decoded with replacement |
| `process.stdin` | string | (only when `LOOPX_OTEL_CAPTURE_STDIN=full`) full payload as a string |
| `process.stdout.bytes` | int | raw byte length captured from the child's stdout pipe before structured-output parsing |
| `process.stderr.bytes` | int | byte length seen on child stderr (passthrough is unaffected) |
| `loopx.spawn.failed` | bool | `true` if the child failed to launch (per SPEC §7.2) |

**Events:**

- `signal.forwarded` — when loopx forwards SIGINT/SIGTERM to the child process group. Attrs: `signal.name`, `target_pgid`.
- `signal.escalated` — when loopx escalates to SIGKILL after the 5-second grace period.

**Status:** `OK` on exit 0. `ERROR` on non-zero exit, spawn failure, or termination by signal / abort / consumer cancellation.

### 5. Trace context propagation

When otel is enabled, loopx injects `TRACEPARENT` (W3C Trace Context) and, when non-empty, `TRACESTATE` into every child script's environment, scoped to the current `loopx.script.exec` span. This is at the **loopx-injected protocol-variable tier** of SPEC §8.3 — it overrides any user-supplied value of the same name. This injection happens regardless of `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS`; that flag governs only `OTEL_*` / `LOOPX_OTEL_*` propagation, not trace linkage.

When otel is disabled, loopx neither injects nor strips `TRACEPARENT` / `TRACESTATE`. An inherited value passes through to children unchanged via the normal inherited-env path. This preserves the case where loopx is itself called from an outer-process otel context.

`TRACEPARENT` and `TRACESTATE` are added to SPEC §13's reserved-name table as **conditionally script-protocol-protected**: protected when `LOOPX_OTEL_ENABLED=true`, and unreserved otherwise.

The propagator used for serialization follows `OTEL_PROPAGATORS`, which defaults in v1 to `tracecontext` only. Baggage propagation is out of scope for v1; `BAGGAGE` is not injected into child environments and is not added to the §13 reserved table. A user who explicitly sets `OTEL_PROPAGATORS=tracecontext,baggage` is opting into baggage at the SDK level, but loopx still injects only `TRACEPARENT` / `TRACESTATE`.

### 6. Resource attributes

Attached to all telemetry emitted by the loopx process:

| Attribute | Source |
|---|---|
| `service.name` | `OTEL_SERVICE_NAME` if set; otherwise `"loopx"` |
| `service.version` | running loopx version |
| `service.instance.id` | random UUIDv4 generated once per process at SDK init |
| `process.runtime.name` | `node` \| `bun` |
| `process.runtime.version` | runtime version string |
| `host.name` | best-effort hostname (`os.hostname()`) |

User-supplied `OTEL_RESOURCE_ATTRIBUTES` are merged on top of these (standard OTel SDK behavior — user-supplied wins on key conflict, except for `service.name` which is governed by `OTEL_SERVICE_NAME`).

`service.instance.id` is process-scoped, not per-run. Per-run identity in the trace tree is carried by the `loopx.run.id` span attribute (§4). The project root is recorded as a span attribute (`loopx.project_root` on `loopx.run` — §4), not a resource attribute, because concurrent or sequential runs in the same programmatic process may pass different `RunOptions.cwd` values; a process-wide resource attribute would be stale or wrong after the first SDK-initializing run. The per-run truth lives on `loopx.run`.

CLI helpers running inside a loopx-spawned child each initialize their own short-lived SDK (§2). They produce a distinct `service.instance.id` from the parent's; correlation back to the parent run happens via `TRACEPARENT` parentage. User-side spans created via the JS programmatic helpers in the *same* process inherit that process's resource directly.

### 7. Metrics

Emitted unconditionally when otel is enabled, subject to standard OTel suppression via `OTEL_METRICS_EXPORTER=none`.

Built-in instruments:

| Instrument | Type | Attributes |
|---|---|---|
| `loopx.run.duration` | Histogram (ms) | `terminal_outcome`, `starting_workflow` |
| `loopx.iteration.duration` | Histogram (ms) | `workflow`, `script`, `entry_kind`, `outcome` (`ok` \| `error`) |
| `loopx.iteration.count` | Counter | `workflow`, `script`, `outcome` |
| `loopx.script.exit_code` | Counter | `workflow`, `script`, `exit_code` |
| `loopx.signal.received` | Counter | `signal.name` |
| `loopx.spawn.failed` | Counter | `workflow`, `script` |
| `loopx.output.parse_warning` | Counter | `workflow`, `script` |
| `loopx.tmpdir.cleanup_warning` | Counter | `category` (impl-defined classification of the §7.4 warning) |

Histogram bucket boundaries are SDK defaults unless `OTEL_*` overrides apply. The metric reader is the SDK default (`PeriodicExportingMetricReader` for OTLP).

User-side metrics emitted via `counter()` / `histogram()` go through the same exporter and inherit the same resource. The `loopx.` prefix is reserved (§12).

**Value rules.** `counter()` (CLI and JS/TS) accepts only **non-negative finite numbers** per OTel monotonic-counter semantics; negative values, `NaN`, and non-finite values are dropped and produce a single per-process stderr warning. `histogram()` accepts any finite number (positive, zero, or negative); `NaN` and non-finite values are dropped under the same warning rule. The CLI helpers' `<value>` argument must still parse as a finite number — a malformed argument is a usage error (exit code 1) regardless of enabled state, per §2; the value-rule check above runs only after parsing succeeds.

### 8. Sampling

Default sampler: `parentbased_always_on`. Honors `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`. Sampling decisions are made on `loopx.run`; descendant spans inherit via parent-based sampling.

### 9. Env-var merging into child scripts

When **effective** `LOOPX_OTEL_ENABLED` is `true` (i.e., telemetry is enabled for the run, regardless of whether the source was the otel config file or `options.otel.enabled=true`) **and** `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS` is `true`, the run's resolved otel configuration is merged into child script environments at a new tier inserted between `RunOptions.env` (existing tier 2) and the local env file (existing tier 3). Updated SPEC §8.3 precedence (highest wins):

1. **loopx-injected protocol variables** — `LOOPX_BIN`, `LOOPX_PROJECT_ROOT`, `LOOPX_WORKFLOW`, `LOOPX_WORKFLOW_DIR`, `LOOPX_TMPDIR`, plus `TRACEPARENT` / `TRACESTATE` when otel is enabled.
2. **`RunOptions.env`** (programmatic API).
3. **Resolved otel configuration** — only when otel is enabled and propagation is on (see resolution rules below).
4. **Local env file** (`-e` / `RunOptions.envFile`).
5. **Global loopx env** (`$XDG_CONFIG_HOME/loopx/env`).
6. **Inherited system environment** (snapshotted once per run).

**What tier 3 contains (resolution rules):**

- `LOOPX_OTEL_ENABLED` — set to `"true"` to mirror the **effective** enabled state. This makes `options.otel.enabled=true` (programmatic enable, even with no otel config file present) light up child-side helpers — `loopx otel counter` / `histogram` / `span` and JS/TS `withSpan` / `counter` / `histogram` calls in child scripts will export, matching the parent's behavior.
- All recognized `LOOPX_OTEL_*` knobs from the otel config file (e.g., `LOOPX_OTEL_CAPTURE_RESULT`, `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS` itself). `LOOPX_OTEL_*` values supplied via `options.otel` are not in scope for v1 — only `enabled` and `parentContext` are programmatically settable; the capture-mode knobs come from the file or are at default.
- All `OTEL_*` keys consulted by the parent SDK at init: the union of the otel config file's `OTEL_*` keys and the inherited `process.env` `OTEL_*` keys at snapshot time, with config-file values winning on conflict. Inherited `OTEL_*` would already reach children at tier 6, but propagating them at tier 3 ensures a consistent SDK configuration survives `RunOptions.env` (tier 2) and env-file (tier 4) overrides of unrelated keys.
- Unrecognized keys in the otel config file (those matching `[A-Za-z_][A-Za-z0-9_]*` but not `OTEL_*` and not on the recognized `LOOPX_OTEL_*` list) are **not** propagated. They are silently retained at the file level (per `loopx otel set`, §2) but have no semantic meaning to loopx or the SDK and are not surfaced to children.

**When tier 3 is empty:** any of (a) effective `LOOPX_OTEL_ENABLED` is `false`, (b) `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS` is `false`, or (c) otel is disabled outright. In all three cases, no `OTEL_*` / `LOOPX_OTEL_*` are propagated by loopx. Trace linkage (`TRACEPARENT` / `TRACESTATE`) is still injected at tier 1 when otel is enabled, regardless of propagation mode; when otel is disabled, no `TRACEPARENT` is injected (an inherited value passes through via tier 6).

Helpers running inside a child where propagation is off receive `TRACEPARENT` but no `OTEL_*` configuration from the otel config file. Such helpers can still self-export only if `OTEL_*` reaches them via another tier (local env file, global env, inherited shell). When no SDK configuration is reachable, the `span` helper falls through to `exec`, and `counter` / `histogram` no-op silently.

The otel config tier sits below `RunOptions.env` so a programmatic caller can override otel-config values per run (e.g., a test harness setting `OTEL_TRACES_EXPORTER=none` for one run while keeping global otel config intact).

### 10. Exporter behavior and lifecycle

**Initialization.**

- Deferred until the iteration phase begins. `loopx version`, `loopx env *`, `loopx otel list`/`set`/`enable`/`disable`/`show`, `loopx -h`, `loopx run -h`, and **`loopx install` in all forms** do not initialize the SDK. `loopx install` (including the post-commit `npm install` pass and `.gitignore` synthesis under SPEC §10.10) is out of scope for telemetry — the only `loopx otel ...` command that initializes the SDK eagerly is `loopx otel test`.
- `loopx run <target>` (and the programmatic equivalents) initialize the SDK after the pre-iteration sequence completes (discovery, env-file loading, target resolution, starting-workflow version check, tmpdir creation) and immediately before opening `loopx.run` — i.e., immediately before the first child spawn.
- SDK initialization failure is non-fatal: a single stderr warning is emitted (per the warning policy below), the run proceeds with telemetry disabled for its lifetime, and exit code is unaffected.
- `loopx otel test` initializes immediately, bypassing the deferred path.
- The SDK is process-wide. Once initialized, it persists for the process lifetime.
- **Bun runtime.** SDK initialization on Bun uses `@opentelemetry/sdk-node`. If that SDK fails to initialize on Bun (e.g., because of incompatibility with the current Bun release), the failure is treated as any other SDK initialization failure: one stderr warning, telemetry disabled for the run's lifetime, exit code unaffected.

**Supported exporters.**

In v1, only `otlp` (default) and `none` are supported values for `OTEL_TRACES_EXPORTER` and `OTEL_METRICS_EXPORTER`. `console`, `stdout`, and any other exporter that writes to the script's stdout are explicitly **unsupported**, because stdout is the structured-output protocol channel (SPEC §2.3 / §6.4) and exporter writes would corrupt parsing — both for the parent loopx process (whose stdout is the loop driver itself in CLI mode) and for child-side helpers that inherit a script's stdout. An unsupported value falls back to `otlp` with a single stderr warning per offending key.

**Export pipeline.**

- Traces: `BatchSpanProcessor` over OTLP HTTP/protobuf (default) or `none`. Async, batched, bounded queue. Drops on queue overflow per the failure-isolation rule below; the SDK's standard `dropped_spans` warning is suppressed.
- Metrics: `PeriodicExportingMetricReader` over OTLP HTTP/protobuf (default) or `none`.
- Logs: not enabled in v1.

**Per-run flush vs. process-exit shutdown.**

These are two distinct lifecycle events with different scope:

- **Per-run flush.** Each individual run reaching a terminal outcome (CLI exit, `run()` settling, `runPromise()` resolving or rejecting, consumer cancellation, abort) closes its own spans and `await`s `forceFlush()` on the trace and metric providers with a 5-second deadline. `forceFlush()` does **not** shut down the SDK; concurrent runs in the same process are unaffected. `forceFlush()` runs whether the run is normal or error: throwing from `run()` or rejecting from `runPromise()` flushes the run's spans but does not shut down the shared SDK. A `forceFlush()` timeout does not produce a separate stderr warning; pending telemetry is left to the eventual process-exit shutdown (or is lost if the process is killed before then). **Per-run `forceFlush()` is the one reliable export guarantee for `run()` / `runPromise()` settlement** — host programs that exit the process synchronously after a run settles cannot rely on process-exit shutdown to drain anything beyond what `forceFlush()` already wrote.
- **Process-exit shutdown.**
  - **CLI:** the run terminal outcome and the process exit coincide. loopx awaits SDK `shutdown()` explicitly between final `LOOPX_TMPDIR` cleanup (per SPEC §7.4) and the actual process exit. The deadline is 5 seconds.
  - **`output()` (child SDK):** when the child-process SDK has been initialized, `output()` `await`s `forceFlush()` + `shutdown()` before calling `process.exit(0)`, per §3. Same 5-second deadline.
  - **Programmatic API host process:** loopx installs `beforeExit` and signal-driven (`SIGINT` / `SIGTERM`) hooks that attempt SDK `shutdown()` best-effort. **`process.on('exit')` is not used for shutdown**, because Node disallows asynchronous work in that hook. Host programs that exit synchronously after `runPromise()` resolves (e.g., `await runPromise(...); process.exit(0)`) may lose pending exports beyond what per-run `forceFlush()` already wrote — `forceFlush()` is the reliable guarantee, not process-exit shutdown.
- **Shutdown deadline.** Hard 5-second deadline; expiration prints a single stderr warning ("otel exporter shutdown timed out after 5s") and proceeds. Does not affect CLI exit code, generator outcome, or promise rejection.
- **Idempotence.** SDK shutdown is idempotent (parallel to SPEC §7.2 cleanup idempotence): at most one shutdown attempt per process.

**Failure isolation.**

All runtime exporter failures — transport errors, deadline-exceeded, malformed configuration detected at runtime, queue overflow / dropped spans, SDK-internal exceptions during export — are caught and discarded. They do not affect the loop, do not change the `loopx.run` terminal outcome, and do not surface in stderr. `loopx otel test` (§2) is the single documented exception and surfaces SDK errors deliberately.

**Warning policy.**

loopx warnings split into two categories by *when* they may fire:

*Category A — may fire even when telemetry is ultimately disabled* (the otel config file is read on every potentially-telemetry-enabled run to resolve the enable bit, so a single read-failure warning is possible regardless of the final state):

- otel config file unreadable: at most once per run init.

*Category B — fires only when telemetry is effectively enabled for the run* (covers SDK initialization, full file validation, and runtime rule violations):

- invalid env-var name in the otel config file: one per offending line; line ignored.
- invalid `LOOPX_OTEL_*` value: one per offending key; fallback to default.
- SDK-side warnings for invalid `OTEL_*` values surfaced at startup.
- unsupported `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` value: one per offending key; fallback to `otlp`.
- SDK initialization failure: at most once per process.
- reserved metric-instrument-name violation (§12): at most once per offending name per run.
- counter / histogram value-rule violation (negative counter, non-finite counter / histogram): at most once per process (§7).
- process-exit shutdown timeout: at most once per process.

`loopx otel test` is the documented exception: SDK / exporter errors surface on stderr and are reflected in the exit code, by design. All other stderr noise from runtime exporter failures (including queue overflow / dropped spans) is suppressed.

### 11. Programmatic API integration

`run()` and `runPromise()` produce telemetry as part of normal execution; no signature change for callers who do not configure telemetry.

`RunOptions` gains an optional `otel` field:

```typescript
interface RunOptions {
  // ... existing fields
  otel?: {
    enabled?: boolean;        // overrides effective enabled state for this run
    parentContext?: string;   // raw TRACEPARENT string to attach as parent of loopx.run
  };
}
```

- **`options.otel.enabled`** — when set, overrides the config-file-derived enabled state for this run only. `false` suppresses telemetry even if the config file enables it; `true` enables even if the config file does not. A `true` override on a process where no otel config file exists initializes the SDK with whatever `OTEL_*` configuration is reachable from inherited `process.env`; if no usable endpoint is reachable, the SDK runs but exports fail silently per the failure-isolation rule. Once the process-wide SDK is initialized, it persists; subsequent runs in the same process inherit it regardless of their own `options.otel` values, except that a `false` override still gates whether *that run* emits `loopx.*` spans and whether its children receive trace-context / OTel propagation per §5 / §9.
- **`options.otel.parentContext`** — when supplied, `loopx.run` becomes a child of the provided context. This is the path for an embedding application that runs many `runPromise()` calls inside its own outer span. `options.otel.parentContext` overrides any inherited `TRACEPARENT` parent (§4 `loopx.run`).

**Validation.**

- `options.otel`, when present and not `undefined`, must be a non-null, non-array, non-function object. Non-conforming values (null, array, function, primitive) are captured at call time and surfaced via the standard pre-iteration error path (SPEC §9.1), identical to `options.env` shape errors.
- `options.otel.enabled`, when present and not `undefined`, must be a boolean. A non-boolean value is captured and surfaced via the pre-iteration error path.
- `options.otel.parentContext`, when present and not `undefined`, must be a string. A non-string value is captured and surfaced via the pre-iteration error path. A string that does not match the W3C trace-context format is captured at snapshot time regardless of whether `enabled` is `true` for this run — an invalid `parentContext` is invalid as a value, even when unused. The format check happens at the option-snapshot point.
- A throwing getter on `options.otel` itself, or on any of its sub-fields (`enabled`, `parentContext`), is captured and surfaced via the pre-iteration error path.

`options.otel` is read on the same option-snapshot schedule as other option fields (SPEC §9.1). It sits **after** `options.signal` and is otherwise implementation-defined in order.

The pre-first-`next()` consumer-cancellation carve-out (ADR-0004 §1, SPEC §9.1) suppresses `options.otel` snapshot errors the same way it suppresses other captured pre-iteration errors. The abort-wins-over-pre-iteration-failures rule (SPEC §9.3) applies unchanged.

### 12. Reserved names and namespaces

**`TRACEPARENT` and `TRACESTATE`** are added to SPEC §13's reserved-name table as conditionally script-protocol-protected (protected when otel is enabled, unreserved otherwise). They are not protocol variables of the loopx core; they exist only when otel is enabled.

**`LOOPX_OTEL_*` keys** in the otel config file are managed by the otel subsystem; user code may read them but should treat them as advisory. `LOOPX_OTEL_*` is not added to the §13 reserved table because the keys reach children only via the §9 tier-3 path, not via the protocol-variable tier.

**`loopx.*` attribute namespace** is reserved. User code emitting attributes via `withSpan()` / CLI `--attr` flags must not set `loopx.*` keys. Conflicting attributes are **silently dropped** by the helpers; no warning is emitted. (Single normative behavior, not implementation-defined.)

**`loopx.*` metric instrument names** are similarly reserved. User code creating metrics via `counter()` / `histogram()` may not use the `loopx.` prefix; attempts produce a single stderr warning per run and the metric is suppressed.

### 13. Interaction with other SPEC sections

The following SPEC sections need updates when this ADR is accepted; this list is the mechanical update target.

- **§3.3 (Module Resolution for Scripts)** — note that the importable `"loopx"` package surface now includes the OTel helpers (`withSpan`, `addEvent`, `setAttribute`, `recordException`, `counter`, `histogram`, `isOtelEnabled`) in addition to `output()` / `input()` / `run()` / `runPromise()`. No change to the resolution mechanism itself.
- **§3.4 (Bash Script Binary Access)** — extend the `LOOPX_BIN` example list with `$LOOPX_BIN otel span ... -- cmd`, `$LOOPX_BIN otel counter ...`, `$LOOPX_BIN otel histogram ...`.
- **§4.3 (Subcommands)** — add `loopx otel` and all its sub-subcommands with synopses. Add `loopx otel -h` to the help-flag short-circuit pattern.
- **§5.4 (Validation Scope)** — add a row for `loopx otel *`: does not require `.loopx/`, performs no discovery, no validation.
- **§6.4 / §6.5** — add a cross-reference to the new observability chapter. Clarify that `output()` / `input()` continue to be the only stdout-protocol helpers; `counter` / `histogram` (CLI and JS/TS) export only via OTLP and write nothing to stdout, while `loopx otel span ... -- <command>` inherits the wrapped command's stdout (which therefore can still affect the script's structured-output stdout — wrapping a command that produces structured stdout requires the same care as any other process-substitution pattern). Add the `output()` flush-on-exit behavior described in §3 of this ADR (on initialized child SDK, `output()` `await`s `forceFlush()` + `shutdown()` with a 5-second deadline before `process.exit(0)`).
- **§7.1 (Basic Loop)** — insert SDK initialization between tmpdir creation (current step 6) and the first child spawn (current step 7); insert an explicit `await` of SDK `shutdown()` after final `LOOPX_TMPDIR` cleanup and before CLI exit. Both are conditional on effective `LOOPX_OTEL_ENABLED`. Document that `forceFlush()` runs per terminal outcome regardless of CLI vs. programmatic invocation.
- **§7.2 (Error Handling)** — add SDK initialization failure as a non-fatal warning. Add SDK process-exit shutdown timeout as a non-fatal warning. Add the unsupported-exporter fallback warning (§10) and the counter / histogram value-rule violation warning (§7) to the non-fatal warning list.
- **§7.3 (Signal Handling)** — clarify that, on signal-driven exit, loopx's signal hook awaits SDK `shutdown()` after tmpdir cleanup and before signal-exit. The 5s otel shutdown deadline runs concurrently with (not in addition to) any subsequent process exit. Process-exit hooks for the programmatic API rely on `beforeExit` and signal hooks; `process.on('exit')` is not used because Node disallows async work in that hook.
- **§7.4 (`LOOPX_TMPDIR`)** — note that otel shutdown follows tmpdir cleanup in the terminal-outcome ordering.
- **§8.1 (Global Storage)** — add a sibling subsection for the new `$XDG_CONFIG_HOME/loopx/otel` config file, with the same fallback rules, concurrent-mutation caveats, the `0600` permission requirement on writes, and the read-side rule that loopx neither chmods nor warns about existing-file permissions.
- **§8.3 (Injection)** — replace the precedence list with the 6-tier list in §9 of this ADR. Add `TRACEPARENT` / `TRACESTATE` to the protocol-variable table (with the "only when otel enabled" qualifier).
- **§9.1 / §9.2** — add `options.otel` to the option-snapshot rules (read order, snapshot timing, error path). Note that the inherited `TRACEPARENT` consulted for `loopx.run` parent context (§4) is captured on the same option-snapshot schedule.
- **§9.3** — add per-run `forceFlush()` (awaited, 5-second deadline) to the cleanup ordering note. Per-run flush runs before throw/reject (alongside `LOOPX_TMPDIR` cleanup); SDK shutdown is a separate process-exit-only event, not part of per-run cleanup. Per-run `forceFlush()` is the only export guarantee for `run()` / `runPromise()` settlement; host programs that synchronously exit after settlement may lose pending exports beyond what `forceFlush()` already wrote.
- **§9.4** — note that the importable `"loopx"` surface now extends beyond `output()` / `input()` / `run()` / `runPromise()` to include the OTel helpers in §3.
- **§9.5 (`RunOptions`)** — add the `otel` field to the type and validation rules. Specify validation for non-object `otel`, non-boolean `enabled`, non-string `parentContext`, throwing getters on `otel` / `enabled` / `parentContext`, and invalid (non-W3C-format) `parentContext` regardless of `enabled` state.
- **§11.1 (Top-level Help)** — add `otel` to the listed top-level subcommands.
- **§12 (Exit Codes)** — note that `loopx otel test` exits 1 on disabled / unreachable backends (the documented exception to exporter-failure isolation, §2). `loopx otel span -- <command>` preserves the wrapped command's exit code byte-for-byte (any value, not just 0/1) regardless of OTel state; `loopx otel counter` / `histogram` exit 0 silently when disabled or unreachable; usage errors (malformed value, missing arguments, unrecognized flags) on any `loopx otel` helper still exit 1.
- **§13** — add `TRACEPARENT`, `TRACESTATE` rows (conditionally script-protocol-protected when otel is enabled). Add a paragraph reserving the `loopx.*` attribute and metric-instrument-name namespaces.
- **New §N (Observability)** — full chapter for the §1–§11 content of this ADR.

## Consequences

**Positive:**

- A single trace can cover an entire ralph loop or a multi-workflow review chain. Cross-workflow `goto` paths become legible at runtime.
- Iteration-duration histograms make agent-latency regressions detectable. Exit-code counters make backend reliability comparable across `telegram` / `codex` / `api` / `batch` reviewers.
- Scripts that already use `claude code` (which emits OTel) become end-to-end traceable when `TRACEPARENT` is propagated. No code change in those scripts is required.
- Token usage and other API-level measurements have a first-class metric surface (`counter` / `histogram`) usable from bash and JS/TS.
- All of the above is opt-in. A user who never runs `loopx otel enable` pays zero overhead in startup time, env vars seen by scripts, or stderr volume.

**Negative / costs:**

- Adds a non-trivial dependency surface (`@opentelemetry/sdk-node`, OTLP exporters, `@opentelemetry/api`). Bundle size and `npm install` time grow even for users who never enable otel; lazy-loading via dynamic `import()` mitigates runtime cost but not install-time cost.
- New surface to maintain: another config file, another subcommand tree, a non-trivial span schema that downstream dashboards will start to depend on. Schema changes become breaking changes.
- CLI helpers init their own SDK per invocation. Tight loops calling `loopx otel counter` in bash can incur per-call SDK-init cost. JS/TS programmatic helpers do not have this cost (process-wide SDK).
- `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS=true` (default) means OTLP credentials reach every spawned script. Workflows that exec untrusted code should set this to `false`.
- `LOOPX_OTEL_CAPTURE_RESULT=full` will exceed many backends' attribute size limits silently. The mode exists for completeness but the documented operational default is `none` or `truncated`.
- v1 supports only `otlp` and `none` as exporter values. Console / stdout exporters are deferred — users who want a local debug exporter must run an OTLP collector that prints to stdout themselves. This trade-off protects the structured-output stdout protocol but reduces low-friction debugging out of the box.
- No CLI surface in v1 for inline events / attributes / exception-recording on the parent script's span. Bash users who want to attach attributes to the current `loopx.script.exec` span must wrap a sub-step in `loopx otel span` (whose `--attr` populates the wrapped span). JS/TS users have the full `addEvent` / `setAttribute` / `recordException` surface in-process. A future ADR can add IPC-backed CLI inline helpers if real workloads demand them.

## Test Recommendations

Easy-to-overlook cases worth covering:

- **Default-off byte-identity.** Without `loopx otel enable` (and without `options.otel.enabled=true`), no SDK initialization occurs, no `TRACEPARENT` is injected into children, no network sockets are opened, and `loopx run` behavior is byte-identical to pre-ADR.
- **Concurrent runs share SDK.** Two concurrent `runPromise()` invocations in one process produce two distinct `loopx.run` spans with distinct `loopx.run.id` but identical `service.instance.id`, and one settling does not shut down the SDK while the other is still active.
- **Per-run `forceFlush()` is the export guarantee for programmatic settlement.** A host program that calls `await runPromise(...); process.exit(0)` exports the run's spans (drained by `forceFlush()`); spans not drained by `forceFlush()` are not guaranteed to reach the exporter, since process-exit shutdown cannot run async work after a synchronous `process.exit`.
- **Exporter unreachable / failure isolation.** With `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1`, the run completes normally, exit code matches the script's behavior, and at most one stderr warning appears (SDK init may emit one; runtime exporter failures are silent).
- **Pre-iteration failure timing.** Discovery error, target resolution error, env-file failure, starting-workflow version mismatch, and tmpdir-creation failure produce no telemetry (SDK not yet initialized) and behave identically to pre-ADR.
- **Cross-workflow version-mismatch event placement.** A cross-workflow `goto` into a workflow whose declared version range is unsatisfied produces a `version_mismatch.warning` event on the **source iteration span** — the iteration that issued the goto — not the destination.
- **Spawn failure produces a `loopx.iteration` span.** A spawn that fails to launch produces a `loopx.iteration` span with `loopx.spawn.failed=true` on its child `loopx.script.exec` span and no `loopx.output.*` attributes; the span ordinal increments but the SPEC §7.1 iteration counter (visible as `loopx.run.iteration_count`) does not.
- **Programmatic enable.** `runPromise("ralph", { otel: { enabled: true } })` with no otel config file present causes child scripts to observe effective `LOOPX_OTEL_ENABLED=true` plus the resolved `OTEL_*` configuration in their environment. `{ otel: { enabled: false } }` against a config file that enables otel produces a run with no `loopx.*` spans, no `TRACEPARENT` injection, and an empty tier 3 in child env merging.
- **Runtime helpers ignore the global config file.** With otel enabled in the global config file but no `LOOPX_OTEL_ENABLED` in the inherited shell, `loopx otel counter` from a plain shell no-ops silently. The same call inside a `loopx run`-spawned child where propagation populated the env exports normally.
- **`output()` flushes child OTel SDK.** A JS/TS script with `LOOPX_OTEL_ENABLED=true` in its environment that calls `withSpan(...)` and then `output({ result: "x" })` produces an exported span — the data is not lost to `process.exit(0)` truncation.
