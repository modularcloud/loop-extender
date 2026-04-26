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
3. **Inherited `process.env` `OTEL_*` variables** captured by the inherited-env snapshot (per the snapshot-timing paragraph below). The "standard SDK env-var behavior" phrasing describes precedence and interpretation only (file values win on conflict; for keys the file does not specify, the SDK uses the snapshotted inherited value); it does **not** mean the SDK reads live `process.env` at init time. Implementations must compute SDK configuration from the inherited-env snapshot plus the otel config file snapshot, and must not allow post-snapshot `process.env` mutations to affect SDK initialization for that run. This matters most for `runPromise()`, where the inherited-env snapshot is taken synchronously at the call site but SDK initialization happens asynchronously after pre-iteration completes.

The shell environment's `LOOPX_OTEL_ENABLED` is **not consulted** for the parent-SDK enable bit. Only the config file's value or `options.otel.enabled` toggles telemetry on. Inherited shell `OTEL_*` are honored for SDK *configuration* (endpoint, headers, sampler, etc.) once telemetry is enabled.

`RunOptions.env` does not configure the parent SDK; its scope is the child script environment (per SPEC §8.3 / §9.5).

**Failure modes and warning gating** (parallel to SPEC §8.1):

**Strict default-off byte identity (scoped to loopx's own behavior).** When the run's effective `LOOPX_OTEL_ENABLED` resolves to `false`, loopx introduces no observable behavior beyond a build without this ADR: no extra stderr lines, no extra exit-code paths, no SDK initialization, no warnings related to the otel config file, and loopx adds no OTel-related variables to child environments via the §9 tier-3 path. The file is read silently to resolve the enable bit (and an unreadable file is silently treated as absent → disabled), but no warning surfaces unless **either** telemetry is effectively enabled for this run **or** the user explicitly invokes a `loopx otel *` config-management command (where unreadable-file errors are surfaced loudly per §2). Users who never enable otel pay zero stderr cost, including in the case of a broken / unreadable otel config file.

This byte-identity guarantee scopes to **loopx's own behavior**, not the totality of children's environments. Specifically, when otel is disabled, loopx does not strip or sanitize user-supplied lower-tier environment variables: an inherited `TRACEPARENT` / `TRACESTATE` still passes through to children via tier 6 (per §5), and `LOOPX_OTEL_ENABLED` or `OTEL_*` values supplied through any other env tier — inherited shell, global env file, local env file, or `RunOptions.env` — also reach children unchanged. If the user explicitly supplies `LOOPX_OTEL_ENABLED=true` to a child through one of those other tiers, child-side helpers (the `loopx otel` CLI helpers and the JS/TS package helpers, both of which read only inherited env per §2 / §3) may act on that explicit environment and produce telemetry of their own, even when the parent's effective enable bit is `false`. Users who want a hard guarantee that no OTel telemetry surfaces anywhere in the process tree must filter such variables out of children's environments themselves (e.g., via `RunOptions.env` to override or unset specific keys).

Per-mode (warnings fire **only when telemetry is effectively enabled** for the run):

- **File absent:** silent. Effective enable bit is `false` unless overridden by `options.otel.enabled=true`. When overridden, the SDK initializes using whatever `OTEL_*` configuration is reachable from inherited `process.env`; if none, defaults apply (likely no usable endpoint, but conformant).
- **File unreadable:** silent when telemetry ends up disabled. When the effective enable bit is `true` (which can only happen via `options.otel.enabled=true` in this case, since the file's enable bit is unknowable), one stderr warning surfaces per run init; the file is treated as absent and the SDK initializes from inherited env. Permission-denied on the config file is never a fatal error for a default-off feature.
- **Malformed line — no `=` separator** (a non-blank, non-comment line that does not contain `=`): stderr warning; line ignored. Same warn-and-ignore behavior as the global env file in SPEC §8.1.
- **Malformed line — invalid env-var name** (a `KEY=VALUE`-shaped line whose key does not match `[A-Za-z_][A-Za-z0-9_]*`): stderr warning; line ignored.
- **Invalid `LOOPX_OTEL_*` value:** stderr warning; fallback to the default value.

**Snapshot timing.** Two events with different schedules:

1. **Inherited `process.env` capture for otel-relevant keys.** `OTEL_*`, `TRACEPARENT`, `TRACESTATE`, and the `XDG_CONFIG_HOME` / `HOME` used to resolve the otel config file path are read from the same inherited-env snapshot the rest of loopx already takes (SPEC §8.1, §9.1, §9.2): pre-iteration for the CLI, lazy at first `next()` for `run()`, eager synchronously at the call site for `runPromise()`. No new snapshot point is introduced for otel; the SDK and config-resolution paths read from the existing capture.

2. **Otel config file disk read and SDK initialization.** Both happen after the pre-iteration sequence completes successfully (discovery, env-file loading, target resolution, starting-workflow version check, tmpdir creation) and immediately before the first child spawn — for **all** invocation modes (CLI, `run()`, `runPromise()`). Pre-iteration failures cause no config-file read, no SDK initialization, and no otel-related warning, preserving byte-identical pre-ADR behavior on the failure path. For `runPromise()`, the inherited-env capture in (1) happens synchronously at the call site, but the disk read of the config file in (2) is deferred until pre-iteration succeeds asynchronously after return. This separation is what preserves both byte-identity on pre-iteration failures and existing `runPromise()` snapshot semantics.

Mid-run mutations to the config file and post-capture mutations to `process.env` are not picked up.

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
- **`loopx otel disable`** — when the config file already exists, sets `LOOPX_OTEL_ENABLED=false` (rewriting the file in place). When the file is absent, exits 0 without creating it (the default is already disabled, so no record is needed). Idempotent. Does not delete other keys.
- **`loopx otel set <name> <value>`** — mirrors `loopx env set`: same name pattern (`[A-Za-z_][A-Za-z0-9_]*`), same value rules (no `\n` / `\r`), same `KEY="<literal value>"` serialization. Accepts any name matching the pattern (no enforcement of `OTEL_*` / `LOOPX_OTEL_*` prefix, consistent with `loopx env set`); unrecognized names are silently retained but ignored at SDK-init time.
- **`loopx otel remove <name>`** — mirrors `loopx env remove`: silent no-op if absent.
- **`loopx otel list`** — mirrors `loopx env list`: one `KEY=VALUE` per line, sorted lexicographically, no output if empty.
- **`loopx otel show`** — human-readable summary of **effective** configuration: enabled state, effective endpoint, protocol, sampler, service name, capture-result mode, propagate-to-scripts mode, plus a one-line note for any key whose value is non-default. "Effective" here is the merge of the otel config file with inherited `process.env` `OTEL_*` (file values win on conflict, mirroring the parent-SDK config-resolution order in §1) — not just the raw file. Distinct from `list`, which shows only the raw file contents. **Credential-bearing values are redacted in `show`**: any key whose name (case-insensitive) contains any of `HEADERS`, `TOKEN`, `AUTH`, `PASSWORD`, `SECRET`, `CREDENTIAL`, or `BEARER` prints with its value replaced by `<redacted>` while the key name remains visible. The substring list is intentionally narrow and may be extended in future minor versions; adding new substrings is not a breaking change. `loopx otel list` is the unredacted view for users who need raw values. `loopx otel show` does not initialize the SDK and does not require `.loopx/`.
- **`loopx otel test`** — initializes the SDK from current effective config, emits one probe per enabled exporter, runs a 5-second `forceFlush()` + `shutdown()`, prints `OK <endpoint>` to stdout and exits 0 on success, prints the underlying SDK error to stderr and exits 1 on failure. When otel is disabled in config, prints ``disabled — run `loopx otel enable` first`` to stderr and exits 1. The enable bit consulted by `loopx otel test` is the otel config file's `LOOPX_OTEL_ENABLED` only; shell-environment `LOOPX_OTEL_ENABLED` is not consulted, matching the parent-SDK enable rule in §1. `loopx otel test` is the **one documented exception** to exporter-failure isolation (§10): SDK / exporter errors are surfaced on stderr and reflected in the exit code, since the command exists to verify connectivity. "OK" means "the SDK exported without raising an error", not "the backend has indexed the probe".

  **Probes emitted** depend on which exporters are enabled in effective config:

  - **Traces exporter enabled** (any value other than `none`): emit one `loopx.otel.test` span with attributes `loopx.version` and `loopx.test_id` (UUIDv4 generated per invocation).
  - **Metrics exporter enabled** (any value other than `none`): emit one `loopx.otel.test` counter increment of value `1` with attributes `loopx.version` and `loopx.test_id` (the same UUID as the span when both probes are emitted).
  - **Both exporters `none`**: no probes are emitted. The command verifies SDK initialization and config resolution only; on success it prints `OK (no exporter)` and exits 0. This is a deliberate sanity-check no-op, not a failure.

  The printed `<endpoint>` is `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` if set, otherwise `OTEL_EXPORTER_OTLP_ENDPOINT`, otherwise the SDK's default OTLP traces endpoint. When traces are disabled (`OTEL_TRACES_EXPORTER=none`) but metrics remain enabled, the corresponding metrics endpoint is printed instead (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` if set, otherwise `OTEL_EXPORTER_OTLP_ENDPOINT`, otherwise the SDK's default OTLP metrics endpoint). When both traces and metrics exporters are `none`, the literal string `(no exporter)` is printed. The reserved-`loopx.*`-metric-name rule in §12 does not apply to `loopx otel test`'s own probe; the command is part of the loopx subsystem.

`loopx otel` with no subcommand is a usage error (exit code 1) and prints help. `loopx otel -h` / `--help` shows help and exits 0. Each subcommand also accepts `-h` / `--help`, which prints subcommand-specific help and exits 0; the help short-circuit suppresses argument validation, file reads, and SDK initialization for that invocation.

None of the config-management commands require `.loopx/` to exist or are affected by it.

**Config-file read failures.** The runtime rule in §1 (an unreadable otel config file is a non-fatal warning treated as absent) does **not** apply to config-management commands — those commands are explicitly user-invoked, and silently treating an unreadable file as absent could misrepresent state or overwrite a file the user cannot read. For `loopx otel list`, `show`, `test`, `enable`, `disable`, `set`, and `remove`, an unreadable existing config file (e.g., permission denied, I/O error) is **fatal**: loopx prints an error to stderr identifying the path and exits 1. An absent file is not a read failure: `enable` / `set` create the file (mode `0600`) on first call; `disable` / `remove` are silent no-ops on absence; `list` prints no entries; `show` prints the effective state computed from inherited `process.env` `OTEL_*` only (no file contribution — so the output is "all-default" only if no inherited `OTEL_*` are set); `test` reports the disabled state per the rule above.

**Config-file parse-level errors (readable file, invalid content).** Three classes of malformed line, all **not fatal** for config-management commands; all mirror the runtime rule in §1 and the global env file's behavior in SPEC §8.1. Each offending line emits one stderr warning and is otherwise ignored:

- **Lines without `=`** — non-blank, non-comment lines that contain no `=` character (so no `KEY=VALUE` shape). Same warn-and-ignore behavior as SPEC §8.1.
- **Invalid env-var names** — lines that parse as a `KEY=VALUE` shape but whose key does not match `[A-Za-z_][A-Za-z0-9_]*`.
- **Invalid `LOOPX_OTEL_*` values** — recognized keys whose values do not satisfy the per-key validation in §1's recognized-keys table; the line is retained at the file level but the value falls back to the documented default at SDK-init time.

Both warnings — for parse-level errors and for invalid-value fallbacks — are subject to the same runtime gating as other otel warnings (per §1's strict default-off rule and §10's warning policy): they fire only when telemetry is effectively enabled for the run, or when a `loopx otel *` config-management command is explicitly invoked. `list` prints valid lines and skips invalid ones (with warnings); `show` resolves effective configuration from valid lines plus inherited `process.env` `OTEL_*` (with the same warnings); `test` runs against that effective configuration. `enable`, `disable`, `set`, and `remove` rewrite the file preserving valid lines unchanged; they neither scrub nor rewrite invalid lines beyond the specific key being managed by the command. Unreadable file (above) is fatal for config-management commands; readable-but-invalid is warn-and-ignore.

#### Runtime helpers

```
loopx otel span <name> [--attr k=v]... [--status ok|error] -- <command>...
loopx otel counter <name> <value> [--attr k=v]...
loopx otel histogram <name> <value> [--attr k=v]...
```

These are the only CLI helpers in v1. Inline events / attributes / exception-recording on a parent script's span are not exposed as CLI helpers (they would require IPC to the parent loopx process); JS/TS callers can use the in-process programmatic helpers in §3 instead.

**Config-source split.** Config-management commands (`loopx otel enable` / `disable` / `set` / `remove` / `list` / `show` / `test`) read and (where applicable) write the global otel config file. **Runtime helpers (`loopx otel span` / `counter` / `histogram`) ignore the global otel config file entirely** and initialize only from inherited environment. This makes `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS=false` an **environment-propagation boundary**: a child whose env was filtered cannot pull credentials from the otel config file by shelling out to a runtime helper, because the helper has no path to the credentials except through that same filtered env.

**Scope of the propagation boundary.** `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS=false` prevents accidental credential propagation through child environments. It is **not** a sandbox or same-user filesystem security boundary: a script running as the same OS user can still read `$XDG_CONFIG_HOME/loopx/otel` directly or invoke `loopx otel list` to read raw contents. `loopx otel show` exposes an effective summary with credential-bearing values redacted (per the redaction rule above). Workflows that need to defend against same-user untrusted code must rely on OS-level isolation (separate users, containers, etc.); this flag is not a substitute.

- **`loopx otel span <name> ... -- <command>`** — runs `<command>` as a child process. Two modes:

  **Span mode** — when otel is enabled (`LOOPX_OTEL_ENABLED=true` or `1` in the helper's env) **and** a valid W3C `TRACEPARENT` is present in the helper's environment. These are the **only** two gating predicates; "reachability" of an `OTEL_*` endpoint is not a gating predicate. The helper initializes its own SDK from whatever `OTEL_*` configuration is reachable in inherited env (including SDK defaults when no explicit endpoint is set), starts a span as a child of the `TRACEPARENT` context, **spawns** the wrapped command as a child process (does not `exec`), injects both `TRACEPARENT` and, when non-empty, `TRACESTATE` derived from the new span's context into the spawned command's environment (mirroring the parent loopx process's child-env injection in §5), awaits exit, closes the span (status from `--status` if provided, otherwise derived from exit code: 0 → OK, non-zero → ERROR), force-flushes and shuts down the SDK with the same 5-second deadline as the parent (§10), and exits with the same exit code as the wrapped command. Exporter failures during force-flush/shutdown are silently swallowed by the standard failure-isolation rule (§10) — the helper does not surface them on stderr or in the exit code. SIGINT and SIGTERM received by the helper are forwarded to the wrapped command's process group; the helper waits for the command to exit before closing its span and exiting itself.

  **Fall-through mode** — otherwise (otel disabled, no `TRACEPARENT` in env, or `TRACEPARENT` present but malformed — does not parse as a valid W3C trace-context string): the helper spawns `<command>` as a child process and proxies it. No SDK init, no span overhead, no warning. The helper neither injects nor strips `TRACEPARENT` / `TRACESTATE`; any inherited values pass through to the wrapped command unchanged. The helper preserves the wrapped command's exit code byte-for-byte, inherits stdin / stdout / stderr from its parent unchanged, and forwards `SIGINT` and `SIGTERM` received by the helper to the wrapped command's process group exactly as in span mode (without span recording). The helper waits for the wrapped command to exit before exiting itself. The helper does **not** attempt POSIX same-process replacement (`execve`) — v1 deliberately accepts one extra process in the tree and the helper's own PID sitting between caller and wrapped command, in exchange for portability across Node and Bun without native interop. The fall-through contract preserves what scripts typically rely on (exit code, stdout / stderr, signal delivery) but not PID identity or exact process-tree shape; scripts that depend on the latter should not wrap with `loopx otel span` in fall-through-prone contexts. Malformed-`TRACEPARENT` parity with the parent SDK: §4 already silently treats malformed inherited `TRACEPARENT` as absent.

  In both modes, helper stdin/stdout/stderr are inherited from the helper's parent unchanged.

  **Wrapped command spawn failure.** When `<command>` cannot be launched at all — `ENOENT` (command not found), `EACCES` (permission denied), or any other OS-level launch error — the helper exits with the standard POSIX shell convention: **127** on `ENOENT`, **126** on `EACCES`, **1** on other launch errors. A one-line diagnostic identifying the failing command is written to stderr; the exact text format is implementation-defined. In span mode, the helper additionally records the failure on its span (sets ERROR status, calls `recordException`), force-flushes, and shuts down the SDK before exiting; exporter failures during the failure-path flush remain silent. In fall-through mode no SDK is initialized; the spawn failure is reported and the helper exits with the codes above.

  **Standalone use (no ambient `TRACEPARENT`).** `loopx otel span` invoked from a context with no inherited `TRACEPARENT` (e.g., a plain shell, not spawned by a loopx run) is **always** in fall-through mode in v1, regardless of `LOOPX_OTEL_ENABLED` or reachable `OTEL_*` configuration. The helper does **not** create a root span in this case. This keeps the bash CLI helper narrower than the JS `withSpan()` helper (§3), which does create root spans when called outside a parent context — `withSpan()` operates in-process where standalone use is the natural common case, while `loopx otel span` is intended as the in-loopx-run wrapper and stays scoped to that use. Bash users who want ad-hoc standalone-command instrumentation are out of scope for v1.

- **`loopx otel counter <name> <value>`**, **`histogram <name> <value>`** — record a metric data point. Gated **only** on `LOOPX_OTEL_ENABLED` (`true` or `1`; no `TRACEPARENT` requirement; no "reachability" predicate). When the enable bit is present, the helper initializes a short-lived SDK from whatever `OTEL_*` configuration is reachable (including SDK defaults), emits the data point, force-flushes, and shuts down; exporter failures are silently swallowed (§10). When the enable bit is absent (or any other value), the helper exits 0 silently without initializing the SDK. `<value>` must parse as a finite number; malformed value is a usage error (exit code 1) **regardless of enabled state**.

`--attr k=v` may repeat. The argument is split on the **first `=`** in the token: everything before that `=` is the key, everything after is the value (so `--attr msg=a=b` records the value `a=b`). The `k` portion is validated against `[A-Za-z_][A-Za-z_0-9.]*`; the `v` portion is recorded as a string attribute (no type inference in v1). Empty values are allowed: `--attr key=` records an empty-string attribute. A `--attr` argument with no `=` (e.g., `--attr key`) is a usage error (exit code 1). Unrecognized flags and missing required arguments are usage errors (exit code 1) regardless of enabled state.

`--status` (on `loopx otel span`) is a single-occurrence flag: a duplicate `--status` is a usage error (exit code 1). Its value must be exactly `ok` or `error`; any other value is a usage error.

`-h` / `--help` for any helper shows helper-specific help and exits 0.

**Token-usage instrumentation pattern.** A bash script that calls an LLM API records per-call token counts via the metric helpers, e.g. `$LOOPX_BIN otel counter "agent.tokens.input" "$INPUT" --attr provider=claude --attr model=opus-4.7`. For per-call distributions use `histogram`. To attach token counts as attributes on a wrapped span instead, use `loopx otel span` with `--attr "tokens.input=$INPUT"` around a no-op or follow-up command. JS/TS callers use `setAttribute` inside `withSpan` (§3) for the same effect in-process.

**Helpers outside a loopx-spawned context.** `counter` / `histogram` still emit when `LOOPX_OTEL_ENABLED=true` is in the helper's environment; the SDK initializes from whatever `OTEL_*` is reachable, exporter failures are silent. `loopx otel span` is always in fall-through mode outside a loopx-spawned context per the rule above.

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
  flushOtel,
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

await flushOtel();
output({ result: "done" });
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

function flushOtel(): Promise<void>;

function isOtelEnabled(): boolean;

type SpanKind = "INTERNAL" | "SERVER" | "CLIENT" | "PRODUCER" | "CONSUMER";
```

`Span` is a minimal local type that mirrors the OTel API surface (`setAttribute`, `setAttributes`, `addEvent`, `recordException`, `setStatus`, `end`). `SpanKind` is the string-literal union shown above; the default when omitted is `"INTERNAL"`, and any other value is rejected at call time with a stderr warning (at most once per offending value per process — see the §10 warning policy) and the span is created with `INTERNAL`. Both are deliberately not re-exports of `@opentelemetry/api` to keep the helpers no-op-safe even when the OTel package is not installed in the consuming project.

**Runtime validation of attribute values** (when TypeScript types are bypassed — e.g., dynamic JS, `any` casts, untyped JSON pass-through). The `attributes` parameter on `withSpan` / `addEvent` / `recordException` / `counter` / `histogram` and the `setAttribute(key, value)` call accept only `string`, `number`, or `boolean`. At call time:

- A non-`string` `key` (or one not matching `[A-Za-z_][A-Za-z_0-9.]*`) is silently dropped (the attribute is not recorded). No warning.
- A `value` whose type is not `string` / `number` / `boolean` (including `null`, `undefined`, objects, arrays, functions, symbols, BigInt) is silently dropped. No warning.
- A `number` `value` that is `NaN` or non-finite is dropped per the §7 value-rule warning policy (a single per-process warning) only for `counter` / `histogram`; for span attributes, non-finite numbers are silently coerced via the OTel SDK's standard handling.

Silent drop (rather than throwing) preserves the no-op-safe contract: a script that accidentally passes a stale value type does not crash the run.

**No-op semantics when otel is disabled or the SDK is uninitialized:**

- `withSpan(name, fn, opts?)` invokes `fn` directly with a stub `Span` whose methods all return synchronously without effect. `fn`'s return value or returned Promise is passed through unchanged. Exceptions propagate unchanged. The disabled path does not initialize the SDK, allocate spans, or perform exporter work.
- `addEvent`, `setAttribute`, `recordException`, `counter`, `histogram` return synchronously without doing anything.
- `flushOtel()` returns an already-resolved `Promise<void>`.
- `isOtelEnabled()` returns `false`.

**Recording semantics when enabled:**

- `withSpan` parent context is determined by, in order: (1) the innermost in-progress local `withSpan` in the same process, (2) `TRACEPARENT` (and `TRACESTATE`) in `process.env` if no local active span, (3) otherwise root.
- `addEvent`, `setAttribute`, `recordException` operate on **the innermost in-progress local `withSpan` in the same process**. If no local active span exists, they no-op. They cannot mutate spans owned by a different process (e.g., the parent loopx process's `loopx.script.exec` span), since the OTel SDK does not expose a remote-span-mutation surface.
- `counter` / `histogram` use the SDK's meter; metric instruments are lazily created and cached by instrument name within the process meter (standard OTel behavior). Different attribute sets recorded against the same name share one instrument.
- `flushOtel()` awaits `forceFlush()` on the trace and metric providers with a 5-second deadline (matching §10's per-run flush deadline). Resolves on success or timeout; never rejects. Calling it before `output()` is the documented pattern for scripts that want guaranteed export of their telemetry before `process.exit(0)`. Concurrent calls share a single in-flight flush.
- `isOtelEnabled()` returns `true` when the process-wide SDK has been initialized in this process. It does not reflect per-run gating: a process whose SDK was initialized by an earlier or concurrent run continues to return `true` even while a specific run has telemetry suppressed via `options.otel.enabled=false`. Per-run gating (§11) governs whether loopx emits its own `loopx.*` spans for that run; user-side `withSpan` / `counter` / `histogram` calls in the same process continue to record against the shared SDK regardless.

**`withSpan` lifecycle and error handling (when enabled):**

- The span starts before `fn` is invoked and ends once `fn`'s return value settles. For a synchronous return, the span ends synchronously after `fn` returns. For a returned Promise, the span ends when the Promise settles (resolves or rejects). `withSpan` returns the same Promise identity (no wrapping or `.then`-chained replacement); a caller using `Promise.race` or identity checks observes the original Promise object. To observe settlement without wrapping the returned identity, the implementation may attach a side-effect-only handler to the original Promise (e.g., `originalPromise.then(onFulfilled, onRejected)` whose result is discarded); doing so attaches a rejection handler to the underlying Promise, which in Node suppresses the `unhandledRejection` event for that Promise. Callers who rely on `unhandledRejection` for error visibility on the Promise returned by `withSpan` should attach their own handler — `withSpan`'s automatic `recordException` / `setStatus(ERROR)` behavior is the documented surface for visibility into the rejection.
- When `fn` throws synchronously or its returned Promise rejects, `withSpan` automatically calls `recordException(err)` on the span and sets the span status to `ERROR` (with `description` set to the error's `message` when one is available) before ending the span. The thrown / rejected value then propagates unchanged to the caller. An explicit `setStatus` call inside `fn` is preserved — automatic ERROR status is applied only when `fn` did not set its own terminal status before throwing.
- A `withSpan` whose `fn` returns a thenable that never settles never ends its span; this matches OTel SDK behavior and is not a leak loopx introduces.

**Interaction with `output()` (child processes).**

`output()` semantics (SPEC §6.4) are unchanged by this ADR. `output()` remains synchronous, flushes stdout, and calls `process.exit(0)`; no code after it runs. The OTel SDK is **not** flushed by `output()`. A child script that emits telemetry via `withSpan` / `counter` / `histogram` and *then* calls `output()` will lose any spans or metrics still queued at the moment of `process.exit(0)` — `process.on('exit')` hooks cannot run asynchronous work, so relying on them would not drain the queue.

`flushOtel()` is the explicit helper for scripts that need guaranteed export before `output()`. The pattern is:

```typescript
await flushOtel();
output({ result: "..." });
```

A flush timeout produces a single stderr warning per process — explicit `flushOtel()` is a debug-aid surface, so a deliberate user call is not silenced even though the parent's per-run `forceFlush()` timeout is (see §10's warning policy). The warning does not affect the exit code; `flushOtel()` resolves either way.

Scripts that exit naturally (returning from `main` without calling `output()`) rely on `beforeExit`-driven SDK shutdown installed at process-wide SDK init; that path can run async work and drains the queue.

When the child-process OTel SDK has not been initialized, `flushOtel()` is a no-op: it returns an already-resolved Promise without initializing the SDK or performing exporter work.

**SDK initialization timing in the JS API:**

- The SDK is **process-wide and idempotent**. It initializes lazily on the first call to a **telemetry-producing** helper — `withSpan`, `counter`, or `histogram` — *or* the first `run()` / `runPromise()` invocation that observes effective `LOOPX_OTEL_ENABLED=true` (or `options.otel.enabled=true`). `flushOtel()` and `isOtelEnabled()` do **not** initialize the SDK; calling either before any other helper or run leaves the SDK uninitialized (and they behave as no-ops in that state per the no-op semantics above). `addEvent`, `setAttribute`, and `recordException` operate on the innermost in-progress local `withSpan` — when no local active span exists they no-op, and they do **not** initialize the SDK in that case. Once initialized, the SDK persists for the process lifetime; subsequent inits are no-ops regardless of differing config.
- Concurrent `run()` / `runPromise()` invocations in the same process share the SDK and produce distinct `loopx.run` spans distinguished by `loopx.run.id` (§4).
- A process that imports the helpers but never calls a telemetry-producing helper and never runs a loop pays zero startup cost.

**Config source for JS/TS helpers.** Helper-driven SDK initialization (i.e., the first telemetry-producing helper call — `withSpan`, `counter`, or `histogram` — when no `run()` / `runPromise()` has yet initialized the SDK in this process) reads configuration **only from inherited `process.env`**; it does **not** read the global `$XDG_CONFIG_HOME/loopx/otel` config file. This is the same constraint that applies to CLI runtime helpers (§2), and it preserves the `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS=false` propagation boundary (§2): a loopx-spawned child whose env was filtered cannot bypass the filter by importing `loopx` and calling helpers directly. The global otel config file is read only by `run()` / `runPromise()` and the loopx CLI run path; helper calls in the same process inherit the SDK that path initialized, but helper calls in a process that never enters that path (a child script, a standalone user program) initialize from inherited env alone. Helper enable parsing matches the parent's: `LOOPX_OTEL_ENABLED=true` or `LOOPX_OTEL_ENABLED=1` enables; any other value (including absence) leaves the helpers in no-op mode.

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

A `loopx.iteration` span is created per spawn attempt. The 1-based span ordinal counts every spawn (including failed spawns); the close-time `loopx.run.iteration_count` attribute reflects the SPEC §7.1 counter, which only increments after successful output parsing. The two values diverge whenever any spawn attempt within the run terminates before stdout is successfully parsed — spawn failure, non-zero child exit, signal termination, abort, or consumer cancellation while a child is active. See the `loopx.iteration` section below.

#### `loopx.run`

Created on entry to the iteration phase, **after the entire pre-iteration sequence completes** (discovery, env-file loading, target resolution, starting-workflow version check, tmpdir creation) and immediately before the first child spawn. Closed on terminal outcome. This is the single, normative ordering.

Pre-iteration failures (discovery error, target resolution error, env-file failure, tmpdir-creation failure) occur before SDK initialization and are not represented in OTel; they remain stderr-only per existing SPEC sections. The non-fatal starting-workflow version-mismatch warning (per SPEC §3.2) is also pre-SDK-init and is not represented in OTel — note that this is a warning, not a failure. The `version_mismatch.warning` event applies only to **cross-workflow** version checks fired during iteration (where the SDK is live); it appears on the `loopx.iteration` span — see below.

**Parent context.** When OTel is enabled and an inherited `TRACEPARENT` parses as a valid W3C trace-context string, `loopx.run` is created as a child of that inherited context (and inherits `TRACESTATE` if also present). When no inherited `TRACEPARENT` is present or it is malformed, `loopx.run` is a root span. `options.otel.parentContext` (§11), when supplied, takes precedence over inherited `TRACEPARENT` **and** fully replaces the inherited trace context — inherited `TRACESTATE` is ignored in that case (it is part of the inherited trace context that the explicit `parentContext` replaces, and v1 does not provide a separate option for supplying `TRACESTATE`). Inherited `TRACEPARENT` / `TRACESTATE` are captured during the inherited `process.env` snapshot (per §1) — pre-iteration for the CLI, lazy at first `next()` for `run()`, eager synchronously at the call site for `runPromise()` — and are consumed at SDK init when `loopx.run` is created. The capture point and the consumption point can be separated by async work: for `runPromise()`, the capture happens at the call site, but pre-iteration runs after return and SDK init follows it. The option-snapshot schedule applies only to `options.otel.parentContext`, which is part of the option object. A malformed inherited `TRACEPARENT` is silently treated as absent (no warning), matching OTel SDK propagator behavior; only an invalid `options.otel.parentContext` surfaces via the pre-iteration error path (§11).

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
| `loopx.iteration_count` | int | close | SPEC §7.1 iteration counter — count of spawns whose stdout was successfully parsed (the value used for `-n` / `maxIterations` accounting). May be less than the largest `loopx.iteration` ordinal when one or more spawn attempts terminated before parse (spawn failure, non-zero exit, signal termination, abort, or consumer cancellation while a child is active). |
| `loopx.exit_code` | int | close | CLI exit code; 0 on normal completion, 1 on most errors, 128+signal on signal exit. Set only when `loopx.invocation = cli`; omitted on programmatic invocations (`run()` / `runPromise()`). |
| `loopx.terminal_outcome` | string | close | `stop` \| `max_iterations` \| `non_zero_exit` \| `invalid_goto` \| `spawn_failure` \| `signal` \| `abort` \| `consumer_cancellation` |

**Events:**

- `signal.received` — attrs: `signal.name` (`SIGINT` \| `SIGTERM`)
- `abort.received` — for programmatic `AbortSignal`
- `loop.reset` — emitted on `loopx.run` only when a target finishes without `goto` **and** execution actually returns to the starting target for a subsequent iteration. When a target finishes without `goto` and the next planned iteration would be the start but `maxIterations` (or any other terminal condition) ends the run instead, no `loop.reset` event fires — the iteration that finished without `goto` simply produces no transition, and `loopx.run` closes with the corresponding `terminal_outcome`.

**Status:** `OK` on `stop` / `max_iterations` / `consumer_cancellation`. `ERROR` with description on every other terminal outcome.

#### `loopx.iteration`

One span per spawn attempt. Parent: `loopx.run`. Created immediately before child spawn — so a spawn that fails to launch (per SPEC §7.2) still produces a `loopx.iteration` span that records the failure. Closed after structured output parsing **and** transition / terminal-decision resolution — that is, after `goto` validation (target syntax, target workflow / script existence in cached discovery), `goto.transition` event emission, or the determination that the iteration ends without a transition (loop reset or terminal `stop` / `maxIterations`). When a failure prevents parsing (non-zero child exit, spawn failure, termination by signal / abort / consumer cancellation), the iteration span closes after that failure is recorded. This ordering is normative: invalid-`goto` errors, missing target workflow / script during goto resolution, and `goto.transition` events all fire on the iteration span before it closes.

**Iteration ordinal vs. SPEC §7.1 iteration counter.** The `loopx.iteration` span attribute is a 1-based ordinal of spawn attempts within the run, incrementing once per `loopx.iteration` span. The close-time `loopx.run.iteration_count` attribute records the SPEC §7.1 counter — the count of spawns whose stdout was successfully parsed (i.e., the value used for `-n` / `maxIterations` accounting). The two values diverge whenever a spawn attempt terminates before stdout is successfully parsed: spawn failure, non-zero child exit, signal termination, abort, or consumer cancellation while a child is active. After such a span, the next spawn (if any) increments the ordinal but the counter remains until that next iteration parses successfully. A run whose final span fails for any of these reasons leaves `loopx.run.iteration_count` strictly below the largest `loopx.iteration` ordinal.

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
| `loopx.output.has_result` | bool | (close-time) `true` iff `Output.result` is a defined string after SPEC §2.3 parsing and coercion (`String(value)` for non-strings; `null` becomes `"null"`); empty stdout parses as `{ result: "" }`, so `has_result` is `true` with `result.bytes == 0` |
| `loopx.output.has_goto` | bool | (close-time) `true` iff `Output.goto` is a defined string after parsing; a non-string `goto` is treated as absent per SPEC §2.3, so `has_goto` is `false` in that case |
| `loopx.output.stop` | bool | (close-time) `true` iff `Output.stop === true`; any other value (including `false`, truthy strings, numbers) is `false` per SPEC §2.3 |
| `loopx.output.goto` | string | (close-time) goto target string; omitted when `has_goto` is `false` |
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

**Status:** `OK` if iteration completed and produced parseable output. `ERROR` for non-zero exit, invalid `goto` target, missing target workflow / script during goto resolution, spawn failure, or termination by signal / abort / consumer cancellation while a child is active.

**Consumer-cancellation cases.** Sub-cases:

1. **Cancellation while a child is active** (`break` mid-iteration, `.return()` / `.throw()` while the child has not yet exited). `terminal_outcome = consumer_cancellation`; `loopx.run` closes `OK`. The active child is killed per SPEC §9.1; the open `loopx.script.exec` and `loopx.iteration` spans both close as `ERROR` with no `loopx.output.*` attributes.
2. **Cancellation between non-final iterations** (after a non-final iteration yielded its `Output`, before the consumer requests the next one, while no natural terminal outcome has been determined). `terminal_outcome = consumer_cancellation`; `loopx.run` closes `OK`. No new `loopx.iteration` span is created; the previously-closed iteration retains whatever status it already had (`OK` if its output parsed, `ERROR` otherwise).
3. **`.return()` / `.throw()` after the final terminal `Output` was yielded.** A natural terminal outcome (`stop` or `max_iterations`) has already been determined and recorded. `loopx.run` closes with that **already-determined** `terminal_outcome` (and the corresponding status — `OK` for `stop` / `max_iterations`); consumer cancellation does not re-classify the outcome. The deferred steps 3–5 of the §10 terminal sequence (tmpdir cleanup → close `loopx.run` → per-run `forceFlush()`) run when the generator is driven to settlement.
4. **Pre-first-`next()` cancellation under `run()`** (per SPEC §9.1 carve-out). No pre-iteration work runs, so SDK initialization never happens and no telemetry is emitted at all — byte-identical to the pre-ADR behavior.

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

**Attribute behavior on spawn failure / signal termination.**

- `process.pid` — omitted on spawn failure (the child PID never came into existence); set as soon as the child is launched in all other cases.
- `process.exit_code` — **omitted** on spawn failure (`loopx.spawn.failed=true`). On termination by signal (whether forwarded by loopx or delivered by an external sender, including SIGKILL escalation), set to `128 + signal_number`, matching the shell convention loopx uses for `loopx.run.exit_code` and SPEC §7.3. Otherwise the wait-pid exit code.
- `process.stdout.bytes` / `process.stderr.bytes` — reflect bytes captured up to the termination point; set to 0 on spawn failure.
- `loopx.spawn.failed` — `true` only when the child failed to launch; `false` (or omitted, implementation-defined for boolean false) in every other terminal path including signal termination.

**Events:**

- `signal.forwarded` — when loopx forwards SIGINT/SIGTERM to the child process group. Attrs: `signal.name`, `target_pgid`.
- `signal.escalated` — when loopx escalates to SIGKILL after the 5-second grace period.

**Status:** `OK` on exit 0. `ERROR` on non-zero exit, spawn failure, or termination by signal / abort / consumer cancellation.

### 5. Trace context propagation

When otel is enabled, loopx injects `TRACEPARENT` (W3C Trace Context) and, when non-empty, `TRACESTATE` into every child script's environment, scoped to the current `loopx.script.exec` span. This is at the **loopx-injected protocol-variable tier** of SPEC §8.3 — it overrides any user-supplied value of the same name. This injection happens regardless of `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS`; that flag governs only `OTEL_*` / `LOOPX_OTEL_*` propagation, not trace linkage.

When otel is disabled, loopx neither injects nor strips `TRACEPARENT` / `TRACESTATE`; values supplied through any non-protocol environment tier (`RunOptions.env`, local env file, global loopx env, or inherited shell — tiers 2 and 4–6 of §9) merge normally per SPEC §8.3 and reach children unchanged. This preserves the case where loopx is itself called from an outer-process otel context, and aligns with the strict default-off byte-identity guarantee in §1 (loopx adds no behavior of its own when telemetry is disabled).

`TRACEPARENT` and `TRACESTATE` are added to SPEC §13's reserved-name table as **conditionally script-protocol-protected**: protected when `LOOPX_OTEL_ENABLED=true`, and unreserved otherwise.

**`OTEL_PROPAGATORS` does not gate child-env injection.** loopx's injection of `TRACEPARENT` / `TRACESTATE` into child script environments is **mandatory whenever otel is enabled**, regardless of the value of `OTEL_PROPAGATORS`. `OTEL_PROPAGATORS` configures which propagators the SDK uses for inbound and outbound propagation at the SDK level; it does not control loopx's protocol-tier child-env injection. A user who sets `OTEL_PROPAGATORS=baggage` (excluding tracecontext) — or any other value that excludes `tracecontext` — still gets `TRACEPARENT` / `TRACESTATE` written into every child script's environment. The trace-linkage guarantee is independent of `OTEL_PROPAGATORS`. The serialization format used to write `TRACEPARENT` is always W3C tracecontext.

Baggage propagation is out of scope for v1: `BAGGAGE` is not injected into child environments and is not added to the §13 reserved table, regardless of whether `OTEL_PROPAGATORS` includes `baggage`. A user who opts into baggage at the SDK level still gets only `TRACEPARENT` / `TRACESTATE` from loopx's child-env injection.

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

**Counter semantics.**

- `loopx.iteration.count` increments **once per spawn attempt**, matching the `loopx.iteration` span ordinal in §4 — including spawns that terminate before their stdout is parsed (spawn failure, non-zero exit, signal termination, abort, or consumer cancellation while a child is active). The `outcome` attribute is `ok` for spawns whose stdout was successfully parsed and `error` for every other terminal path (spawn failure, non-zero exit, signal termination, abort, consumer cancellation while a child is active). The sum of this counter across a run therefore equals the largest `loopx.iteration` ordinal, which may exceed `loopx.run.iteration_count` — the latter is the SPEC §7.1 counter that increments only after successful parse.
- `loopx.script.exit_code` increments **once per child process that actually launched and reached an exit status**. Spawn failures (where the child never came into existence) are excluded from this counter — they are tracked separately by `loopx.spawn.failed`. The `exit_code` attribute uses the same shell convention as the corresponding span attribute (§4 `process.exit_code`): the wait-pid exit code on normal termination, and `128 + signal_number` on termination by signal (whether forwarded by loopx or delivered by an external sender, including SIGKILL escalation).

Histogram bucket boundaries are SDK defaults unless `OTEL_*` overrides apply. The metric reader is the OTel SDK default for OTLP (periodic exporting).

User-side metrics emitted via `counter()` / `histogram()` go through the same exporter and inherit the same resource. The `loopx.` prefix is reserved (§12).

**Value rules.** `counter()` (CLI and JS/TS) accepts only **non-negative finite numbers** per OTel monotonic-counter semantics; negative values, `NaN`, and non-finite values are dropped under the warning rule below. `histogram()` accepts any finite number (positive, zero, or negative); `NaN` and non-finite values are dropped under the same warning rule.

**Parsing vs value-rule split (CLI helpers).** The CLI helpers' `<value>` argument must always parse as a finite number — a malformed argument is a usage error (exit code 1) regardless of enabled state, per §2. This is a parser-level error and runs unconditionally. After parsing succeeds, the OTel value-rule check (negative counter, non-finite counter / histogram) and its single per-process stderr warning run **only when the helper is enabled** (`LOOPX_OTEL_ENABLED=true` or `1` in the helper's env). When the helper is disabled, value-rule violations are silently ignored alongside the rest of the data-point work — consistent with the helper no-op-when-disabled contract (§2). For the JS/TS helpers, "enabled" means the process-wide SDK is initialized; calls before initialization no-op silently (per the no-op semantics in §3) and value-rule warnings do not fire.

**`loopx.tmpdir.cleanup_warning` scope.** Increments only for cleanup warnings emitted during the **terminal cleanup** pass (per SPEC §7.4, after SDK init and before per-run flush — see the §10 terminal ordering). Cleanup warnings emitted during **tmpdir-creation-failure handling** (per SPEC §7.4 creation order) occur before SDK init and remain stderr-only; they are not represented in OTel.

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
- All `OTEL_*` keys consulted by the parent SDK at init: the union of the otel config file's `OTEL_*` keys and the inherited `process.env` `OTEL_*` keys at snapshot time, with config-file values winning on conflict. Inherited `OTEL_*` would already reach children at tier 6, but propagating them at tier 3 ensures a consistent SDK configuration is delivered to children even when the local env file (tier 4) or global env file (tier 5) sets unrelated keys at higher precedence than tier 6. **`RunOptions.env` (tier 2) still overrides tier-3 entries** on key conflict, so a programmatic caller can per-run override individual `OTEL_*` knobs for children without touching the otel config file (e.g., a test harness setting `OTEL_TRACES_EXPORTER=none` in `RunOptions.env` to suppress child-side exports).
- Unrecognized keys in the otel config file (those matching `[A-Za-z_][A-Za-z0-9_]*` but not `OTEL_*` and not on the recognized `LOOPX_OTEL_*` list) are **not** propagated. They are silently retained at the file level (per `loopx otel set`, §2) but have no semantic meaning to loopx or the SDK and are not surfaced to children.

**When tier 3 is empty:** any of (a) effective `LOOPX_OTEL_ENABLED` is `false`, (b) `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS` is `false`, or (c) otel is disabled outright. In all three cases, no `OTEL_*` / `LOOPX_OTEL_*` are propagated by loopx. Trace linkage (`TRACEPARENT` / `TRACESTATE`) is still injected at tier 1 when otel is enabled, regardless of propagation mode; when otel is disabled, no `TRACEPARENT` is injected (an inherited value passes through via tier 6).

Helpers running inside a child where propagation is off receive `TRACEPARENT` (and `TRACESTATE` when present) but no `LOOPX_OTEL_ENABLED`, no `LOOPX_OTEL_*`, and no `OTEL_*` from the otel config file. Such child-side helpers therefore stay disabled by default — `propagation=false` is a clean propagation boundary, not a partial-propagation mode. They self-export only when `LOOPX_OTEL_ENABLED=true` (or `1`) reaches them via another env tier (local env file, global loopx env, or inherited shell), which the user wires explicitly. When the enable bit is missing, child helpers no-op silently. When the enable bit is present, helpers initialize their SDK from whatever `OTEL_*` configuration is reachable (including SDK defaults if no explicit endpoint is set); exporter failures are silently swallowed by the standard failure-isolation rule (§10) — there is no separate "reachability" predicate. Span-mode entry for `loopx otel span` additionally requires a valid `TRACEPARENT` (per §2). Trace linkage to agent CLIs that emit OTel themselves (e.g., `claude code`) continues to work via `TRACEPARENT` regardless, since those CLIs read trace context directly without going through the loopx helper surface.

The otel config tier sits below `RunOptions.env` so a programmatic caller can override **child-side** OTel configuration per run via `RunOptions.env` — for example, a test harness setting `OTEL_TRACES_EXPORTER=none` in `RunOptions.env` to suppress child-side exports while keeping global otel config intact. `RunOptions.env` does **not** configure the parent loopx SDK (as stated in §1); the parent SDK is governed by the otel config file and `options.otel` (§11). To suppress parent-side telemetry for a single run, set `options.otel.enabled=false`. v1 does not provide a programmatic surface for overriding individual parent-SDK `OTEL_*` knobs per run; callers needing that must mutate `process.env` before invoking `run()` / `runPromise()`, subject to the inherited-env snapshot timing in SPEC §8.1 / §9.1 / §9.2.

The otel config tier sits **above** the local env file (`-e`), the global loopx env file, and inherited system env by deliberate design — the global otel config is the canonical source of OTel configuration for a run, and lower tiers (a project's local `-e` env file, the global loopx env, or shell-inherited env) must not silently shadow it. This inverts the normal "local beats global" pattern that applies among tiers 4–6 for non-OTel keys, and is intentional. CLI users who need per-project OTel overrides edit the global otel config (`loopx otel set …`); programmatic callers use `RunOptions.env`. There is no CLI surface for per-run OTel override beyond editing the otel config file.

### 10. Exporter behavior and lifecycle

**Initialization.**

- Deferred until the iteration phase begins. `loopx version`, `loopx env *`, `loopx otel list`/`set`/`enable`/`disable`/`show`, `loopx -h`, `loopx run -h`, and **`loopx install` in all forms** do not initialize the SDK. `loopx install` (including the post-commit `npm install` pass and `.gitignore` synthesis under SPEC §10.10) is out of scope for telemetry — the only `loopx otel ...` command that initializes the SDK eagerly is `loopx otel test`.
- `loopx run <target>` (and the programmatic equivalents) initialize the SDK after the pre-iteration sequence completes (discovery, env-file loading, target resolution, starting-workflow version check, tmpdir creation) and immediately before opening `loopx.run` — i.e., immediately before the first child spawn.
- SDK initialization failure is non-fatal: a single stderr warning is emitted (per the warning policy below), the run proceeds with telemetry disabled for its lifetime, and exit code is unaffected.
- **Init failure is per-run, not per-process.** A failed init disables telemetry only for the run that triggered the attempt. Subsequent runs in the same process whose effective `LOOPX_OTEL_ENABLED` resolves true will attempt SDK init again; once any attempt succeeds, the SDK is process-wide and persists per the rule below. The SDK-initialization-failure stderr warning is deduped to at most once per process regardless of how many subsequent attempts also fail.
- `loopx otel test` initializes immediately, bypassing the deferred path.
- The SDK is process-wide. Once initialized, it persists for the process lifetime.
- **Process-wide SDK vs per-run child propagation.** The SDK initializes once per process from the snapshot of the run that triggered initialization, and is immutable thereafter — later mutations to the otel config file are not picked up by the parent SDK. Per-run child env propagation (§9 tier 3), however, is computed from **each run's own snapshot** of the otel config file, not from the SDK's init-time config. The two can diverge if the file mutates between Run A (which initialized the SDK) and Run B in the same process: Run B's children receive Run B's snapshot in their env, while Run B's parent-side `loopx.*` spans are exported by the SDK Run A initialized. This is intentional — keeping each run's children consistent with the file state at the run's own start time is more useful for long-lived host processes than freezing children at the first run's config. Host programs that need parent / children consistency across runs should not mutate the otel config file mid-process; restart the process to pick up file changes parent-side.
- **Bun runtime.** SDK initialization on Bun uses the OpenTelemetry Node SDK (which is the only SDK distribution loopx requires implementations to support in v1). If that SDK fails to initialize on Bun (e.g., because of incompatibility with the current Bun release), the failure is treated as any other SDK initialization failure: one stderr warning, telemetry disabled for the run's lifetime, exit code unaffected.

**Supported exporters.**

In v1, only `otlp` (default) and `none` are supported values for `OTEL_TRACES_EXPORTER` and `OTEL_METRICS_EXPORTER`. `console`, `stdout`, and any other exporter that writes to the script's stdout are explicitly **unsupported**, because stdout is the structured-output protocol channel (SPEC §2.3 / §6.4) and exporter writes would corrupt parsing — both for the parent loopx process (whose stdout is the loop driver itself in CLI mode) and for child-side helpers that inherit a script's stdout. An unsupported value falls back to `otlp` with a single stderr warning per offending key.

**Export pipeline.**

- Traces: asynchronous, batched export with a bounded queue over OTLP HTTP/protobuf (default) or `none`. Implementations that use the standard OTel `BatchSpanProcessor` satisfy this requirement. Drops on queue overflow per the failure-isolation rule below; the SDK's standard `dropped_spans` warning is suppressed.
- Metrics: periodic exporting metric reader over OTLP HTTP/protobuf (default) or `none`. Implementations that use the standard OTel `PeriodicExportingMetricReader` satisfy this requirement.
- Logs: not enabled in v1.

**Per-run flush vs. process-exit shutdown.**

These are two distinct lifecycle events with different scope:

- **Per-run flush.** Each individual run reaching a terminal outcome (CLI exit, `run()` settling, `runPromise()` resolving or rejecting, consumer cancellation, abort) closes its own spans and `await`s `forceFlush()` on the trace and metric providers with a 5-second deadline. `forceFlush()` does **not** shut down the SDK; concurrent runs in the same process are unaffected. `forceFlush()` runs whether the run is normal or error: throwing from `run()` or rejecting from `runPromise()` flushes the run's spans but does not shut down the shared SDK. A `forceFlush()` timeout does not produce a separate stderr warning; pending telemetry is left to the eventual process-exit shutdown (or is lost if the process is killed before then). **Per-run `forceFlush()` is the one reliable export guarantee for `run()` / `runPromise()` settlement** — host programs that exit the process synchronously after a run settles cannot rely on process-exit shutdown to drain anything beyond what `forceFlush()` already wrote.
- **Process-exit shutdown.**
  - **CLI:** the run terminal outcome and the process exit coincide. loopx awaits SDK `shutdown()` explicitly after per-run `forceFlush()` and before the actual process exit. The deadline is 5 seconds.
  - **`output()` (child SDK):** `output()` does not flush or shut down the OTel SDK; see §3 and `flushOtel()`. `output()` semantics in SPEC §6.4 are unchanged.
  - **Programmatic API host process:** loopx installs `beforeExit` and signal-driven (`SIGINT` / `SIGTERM`) hooks that attempt SDK `shutdown()` best-effort. **`process.on('exit')` is not used for shutdown**, because Node disallows asynchronous work in that hook. Host programs that exit synchronously after `runPromise()` resolves (e.g., `await runPromise(...); process.exit(0)`) may lose pending exports beyond what per-run `forceFlush()` already wrote — `forceFlush()` is the reliable guarantee, not process-exit shutdown.
- **Shutdown deadline.** Hard 5-second deadline; expiration prints a single stderr warning ("otel exporter shutdown timed out after 5s") and proceeds. Does not affect CLI exit code, generator outcome, or promise rejection.
- **Idempotence.** SDK shutdown is idempotent (parallel to SPEC §7.2 cleanup idempotence): at most one shutdown attempt per process.

**Terminal ordering (normative).** For a run that reached SDK initialization, the per-run terminal sequence runs in this exact order; no step is skipped or reordered:

1. The active child process (if any) has exited and its `loopx.script.exec` span is closed.
2. Output parsing / transition resolution completes (or is skipped on failure paths per §4); the `loopx.iteration` span is closed.
3. **`LOOPX_TMPDIR` cleanup runs** per SPEC §7.4. Any cleanup-warning condition increments the `loopx.tmpdir.cleanup_warning` counter (§7) **during this step**, while the SDK is still live, so the metric is queued before the per-run flush below.
4. The `loopx.run` span is closed with its terminal-outcome attributes (`loopx.run.iteration_count`, `loopx.terminal_outcome`, and `loopx.exit_code` for CLI).
5. **Per-run `forceFlush()`** with a 5-second deadline drains all spans (including `loopx.run`) and metrics queued in steps 1–4.
6. **CLI only:** SDK `shutdown()` runs with a 5-second deadline, then the process exits with the appropriate code.

**When the terminal sequence runs for `run()`.** The terminal sequence above runs when the run reaches a terminal outcome — for CLI and `runPromise()`, that is at the natural end of execution. For `run()` (async generator), terminal-outcome cleanup (steps 3–5 above, with step 4 closing `loopx.run`) runs when the generator is **driven to settlement** (`{ done: true }`, `.return()`, `.throw()`, or a `for await` loop that completes), **not** when the final terminal `Output` is yielded. The existing SPEC §7.4 / §9.1 rule — "the final yielded `Output` is not itself settlement; a caller that consumes the final output and abandons the generator may leak the tmpdir" — is preserved unchanged. The `loopx.iteration` span for the final iteration (step 2 above) closes when its iteration ends, before the final yield, since it has no dependency on settlement; only the `loopx.run` span close, tmpdir cleanup, and per-run flush wait for settlement. A consumer that abandons the generator after the final yield therefore leaks both `LOOPX_TMPDIR` and any spans / metrics queued by steps 3–5 (the `loopx.run` span never closes; pending exports are not flushed by loopx, only by the eventual process-exit shutdown). This is the same leak surface SPEC already documents for tmpdir.

**Telemetry outcome on `.return()` / `.throw()` after the final terminal `Output`.** When the loop body has already determined a natural terminal outcome (`stop` or `max_iterations`) and yielded its final `Output`, and the consumer then calls `.return()` or `.throw()` to settle the generator, `loopx.run` closes with the **already-determined** `terminal_outcome` (`stop` or `max_iterations`), not `consumer_cancellation`. Consumer cancellation as a terminal outcome applies only when cancellation interrupts the loop **before** a natural terminal outcome was determined — i.e., while a child is still active, or between iterations before the next iteration starts. After a natural terminal outcome has been recorded, `.return()` / `.throw()` only triggers the deferred steps 3–5 cleanup; it does not re-classify the outcome.

**Telemetry outcome on `AbortSignal` abort after the final terminal `Output`.** When an `AbortSignal` aborts after the final terminal `Output` has been yielded but before generator settlement, **existing SPEC §9.3 behavior is preserved**: the generator surfaces the abort error on the next interaction (`g.next()`, `.return()`, or `.throw()`), `loopx.run` closes with `loopx.terminal_outcome = "abort"`, and the run span status is `ERROR`. The deferred steps 3–5 of the §10 terminal sequence (`LOOPX_TMPDIR` cleanup → close `loopx.run` → per-run `forceFlush()`) run when the abort error is surfaced. This differs from consumer `.return()` / `.throw()` after the final yielded `Output`, which does not reclassify an already-determined natural terminal outcome: abort, by contrast, is an external interrupt that SPEC §9.3 defines as producing an error in this window ("Normal completion is fixed only at settlement, not at the final yield"), and the telemetry outcome reflects that error. The `abort.received` event still fires on `loopx.run`.

For programmatic invocations (`run()` / `runPromise()`), step 6 does not execute on settlement; SDK shutdown is deferred to process-exit hooks (`beforeExit`, signal handlers). `loopx.tmpdir.cleanup_warning` metrics emitted in step 3 are therefore exported reliably for both CLI and programmatic invocations because step 5 always runs before settlement / exit (when the consumer drives the generator to settlement under `run()`).

**Failure isolation.**

All runtime exporter failures — transport errors, deadline-exceeded, malformed configuration detected at runtime, queue overflow / dropped spans, SDK-internal exceptions during export — are caught and discarded. They do not affect the loop, do not change the `loopx.run` terminal outcome, and do not surface in stderr. `loopx otel test` (§2) is the single documented exception and surfaces SDK errors deliberately.

**Warning policy.**

OTel-related warnings fire **only when telemetry is effectively enabled for the run** (or when a config-management command is explicitly invoked — see §2). A run that ends up with telemetry disabled produces no OTel-related stderr per the strict default-off rule (§1), even if the otel config file is broken or unreadable. Cardinality:

- otel config file unreadable when effective enable bit is `true` (only reachable via `options.otel.enabled=true`, since the file's enable bit is unknowable when the file cannot be read): at most once per run init.
- malformed line in the otel config file (no `=` separator, or invalid env-var name): one per offending line; line ignored.
- invalid `LOOPX_OTEL_*` value: one per offending key; fallback to default.
- SDK-side warnings for invalid `OTEL_*` values surfaced at startup.
- unsupported `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` value: one per offending key; fallback to `otlp`.
- SDK initialization failure: at most once per process.
- reserved metric-instrument-name violation: see §12 for cardinality (differs between in-process JS/TS and per-process CLI helpers).
- counter / histogram value-rule violation (negative counter, non-finite counter / histogram): at most once per process (§7).
- invalid `SpanKind` value passed to JS/TS `withSpan`: at most once per offending value per process; the span is created with `INTERNAL` (§3).
- explicit JS/TS `flushOtel()` timeout: at most one per process. (User-called debug-aid surface; the parent's per-run `forceFlush()` timeout is silent because it is loopx-internal and would be noisy across many runs in a long-lived host.)
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

**`loopx.*` metric instrument names** are similarly reserved. User code creating metrics via `counter()` / `histogram()` (CLI or JS/TS) may not use the `loopx.` prefix. The metric is silently suppressed; a single stderr warning is emitted with the cardinality below:

- **In-process JS/TS helpers** (programmatic API host, or scripts that import the `loopx` package and call helpers): at most one warning per offending name **per process**, regardless of how many runs share the process.
- **CLI helpers** (`loopx otel counter` / `histogram` invoked as a subprocess): at most one warning per offending name **per helper process**. Each `$LOOPX_BIN otel counter ...` invocation is a fresh process with no inherited dedup state, so two such calls from the same workflow each produce one warning. v1 deliberately does not introduce cross-process dedup state in `LOOPX_TMPDIR` for this case; users who need dedup across many calls should switch to the in-process JS/TS helpers.

### 13. Interaction with other SPEC sections

The following SPEC sections need updates when this ADR is accepted; this list is the mechanical update target.

- **§3.1 (Global Install)** — extend the `import { output, input } from "loopx"` example list to mention that the importable surface now includes the OTel helpers (`withSpan`, `addEvent`, `setAttribute`, `recordException`, `counter`, `histogram`, `flushOtel`, `isOtelEnabled`) in addition to `output` / `input` (and, for application code, `run` / `runPromise`).
- **§3.3 (Module Resolution for Scripts)** — note that the importable `"loopx"` package surface now includes the OTel helpers (`withSpan`, `addEvent`, `setAttribute`, `recordException`, `counter`, `histogram`, `flushOtel`, `isOtelEnabled`) and the `Span` / `SpanKind` types in addition to `output()` / `input()` / `run()` / `runPromise()`. No change to the resolution mechanism itself.
- **§3.4 (Bash Script Binary Access)** — extend the `LOOPX_BIN` example list with `$LOOPX_BIN otel span ... -- cmd`, `$LOOPX_BIN otel counter ...`, `$LOOPX_BIN otel histogram ...`.
- **§4.2 (Options)** — under `loopx otel` parsing rules, define `--attr k=v` repetition and the first-`=` split rule (§2 of this ADR), `--status ok|error` for `loopx otel span`, the `-h` / `--help` short-circuit on each `loopx otel` subcommand, and the duplicate-flag / unknown-flag rules consistent with the `run` and `install` scopes.
- **§4.3 (Subcommands)** — add `loopx otel` and all its sub-subcommands with synopses, including the credential-redaction rule for `loopx otel show` (redacts values for keys whose names contain `HEADERS`, `TOKEN`, `AUTH`, `PASSWORD`, `SECRET`, `CREDENTIAL`, or `BEARER`; `loopx otel list` remains the unredacted view). Add `loopx otel -h` and per-subcommand `loopx otel <sub> -h` to the help-flag short-circuit pattern.
- **§5.4 (Validation Scope)** — add a row for `loopx otel *`: does not require `.loopx/`, performs no discovery, no validation.
- **§6.4 / §6.5** — add a cross-reference to the new observability chapter. Clarify that `output()` / `input()` continue to be the only stdout-protocol helpers; `counter` / `histogram` (CLI and JS/TS) export only via OTLP and write nothing to stdout, while `loopx otel span ... -- <command>` inherits the wrapped command's stdout (which therefore can still affect the script's structured-output stdout — wrapping a command that produces structured stdout requires the same care as any other process-substitution pattern). **`output()` semantics in SPEC §6.4 are unchanged** — it does not flush the OTel SDK; scripts that need guaranteed export before `output()` use the new `flushOtel()` helper (§3 of this ADR) per the documented `await flushOtel(); output(...)` pattern.
- **§7.1 (Basic Loop)** — insert SDK initialization between tmpdir creation (current step 6) and the first child spawn (current step 7). At terminal outcome, insert (in order) `LOOPX_TMPDIR` cleanup → close `loopx.run` span → per-run `forceFlush()` (5-second deadline) → CLI-only SDK `shutdown()` (5-second deadline) → CLI exit (§10's terminal-ordering note in this ADR). All conditional on effective `LOOPX_OTEL_ENABLED`. Per-run `forceFlush()` runs for both CLI and programmatic invocations; SDK `shutdown()` runs at process exit only. For `run()` (async generator), tmpdir cleanup, `loopx.run` close, and per-run `forceFlush()` run when the generator is **driven to settlement**, not when the final terminal `Output` is yielded — preserving the existing SPEC §7.4 / §9.1 rule that the final yield is not itself settlement. Iteration-level spans (`loopx.iteration`, `loopx.script.exec`) close when their iteration ends and are not deferred to settlement.
- **§7.2 (Error Handling)** — add SDK initialization failure as a non-fatal warning. Specify that an init failure disables telemetry only for the run that triggered it; subsequent runs in the same process whose effective `LOOPX_OTEL_ENABLED` is true retry SDK init, and the SDK-init-failure stderr warning is deduped to at most once per process across all such retries. Add SDK process-exit shutdown timeout as a non-fatal warning. Add the unsupported-exporter fallback warning (§10), the counter / histogram value-rule violation warning (§7), and the explicit JS/TS `flushOtel()` timeout warning (§3 / §10) to the non-fatal warning list. All OTel-related warnings fire only when telemetry is effectively enabled; a default-off run produces no OTel-related stderr.
- **§7.3 (Signal Handling)** — clarify that, on signal-driven exit, loopx's signal hook runs the §10 terminal-ordering sequence (tmpdir cleanup → close `loopx.run` → per-run `forceFlush()` → SDK `shutdown()`) before the signal-exit. The 5s otel deadlines run concurrently with (not in addition to) any subsequent process exit. Process-exit hooks for the programmatic API rely on `beforeExit` and signal hooks; `process.on('exit')` is not used because Node disallows async work in that hook.
- **§7.4 (`LOOPX_TMPDIR`)** — note that the terminal-outcome ordering is: tmpdir cleanup → close `loopx.run` span → per-run `forceFlush()` → (CLI only) SDK `shutdown()`. Cleanup-warning conditions emitted during this **terminal cleanup** pass increment `loopx.tmpdir.cleanup_warning` (§7) before the per-run flush, so warning metrics are reliably exported. Cleanup warnings emitted during **tmpdir-creation-failure handling** occur pre-SDK-init and remain stderr-only; they are not represented in OTel. The existing rule that, for `run()`, cleanup runs at generator settlement (not at the final yielded `Output`) extends to the OTel terminal-ordering steps that follow it: closing `loopx.run`, recording cleanup-warning metrics, and per-run `forceFlush()` are likewise deferred to settlement. A consumer that abandons the generator after the final yield therefore leaks both `LOOPX_TMPDIR` and any spans / metrics queued for the deferred steps; this is the same leak surface the section already documents for tmpdir.
- **§8.1 (Global Storage)** — add a sibling subsection for the new `$XDG_CONFIG_HOME/loopx/otel` config file, with the same fallback rules, concurrent-mutation caveats, the `0600` permission requirement on writes, and the read-side rule that loopx neither chmods nor warns about existing-file permissions. Document the runtime-side rule per §1's strict default-off behavior (an unreadable file is silently treated as absent → disabled when telemetry is not effectively enabled, and is a non-fatal one-shot warning only when `options.otel.enabled=true` forces telemetry on despite the unreadable file) and the contrasting config-management-command rule (unreadable file is fatal — §2 of this ADR). For both runtime and config-management commands, readable-but-invalid lines are warn-and-ignore (one stderr warning per offending line, line otherwise skipped) for all three classes: lines without `=` (mirroring SPEC §8.1's existing rule for the global env file), env-var names not matching `[A-Za-z_][A-Za-z0-9_]*`, and invalid `LOOPX_OTEL_*` values. `enable` / `disable` / `set` / `remove` rewrites preserve unchanged lines (including invalid ones beyond the key being managed). Disk-read timing for the otel config file: after the pre-iteration sequence completes successfully, for all invocation modes (per §1). The inherited `OTEL_*` / `TRACEPARENT` / `TRACESTATE` / `XDG_CONFIG_HOME` / `HOME` values consulted alongside the file are captured by the **existing** inherited `process.env` snapshot the section already specifies — no new inherited-env snapshot point is introduced. Implementations must compute SDK configuration from this snapshot plus the otel config file snapshot; live `process.env` mutations after the snapshot do not affect SDK initialization for that run (this matters most for `runPromise()`, where the snapshot is at the call site but SDK init happens asynchronously after pre-iteration).
- **§8.3 (Injection)** — replace the precedence list with the 6-tier list in §9 of this ADR. Add `TRACEPARENT` / `TRACESTATE` to the protocol-variable table (with the "only when otel enabled" qualifier). Note that the otel config tier (3) sits **above** the local env file (4), the global loopx env (5), and inherited env (6) by deliberate design — the global otel config is the canonical OTel source for a run; lower tiers cannot silently shadow it. This inverts the standard "local beats global" pattern that applies among tiers 4–6 for non-OTel keys, and is intentional. CLI users override per-project by editing the otel config file; programmatic callers use `RunOptions.env` (tier 2).
- **§9.1 / §9.2** — add `options.otel` to the option-snapshot rules (read order, snapshot timing, error path). Clarify that inherited `OTEL_*` / `TRACEPARENT` / `TRACESTATE` (and the inherited `XDG_CONFIG_HOME` / `HOME` consulted for the otel config file path) are captured during the existing inherited `process.env` snapshot — eager synchronously at the call site for `runPromise()`, lazy at first `next()` for `run()` — not on the option-snapshot schedule. The otel config file's disk read and SDK init are deferred until **after** the pre-iteration sequence completes (§1, §10), for all invocation modes; for `runPromise()` the inherited-env capture is at the call site but the disk read happens asynchronously after return. Only `options.otel.parentContext` follows the option-snapshot schedule, since it is part of the option object. Note for §9.1 specifically: the existing rule that, for `run()`, cleanup on normal completion is guaranteed only once the generator is driven to settlement is preserved unchanged when OTel is enabled — `loopx.run` close, tmpdir cleanup, and per-run `forceFlush()` are deferred to settlement on the same schedule. When `.return()` / `.throw()` is called after a natural terminal `Output` (`stop` or `max_iterations`) has already been yielded, `loopx.run` closes with the **already-determined** `terminal_outcome`, not `consumer_cancellation`; only cancellation that interrupts before a natural terminal outcome was determined is classified as `consumer_cancellation`.
- **§9.3** — add per-run `forceFlush()` (awaited, 5-second deadline) to the cleanup ordering note. Per-run flush runs before throw/reject (after `LOOPX_TMPDIR` cleanup and `loopx.run` span close); SDK shutdown is a separate process-exit-only event, not part of per-run cleanup. Per-run `forceFlush()` is the only export guarantee for `run()` / `runPromise()` settlement; host programs that synchronously exit after settlement may lose pending exports beyond what `forceFlush()` already wrote. For `run()`, the per-run flush (along with tmpdir cleanup and `loopx.run` close) is deferred to generator settlement, not the final yielded `Output`, matching the existing tmpdir-cleanup rule. Extend the existing "Abort after final yield" paragraph with a telemetry sentence: an `AbortSignal` that aborts after the final terminal `Output` was yielded but before generator settlement preserves the existing SPEC §9.3 runtime behavior (abort error on next interaction) and additionally closes `loopx.run` with `loopx.terminal_outcome = "abort"` and run span status `ERROR`. This is distinct from consumer `.return()` / `.throw()` in the same window, which preserves the already-determined natural terminal outcome (`stop` / `max_iterations`) — the distinction follows from SPEC §9.3 already differentiating the two: abort produces an error, while `.return()` / `.throw()` does not.
- **§9.4** — note that the importable `"loopx"` surface now extends beyond `output()` / `input()` / `run()` / `runPromise()` to include the OTel helpers (including `flushOtel()`) in §3.
- **§9.5 (`RunOptions`)** — add the `otel` field to the type and validation rules. Specify validation for non-object `otel`, non-boolean `enabled`, non-string `parentContext`, throwing getters on `otel` / `enabled` / `parentContext`, and invalid (non-W3C-format) `parentContext` regardless of `enabled` state.
- **§11 (Help)** — define `loopx otel <sub> -h` short-circuit semantics for each subcommand (mirrors `run -h` / `install -h` short-circuits: print subcommand-specific help, exit 0, suppress argument validation, file reads, and SDK initialization). `loopx otel test -h` does not initialize the SDK.
- **§11.1 (Top-level Help)** — add `otel` to the listed top-level subcommands.
- **§12 (Exit Codes)** — note that `loopx otel test` exits 1 on disabled / unreachable backends (the documented exception to exporter-failure isolation, §2). `loopx otel span -- <command>` preserves the wrapped command's exit code byte-for-byte (any value, not just 0/1) when the command runs; on wrapped-command launch failure the helper exits **127** (`ENOENT`), **126** (`EACCES`), or **1** (other launch errors) per §2. `loopx otel counter` / `histogram` exit 0 silently when the enable bit is absent. Usage errors on any `loopx otel` helper (malformed value, missing arguments, unrecognized flags, duplicate `--status`) exit 1 regardless of enabled state.
- **§13** — add `TRACEPARENT`, `TRACESTATE` rows (conditionally script-protocol-protected when otel is enabled). Add a paragraph reserving the `loopx.*` attribute and metric-instrument-name namespaces.
- **New §N (Observability)** — full chapter for the §1–§11 content of this ADR.

## Consequences

**Positive:**

- A single trace can cover an entire ralph loop or a multi-workflow review chain. Cross-workflow `goto` paths become legible at runtime.
- Iteration-duration histograms make agent-latency regressions detectable. Exit-code counters make backend reliability comparable across `telegram` / `codex` / `api` / `batch` reviewers.
- Scripts that already use `claude code` (which emits OTel) become end-to-end traceable when `TRACEPARENT` is propagated. No code change in those scripts is required.
- Token usage and other API-level measurements have a first-class metric surface (`counter` / `histogram`) usable from bash and JS/TS.
- All of the above is opt-in. A user who never runs `loopx otel enable` pays zero SDK / exporter / network overhead, no extra env vars in spawned scripts, and byte-identical stdout / stderr / exit behavior compared to a build without this ADR. (The otel config file is still read silently to resolve the enable bit, but this is below the threshold of observable cost.)

**Negative / costs:**

- Adds a non-trivial dependency surface (`@opentelemetry/sdk-node`, OTLP exporters, `@opentelemetry/api`). Bundle size and `npm install` time grow even for users who never enable otel; lazy-loading via dynamic `import()` mitigates runtime cost but not install-time cost.
- New surface to maintain: another config file, another subcommand tree, a non-trivial span schema that downstream dashboards will start to depend on. Schema changes become breaking changes.
- CLI helpers init their own SDK per invocation. Tight loops calling `loopx otel counter` in bash can incur per-call SDK-init cost. JS/TS programmatic helpers do not have this cost (process-wide SDK).
- `LOOPX_OTEL_PROPAGATE_TO_SCRIPTS=true` (default) means OTLP credentials reach every spawned script via the §9 env tier. Setting it to `false` prevents accidental credential **propagation** through child environments but is not a same-user security boundary — a same-user script can still read `$XDG_CONFIG_HOME/loopx/otel` directly or invoke `loopx otel list` to read raw contents (`loopx otel show` redacts credential-bearing values per §2 and so is not a credential-disclosure path). Workflows defending against same-user untrusted code must rely on OS-level isolation (separate users, containers, etc.).
- `LOOPX_OTEL_CAPTURE_RESULT=full` will exceed many backends' attribute size limits silently. The mode exists for completeness but the documented operational default is `none` or `truncated`.
- v1 supports only `otlp` and `none` as exporter values. Console / stdout exporters are deferred — users who want a local debug exporter must run an OTLP collector that prints to stdout themselves. This trade-off protects the structured-output stdout protocol but reduces low-friction debugging out of the box.
- No CLI surface in v1 for inline events / attributes / exception-recording on the parent script's span. Bash users who want to attach attributes to the current `loopx.script.exec` span must wrap a sub-step in `loopx otel span` (whose `--attr` populates the wrapped span). JS/TS users have the full `addEvent` / `setAttribute` / `recordException` surface in-process. A future ADR can add IPC-backed CLI inline helpers if real workloads demand them.

## Test Recommendations

Easy-to-overlook cases worth covering:

- **Default-off byte-identity.** Without `loopx otel enable` (and without `options.otel.enabled=true`), no SDK initialization occurs, no `TRACEPARENT` is injected into children, no network sockets are opened, no OTel-related stderr appears, and `loopx run` behavior is byte-identical to pre-ADR — **including** when the otel config file at `$XDG_CONFIG_HOME/loopx/otel` exists but is unreadable, malformed, or contains invalid keys / values. The file is read silently to determine the enable bit; an unreadable file is silently treated as disabled.
- **Concurrent runs share SDK.** Two concurrent `runPromise()` invocations in one process produce two distinct `loopx.run` spans with distinct `loopx.run.id` but identical `service.instance.id`, and one settling does not shut down the SDK while the other is still active.
- **Per-run `forceFlush()` is the export guarantee for programmatic settlement.** A host program that calls `await runPromise(...); process.exit(0)` exports the run's spans (drained by `forceFlush()`); spans not drained by `forceFlush()` are not guaranteed to reach the exporter, since process-exit shutdown cannot run async work after a synchronous `process.exit`.
- **Exporter unreachable / failure isolation.** With `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1`, the run completes normally, exit code matches the script's behavior, and at most one stderr warning appears (SDK init may emit one; runtime exporter failures are silent).
- **Pre-iteration failure timing.** Pre-iteration **failures** (discovery error, target resolution error, env-file failure, tmpdir-creation failure) produce no telemetry (SDK not yet initialized), no otel config file read, and behave identically to pre-ADR. The non-fatal **starting-workflow version-mismatch warning** (per SPEC §3.2) is also pre-SDK-init and is not represented in OTel — the warning still surfaces on stderr per pre-ADR semantics, and the run still proceeds to SDK init and iteration.
- **Cross-workflow version-mismatch event placement.** A cross-workflow `goto` into a workflow whose declared version range is unsatisfied produces a `version_mismatch.warning` event on the **source iteration span** — the iteration that issued the goto — not the destination.
- **Spawn failure produces a `loopx.iteration` span.** A spawn that fails to launch produces a `loopx.iteration` span with `loopx.spawn.failed=true` on its child `loopx.script.exec` span and no `loopx.output.*` attributes; the span ordinal increments but the SPEC §7.1 iteration counter (visible as `loopx.run.iteration_count`) does not.
- **Programmatic enable.** `runPromise("ralph", { otel: { enabled: true } })` with no otel config file present causes child scripts to observe effective `LOOPX_OTEL_ENABLED=true` plus the resolved `OTEL_*` configuration in their environment. `{ otel: { enabled: false } }` against a config file that enables otel produces a run with no `loopx.*` spans, no `TRACEPARENT` injection, and an empty tier 3 in child env merging.
- **Runtime helpers ignore the global config file.** With otel enabled in the global config file but no `LOOPX_OTEL_ENABLED` in the inherited shell, `loopx otel counter` from a plain shell no-ops silently. The same call inside a `loopx run`-spawned child where propagation populated the env exports normally.
- **`flushOtel()` is the documented pattern for export-before-`output()`.** A JS/TS script with `LOOPX_OTEL_ENABLED=true` that calls `withSpan(...)`, `await flushOtel()`, then `output({ result: "x" })` produces an exported span. The same script that calls `output()` without first awaiting `flushOtel()` is **not** guaranteed to export the span — the data may be lost to `process.exit(0)` truncation. SPEC §6.4 `output()` semantics are unchanged.
- **Inherited `TRACEPARENT` snapshot timing.** Inherited `TRACEPARENT` is captured at the existing inherited-env snapshot point — eager at the `runPromise()` call site, lazy at first `next()` for `run()` — and consumed at SDK init after pre-iteration completes (§1, §10). Mutating `process.env.TRACEPARENT` between `run()` returning and the first `next()` call is observed by `loopx.run`; mutating it after `runPromise()` returns is not, because the inherited-env capture happened synchronously at the call site.
- **Cleanup-warning metric is exported.** A run that produces a `loopx.tmpdir.cleanup_warning` (per SPEC §7.4) drains the metric via per-run `forceFlush()` before settlement, for both CLI and programmatic invocations. The metric is recorded **before** `loopx.run` closes and **before** the per-run flush, so it is reliably exported.
