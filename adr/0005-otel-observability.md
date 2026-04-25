# ADR-0005: OpenTelemetry Observability

**Status:** Proposed

---

## Context

loopx runs are long-lived, multi-iteration, multi-workflow processes that wrap agent CLIs (`claude`, `codex`, etc.). Real-world workflows in this repository show the shapes that need to be observable:

- **`ralph`** — a perpetual agent loop. Each iteration spawns `claude -p`, hand-maintains an iteration counter in a tmp file (predates ADR-0004's `LOOPX_TMPDIR`), and notifies Telegram. Iterations have wildly variable wall-clock times depending on what `claude` is doing; today there is no way to plot duration distribution, exit-code rates, or which agent invocations stalled.
- **`review-adr`** / **`apply-adr`** / **`spec-test-adr`** — multi-step pipelines that cross-workflow `goto` into `shared:dispatch`, which fans out to one of four reviewer backends (`telegram`, `codex`, `api`, `batch`) selected by `LOOPX_REVIEWER`. The cross-workflow chain is invisible: there is no single trace tying "I asked review-adr to review ADR 0005" to "the codex backend took 47 seconds and produced this exit code". When something goes wrong mid-chain, the user sees stderr but has no structured record of which transitions happened in what order.
- **Long bash chains** that pipe `claude` / `codex` output through helper scripts (`md-to-tg-html.mjs`, `apply-answer.sh`, `check-feedback-done.sh`). Each stage is a black box from a metrics standpoint.

The observability gaps that matter:

1. **Wall-clock duration of runs, iterations, and individual scripts** — needed to spot regressions in agent latency, slow scripts, and stalled iterations.
2. **`goto` graph realized at runtime** — which transitions actually fired, in what order, across which workflows. The static script topology is in `.loopx/`; the dynamic trace is what tells you what your agent actually did.
3. **Exit-code and error-rate distributions** — per workflow, per script, per reviewer backend.
4. **Agent-side spans connected to loopx-side spans.** `claude code` already emits OpenTelemetry. Without trace-context propagation, those spans are orphans; with it, a single trace covers loopx + agent end-to-end.
5. **User-defined instrumentation inside scripts** — counters, custom spans around expensive sub-steps, attributes recorded at decision points. Today there is no telemetry surface; users would have to bolt on their own SDK in every script.

Two non-goals worth stating up front:

- **Not a logging system.** stderr is already passed through to the terminal (SPEC §6.2 / §6.3), and structured-output JSON on stdout is the protocol with the next iteration. Adding a third channel for structured logs is scope creep; the tracing surface (events on spans) covers the cases where structured logs would have helped.
- **Not a metrics-server.** loopx exports OTLP to a user-provided collector; it does not host its own backend, dashboard, or query layer.

## Decision

loopx gains optional OpenTelemetry support, **disabled by default**, configured via a dedicated global config file and a new `loopx otel` subcommand namespace. When enabled, loopx emits traces (always) and metrics (always, suppressible via standard OTel env vars) describing the run, propagates W3C trace context to every spawned script, and exposes a no-op-when-disabled helper API in both the CLI and the `loopx` JS/TS package so scripts can self-instrument without conditional code.

### 1. Global configuration

A new global config file lives at:

```
$XDG_CONFIG_HOME/loopx/otel
```

Fallback to `$HOME/.config/loopx/otel` when `XDG_CONFIG_HOME` is unset. Same `.env` format and parser as the existing global env file (SPEC §8.1) — same key restrictions, same comment / blank-line / quoting rules, same "last occurrence wins" duplicate behavior, same single-line-value constraint. Concurrent-mutation behavior is the same as for the env file (undefined under simultaneous writes).

The config is intentionally separate from `$XDG_CONFIG_HOME/loopx/env`:

- **Lifecycle differs.** Otel config is loopx-process-side first (the loopx process itself initializes its SDK from these values), and only secondarily injected into children. The env file is script-side first.
- **Surface differs.** Otel config has an explicit on/off toggle. The env file does not.
- **Privacy differs.** OTLP credentials (e.g., `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer …`) should not leak into every script's environment if the user only wants loopx-side instrumentation. Keeping it in a separate file makes the merging-into-children rule explicit and skippable.

Recognized loopx-specific keys:

| Key | Default | Meaning |
|-----|---------|---------|
| `LOOPX_OTEL_ENABLED` | unset (disabled) | `"true"` or `"1"` enables the SDK; any other value (including absent) keeps it disabled. |
| `LOOPX_OTEL_CAPTURE_RESULT` | `"none"` | `"none"`: record only `result` byte length and sha256. `"truncated"`: also record first N bytes. `"full"`: record entire `result` string as a span attribute. |
| `LOOPX_OTEL_CAPTURE_RESULT_TRUNCATE_BYTES` | `"4096"` | Byte cap for `"truncated"` mode. Must parse as a non-negative integer; invalid value falls back to default with a stderr warning. |
| `LOOPX_OTEL_CAPTURE_STDIN` | `"none"` | Same three values applied to script stdin (i.e., the `result` piped from the previous iteration). Sized similarly. |
| `LOOPX_OTEL_CAPTURE_STDIN_TRUNCATE_BYTES` | `"4096"` | Byte cap for stdin truncation. |
| `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS` | `"true"` | When `"true"`, the otel config file's keys are merged into child script environments at the new tier defined in §9. When `"false"`, only `TRACEPARENT` / `TRACESTATE` are injected, and scripts that want to self-instrument must read OTLP config from elsewhere. |

Any key matching `OTEL_*` (the SDK's standard env-var namespace) is also recognized, validated by name pattern only (`[A-Za-z_][A-Za-z0-9_]*`), and passed to the SDK and (per §9) to children. This includes:

- `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TIMEOUT`
- `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`
- `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`
- `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`
- `OTEL_PROPAGATORS`, `OTEL_BSP_*`, `OTEL_METRIC_EXPORT_*`, etc.

loopx does not validate semantic correctness of `OTEL_*` values — that is the SDK's job. Invalid values produce SDK-side warnings on stderr at startup.

**Failure modes** (parallel to SPEC §8.1):

- File absent: treated as no otel config. SDK is not initialized regardless of any other state. (`LOOPX_OTEL_ENABLED` unset ≡ disabled.)
- File unreadable: stderr warning, SDK is not initialized, run proceeds. Treating an unreadable otel config as fatal would make a permission-denied bug block agent loops, which is the wrong trade-off for a default-off feature.
- Invalid JSON: not applicable (`.env` format).
- Invalid env-var name in a non-blank, non-comment line: stderr warning, line ignored (consistent with SPEC §8.1).

**Snapshot timing.** The otel config file is read on the same schedule as the inherited `process.env` snapshot (SPEC §8.1, §9.1, §9.2): pre-iteration for the CLI, lazy first-`next()` for `run()`, eager call-site for `runPromise()`. Mutations to the file mid-run are not picked up.

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

- **`loopx otel enable`** — sets `LOOPX_OTEL_ENABLED=true` in the config file. Idempotent. Creates the config file and any missing parent directories on first call.
- **`loopx otel disable`** — sets `LOOPX_OTEL_ENABLED=false`. Idempotent. Does not delete other keys.
- **`loopx otel set <name> <value>`** — mirrors `loopx env set`: same name pattern (`[A-Za-z_][A-Za-z0-9_]*`), same value rules (no `\n` / `\r`), same `KEY="<literal value>"` serialization. No semantic validation of `OTEL_*` values.
- **`loopx otel remove <name>`** — mirrors `loopx env remove`: silent no-op if absent.
- **`loopx otel list`** — mirrors `loopx env list`: one `KEY=VALUE` per line, sorted lexicographically, no output if empty.
- **`loopx otel show`** — human-readable summary: enabled state, effective endpoint, protocol, sampler, service name, capture-result mode, propagate-to-scripts mode, plus a one-line note for any key whose value is non-default. Distinct from `list` in that it shows *effective* / *default-resolved* state, not raw config.
- **`loopx otel test`** — initializes the SDK from current config, emits a single `loopx.otel.test` span with attributes (`loopx.version`, `loopx.test_id` UUID), runs a 5-second flush+shutdown, prints `OK <endpoint>` to stdout and exits 0 on success, prints the underlying error to stderr and exits 1 on failure. When otel is disabled in config, prints `disabled — run \`loopx otel enable\` first` to stderr and exits 1.

`loopx otel` with no subcommand is a usage error (exit code 1) and prints help. `loopx otel -h` / `--help` shows help and exits 0.

None of the config-management commands require `.loopx/` to exist or are affected by it.

#### Runtime helpers

```
loopx otel span <name> [--attr k=v]... [--status ok|error] -- <command>...
loopx otel event <name> [--attr k=v]...
loopx otel attr <key> <value>
loopx otel record-exception <message> [--attr k=v]...
loopx otel counter <name> <value> [--attr k=v]...
loopx otel histogram <name> <value> [--attr k=v]...
```

These helpers are designed to be safe to call unconditionally from any script. Behavior:

- **`loopx otel span <name> ... -- <command>`** — runs `<command>` as a child process. When otel is enabled and a `TRACEPARENT` is present in the helper's environment, the helper starts a span as a child of that context, sets the span's context as `TRACEPARENT` in the spawned command's environment, awaits exit, closes the span (status from `--status` if provided, otherwise derived from exit code: 0 → OK, non-zero → ERROR), and exits with the same exit code as `<command>`. When otel is disabled or `TRACEPARENT` is absent, the helper `exec`s `<command>` directly with no span overhead and preserves the exit code byte-for-byte.

- **`loopx otel event <name>`**, **`attr`**, **`record-exception`** — emit an event / set an attribute / record an exception on the ambient span identified by the helper's `TRACEPARENT`. When otel is disabled or `TRACEPARENT` is absent, exit 0 silently.

- **`loopx otel counter <name> <value>`**, **`histogram <name> <value>`** — record a metric data point. Gated only on `LOOPX_OTEL_ENABLED` (no `TRACEPARENT` requirement). When disabled, exit 0 silently.

`<value>` for `counter` / `histogram` must parse as a finite number; malformed value is a usage error (exit code 1) and is **not** silenced under the disabled fall-through.

`--attr k=v` may repeat. The `k` portion is validated against `[A-Za-z_][A-Za-z_0-9.]*`; the `v` portion is recorded as a string attribute (no type inference in v1). Unrecognized flags and missing required arguments are usage errors (exit code 1) regardless of enabled state — argument validity is independent of telemetry state.

`-h` / `--help` for any helper shows helper-specific help and exits 0.

**Helpers outside a loopx-spawned context.** A user can run `loopx otel span ... -- cmd` from a plain shell. Without an ambient `TRACEPARENT`, the span helper falls through to a direct `exec` of `<command>` (preserving exit code); the event/attr/record-exception helpers no-op; counter/histogram still emit if the SDK is enabled in config. This makes the helpers a useful standalone otel-emission tool, not just a child-of-loopx convenience.

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

counter("feedback.applied", 1, { workflow: "review-adr" });
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

- `withSpan(name, fn, opts?)` invokes `fn` directly with a stub `Span` whose methods all return synchronously without effect. `fn`'s return value or returned Promise is passed through unchanged. Exceptions from `fn` propagate unchanged. There is no measurable wall-clock overhead beyond the function call.
- `addEvent`, `setAttribute`, `recordException`, `counter`, `histogram` return synchronously without doing anything.
- `isOtelEnabled()` returns `false`.

**Recording semantics when enabled:**

- `withSpan` reads `TRACEPARENT` (and `TRACESTATE`) from `process.env` to determine the parent context. If present, the new span is a child of that context. If absent, the span is a root span (or attached to the SDK's currently-active context, if one was activated programmatically).
- `addEvent`, `setAttribute`, `recordException` operate on the currently-active span (the innermost `withSpan` if any; otherwise the span identified by ambient `TRACEPARENT` if reachable; otherwise no-op even though enabled).
- `counter` / `histogram` use the SDK's meter; metric instruments are lazily created and cached by name + attribute-key shape.

**SDK initialization timing in the JS API:**

- The SDK initializes lazily on the first call to any helper *or* the first `run()`/`runPromise()` invocation that observes `LOOPX_OTEL_ENABLED=true` in its option-snapshot pass (see §11). Initialization is idempotent.
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
├── loopx.iteration[3]  target=review-adr:start      (entry_kind=goto.cross)
│   └── loopx.script.exec
└── ...
```

Iteration counting (every target execution counts, including goto hops) follows SPEC §7.1 — there is no "logical step" abstraction layered on top.

#### `loopx.run`

Created on entry to the iteration phase, after the pre-iteration sequence (discovery, env-file loading, target resolution, version check, tmpdir creation) and before the first child spawn. Closed on terminal outcome of the run.

**Attributes:**

| Attribute | Type | When | Notes |
|---|---|---|---|
| `loopx.version` | string | open | running loopx version |
| `loopx.invocation` | string | open | `cli` \| `programmatic.run` \| `programmatic.runPromise` |
| `loopx.starting_target` | string | open | e.g. `"ralph:index"` |
| `loopx.starting_workflow` | string | open | resolved workflow name |
| `loopx.starting_script` | string | open | resolved script name (always set; defaults to `"index"`) |
| `loopx.project_root` | string | open | absolute path; same string as `LOOPX_PROJECT_ROOT` |
| `loopx.max_iterations` | int | open | only if `-n` / `maxIterations` was supplied |
| `loopx.delegated` | bool | open | `true` if running under the post-delegation binary |
| `loopx.iteration_count` | int | close | total iterations executed |
| `loopx.exit_code` | int | close | CLI exit code; 0 on normal completion, 1 on most errors, 128+signal on signal exit |
| `loopx.terminal_outcome` | string | close | `stop` \| `max_iterations` \| `non_zero_exit` \| `invalid_goto` \| `spawn_failure` \| `signal` \| `abort` \| `consumer_cancellation` \| `pre_iteration_error` |

**Events:**

- `signal.received` — attrs: `signal.name` (`SIGINT` \| `SIGTERM`)
- `abort.received` — for programmatic `AbortSignal`
- `loop.reset` — when a target finishes without `goto` and execution returns to the starting target
- `version_mismatch.warning` — when a workflow's declared `loopx` version range is not satisfied (per SPEC §3.2); attrs: `workflow`, `declared_range`, `running_version`

**Status:** `OK` on `stop`/`max_iterations`/`consumer_cancellation`. `ERROR` with description on every other terminal outcome.

#### `loopx.iteration`

One per iteration. Parent: `loopx.run`. Created immediately before child spawn, closed after structured output is parsed (or after the failure that prevented parsing).

**Attributes:**

| Attribute | Type | Notes |
|---|---|---|
| `loopx.iteration` | int | 1-based |
| `loopx.workflow` | string | current workflow |
| `loopx.script` | string | current script |
| `loopx.target` | string | `workflow:script` |
| `loopx.entry_kind` | string | `start` \| `goto.intra` \| `goto.cross` \| `loop.reset` |
| `loopx.previous_target` | string | absent on first iteration; set on goto / loop.reset |
| `loopx.workflow.first_entry` | bool | true if this is the first entry into this workflow during the run (per SPEC §3.2 cross-workflow version check timing) |
| `loopx.output.has_result` | bool | (close-time) |
| `loopx.output.has_goto` | bool | (close-time) |
| `loopx.output.stop` | bool | (close-time) |
| `loopx.output.goto` | string | (close-time) goto target string if present |
| `loopx.output.result.bytes` | int | (close-time) byte length of `result`; 0 for empty/absent |
| `loopx.output.result.sha256` | string | (close-time) hex sha256 of `result` bytes; absent if `result` is absent |
| `loopx.output.result.preview` | string | (close-time) only when `LOOPX_OTEL_CAPTURE_RESULT=truncated`; first N bytes UTF-8-decoded with replacement on invalid sequences |
| `loopx.output.result` | string | (close-time) only when `LOOPX_OTEL_CAPTURE_RESULT=full` |
| `loopx.output.parse_kind` | string | `structured` \| `raw` \| `empty` (per SPEC §2.3 parsing rules) |

**Events:**

- `goto.transition` — emitted just before transitioning. Attrs: `goto.target`, `goto.kind` (`intra` \| `cross`), `goto.from_target`.
- `output.parse_warning` — emitted when stdout was non-empty, was a JSON object, but contained no known fields and was therefore treated as raw `result` (a soft anomaly worth surfacing).

**Status:** `OK` if iteration completed and produced parseable output. `ERROR` for non-zero exit, invalid `goto` target, missing target workflow/script during goto resolution, or spawn failure. The error description is human-readable; the precise enum is on `loopx.terminal_outcome` of the parent `loopx.run` span.

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
| `process.stdin.bytes` | int | bytes piped to child stdin |
| `process.stdin.sha256` | string | hex sha256 of stdin payload (absent if 0 bytes) |
| `process.stdin.preview` | string | (only when `LOOPX_OTEL_CAPTURE_STDIN=truncated`) |
| `process.stdin` | string | (only when `LOOPX_OTEL_CAPTURE_STDIN=full`) |
| `process.stdout.bytes` | int | bytes captured from child stdout |
| `process.stderr.bytes` | int | bytes seen on child stderr (passthrough is unaffected) |
| `loopx.spawn.failed` | bool | `true` if the child failed to launch (per SPEC §7.2 child launch / spawn failure) |

**Events:**

- `signal.forwarded` — when loopx forwards SIGINT/SIGTERM to the child process group. Attrs: `signal.name`, `target_pgid`.
- `signal.escalated` — when loopx escalates to SIGKILL after the 5-second grace period.

**Status:** `OK` on exit 0. `ERROR` on non-zero exit or spawn failure.

### 5. Trace context propagation

When otel is enabled, loopx injects `TRACEPARENT` (W3C Trace Context) and `TRACESTATE` (when non-empty) into every child script's environment, scoped to the current `loopx.script.exec` span. This is at the **loopx-injected protocol-variable tier** of SPEC §8.3 — overrides any user-supplied value.

When otel is disabled, loopx neither injects nor strips `TRACEPARENT` / `TRACESTATE`. An inherited value passes through to children unchanged via the normal inherited-env path. This preserves the case where loopx is itself called from an outer-process otel context that already established trace propagation.

`TRACEPARENT` and `TRACESTATE` are added to SPEC §13's reserved-name table as **conditionally script-protocol-protected**: script-protocol-protected when `LOOPX_OTEL_ENABLED=true`, and unreserved otherwise.

The propagator used for serialization follows `OTEL_PROPAGATORS` (default `tracecontext,baggage`).

### 6. Resource attributes

Attached to all telemetry emitted by the loopx process:

| Attribute | Source |
|---|---|
| `service.name` | `OTEL_SERVICE_NAME` if set; otherwise `"loopx"` |
| `service.version` | running loopx version |
| `service.instance.id` | random UUIDv4 generated per run |
| `process.runtime.name` | `node` \| `bun` |
| `process.runtime.version` | runtime version string |
| `host.name` | best-effort hostname (`os.hostname()`) |
| `loopx.project_root` | absolute project root |

User-supplied `OTEL_RESOURCE_ATTRIBUTES` are merged on top of these (standard OTel SDK behavior — user-supplied wins on key conflict, except for `service.name` which is governed by `OTEL_SERVICE_NAME`).

Helper-emitted spans / metrics inherit the resource of whichever process emits them. CLI helpers running inside a loopx-spawned child use the same resource attributes by virtue of inheriting the same env-derived configuration; if the helper instead IPCs back to the parent, it inherits the parent's resource directly.

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

User-side metrics emitted via `counter()` / `histogram()` go through the same exporter and inherit the same resource.

### 8. Sampling

Default sampler: `parentbased_always_on`.

Honors `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`. Sampling decisions are made on `loopx.run`; descendant spans (`loopx.iteration`, `loopx.script.exec`) inherit via parent-based sampling in the standard way.

### 9. Env-var merging into child scripts

When `LOOPX_OTEL_ENABLED=true` **and** `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS=true`, the otel config file's contents are merged into child script environments at a new tier inserted between `RunOptions.env` (existing tier 2) and the local env file (existing tier 3). Updated SPEC §8.3 precedence (highest wins):

1. **loopx-injected protocol variables** — `LOOPX_BIN`, `LOOPX_PROJECT_ROOT`, `LOOPX_WORKFLOW`, `LOOPX_WORKFLOW_DIR`, `LOOPX_TMPDIR`, plus `TRACEPARENT` / `TRACESTATE` when otel is enabled.
2. **`RunOptions.env`** (programmatic API).
3. **Otel config file** (`$XDG_CONFIG_HOME/loopx/otel`) — only when otel is enabled and propagation is on. Includes both `OTEL_*` keys and the `LOOPX_OTEL_*` knobs (so that a script invoking the helpers reads the same modes the parent uses).
4. **Local env file** (`-e` / `RunOptions.envFile`).
5. **Global loopx env** (`$XDG_CONFIG_HOME/loopx/env`).
6. **Inherited system environment** (snapshotted once per run).

When otel is disabled or propagation is off, tier 3 is empty, and `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS=false` keeps OTLP credentials out of child environments. Helpers running in such a child cannot self-export and will no-op (no `TRACEPARENT`, no `LOOPX_OTEL_ENABLED`).

The otel config tier sits below `RunOptions.env` so a programmatic caller can override otel-config values per run (e.g., a test harness that wants `OTEL_TRACES_EXPORTER=none` for one run while keeping global otel config intact).

### 10. Exporter behavior and lifecycle

**Initialization.**

- Deferred until the iteration phase begins. `loopx version`, `loopx env *`, `loopx otel list`/`set`/`enable`/`disable`/`show`, `loopx -h`, `loopx run -h`, `loopx install` (any subcommand other than the actual install execution) do not initialize the SDK.
- `loopx run <target>` initializes the SDK after the pre-iteration sequence (discovery, env-file loading, target resolution, version check, tmpdir creation) and before opening `loopx.run`. SDK initialization failure is non-fatal: a single stderr warning is emitted, the run proceeds with telemetry disabled for its lifetime, and exit code is unaffected.
- `loopx otel test` initializes immediately.

**Export pipeline.**

- Traces: `BatchSpanProcessor` over OTLP HTTP/protobuf (default) or whatever `OTEL_TRACES_EXPORTER` selects. Async, batched, bounded queue. Drops on overflow with the SDK's standard `dropped_spans` warning.
- Metrics: `PeriodicExportingMetricReader` over OTLP HTTP/protobuf (default).
- Logs: not enabled in v1 (no log signal emitted by loopx).

**Shutdown.**

- Triggered after the run reaches a terminal outcome **and after `LOOPX_TMPDIR` cleanup completes** (per SPEC §7.4) but **before** the loopx process exits, throws, or rejects.
- Hard 5-second deadline; expiration prints a single stderr warning ("otel exporter shutdown timed out after 5s") and proceeds. Does not affect exit code, generator outcome, or promise rejection.
- Idempotent (parallel to SPEC §7.2 cleanup idempotence): at most one shutdown attempt per run.

**Failure isolation.**

- All exporter failures, including transport errors, deadline-exceeded, malformed configuration detected at runtime, queue overflow, and SDK-internal exceptions, are caught and discarded. They do not affect the loop, do not change the `loopx.run` terminal outcome, and do not surface in stderr beyond a single summary warning at shutdown.

### 11. Programmatic API integration

`run()` and `runPromise()` produce telemetry as part of normal execution; no signature change for callers who do not configure telemetry.

`RunOptions` gains an optional `otel` field:

```typescript
interface RunOptions {
  // ... existing fields
  otel?: {
    enabled?: boolean;        // overrides LOOPX_OTEL_ENABLED for this run
    parentContext?: string;   // raw TRACEPARENT string to attach as parent of loopx.run
  };
}
```

- **`options.otel.enabled`** — when set, overrides the `LOOPX_OTEL_ENABLED` config value for this run only. Setting `false` suppresses telemetry even if config has it on; setting `true` enables it even if config has it off. A `true` override on a process where `loopx` was imported but no SDK config exists initializes the SDK with default-only configuration (effectively useless without an endpoint, but conformant).
- **`options.otel.parentContext`** — when supplied, `loopx.run` becomes a child of the provided context. This is the path for an embedding application that runs many `runPromise()` calls inside its own outer span and wants the trace tree to remain connected.

`options.otel` is read on the same option-snapshot schedule as other option fields (SPEC §9.1). It sits **after** `options.signal` and is otherwise implementation-defined in order. A throwing getter on `options.otel` or any of its sub-fields is captured and surfaced via the standard pre-iteration error path, identical to other option-snapshot errors.

The pre-first-`next()` consumer-cancellation carve-out (ADR-0004 §1, SPEC §9.1) suppresses `options.otel` snapshot errors the same way it suppresses other captured pre-iteration errors.

The abort-wins-over-pre-iteration-failures rule (SPEC §9.3) applies unchanged: an aborted signal supersedes an `options.otel` snapshot error.

### 12. Scope reservations and additions

**`TRACEPARENT` and `TRACESTATE`** are added to SPEC §13's reserved-name table as conditionally protected (protected when otel is enabled, unreserved otherwise). They are not protocol variables of the loopx core (they exist only when otel is enabled).

**`LOOPX_OTEL_*` keys** in the otel config file are managed by the otel subsystem; user code may read them but should treat them as advisory (they describe the parent's mode, not a contract for the child's behavior). `LOOPX_OTEL_*` is not added to the §13 reserved table because the keys are not loopx-injected from the protocol-variable tier — they reach children only via the §9 tier-3 path.

**`loopx.*` attribute namespace** is reserved. Spans emitted by user code via `withSpan()` / CLI helpers should not set `loopx.*` attributes; values supplied there are silently dropped. (Implementation may instead overwrite — exact behavior is implementation-defined; user code should not depend on either.)

**`loopx.*` metric instrument names** are similarly reserved. User code creating metrics via `counter()` / `histogram()` may not use the `loopx.` prefix; attempts produce a single stderr warning per run and the metric is suppressed.

### 13. Interaction with other SPEC sections

The following SPEC sections need updates when this ADR is accepted; this list is the mechanical update target.

- **§3.4 (Bash Script Binary Access)** — extend the `LOOPX_BIN` example list with the otel helpers (`$LOOPX_BIN otel span ... -- cmd`, `$LOOPX_BIN otel event ...`).
- **§4.3 (Subcommands)** — add `loopx otel` and all its sub-subcommands (config-management and runtime helpers) with synopses. Add to the help-flag short-circuit pattern (`loopx otel -h`).
- **§5.4 (Validation Scope)** — add a row for `loopx otel *`: does not require `.loopx/`, performs no discovery, no validation.
- **§6.4 / §6.5** — add a cross-reference to the new §X covering programmatic helpers; clarify that `output()` / `input()` continue to be the only stdout-protocol helpers and that the otel helpers do not write to stdout (their export channel is OTLP).
- **§7.1 (Basic Loop)** — insert SDK initialization between version check (step 5) and tmpdir creation (step 6); insert SDK shutdown between final cleanup and CLI exit. Both are conditional on `LOOPX_OTEL_ENABLED`.
- **§7.2 (Error Handling)** — add SDK initialization failure as a non-fatal warning. Add SDK shutdown timeout as a non-fatal warning.
- **§7.3 (Signal Handling)** — clarify that SDK shutdown runs after tmpdir cleanup and before signal-exit, and that the 5s otel shutdown deadline runs concurrently with (not in addition to) any subsequent process exit.
- **§7.4 (`LOOPX_TMPDIR`)** — note that otel shutdown follows tmpdir cleanup in the terminal-outcome ordering.
- **§8.1 (Global Storage)** — add a sibling subsection or paragraph noting the new `$XDG_CONFIG_HOME/loopx/otel` config file, with the same fallback rules and concurrent-mutation caveats.
- **§8.3 (Injection)** — replace the precedence list with the 6-tier list in §9 of this ADR. Add `TRACEPARENT` / `TRACESTATE` to the protocol-variable table (with the "only when otel enabled" qualifier).
- **§9.1 / §9.2** — add `options.otel` to the option-snapshot rules (read order, snapshot timing, error path).
- **§9.3** — add SDK shutdown to the cleanup ordering note (cleanup runs before throw/reject; otel shutdown runs after cleanup and before throw/reject).
- **§9.5 (`RunOptions`)** — add the `otel` field to the type and validation rules.
- **§13** — add `TRACEPARENT`, `TRACESTATE` rows. Add a paragraph reserving the `loopx.*` attribute and metric-name namespaces.
- New **§N (Observability)** — full chapter for the §1–§11 content of this ADR (config, helpers, span model, metrics, exporter behavior).

### 14. Open Questions

These are intentionally left open for resolution during ADR review rather than fixed in v1. They do not block the rest of the decision.

1. **Helper IPC vs. independent SDK per helper invocation.** The CLI helpers (`loopx otel span`, etc.) need to emit telemetry from a short-lived child process. Two implementations are conformant under the user-visible contract above: (a) each helper invocation initializes its own SDK from inherited `OTEL_*` env, exports, and shuts down; (b) helpers IPC to the loopx parent over a Unix-domain socket in `$LOOPX_TMPDIR`, and the parent's exporter handles export. (b) is more efficient (one BatchSpanProcessor per run) but more complex. Recommend specifying behavior, deferring choice to implementation, and making it a documented v2 optimization if (a) ships first.

2. **`loopx run --otel` / `--no-otel` inline override flag.** Users who frequently switch between traced and untraced runs might want a per-invocation CLI flag, parallel to `options.otel.enabled`. Suggest deferring: the global toggle plus `OTEL_TRACES_EXPORTER=none` env-var override are sufficient for v1, and adding a flag here re-opens the run-level option-grammar surface that ADR-0004 worked to keep narrow.

3. **`loopx otel test` — confirm-export vs. send-and-shutdown.** Send-and-shutdown is simpler and runs in 5s; confirm-export requires the OTLP backend to surface success acks (not all do reliably). Suggest send-and-shutdown for v1 and document that "OK" means "exported without SDK-side error", not "the backend has indexed the span".

4. **Logs signal.** OTel logs are out of scope for v1 (stderr is the human channel, span events are the structured channel). If users want loopx-emitted log records, that is a v2 ADR.

5. **Trace ID propagation in `loopx.run` attributes.** Should the `loopx.run` span's trace ID be exposed in some non-otel-channel way (e.g., printed to stderr at run start) so that users can correlate without an otel backend search? Suggest no: that re-introduces a stderr-pollution surface that defaults to off but encourages opt-in. The otel test span's stdout already gives that for verification flows.

6. **Capture-attribute payload size cap.** `LOOPX_OTEL_CAPTURE_RESULT=full` on a `claude` invocation can produce attributes in the megabytes. Many backends reject spans whose attribute payload exceeds 32–64KB. Suggest documenting that "full" mode is a footgun for large agent outputs and recommending "truncated" as the operational default when capture is desired.

## Consequences

**Positive:**

- A single trace can cover an entire ralph loop or a multi-workflow review chain. Cross-workflow `goto` paths become legible at runtime, not just at design time.
- Iteration-duration histograms make agent-latency regressions detectable. Exit-code counters make backend reliability comparable across `telegram` / `codex` / `api` / `batch` reviewers.
- Scripts that already use `claude code` (which emits OTel) become end-to-end traceable when `TRACEPARENT` is propagated. No code change in those scripts is required to benefit.
- The helper API lets workflow authors instrument decision points (e.g., the `LOOPX_REVIEWER` switch in `shared/dispatch.sh`) without bolting on an SDK; calls are no-ops by default.
- All of the above is opt-in. A user who never runs `loopx otel enable` pays zero overhead in startup time, env vars seen by scripts, or stderr volume.

**Negative / costs:**

- Adds a non-trivial dependency surface (`@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/exporter-metrics-otlp-proto`, `@opentelemetry/api`). Bundle size and `npm install` time grow even for users who never enable otel; lazy-loading mitigates runtime cost but not install-time cost. Consider making the OTel SDK a `peerDependency` or lazy-loading via dynamic `import()` only when enabled.
- New surface to maintain: another config file, another subcommand tree, a non-trivial span schema that downstream dashboards will start to depend on. Schema changes become breaking changes.
- Helpers running inside child scripts may have meaningful overhead per invocation if implemented as full per-invocation SDK init (see Open Question 1). Workflows that call helpers in tight loops should profile.
- `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS=true` (default) means OTLP credentials reach every spawned script. Workflows that exec untrusted code (uncommon in the current shape but possible) could leak credentials. Calling out the toggle in docs is essential.
- `LOOPX_OTEL_CAPTURE_RESULT=full` will exceed many backends' attribute size limits silently. The mode exists for completeness but the documented operational default is "none" or "truncated".

**Migration:**

- No breaking changes. Existing workflows and scripts run identically when otel is disabled (the default).
- Workflows wanting to instrument: optional, additive — add helper calls; they no-op until otel is enabled.
- Workflows that already set `TRACEPARENT` in `RunOptions.env` for some other purpose: behavior change when otel is enabled, since loopx's protocol-variable tier overrides. Suggest a v1 stderr warning if a `RunOptions.env.TRACEPARENT` is supplied while otel is enabled.

## Test Recommendations

Focus on the cases that are easy to overlook; this is not an exhaustive plan.

- **Default-off semantics.** Verify that without `loopx otel enable`, no SDK initialization occurs, no `TRACEPARENT` is injected into children, no network sockets are opened, and `loopx run` behavior is byte-identical to pre-ADR.
- **Disabled helper no-ops.** Verify `loopx otel span foo -- echo hi` exits 0, prints `hi`, and produces no telemetry when otel is disabled. Verify exit code preservation when the wrapped command exits non-zero.
- **JS helper no-ops with no SDK installed.** Verify that `import { withSpan } from "loopx"; await withSpan("x", async () => 42)` returns 42 in a project that does not have `@opentelemetry/api` installed and has otel disabled.
- **Cross-workflow goto preserves trace continuity.** Run a workflow that goes `A:start → goto B:run → goto C:end → no goto → A:start`. Verify the entire iteration sequence is one trace with one `loopx.run` parent and N `loopx.iteration` children. Verify `entry_kind` is correct on each (`start`, `goto.cross`, `goto.cross`, `loop.reset`).
- **Iteration count attribute matches `-n`.** Run with `-n 3`, verify `loopx.run.iteration_count = 3` and exactly 3 `loopx.iteration` spans.
- **`-n 0` does not initialize SDK.** Verify no spans, no exporter init, no shutdown warning when running with `-n 0`.
- **Signal forwarding produces span events.** Send SIGINT mid-iteration; verify `loopx.script.exec` has a `signal.forwarded` event and (if the grace period elapses) a `signal.escalated` event. Verify `loopx.run.terminal_outcome=signal` and exit code 130.
- **AbortSignal abort during pre-iteration.** Verify abort-wins-over-pre-iteration-failures rule still holds when the only pre-iteration failure is otel SDK init: SDK init failure is non-fatal, so an aborted signal is the surfaced terminal outcome, not the SDK init warning.
- **Exporter unreachable.** Configure `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1` (closed port). Verify the run completes normally, exit code matches the script's behavior, and at most one stderr warning appears.
- **Exporter slow (shutdown timeout).** Configure an endpoint that holds connections open. Verify shutdown returns within ~5s, the warning fires once, and exit code is unaffected.
- **`LOOPX_OTEL_CAPTURE_RESULT` modes.** Verify `none` produces only `bytes` + `sha256` attrs, `truncated` adds `preview` capped to N bytes, `full` adds the entire `result` (and verify the run still completes if the backend rejects an oversized span).
- **Result containing binary data.** Run a script that emits non-UTF-8 bytes as `result`. Verify `bytes` is correct, `sha256` is correct, `preview` (truncated mode) decodes with replacement and does not cause the exporter to fail on encoding.
- **Helper called outside loopx.** Verify `loopx otel span x -- echo hi` from a plain shell with no `TRACEPARENT` runs `echo hi` directly and exits 0. Verify `loopx otel counter foo 1` from a plain shell with otel enabled still emits the metric (no `TRACEPARENT` requirement on metrics).
- **Helper with malformed `--attr`.** Verify `loopx otel event foo --attr badvalue` exits 1 with usage error, regardless of whether otel is enabled — argument validation precedes telemetry-state gating.
- **`TRACEPARENT` override.** With otel enabled, set `RunOptions.env.TRACEPARENT="00-…-00"`; verify loopx's protocol-tier value wins inside the child (the child's `process.env.TRACEPARENT` matches the `loopx.script.exec` span context, not the `RunOptions.env` value), and verify the warning fires.
- **`TRACEPARENT` passthrough.** With otel disabled, set `RunOptions.env.TRACEPARENT="00-…-00"`; verify the value reaches children unchanged (no protection, no override).
- **`options.otel.parentContext`.** Pass a synthetic `TRACEPARENT` string; verify `loopx.run` has the corresponding parent in the trace.
- **`options.otel.enabled=false` overrides config.** With config enabled, run with `otel: { enabled: false }`; verify zero telemetry produced, no `TRACEPARENT` injected.
- **Throwing `options.otel` getter.** Verify the snapshot error is captured and surfaced via the standard pre-iteration error path on first `next()` (or promise rejection for `runPromise()`), not at the call site.
- **`loopx otel test` — config disabled.** Verify exit 1, stderr `disabled — run \`loopx otel enable\` first`.
- **`loopx otel test` — endpoint unreachable.** Verify exit 1 within ~5s with the SDK error on stderr.
- **Helper inside an iteration.** Verify a `withSpan` call inside an `index.ts` script becomes a child of the `loopx.script.exec` span (parent trace ID matches).
- **`loopx.*` attribute namespace reservation.** Verify a user `withSpan("x", s => s.setAttribute("loopx.injected", "v"), ...)` either drops the attribute or overwrites it consistently — pinned behavior is implementation-defined but the test fixes whichever it is to detect regressions.
- **Concurrent runs.** Two concurrent `runPromise()` invocations produce two distinct `loopx.run` spans with distinct `service.instance.id` and disjoint `LOOPX_TMPDIR` (verifying ADR-0004 isolation extends to telemetry).
- **Ralph-shape workload.** Long-running loop with `-n` unset; verify memory does not grow unbounded over hundreds of iterations (BatchSpanProcessor queue is bounded; verify no leak in metric instrument cache).
- **Discovery error before SDK init.** With `.loopx/` containing a name collision (fatal per SPEC §5.2), verify the run fails as before, no SDK init occurs, and no telemetry is emitted (SDK init is gated behind a successful pre-iteration sequence).
- **`loopx env` semantics unchanged.** Verify enabling otel does not change behavior of `loopx env set` / `list` / `remove` and does not cause otel keys to leak into the `loopx env` file.
- **Otel config file failure modes.** Unreadable / invalid-name lines / oversized values — verify the same warnings-and-continue behavior as the env file, and verify SDK starts disabled (if `LOOPX_OTEL_ENABLED` cannot be read) or with partial config (if only some keys parsed).
