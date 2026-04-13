# Loop Extender (loopx) — Specification

## 1. Overview

loopx is a CLI tool that automates repeated execution ("loops") of scripts, primarily designed to wrap agent CLIs. It provides a scriptable loop engine with structured output, control flow between scripts, environment variable management, and a workflow installation mechanism.

**Package name:** `loopx`
**Implementation language:** TypeScript
**Module format:** ESM-only
**Target runtimes:** Node.js ≥ 20.6, Bun ≥ 1.0
**Platform support:** POSIX-only (macOS, Linux) for v1. Windows is not supported.

> **Note:** The Node.js minimum was raised from 18 to 20.6 to support `module.register()`, which is required for the custom module loader used to resolve `import from "loopx"` in scripts (see section 3.3).

---

## 2. Concepts

### 2.1 Workflow and Script

A **workflow** is a named subdirectory of `.loopx/` that contains one or more script files. Workflows are the primary organizational unit in loopx — scripts are not placed directly in `.loopx/` as loose files.

**Supported script extensions:**

- Bash (`.sh`)
- JavaScript (`.js` / `.jsx`)
- TypeScript (`.ts` / `.tsx`)

`.mjs` and `.cjs` extensions are intentionally unsupported. All JS/TS scripts must be ESM (see section 6.3).

```
.loopx/
  ralph/
    index.sh              ← default entry point
    check-ready.sh
  my-pipeline/
    index.ts              ← default entry point
    setup.ts              ← another script (targeted as my-pipeline:setup)
    lib/
      helpers.ts          ← not discovered (subdirectory)
    package.json          ← optional (for dependencies, version pinning)
```

#### Workflow detection

A subdirectory of `.loopx/` is recognized as a workflow if it contains at least one **top-level** file with a supported script extension. Only files directly inside the subdirectory are considered — the scan is not recursive. Subdirectories that contain no top-level script files are ignored during discovery.

#### Workflow naming

Workflow names must match `[a-zA-Z0-9_][a-zA-Z0-9_-]*`. Additionally, workflow names must not contain `:` (already excluded by the pattern, but called out explicitly since `:` is a syntactic delimiter — see section 4.1).

#### Script naming within workflows

Script names (the base name of a file without its extension) follow the same naming rules as workflow names: `[a-zA-Z0-9_][a-zA-Z0-9_-]*`, no `:`.

#### Non-script files

Files without supported extensions (e.g., `.json`, `.schema.json`, `.md`, `.txt`) inside a workflow directory are allowed and ignored by discovery. This supports patterns like schema files, documentation, or configuration that live alongside scripts.

#### All top-level files with supported extensions are scripts

Every file directly inside a workflow directory that has a supported script extension is a discovered script — there is no opt-out or exclusion mechanism. Reusable helper modules, configuration files, or shared utilities that happen to use a supported extension must be placed in subdirectories (e.g., `lib/`, `helpers/`, `config/`). Subdirectories within a workflow are not scanned during script discovery (see below), so files in subdirectories are invisible to loopx and available for internal use by the workflow's scripts.

#### Nested directory scripts within workflows are not supported

Scripts within a workflow must be files, not subdirectories. A subdirectory inside a workflow is ignored during script discovery within that workflow.

#### Default entry point

Each workflow has a **default entry point**: a script named `index` (i.e., `index.sh`, `index.js`, `index.jsx`, `index.ts`, or `index.tsx`). This is the script that runs when a workflow is invoked without specifying a script name.

- `loopx run ralph` is equivalent to `loopx run ralph:index`.
- If a workflow has no script named `index`, invoking it without a script name is an error (exit code 1). The workflow is still valid — its other scripts can be targeted explicitly.

`index` is not otherwise special. It can be the target of `goto`, it follows the same naming/collision rules as other scripts, and it can `goto` other scripts.

#### Workflow-level `package.json`

A workflow may include a `package.json` that serves two optional purposes:

1. **Dependency management:** The workflow can declare its own dependencies. Users manage installation themselves (`npm install` / `bun install` within the workflow directory). loopx does not auto-install dependencies. If `node_modules/` is missing and the script fails to import a package, the resulting error is the active runtime's normal module resolution error.
2. **Version declaration:** The workflow can declare a `loopx` version requirement (see section 3.2).

The `main` field is no longer used to determine the entry point. The entry point is always the `index` script by convention. If a `package.json` contains a `main` field, it is ignored by loopx.

The `type` field (`"module"`) continues to be relevant for Node.js module resolution within the workflow.

**Failure modes:** If a workflow's `package.json` is absent, unreadable, contains invalid JSON, or declares an invalid semver range for `loopx`, see section 3.2 for the defined behavior. In all cases, a broken `package.json` degrades version checking but does not prevent the workflow from being used or installed.

### 2.2 Loop

A loop is a repeated execution cycle modeled as a **state machine**. Each iteration runs a **target** (a specific script within a workflow), examines its structured output, and transitions:

- **`goto` another script:** transition to that target for the next iteration (see below for bare vs. qualified goto).
- **No `goto`:** the cycle ends and the loop restarts from the **starting target**.
- **`stop`:** the machine halts.

The **starting target** is the target specified when loopx was invoked (e.g., `ralph:index` from `loopx run ralph`). The `goto` mechanism is a **state transition, not a permanent reassignment.** When a target finishes without its own `goto`, execution returns to the starting target. The loop always resets to its initial state after a transition chain completes — regardless of which workflow the chain ended in. Cross-workflow `goto` does not change the starting target.

**Self-referencing goto:** A script may `goto` itself. This is a normal transition and counts as an iteration.

#### Goto semantics

A bare name (no colon) means different things depending on context:

- **In `run` (CLI or programmatic API):** A bare name is a **workflow name** and resolves to that workflow's `index` script. `loopx run ralph` and `run("ralph")` both mean `ralph:index`.
- **In `goto`:** A bare name is a **script name** within the current workflow. `{ "goto": "check-ready" }` from a script in the `ralph` workflow means `ralph:check-ready`, not `check-ready:index`.

This distinction is fundamental to the invocation model: `run` addresses workflows, `goto` addresses scripts within the current workflow's scope.

**Intra-workflow goto (bare name):** A `goto` value without a colon targets a script in the **same workflow as the currently executing script**. If the current script is in the `ralph` workflow, `{ "goto": "check-ready" }` transitions to `ralph:check-ready`.

**Qualified goto:** A `goto` value with a colon targets a specific script in a named workflow. `{ "goto": "review-adr:request-feedback" }` transitions to the `request-feedback` script in the `review-adr` workflow. The qualified form is valid whether the target is a different workflow or the same workflow as the currently executing script — e.g., a script in `ralph` may use `{ "goto": "ralph:check-ready" }`, which is equivalent to the bare `{ "goto": "check-ready" }`.

The target workflow must exist in the cached discovery results; otherwise it is an invalid `goto` target (error, exit code 1).

**Bare goto from a cross-workflow context:** When a script reached via cross-workflow `goto` issues a bare (unqualified) `goto`, it targets a script in **its own workflow**, not the starting target's workflow.

**Example:**
```
Starting target: ralph:index

Iteration 1: ralph:index → goto "check-ready"        (intra-workflow → ralph:check-ready)
Iteration 2: ralph:check-ready → goto "review-adr:request-feedback"  (cross-workflow)
Iteration 3: review-adr:request-feedback → goto "apply-feedback"
                                           ↑ bare name → resolves to review-adr:apply-feedback
Iteration 4: review-adr:apply-feedback → (no goto)
Iteration 5: ralph:index → (back to starting target)
```

### 2.3 Structured Output

Every iteration produces an output conforming to:

```typescript
interface Output {
  result?: string;
  goto?: string;
  stop?: boolean;
}
```

**Stdout is reserved for the structured output payload.** Any human-readable logs, progress messages, or debug output from scripts must go to stderr.

**Parsing rules:**

- Only a **top-level JSON object** can be treated as structured output. Arrays, primitives (strings, numbers, booleans), and `null` fall back to raw result treatment.
- If stdout is a valid JSON object containing at least one known field (`result`, `goto`, `stop`), it is parsed as structured output.
- If stdout is not valid JSON, is not an object, or is a valid JSON object but contains none of the known fields, the entire stdout content is treated as `{ result: <raw output> }`.
- **Empty stdout** (0 bytes) is treated as `{ result: "" }`. This is the default case for scripts that produce no output, and causes the loop to reset (no `goto`, no `stop`).
- Extra JSON fields beyond `result`, `goto`, and `stop` are silently ignored.
- If `result` is present but not a string, it is coerced via `String(value)`. This includes `null`: `{"result": null}` produces result `"null"`.
- A string `goto` value is either a bare script name (targeting a script within the current workflow) or a qualified `workflow:script` name (targeting a specific workflow and script). See section 2.2 for full goto semantics.
- If `goto` is present but not a string, it is treated as absent. Target validation (section 4.1) applies only after a `goto` value has been parsed as a string.
- `stop` must be exactly `true` (boolean). Any other value (including truthy strings like `"true"`, numbers, etc.) is treated as absent. This prevents surprises like `{"stop": "false"}` halting the loop.

**Field precedence:**

- `stop: true` takes priority over `goto`. If both are set, the loop halts.
- `goto` with no `result` is valid: the target script receives empty stdin.
- **`result` is only piped to the next script when `goto` is present.** When the loop resets to the starting target (no `goto`), the starting target receives empty stdin regardless of whether the previous iteration produced a `result`.

---

## 3. Installation & Module Resolution

### 3.1 Global Install

loopx is installed **globally** to provide the `loopx` CLI command:

```
npm install -g loopx
```

A global install is sufficient for all loopx functionality, including JS/TS scripts that `import { output, input } from "loopx"`. loopx uses a custom module loader to make its exports available to scripts regardless of install location (see section 3.3).

### 3.2 Local Version Pinning

A project may pin a specific loopx version by installing it as a local dependency:

```
npm install --save-dev loopx
```

A local install provides two guarantees:

1. **CLI delegation:** When the globally installed `loopx` binary starts, it checks the project root for a local `loopx` dependency and delegates if found (see resolution order below). Delegation happens **before command parsing**, so the entire session — CLI behavior, script helpers, and all — uses the pinned version.

2. **Importable library:** Application code can `import { run, runPromise } from "loopx"` when loopx is a local dependency. This is standard Node.js module resolution — no special mechanism required.

#### Project root

For loopx, the **project root** is always the invocation cwd. This is the same directory where `.loopx/` lives (when it exists), but the project root is determined by cwd alone — it does not depend on `.loopx/` existing. This means delegation, version pinning, and all project-root-relative behavior work regardless of whether `.loopx/` has been initialized.

#### Resolution order (highest precedence first)

1. **Project root `package.json`:** If the project root has a `package.json` that lists `loopx` as a dependency (in `dependencies`, `devDependencies`, or `optionalDependencies`) and a corresponding `node_modules/.bin/loopx` exists, the global binary delegates to it.
2. **Global install:** If no local version is found, the global install runs.

Because delegation happens before command parsing, it is based on the project root only — not on the target workflow. Delegation works for all commands, including those that do not require `.loopx/` to exist (e.g., `loopx version`, `loopx install`, `loopx env`).

#### Project-root `package.json` failure modes

- **No `package.json` at project root:** No delegation. The global install runs. No warning.
- **Unreadable `package.json`** (e.g., permission denied): A warning is printed to stderr. Delegation is skipped and the global install runs.
- **Invalid JSON:** A warning is printed to stderr. Delegation is skipped and the global install runs.
- **Valid JSON, `loopx` declared in `dependencies`/`devDependencies`/`optionalDependencies`, but `node_modules/.bin/loopx` does not exist:** A warning is printed to stderr (the dependency is declared but the binary is missing — likely `npm install` has not been run). Delegation is skipped and the global install runs.
- **Valid JSON, `loopx` not declared in any dependency field, but `node_modules/.bin/loopx` exists:** No delegation. The dependency declaration is required for delegation — an undeclared binary is not used. No warning.

In all cases, a problematic project-root `package.json` degrades delegation but does not prevent loopx from running. The global install is always the fallback.

#### Recursion guard

The delegated process is spawned with `LOOPX_DELEGATED=1` in its environment. If this variable is set when loopx starts, delegation is skipped. This prevents infinite delegation loops. After delegation, `LOOPX_BIN` contains the **resolved realpath** of the effective binary (the local version), not the original global launcher or any intermediate symlinks.

#### Workflow-level version declaration (runtime validation)

A workflow's `package.json` may declare a `loopx` version requirement in `dependencies` or `devDependencies`. `optionalDependencies` is intentionally not checked at the workflow level — a version requirement declared there is ignored. Workflow-level version declarations are compatibility assertions, not optional suggestions. (Project-root delegation checks `optionalDependencies` because it follows standard npm dependency semantics for locating a local binary.)

If `loopx` is declared in **both** `dependencies` and `devDependencies` within the same workflow `package.json`, the `dependencies` range takes precedence for version checking and the `devDependencies` range is ignored. This precedence rule applies only to **version checking** (workflow-level runtime validation and install-time validation). At the project root level, delegation depends on declaration presence and binary existence — no range comparison is performed, so range precedence is not relevant to delegation.

This declaration is **not used for delegation** — delegation always happens at project root level. Instead, after delegation and command parsing, the running loopx version is checked against the workflow's declared version range:

- If the running version satisfies the declared range: execution proceeds normally.
- If the running version does **not** satisfy the declared range: loopx prints a warning to stderr and continues execution. This is a non-fatal warning, not an error — it alerts the user to a potential incompatibility without blocking work.

#### Workflow `package.json` failure modes

A workflow's `package.json` may be absent, unreadable, or malformed. The following failure-mode rules apply at both runtime and install time:

- **No `package.json`:** No version check is performed. This is the normal case for workflows without dependencies or version requirements.
- **Unreadable `package.json`** (e.g., permission denied): A warning is printed to stderr. The version check is skipped (treated as no version declared). Execution / installation proceeds.
- **Invalid JSON:** A warning is printed to stderr. The version check is skipped. Execution / installation proceeds.
- **Valid JSON but `loopx` version field contains an invalid semver range:** A warning is printed to stderr. The version check is skipped. Execution / installation proceeds.
- **Valid JSON, no `loopx` dependency declared:** No version check is performed.

In all warning cases, the workflow is still usable — a broken `package.json` degrades version checking but does not block execution or installation.

**Warning timing differs by context:**

- **Runtime:** `package.json` failure warnings follow the same "first entry only" rule as version mismatch warnings (see below). The version check — and any warnings it produces — runs once on first entry into a workflow during a loop run. Subsequent entries into the same workflow do not re-read `package.json` or repeat warnings.
- **Install:** Each workflow's `package.json` is checked once during the install operation. Warnings are emitted once per affected workflow. `package.json` failure warnings (unreadable, invalid JSON, invalid semver range) do not block installation — the workflow is still installable, just without version validation. Version *mismatches* (a valid range not satisfied by the running version) are blocking errors and are included in the aggregated preflight failure report (see section 10.7).

#### Cross-workflow version checking

When a loop enters a workflow — whether at loop start or via `goto` — the workflow's declared `loopx` version range (if any) is checked against the running version **on first entry only**. If the range is not satisfied, a warning is printed to stderr. Subsequent entries into the same workflow during the same loop run do not repeat the warning.

This means:
- The starting workflow is checked once before the first iteration.
- A workflow reached via `goto` is checked on first transition into it.
- Re-entering a previously visited workflow (e.g., via loop reset or another `goto`) does not produce a second warning.

**`-n 0` behavior:** When `-n 0` is specified, discovery, target resolution, and environment variable loading (global and `-e`) still run — the target workflow and script must exist and pass validation (name collisions, name restrictions), and env files must be readable and valid, consistent with section 4.2. However, workflow-level version checking is skipped because no workflow is entered for execution. `-n 0` validates that the target is runnable, but does not perform the runtime version compatibility check.

### 3.3 Module Resolution for Scripts

Scripts spawned by loopx need access to the `output` and `input` helpers via `import { output, input } from "loopx"`.

**For Node.js / tsx:** loopx uses Node's `--import` flag to preload a registration module that installs a custom module resolve hook via `module.register()`. This hook intercepts bare specifier imports of `"loopx"` and resolves them to the running CLI's package exports. This approach works correctly with Node's ESM resolver, which does not support `NODE_PATH`.

**For Bun:** Bun's module resolver supports `NODE_PATH` for both CJS and ESM. loopx sets `NODE_PATH` to include its own package directory when running under Bun.

In both cases, the resolution **points to the post-delegation version** when no closer `node_modules/loopx` exists. If a local install triggered delegation, the helpers resolve to the local version's package. However, if a workflow has its own `node_modules/loopx`, standard module resolution applies and the closer package takes precedence over the CLI-provided one. This is a natural consequence of running scripts with the workflow directory as cwd (section 6.1).

loopx does **not** override standard module resolution to force the CLI version. This means a workflow with a locally installed `loopx` may get different helper behavior than the running CLI provides. The workflow's `package.json` version declaration (section 3.2) serves as the intended mechanism for surfacing version mismatches. No warning is emitted for this scenario in v1.

### 3.4 Bash Script Binary Access

loopx injects a `LOOPX_BIN` environment variable into every script's execution environment. This variable contains the **resolved realpath** of the effective loopx binary (post-delegation), allowing bash scripts to call loopx subcommands reliably:

```bash
#!/bin/bash
$LOOPX_BIN output --result "done" --goto "next-step"               # intra-workflow goto
$LOOPX_BIN output --goto "review-adr:request-feedback"              # cross-workflow goto
```

---

## 4. CLI Interface

### 4.1 Running Scripts

```
loopx run [options] <workflow>[:<script>]
```

Scripts are executed exclusively via the `run` subcommand. `run` accepts exactly one positional argument, the target:

- The `<workflow>` portion is required. The `:<script>` portion is optional and defaults to `index`.
- `loopx run ralph` runs the `index` script in the `ralph` workflow.
- `loopx run ralph:check-ready` runs the `check-ready` script in the `ralph` workflow.
- `loopx run ralph:index` explicitly runs the `index` script (same as bare `loopx run ralph`).
- The target is required. `loopx run` with no target (e.g., `loopx run` or `loopx run -n 5`) is a usage error (exit code 1). This does not inspect `.loopx/` or perform discovery.
- More than one positional argument (e.g., `loopx run ralph bar`) is a usage error (exit code 1).
- If the workflow does not exist in `.loopx/`, loopx exits with an error. If the workflow exists but the specified script does not, loopx exits with an error.
- If a workflow has no `index` script and is invoked without specifying a script (e.g., `loopx run ralph`), loopx exits with an error (exit code 1). The workflow is still valid — its scripts can be targeted explicitly.
- `loopx` with no arguments shows top-level help (equivalent to `loopx -h`). No discovery is performed.
- Unrecognized subcommands (e.g., `loopx foo`) are usage errors (exit code 1). There is no implicit fallback to `run`.
- `default` is an ordinary workflow name with no special behavior. `loopx run default` runs the `index` script in the `default` workflow.
- Workflows may be named after built-in subcommands (e.g., `version`, `output`). `loopx run version` runs a workflow named `version` (not the built-in). `loopx run run` runs a workflow named `run`.

The colon is a reserved delimiter. It must not appear in workflow names or script names (already excluded by the name restriction pattern).

#### Target validation

The following target strings are invalid in all contexts — CLI invocation (`loopx run <target>`), programmatic API (`run(target)`), and `goto` values:

- **Empty string** (`""`): error.
- **Bare colon** (`":"`): error.
- **Leading colon** (e.g., `":script"`): error.
- **Trailing colon** (e.g., `"workflow:"`): error. In CLI invocation and the programmatic API, target the default entry point by omitting the colon (`"workflow"`) or using `"workflow:index"`. In `goto`, a bare name is a script in the current workflow (see section 2.2), so targeting another workflow's default entry point from `goto` requires the qualified form `"workflow:index"`.
- **Multiple colons** (e.g., `"a:b:c"`): error. The colon delimiter may appear at most once.
- **Name restriction violations**: The workflow portion and the script portion (if present) must each match `[a-zA-Z0-9_][a-zA-Z0-9_-]*`. A target where either portion violates this pattern is an error.

Existing structured-output parsing semantics are unchanged: if `goto` is present but not a string, it is treated as absent. Target validation applies only after a `goto` value has been parsed as a string.

For CLI invocation and the programmatic API, invalid targets are rejected at the same point as a missing workflow (after discovery, or lazily on first iteration for the API). For `goto` values, invalid targets produce an error at transition time (exit code 1).

### 4.2 Options

The CLI has a multi-level option structure: top-level options, `run`-scoped options, and `install`-scoped options.

#### Top-level options

| Flag | Description |
|------|-------------|
| `-h`, `--help` | Print top-level help (subcommand list, general syntax). Does not inspect `.loopx/` or perform discovery. |

`-h` / `--help` is the only recognized top-level flag. Any other flag at top level — including `-n`, `-e`, and any unrecognized flag (e.g., `loopx --unknown`, `loopx -n 5 ralph`, `loopx -e .env ralph`) — is a usage error (exit code 1).

**Top-level `-h` precedence:** `loopx -h` takes precedence over everything that follows. `loopx -h run ralph` shows top-level help (no discovery), not run help, and exits 0.

An unrecognized token in the subcommand position is an error regardless of what follows: `loopx foo -h` is an unrecognized subcommand error (exit code 1), not top-level help. The top-level `-h` short-circuit only applies when `-h` appears before subcommand dispatch (i.e., as the first argument to `loopx`).

#### `run`-scoped options

| Flag | Description |
|------|-------------|
| `-n <count>` | Maximum number of loop iterations (see section 7.1 for counting semantics). Must be a non-negative integer; negative values or non-integers are usage errors. `-n 0` validates the starting target (discovery, target resolution, env file loading) but executes zero iterations, then exits with code 0. Workflow-level version checking is skipped (section 3.2). |
| `-e <path>` | Path to a local env file (`.env` format). The file must exist and is validated during execution; a missing file is an error. Variables are merged with global env vars; local values take precedence on conflict. |
| `-h`, `--help` | Print run help — options (`-n`, `-e`) and dynamically discovered workflows and scripts in `.loopx/`. See section 11 for full run help behavior. |

Within `run`, options and the target may appear in any order.

**Duplicate flags:** Repeating `-n` or `-e` within `run` (e.g., `loopx run -n 5 -n 10` or `loopx run -e .env1 -e .env2`) is a usage error (exit code 1) — unless `-h` / `--help` is present (see below).

**Unrecognized flags:** Unrecognized flags within `run` (e.g., `loopx run --unknown ralph`) are usage errors (exit code 1) — unless `-h` / `--help` is present (see below).

**`run -h` short-circuit:** Within `run`, `-h` / `--help` is a full short-circuit: when present, loopx shows run help, exits 0, and ignores all other run-level arguments unconditionally. This means:

- Target requirements are suppressed (zero or multiple positionals are not errors).
- `-n` and `-e` values are not parsed or validated (including duplicates and invalid values).
- Unknown flags are ignored.
- Examples:
  - `loopx run -h ralph` — shows run help (target ignored).
  - `loopx run ralph -h` — shows run help (`-h` after target still triggers help short-circuit).
  - `loopx run ralph:check-ready -h` — shows run help (target ignored).
  - `loopx run -h -e missing.env` — shows run help (env file not validated).
  - `loopx run -h -n bad` — shows run help (`-n` not validated).
  - `loopx run -h -n 5 -n 10` — shows run help (duplicate `-n` not rejected).
  - `loopx run -h foo bar` — shows run help (extra positional not rejected).
  - `loopx run -h --unknown` — shows run help (unknown flag not rejected).

#### `install`-scoped options

| Flag | Description |
|------|-------------|
| `-w <name>`, `--workflow <name>` | Install only the named workflow from a multi-workflow source (see section 10.8). |
| `-y` | Override version mismatch and workflow collision checks (see sections 10.5 and 10.6). |
| `-h`, `--help` | Print install help and exit. |

**Duplicate flags:** Repeating `-w` or `-y` is a usage error (exit code 1) — unless `-h` / `--help` is present.

**Unrecognized flags:** Unrecognized flags (e.g., `loopx install --unknown <source>`) are usage errors (exit code 1) — unless `-h` / `--help` is present.

**`install -h` / `--help` short-circuit:** When `-h` / `--help` is present, loopx shows install help, exits 0, and ignores all other install-level arguments unconditionally. Source is not required, flags are not validated, and no network requests are made.

### 4.3 Subcommands

#### `loopx run`

Executes a script within a workflow. This is the only way to run scripts — see section 4.1 for the full grammar and section 4.2 for `run`-scoped options.

```
loopx run [options] <workflow>[:<script>]
```

#### `loopx version`

Prints the installed version of loopx to stdout and exits. The output is the bare package version string (e.g., `1.2.3`) followed by a newline, with no additional text or labels.

#### `loopx output`

A helper for bash scripts to emit structured output:

```bash
loopx output [--result <value>] [--goto <target>] [--stop]
```

Prints the corresponding JSON to stdout. **At least one flag must be provided;** calling `loopx output` with no flags is an error.

The `--goto` value is a target string that accepts both bare script names (intra-workflow) and qualified `workflow:script` names (cross-workflow). `loopx output --goto` only serializes the value into the structured output JSON; it does not validate the target format. Target validation occurs at loop execution time when the `goto` value is resolved. This keeps the CLI helper aligned with the JS/TS `output()` function, which also performs no validation.

Example usage in a bash script:

```bash
#!/bin/bash
# do work...
$LOOPX_BIN output --result "done" --goto "next-step"               # intra-workflow
$LOOPX_BIN output --goto "review-adr:request-feedback"              # cross-workflow
exit 0
```

#### `loopx env set <name> <value>`

Sets a global environment variable stored in the loopx global config directory.

**Validation:** The variable name must match `[A-Za-z_][A-Za-z0-9_]*`. Values containing `\n` or `\r` are rejected, since multiline values are not supported by the env file format.

**Serialization:** `loopx env set` writes the value as `KEY="<literal value>"` followed by a newline. No escape sequences are applied — the value is written literally within double quotes. This ensures reliable round-tripping for values containing spaces, `#`, `=`, quotes, and trailing spaces.

#### `loopx env remove <name>`

Removes a global environment variable. If the variable does not exist, this is a silent no-op (exits with code 0).

#### `loopx env list`

Lists all currently set global environment variables. Output format is one `KEY=VALUE` pair per line, sorted lexicographically by key name. If no variables are set, produces no output.

#### `loopx install`

Installs one or more workflows into the `.loopx/` directory. See section 10 for full details.

```
loopx install [options] <source>
```

`<source>` is required. `loopx install` with no source is a usage error (exit code 1). Supports:

- **`org/repo` shorthand** — expands to `https://github.com/org/repo.git` and clones.
- **Git URL** — clones a repository.
- **Tarball URL** — extracts an archive.

Single-file URL install is not supported. Creates the `.loopx/` directory if it does not exist.

---

## 5. Discovery and Validation

### 5.1 Discovery

Workflows and scripts are discovered by scanning the `.loopx/` directory in the project root (section 3.2). The `.loopx/` directory is only searched in the project root — ancestor directories are not searched.

#### Workflow discovery

Files placed directly inside `.loopx/` are never discovered, even if they have supported script extensions; only subdirectories are candidates for workflow discovery.

- Scan `.loopx/` for top-level subdirectories.
- A subdirectory is a workflow if it contains at least one **top-level** file (directly inside the subdirectory, not in nested subdirectories) with a supported extension.
- Subdirectories with no script files are ignored (no warning).
- Workflow names are validated against the name restriction rules (section 5.3).

Legacy layouts are not recognized: loose script files placed directly in `.loopx/` are ignored (only subdirectories are candidates), and the former "directory script" model (`package.json` + `main` field as entry point) no longer applies — a subdirectory must satisfy the workflow detection rules (section 2.1) to be discovered. loopx does not provide migration warnings or automatic migration for these legacy layouts; they are simply not discovered.

#### Script discovery within workflows

- Scan each workflow directory for top-level files with supported extensions.
- The script name is the file's base name (filename without extension).
- Subdirectories within a workflow are ignored.
- Name collisions (e.g., `check.sh` and `check.ts` in the same workflow) follow the rules in section 5.2.

**Symlink policy:** Symlinks within `.loopx/` are followed during discovery. A symlinked workflow directory or script file is treated identically to its non-symlinked equivalent. Symlink resolution does not affect workflow or script naming — names are derived from the symlink's own name, not its target.

**Discovery metadata is cached at loop start for the duration of the loop.** This means:

- Workflows and scripts added, removed, or renamed during loop execution are not detected until the next invocation.
- **Edits to the contents of an already-discovered script file take effect on subsequent iterations**, because the child process reads the file from disk each time it is spawned.
- **If a discovered script's underlying file is removed or renamed mid-loop**, execution uses the cached entry path and fails at spawn time as a normal child-process launch error. This is treated as a non-zero exit (section 7.2).

Discovery runs at loop start for `loopx run <target>` and during `loopx run -h`. Discovery does **not** run for top-level help (`loopx -h` / `loopx --help` / bare `loopx`).

### 5.2 Name Collision

If multiple scripts within the same workflow share the same base name (e.g., `check.sh` and `check.ts` in the same workflow directory), the behavior depends on the command:

- **`loopx run <target>`:** Collisions are fatal. loopx refuses to start and displays an error message listing the conflicting entries.
- **`loopx run -h`:** Collisions are non-fatal. Run help is displayed with warnings about the conflicting entries.

Workflow names themselves cannot collide on a normal filesystem (directory names are unique), so workflow-level collision rules are not needed.

### 5.3 Name Restrictions

Both workflow names and script names must match the pattern `[a-zA-Z0-9_][a-zA-Z0-9_-]*` (start with alphanumeric or underscore, followed by alphanumerics, underscores, or hyphens). The `:` character is explicitly disallowed (already excluded by the pattern, but called out since `:` is a reserved delimiter).

If any workflow or script in `.loopx/` violates these restrictions, the behavior depends on the command:

- **`loopx run <target>`:** Violations are fatal. loopx refuses to start and displays an error message.
- **`loopx run -h`:** Violations are non-fatal. The invalid entry is listed with a warning; run help is still displayed.

### 5.4 Validation Scope

The global validation model is preserved. All discovered workflows and their scripts are validated at discovery time. An invalid workflow name, invalid script name, or same-base-name collision in **any** workflow under `.loopx/` is fatal for `loopx run <target>`, regardless of whether the target workflow is the one containing the error. This means `loopx run good` fails if a sibling workflow `broken` contains a name collision or an invalid script name.

For `loopx run -h`, validation remains non-fatal: all issues across all workflows are reported as warnings.

Not all commands require `.loopx/` to exist or be valid:

| Command | Requires `.loopx/` | Validates |
|---------|--------------------|--------------------|
| `loopx` (no arguments) | No | No |
| `loopx -h` / `loopx --help` | No | No |
| `loopx version` | No | No |
| `loopx env *` | No | No |
| `loopx output` | No | No |
| `loopx install [options] <source>` | No (creates if needed) | Source workflows, target-path collisions, version mismatches, and install-time validation (section 10) |
| `loopx run -h` | No | Non-fatal (warnings shown for all discovered workflows) |
| `loopx run <target>` | Yes | Yes — collisions (5.2), name-restriction violations (5.3), and missing target are fatal across all discovered workflows |

---

## 6. Script Execution

### 6.1 Working Directory

All scripts run with the **workflow directory** as their working directory (e.g., `.loopx/ralph/`). This ensures relative imports and `node_modules/` resolve naturally.

loopx injects `LOOPX_PROJECT_ROOT` into every script's environment, set to the absolute path of the project root (see section 3.2; for the programmatic API, this is `RunOptions.cwd` if provided — see section 9.5). This is essential for scripts that need to reference project files outside their workflow directory.

### 6.2 Bash Scripts

Bash scripts (`.sh`) are executed as child processes via `/bin/bash`. The script's stdout is captured as its structured output. Stderr is passed through to the user's terminal.

### 6.3 JS/TS Scripts

JavaScript and TypeScript scripts are executed as child processes using `tsx`, which handles `.js`, `.jsx`, `.ts`, and `.tsx` files uniformly. `tsx` is a dependency of loopx and does not need to be installed separately by the user.

**JS/TS scripts must be ESM and must use `import`, not `require`.** CommonJS is not supported. `.mjs` and `.cjs` extensions are intentionally unsupported. Using CommonJS syntax (`require()`, `module.exports`, `exports`) in a loopx script is an error — the script will fail at execution time.

- Stdout is captured as structured output.
- Stderr is passed through to the user's terminal.

When running under Bun, loopx uses Bun's native TypeScript/JSX support instead of `tsx`.

### 6.4 `output()` Function (JS/TS)

When imported from `loopx`, the `output()` function writes structured JSON to stdout and terminates the process.

```typescript
import { output } from "loopx";

output({ result: "hello", goto: "next-step" });
// process exits here — no code after this line runs
```

**Behavior:**

- `output()` **flushes stdout** before calling `process.exit(0)`, ensuring the JSON payload is not lost.
- Since `output()` calls `process.exit()`, calling it multiple times is not possible — only the first call takes effect.
- The argument must be an object containing at least one known field (`result`, `goto`, or `stop`) with a defined value. Calling `output({})` (no known fields) throws an error.
- Properties whose value is `undefined` are treated as absent (they are omitted during JSON serialization). For example, `output({ result: "done", goto: undefined })` is equivalent to `output({ result: "done" })`.
- If called with a non-object value (e.g., a plain string, number, or boolean), the value is serialized as `{ result: String(value) }`. Arrays are **not** treated as non-object values (since `typeof [] === 'object'`); an array must contain at least one known field with a defined value, just like any other object — so `output([1,2,3])` throws an error (no known fields).
- If called with `null` or `undefined`, an error is thrown.

`output()` does not validate `goto` target syntax or existence; it only serializes the value. Target validation occurs during loop execution (section 7.1).

### 6.5 `input()` Function (JS/TS)

When imported from `loopx`, the `input()` function reads the input piped from the previous script via stdin:

```typescript
import { input, output } from "loopx";

const data = await input(); // Returns the input string, or empty string if no input

output({ result: `processed: ${data}` });
```

`input()` returns a `Promise<string>`. On the first iteration (when no input is available), it resolves to an empty string.

**The result is cached:** calling `input()` multiple times within the same script execution returns the same string each time.

### 6.6 Input Piping

When a script's output includes both `result` and `goto`, the `result` value is delivered to the next script via **stdin** — the `result` string is written to the next script's stdin.

**`result` is only piped when `goto` is present.** When the loop resets to the starting target (no `goto` in the output), the starting target receives empty stdin, regardless of any `result` value in the previous output.

### 6.7 Initial Input

The first script invocation in a loop receives **no input**. Stdin is empty.

---

## 7. Loop Execution Flow

### 7.1 Basic Loop

1. A target is required. If none was provided, this is a usage error (exit code 1) — see section 4.1. Discover workflows and scripts in the `.loopx/` directory per section 5.1. Validate for name collisions (section 5.2) and name restrictions (section 5.3) across **all** discovered workflows — these are fatal in run mode. Cache the discovery results.
2. Load environment variables (global + local via `-e`). Cache the resolved set for the duration of the loop.
3. Resolve the starting target from the target provided to `loopx run`. Parse the workflow and optional script portions. If the workflow does not exist in the cached discovery results, exit with an error. If a script was specified and does not exist in the workflow, exit with an error. If no script was specified, resolve to `index` — if the workflow has no `index` script, exit with an error.
4. If `-n 0` was specified: exit with code 0 (no iterations executed, no workflow-level version checking).
5. Check the starting workflow's version declaration (section 3.2) against the running loopx version on first entry.
6. Execute the starting target with no input (first iteration).
7. Capture stdout. Parse it as structured output per section 2.3.
8. Increment the iteration counter.
9. If `stop` is `true`: exit with code 0.
10. If `-n` was specified and the iteration count has been reached: exit with code 0. The output from this final iteration is still yielded/observed before termination.
11. If `goto` is present:
    a. Validate the `goto` value against the target validation rules (section 4.1). If invalid, print an error and exit with code 1.
    b. Resolve the target: a bare name targets a script in the current workflow; a qualified `workflow:script` targets a specific workflow and script.
    c. Validate that the resolved workflow exists in the cached discovery results. If not found, print an error and exit with code 1.
    d. Validate that the resolved script exists in the target workflow. If not found, print an error and exit with code 1.
    e. If entering a workflow for the first time during this loop run, check its version declaration (section 3.2).
    f. Execute the resolved target with `result` piped via stdin (or empty stdin if `result` is absent).
    g. Return to step 7 with the new script's output.
12. If `goto` is absent:
    a. Re-run the **starting target** with no input.
    b. Return to step 7.

**Iteration counting:** `-n` / `maxIterations` counts **every target execution**, including goto hops — not just returns to the starting target. For example, if `ralph:index` outputs `goto: "check-ready"` and `ralph:check-ready` outputs `goto: "review-adr:start"`, that is three iterations.

**The CLI does not print `result` to its own stdout at any point.** All human-readable output from scripts should go to stderr, which passes through to the terminal. Structured results are accessed via the programmatic API (section 9).

### 7.2 Error Handling

- **Non-zero exit code from a script:** The loop **stops immediately**. loopx exits with code 1. The script's stderr has already been passed through to the terminal. Any stdout produced by the script before it failed is not parsed as structured output.
- **Missing workflow / missing script / missing default entry point:** If the starting target resolves to a workflow that does not exist, a script that does not exist in that workflow, or a bare workflow invocation where `index` is missing, loopx exits with code 1 and prints an error to stderr. These checks occur during target resolution (step 3 in section 7.1) before any iterations run.
- **Invalid `goto` target:** If `goto` contains an invalid target string (section 4.1), references a workflow that does not exist in the cached discovery results, or references a script that does not exist within the target workflow, loopx prints an error message to stderr and exits with code 1.
- **Missing `.loopx/` directory:** When executing via `loopx run <target>`, if `.loopx/` does not exist, loopx exits with an error instructing the user to create it.

### 7.3 Signal Handling

loopx handles process signals to ensure clean shutdown:

- **SIGINT / SIGTERM:** The signal is forwarded to the **active child process group** (not just the direct child). This ensures grandchild processes (e.g., agent CLIs spawned by scripts) also receive the signal, preventing orphaned processes.
- **Grace period:** After forwarding the signal, loopx waits **5 seconds** for the child process group to exit. If the process group has not exited after 5 seconds, loopx sends SIGKILL to the process group.
- **Exit code:** After the child exits, loopx exits with code `128 + signal number` (standard POSIX convention, e.g., 130 for SIGINT).
- **Between iterations:** If no child process is running (e.g., between iterations), loopx exits immediately with the appropriate signal exit code.

---

## 8. Environment Variables

### 8.1 Global Storage

Global environment variables are stored in the loopx configuration directory at:

```
$XDG_CONFIG_HOME/loopx/env
```

If `XDG_CONFIG_HOME` is not set, it defaults to `~/.config`, resulting in `~/.config/loopx/env`.

The file uses `.env` format with the following rules:

- One `KEY=VALUE` pair per line.
- **No whitespace is permitted around `=`.** The key extends to the first `=`, and the value is everything after it to the end of the line (trimmed of trailing whitespace).
- Lines starting with `#` are comments. **Inline comments are not supported** — a `#` after a value is part of the value.
- Blank lines are ignored.
- Duplicate keys: **last occurrence wins**.
- Values are single-line strings. Values may be optionally wrapped in double quotes (`"`) or single quotes (`'`), which are stripped. "Wrapped" means the value begins and ends with the same quote character — if quotes are unmatched (e.g., `KEY="hello` or `KEY='world`), the value is treated literally with no quotes stripped. **No escape sequence interpretation** — content inside quotes is treated literally (e.g., `"\n"` is a backslash followed by `n`, not a newline).
- No multiline value support.
- **Key validation:** Only keys matching `[A-Za-z_][A-Za-z0-9_]*` are recognized from env files (both global and local). Non-blank, non-comment lines that do not contain a valid key (e.g., lines without `=`, lines with invalid key names like `1BAD=val` or `KEY WITH SPACES=val`) are ignored with a warning to stderr.

If the directory or file does not exist, loopx treats it as having no global variables. The directory is created on first `loopx env set`. If the file exists but is unreadable (e.g., permission denied), loopx exits with code 1 and an error message.

**Concurrent mutation:** Concurrent writes to the same global env file (e.g., multiple simultaneous `loopx env set` calls) are not guaranteed to be atomic in v1. The result is undefined.

**Environment variables are loaded once at loop start and cached for the duration of the loop.** Changes to env files during loop execution are not picked up until the next invocation.

### 8.2 Local Override (`-e`)

When `-e <path>` is specified during execution (`loopx run <target>` or the programmatic API), the file at `<path>` is read using the same `.env` format rules. If the file does not exist, loopx exits with an error.

**Note:** Under the `loopx run -h` short-circuit, `-e` is not parsed or validated — a missing env file is not an error in that context (see section 4.2).

Local variables are merged with global env vars. Local values take precedence on conflict.

### 8.3 Injection

All resolved environment variables are injected into the script's execution environment alongside the inherited system environment, with the following precedence (highest wins):

1. **loopx-injected variables** (`LOOPX_BIN`, `LOOPX_PROJECT_ROOT`, `LOOPX_WORKFLOW`) — always override any user-supplied values of the same name.
2. **Local env file** (`-e`) values.
3. **Global loopx env** (`$XDG_CONFIG_HOME/loopx/env`) values.
4. **Inherited system environment.**

loopx injects the following variables into every script execution:

| Variable | Value |
|----------|-------|
| `LOOPX_BIN` | Resolved realpath of the effective loopx binary (post-delegation) |
| `LOOPX_PROJECT_ROOT` | Absolute path to the project root (section 3.2) |
| `LOOPX_WORKFLOW` | The name of the workflow containing the currently executing script |

**Note:** For Node.js/tsx, module resolution for `import from "loopx"` is handled via `--import` and a custom resolve hook (see section 3.3), not via `NODE_PATH`. For Bun, `NODE_PATH` is set internally but is not considered a user-facing injected variable.

---

## 9. Programmatic API

loopx can be imported and used from TypeScript/JavaScript. **This requires loopx to be installed as a local dependency** (`npm install loopx` or `npm install --save-dev loopx`).

### 9.1 `run(target: string, options?: RunOptions)`

```typescript
import { run } from "loopx";

const loop = run("ralph");

for await (const output of loop) {
  console.log(output.result);
  // each yielded value is an Output from one iteration
}
// loop has ended (stop: true or max iterations reached)
```

Returns an `AsyncGenerator<Output>` that yields the `Output` from each loop iteration. The generator completes when the loop ends via `stop: true` or when `maxIterations` is reached. **The output from the final iteration is always yielded before the generator completes.**

The `target` parameter follows the same `workflow[:script]` naming convention as the CLI:

```typescript
run("ralph")                // runs ralph:index
run("ralph:check-ready")   // runs ralph:check-ready
```

`target` is a required parameter. In TypeScript, omitting `target` is a static type error. In JavaScript, or when the type check is bypassed, runtime-invalid `target` values (e.g., `undefined`, `null`, `42`, or any non-string) are rejected lazily: `run()` still returns a generator without throwing, and the error is raised on first iteration (first `next()` call). For example, `run(undefined as any)` returns a generator that throws on first iteration.

**Error timing:** `run()` snapshots its options and `cwd` at call time, but all errors (validation failures, missing workflows, missing scripts, discovery errors, invalid `target`) are surfaced lazily when iteration begins (i.e., on the first `next()` call or equivalent). The `run()` call itself always returns a generator without throwing.

Options can be passed as a second argument:

```typescript
import { run } from "loopx";

for await (const output of run("ralph", { maxIterations: 10, envFile: ".env" })) {
  // ...
}
```

**Early termination:** There are two cancellation mechanisms with different semantics:

- **Consumer-driven (`break`, `generator.return()`):** loopx terminates the active child process group (if one is running — SIGTERM, then SIGKILL after 5 seconds) and ensures no further iterations start. If no child process is active at the time of cancellation (e.g., `break` after a yield, between iterations), the generator simply completes with no further yields. This is a silent, clean completion.

- **AbortSignal:** When the `signal` is aborted, loopx terminates the active child process group (if one is running — SIGTERM, then SIGKILL after 5 seconds) and the generator **throws an abort error**. This applies regardless of whether a child process is active — aborting the signal always produces an error, even if it occurs between iterations or before the first `next()` call. This follows conventional JavaScript `AbortSignal` semantics.

### 9.2 `runPromise(target: string, options?: RunOptions)`

```typescript
import { runPromise } from "loopx";

const outputs: Output[] = await runPromise("ralph");
```

Returns a `Promise<Output[]>` that resolves with an array of all `Output` values when the loop ends. Accepts the same options object as `run()`.

`target` is required, same as `run()`. In JavaScript or when the type check is bypassed, `runPromise(undefined as any)` returns a rejected promise rather than throwing synchronously — the call itself always returns a promise, and the validation error surfaces as a rejection.

### 9.3 Error Behavior

The programmatic API has different behavior from the CLI:

- **The library never prints `result` to stdout.** All results are returned as structured `Output` objects.
- **Errors throw/reject.** Any condition that would cause the CLI to exit with code 1 (non-zero script exit, invalid `goto`, missing workflow, missing script, validation failures) causes `run()` to throw from the generator and `runPromise()` to reject.
- **Partial outputs are preserved.** When `run()` throws, all previously yielded outputs have already been consumed by the caller. When `runPromise()` rejects, partial outputs are not available (use `run()` if partial results matter).
- **Stderr passes through.** Script stderr is still forwarded to the parent process's stderr, same as in CLI mode.

### 9.4 `output(value)` and `input()`

These functions are documented in sections 6.4 and 6.5. They are designed for use **inside scripts**, not in application code that calls `run()` / `runPromise()`.

### 9.5 Types

```typescript
import type { Output, RunOptions } from "loopx";

interface Output {
  result?: string;
  goto?: string;
  stop?: boolean;
}

interface RunOptions {
  maxIterations?: number;
  envFile?: string;
  signal?: AbortSignal;
  cwd?: string;
}
```

- When `signal` is provided and aborted, the active child process group is terminated and the generator/promise completes with an abort error.
- `cwd` specifies the **project root**: the directory from which `.loopx/` is resolved and from which `LOOPX_PROJECT_ROOT` is derived. It does not control the child process working directory — scripts always execute with their workflow directory as cwd (section 6.1). Defaults to `process.cwd()` at the time `run()` or `runPromise()` is called. Code that passes `cwd` expecting it to set the script's working directory must be updated — relative path resolution within the script will be relative to the workflow directory, and `LOOPX_PROJECT_ROOT` (sourced from `RunOptions.cwd` or `process.cwd()`) should be used for project-root-relative paths.
- `maxIterations` counts every target execution, including goto hops. `maxIterations: 0` mirrors CLI `-n 0` behavior: validates and exits without executing any iterations. `maxIterations` must be a non-negative integer; invalid values (negative, non-integer, NaN) cause `run()` to throw on first iteration and `runPromise()` to reject.
- Relative `envFile` paths are resolved against `cwd` if provided, otherwise against `process.cwd()` at call time.

---

## 10. `loopx install`

```
loopx install [options] <source>
```

Installs one or more workflows into the `.loopx/` directory, creating it if necessary.

`<source>` is required. `loopx install` with no source is a usage error (exit code 1). See section 4.2 for install-scoped options (`-w`, `-y`, `-h`) and their parsing rules.

### 10.1 Source Detection

Sources are classified using the following rules, applied in order:

1. **`org/repo` shorthand:** A source matching the pattern `<org>/<repo>` (no protocol prefix, exactly one slash, no additional path segments) is expanded to `https://github.com/<org>/<repo>.git` and treated as a git source. The `<repo>` segment must not end in `.git` — inputs like `org/repo.git` are rejected with an error. Users who want to specify a `.git` URL must provide the full URL (e.g., `https://github.com/org/repo.git`).
2. **Known git hosts:** A URL whose hostname is `github.com`, `gitlab.com`, or `bitbucket.org` is treated as a git source **only when the pathname is exactly `/<owner>/<repo>` or `/<owner>/<repo>.git`**, optionally with a trailing slash. Other URLs on these hosts (e.g., tarball download URLs, raw file URLs, paths with additional segments like `/org/repo/tree/main`) continue through the remaining source-detection rules.
3. **`.git` URL:** Any other URL ending in `.git` is treated as a git source.
4. **Tarball URL:** A URL whose **pathname** (ignoring query string and fragment) ends in `.tar.gz` or `.tgz` is downloaded and extracted.
5. **Any other URL:** Rejected with an error. Single-file URL install is not supported — scripts must be part of a workflow.

```
loopx install myorg/my-agent-workflow
# equivalent to: loopx install https://github.com/myorg/my-agent-workflow.git

loopx install https://github.com/myorg/my-agent-workflow
# also treated as git (github.com host detected)
```

### 10.2 Source Type Details

#### Git URL

- The repository is cloned with `--depth 1` (shallow clone) into a temporary location.
- For single-workflow sources (see section 10.3), the workflow name is derived from the repository name (last path segment, minus `.git` suffix if present).
- For multi-workflow sources, workflow names are derived from the subdirectory names within the repository.

#### Tarball URL

- The archive is downloaded and extracted.
- **If extraction yields a single top-level directory**, that directory's contents become the source root (wrapper-directory stripping). **If extraction yields multiple top-level entries**, the extracted contents are used directly as the source root.
- After extraction and wrapper-directory stripping (if applicable), the source root is classified as single-workflow, multi-workflow, or zero-workflow using the rules in section 10.3.
- For single-workflow tarball sources, the workflow name is the **archive-name**: the URL's last path segment with archive extensions (`.tar.gz`, `.tgz`) removed and query strings and fragments stripped. For multi-workflow tarball sources, workflow names are derived from the subdirectory names within the source root.

### 10.3 Workflow Classification

After obtaining the source (via git clone or tarball extraction), the source root is classified:

- **Single-workflow source:** The source root itself contains at least one file with a supported script extension. **Root-level script files take precedence unconditionally:** if the root has script files, the source is single-workflow regardless of what subdirectories contain. Subdirectories (e.g., `lib/`, `src/`, `config/`) are part of the workflow's content, not separate workflows. The entire source root is installed as a single workflow — all files and directories at the root, including non-script files such as `package.json`, configuration, documentation, schemas, and helper directories, are copied into `.loopx/<workflow-name>/`. This means a standard TypeScript project with `index.ts` at the root and a `lib/` or `src/` directory containing `.ts` files is a valid single-workflow source — the subdirectories are workflow internals, not competing workflow definitions.

- **Multi-workflow source:** The source root contains **no** files with supported script extensions, but contains one or more top-level directories that qualify as workflows (each containing at least one top-level file with a supported script extension). Each valid workflow directory is installed as a separate workflow in `.loopx/`. Non-script files and directories at the source root (README, LICENSE, CI config, etc.) are ignored — they are not copied into `.loopx/`. Subdirectories that contain no top-level script files are silently skipped — they are not workflows and do not cause a failure.

- **Zero-workflow source:** If the source contains no installable workflows (no root-level script files and no top-level subdirectories that qualify as workflows), install refuses with an error.

A multi-workflow source must not contain source-root files with supported script extensions. Such files cause the source to be classified as single-workflow. Tooling or configuration files using supported extensions (e.g., `eslint.config.js`, `vitest.config.ts`) must live inside workflow directories or use a non-supported extension.

#### Workflow self-containment

Each workflow must be fully self-contained:

- **Multi-workflow sources:** During installation, only each workflow's own directory is copied. Source-root support files (README, LICENSE, CI config, shared utilities, etc.) are not included. Workflow authors who need shared files must include them within each workflow directory.
- **Single-workflow sources:** The source root is the workflow directory, so all files and directories at the root are part of the workflow and are copied.

### 10.4 Install-time Validation

Installable workflows must satisfy the same discovery and validation rules as runtime (section 5), with one exception: a missing `index` script is allowed. Specifically, install validates:

- **Script naming:** All script files within the workflow must have base names matching `[a-zA-Z0-9_][a-zA-Z0-9_-]*`. Invalid script names cause the install to fail.
- **Base-name collisions:** If a workflow contains scripts with the same base name but different extensions (e.g., `check.sh` and `check.ts`), the install fails. This prevents installing a workflow that would fail at runtime.
- **Workflow naming:** The derived workflow name must match name restriction rules.
- **Missing `index`:** Allowed. A workflow without an `index` script can be installed — its scripts are invoked via explicit `workflow:script` targeting.

### 10.5 Collision Handling

A workflow install targets `.loopx/<workflow-name>/`. Workflow name and destination path are directly coupled — a workflow named `ralph` always installs to `.loopx/ralph/`.

Collision is determined by whether any filesystem entry (file, directory, or symlink) already exists at `.loopx/<workflow-name>`:

- **Path does not exist:** The workflow is installed. No collision checks are needed.
- **Path exists and is a workflow by structure:** The install is refused with an error. With `-y`, the existing entry is removed and the replacement is installed. The check is **local**: `.loopx/<workflow-name>` is a workflow if it is a directory containing at least one top-level file with a supported script extension. If `.loopx/<workflow-name>` is a symlink, the structural check follows the symlink (consistent with the discovery symlink policy in section 5.1) and inspects the symlink target's contents. When `-y` removes a symlinked workflow, it removes the symlink itself, not the symlink's target directory. This does not require a full discovery/validation pass over all of `.loopx/` — only the target path is inspected. Invalid sibling workflows, name collisions in other workflows, or other issues elsewhere under `.loopx/` do not affect whether `-y` can replace the target.
- **Path exists but is not a workflow by structure** (e.g., a directory with no script files, or a non-directory filesystem entry): The install is refused with an error, even with `-y`. This prevents `-y` from accidentally deleting non-workflow data.

`-y` replaces only entries that are workflows by structure at the target path. It does not replace non-workflow directories or other arbitrary filesystem entries.

### 10.6 Version Checking on Install

If a workflow being installed declares a `loopx` version range in its `package.json`, and the **currently running** loopx version does not satisfy that range, installation is refused with an error explaining the mismatch.

This can be overridden with `-y`:

```
loopx install -y <source>
```

With `-y`, the installation proceeds despite version mismatch and the workflow's version declaration is preserved in its own `package.json`.

**`package.json` failure modes at install:** The same `package.json` failure rules from section 3.2 apply. If the workflow's `package.json` is unreadable, contains invalid JSON, or has an invalid semver range, a warning is printed and the version check is skipped — the install proceeds (the workflow is still installable, just without version validation). Version *mismatches* (a valid range not satisfied by the running version) are blocking errors unless `-y` is used.

There is no `.loopx/package.json` manifest. Version authority lives in two places only: the project root `package.json` (for delegation, section 3.2) and each workflow's own `package.json` (for runtime and install-time validation).

### 10.7 Install Atomicity

Multi-workflow installs are **preflight-atomic**: no workflows are written until all selected workflows pass preflight and staging completes. Once commit begins, a rare failure may leave a partial install; loopx reports which workflows were and were not committed.

**Preflight phase:** All preflight checks — name restriction violations, script-name collisions within a workflow, collisions with existing entries at `.loopx/<workflow-name>`, and version mismatches (workflow declares a `loopx` range not satisfied by the running version) — are evaluated for every selected workflow (that is, every workflow that would be installed) before any are written. If any workflow fails any preflight check, the entire install fails, no workflows are written to `.loopx/`, and a single aggregated error is displayed listing all failures across all workflows. When `-y` is present, replaceable workflow-path collisions and version mismatches are recorded during preflight but are not treated as failures; all other validation failures (invalid names, same-base-name collisions, zero-workflow sources, non-workflow destination paths) remain fatal regardless of `-y`. Directories with no script files are silently skipped (they are not workflows) and do not cause a failure.

**Write phase (stage-then-commit):** After preflight passes, writes use a stage-then-commit strategy to preserve atomicity:

1. **Stage:** All workflows are written to a temporary staging directory. For `-y` replacements, the existing workflow directories in `.loopx/` are not yet touched.
2. **Commit:** If all staging writes succeed, the commit phase begins: existing workflows targeted by `-y` are removed and staged workflows are moved (renamed) into `.loopx/`.
3. **Staging failure:** If any write fails during staging (copy error, permission denied, disk full), the staging directory is cleaned up and `.loopx/` is left unchanged. The install fails with an error identifying the failing workflow and the underlying cause.
4. **Commit failure:** If a failure occurs during the commit phase (e.g., a rename fails after some workflows have already been committed), loopx reports the error and lists which workflows were and were not committed. No automatic rollback of already-committed workflows is attempted — the commit phase involves only renames within the same filesystem, which minimizes the window for partial failure.

### 10.8 Selective Workflow Installation

```
loopx install -w <name> <source>
loopx install --workflow <name> <source>
```

`-w` / `--workflow` installs only the named workflow from a **multi-workflow** source. If the named workflow does not exist in the source, it is an error.

When `-w` is used, only the selected workflow is validated. Invalid sibling workflows in the source do not block installation of the selected workflow.

`-w` is only valid for multi-workflow sources. If the source is a single-workflow source (root-level script files), using `-w` is an error regardless of the name provided.

### 10.9 Common Rules

- **loopx does not run `npm install` or `bun install` after cloning/extracting.** For workflows with dependencies, the user must install them manually (e.g., `cd .loopx/my-workflow && npm install`).
- **Install failure cleanup:** Any install failure (download error, HTTP non-2xx, git clone failure, extraction failure, post-download validation failure) exits with code 1. Any partially created staging directory is removed before exit. For single-workflow installs, any partially created target directory at the destination path is also removed before exit.

---

## 11. Help

Help has three forms: top-level help, run help, and install help.

### 11.1 Top-level Help

`loopx -h` / `loopx --help` / `loopx` (no arguments) prints top-level usage information:

- General CLI syntax
- Available subcommands (`run`, `version`, `output`, `env`, `install`)

Top-level help does **not** inspect `.loopx/` or perform discovery.

### 11.2 Run Help

`loopx run -h` / `loopx run --help` prints run-specific usage information:

- `run` syntax and options (`-n`, `-e`)
- A dynamically generated list of workflows and their scripts discovered in the current `.loopx/` directory. If a workflow has an `index` script, it is indicated as the default entry point.

Run help performs **non-fatal discovery and validation**:

- If `.loopx/` does not exist, run help is still displayed with a warning that the directory was not found. The discovered-workflows section is omitted.
- If `.loopx/` exists but contains validation issues (name collisions, name restriction violations), run help is displayed with warnings for the problematic entries.

`loopx run <target> -h` is equivalent to `loopx run -h` — the target argument is ignored due to the `-h` short-circuit (section 4.2).

Run help is the only help form that performs workflow and script discovery. The `-h` short-circuit within `run` ignores all other run-level arguments (see section 4.2).

### 11.3 Install Help

`loopx install -h` / `loopx install --help` prints install-specific usage information:

- `install` syntax and options (`-w`, `-y`)
- Supported source types

Install help does not require a source argument, does not make network requests, and does not inspect `.loopx/`.

---

## 12. Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Clean exit: loop ended via `stop: true`, `-n` limit reached (including `-n 0`), successful subcommand execution, or help display. |
| 1 | Error: script exited non-zero, validation failure, invalid `goto` target, missing workflow, missing script, missing `.loopx/` directory, install failure, or usage error. |
| 128+N | Interrupted by signal N (e.g., 130 for SIGINT). |

Usage errors (exit code 1) include: `loopx run` with no target, `loopx run ralph bar` (extra positional), `loopx foo` (unrecognized subcommand), `loopx ralph` (unrecognized subcommand — no implicit fallback to `run`), `loopx --unknown` (unrecognized top-level flag), `loopx -n 5 ralph` (top-level `-n`), `loopx -e .env ralph` (top-level `-e`), `loopx run --unknown ralph` (unrecognized run flag), `loopx run -n 5 -n 10 ralph` (duplicate run flag), `loopx install` with no source, `loopx install -w a -w b <source>` (duplicate install flag), and `loopx install --unknown <source>` (unrecognized install flag).

Invalid target strings (e.g., `loopx run ":script"`, `loopx run "workflow:"`, `loopx run "a:b:c"`, `loopx run ""`) are also exit code 1 but are not usage errors — they are rejected after discovery, at the same point as a missing workflow or missing script (section 4.1).

Note: A non-zero exit code from any script causes loopx to exit with code 1. Scripts that need error resilience should handle errors internally and exit 0.

---

## 13. Summary of Reserved and Special Values

| Name | Context | Purpose |
|------|---------|---------|
| `LOOPX_BIN` | Env variable | Resolved realpath of the effective loopx binary (post-delegation) |
| `LOOPX_PROJECT_ROOT` | Env variable | Absolute path to the project root (section 3.2) |
| `LOOPX_WORKFLOW` | Env variable | The name of the workflow containing the currently executing script |
| `LOOPX_DELEGATED` | Env variable | Set to `1` during delegation to prevent recursion |
| `index` | Convention | Default entry point script name within a workflow |
| `:` | Delimiter | Reserved separator between workflow and script names in target strings |
