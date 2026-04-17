# ADR-0003: Workflow-Based Script Organization

**Status:** Tested

---

## Context

The current loopx model organizes scripts as flat files (or directory scripts) directly inside `.loopx/`. As real-world usage has grown — e.g., multi-step agent loops like `review-adr`, `apply-adr`, and `spec-test-adr` — a pattern has emerged: groups of related scripts that form a logical unit, with `goto` transitions between them. Today, all scripts share a single namespace, `goto` can only target scripts within `.loopx/`, and there is no way to package or reuse a group of scripts as a cohesive unit.

Additionally, the current version resolution mechanism (section 3.2) relies on ancestor-directory traversal to find a local `node_modules/.bin/loopx`, which is more complex than necessary. A simpler, more explicit model is desirable.

This ADR introduces **workflows** — named directories of scripts within `.loopx/` — as the primary organizational unit, replaces the flat script and directory script models, adds cross-workflow `goto` transitions, simplifies version resolution, and updates the install mechanism to operate on workflows.

## Decision

### 1. Workflows replace flat scripts and directory scripts

A **workflow** is a subdirectory of `.loopx/` that contains one or more script files. Scripts are no longer placed directly in `.loopx/` as loose files.

**Before (current):**
```
.loopx/
  check-ready.sh          ← file script
  run-ralph.sh            ← file script
  my-pipeline/            ← directory script (package.json + main)
    package.json
    index.ts
```

**After (workflows):**
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

A subdirectory of `.loopx/` is recognized as a workflow if it contains at least one **top-level** file with a supported script extension (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`). Only files directly inside the subdirectory are considered — the scan is not recursive. Subdirectories that contain no top-level script files are ignored during discovery.

#### Workflow naming

Workflow names follow the same restrictions as current script names: must match `[a-zA-Z0-9_][a-zA-Z0-9_-]*`. Additionally, workflow names must not contain `:` (already excluded by the existing pattern, but called out explicitly since `:` is now a syntactic delimiter).

#### Script naming within workflows

Script names (the base name of a file without its extension) follow the same naming rules as workflow names: `[a-zA-Z0-9_][a-zA-Z0-9_-]*`, no `:`.

#### Non-script files

Files without supported extensions (e.g., `.json`, `.schema.json`, `.md`, `.txt`) inside a workflow directory are allowed and ignored by discovery. This supports patterns like schema files, documentation, or configuration that live alongside scripts.

#### All top-level files with supported extensions are scripts

Every file directly inside a workflow directory that has a supported script extension (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`) is a discovered script — there is no opt-out or exclusion mechanism. This means reusable helper modules, configuration files, or shared utilities that happen to use a supported extension must be placed in subdirectories (e.g., `lib/`, `helpers/`, `config/`). Subdirectories within a workflow are not scanned during script discovery (see "Nested directory scripts within workflows are not supported" below), so files in subdirectories are invisible to loopx and available for internal use by the workflow's scripts.

#### Directory scripts are removed

The "directory script" concept (a directory with `package.json` + `main` field acting as a single script) is removed. Subdirectories of `.loopx/` are recognized as workflows only if they satisfy the workflow detection rules above — they must contain at least one top-level file with a supported script extension. Subdirectories that do not meet this criterion (e.g., utility directories, shared configuration) are allowed but are not workflows and are ignored by discovery. If a workflow needs dependencies, it may include a `package.json` and `node_modules/` — but the `main` field no longer determines the entry point. The entry point is determined by convention (see section 2).

#### Nested directory scripts within workflows are not supported

Scripts within a workflow must be files, not subdirectories. A subdirectory inside a workflow is ignored during script discovery within that workflow.

### 2. Default entry point

Each workflow has a **default entry point**: a script named `index` (i.e., `index.sh`, `index.js`, `index.jsx`, `index.ts`, or `index.tsx`). This is the script that runs when a workflow is invoked without specifying a script name.

- `loopx run ralph` is equivalent to `loopx run ralph:index`.
- If a workflow has no script named `index`, invoking it without a script name is an error (exit code 1). The workflow is still valid — its other scripts can be targeted explicitly.

`index` is not otherwise special. It can be the target of `goto`, it follows the same naming/collision rules as other scripts, and it can `goto` other scripts.

### 3. Invocation syntax

The `run` subcommand syntax becomes:

```
loopx run [options] <workflow>[:<script>]
```

- `loopx run ralph` — runs the `index` script in the `ralph` workflow.
- `loopx run ralph:check-ready` — runs the `check-ready` script in the `ralph` workflow.
- `loopx run ralph:index` — explicitly runs the `index` script (same as bare `loopx run ralph`).

The `<workflow>` portion is required. The `:<script>` portion is optional and defaults to `index`.

The colon is a reserved delimiter. It must not appear in workflow names or script names (already excluded by the name restriction pattern).

#### Programmatic API

The programmatic API follows the same naming convention:

```typescript
run("ralph", options?)              // runs ralph:index
run("ralph:check-ready", options?)  // runs ralph:check-ready
```

`scriptName` is renamed to `target` in the API to reflect the new `workflow:script` semantics:

```typescript
run(target: string, options?: RunOptions): AsyncGenerator<Output>
runPromise(target: string, options?: RunOptions): Promise<Output[]>
```

The same lazy error semantics apply: invalid `target` values are rejected on first iteration / as a promise rejection.

#### Target validation

The following target strings are invalid in all contexts — CLI invocation (`loopx run <target>`), programmatic API (`run(target)`), and `goto` values:

- **Empty string** (`""`): error.
- **Bare colon** (`":"`): error.
- **Leading colon** (e.g., `":script"`): error.
- **Trailing colon** (e.g., `"workflow:"`): error. In CLI invocation and the programmatic API, target the default entry point by omitting the colon (`"workflow"`) or using `"workflow:index"`. In `goto`, a bare name is a script in the current workflow (see section 4), so targeting another workflow's default entry point from `goto` requires the qualified form `"workflow:index"`.
- **Multiple colons** (e.g., `"a:b:c"`): error. The colon delimiter may appear at most once.
- **Name restriction violations**: The workflow portion and the script portion (if present) must each match `[a-zA-Z0-9_][a-zA-Z0-9_-]*`. A target where either portion violates this pattern is an error.

Existing structured-output parsing semantics are unchanged: if `goto` is present but not a string, it is treated as absent. Target validation in this ADR applies only after a `goto` value has been parsed as a string.

For CLI invocation and the programmatic API, invalid targets are rejected at the same point as a missing workflow (after discovery, or lazily on first iteration for the API). For `goto` values, invalid targets produce an error at transition time (exit code 1).

### 4. Goto semantics

#### Bare target disambiguation

A bare name (no colon) means different things depending on context:

- **In `run` (CLI or programmatic API):** A bare name is a **workflow name** and resolves to that workflow's `index` script. `loopx run ralph` and `run("ralph")` both mean `ralph:index`.
- **In `goto`:** A bare name is a **script name** within the current workflow. `{ "goto": "ralph" }` from a script in the `review-adr` workflow means `review-adr:ralph`, not `ralph:index`.

This distinction is fundamental to the invocation model: `run` addresses workflows, `goto` addresses scripts within the current workflow's scope.

#### Intra-workflow goto (bare name)

A `goto` value without a colon targets a script in the **same workflow as the currently executing script**:

```json
{ "goto": "check-ready" }
```

If the current script is in the `ralph` workflow, this transitions to `ralph:check-ready`.

#### Qualified goto

A `goto` value with a colon targets a specific script in a named workflow:

```json
{ "goto": "review-adr:request-feedback" }
```

This transitions to the `request-feedback` script in the `review-adr` workflow. The qualified form is valid whether the target is a different workflow or the same workflow as the currently executing script — e.g., a script in `ralph` may use `{ "goto": "ralph:check-ready" }`, which is equivalent to the bare `{ "goto": "check-ready" }`.

The target workflow must exist in the cached discovery results; otherwise it is an invalid `goto` target (error, exit code 1). Malformed `goto` values follow the same rules as all target strings (see section 3, Target validation).

#### Starting target and loop reset

The **starting target** is always the target specified at invocation (e.g., `ralph:index`). When a transition chain ends (a script finishes without a `goto`), the loop resets to the starting target — regardless of which workflow the chain ended in. Cross-workflow `goto` does not change the starting target.

**Example:**
```
Starting target: ralph:index

Iteration 1: ralph:index → goto "check-ready"        (intra-workflow)
Iteration 2: ralph:check-ready → goto "review-adr:request-feedback"  (cross-workflow)
Iteration 3: review-adr:request-feedback → (no goto)
Iteration 4: ralph:index → (back to starting target)
```

#### Bare goto from a cross-workflow context

When a script reached via cross-workflow `goto` issues a bare (unqualified) `goto`, it targets a script in **its own workflow**, not the starting target's workflow:

```
Starting target: ralph:index

Iteration 1: ralph:index → goto "review-adr:check-question"
Iteration 2: review-adr:check-question → goto "apply-feedback"
                                          ↑ bare name → resolves to review-adr:apply-feedback
Iteration 3: review-adr:apply-feedback → (no goto)
Iteration 4: ralph:index → (back to starting target)
```

### 5. Simplified version resolution

The current version delegation mechanism (section 3.2 — ancestor-directory traversal for `node_modules/.bin/loopx`) is replaced with a simpler, explicit resolution chain.

#### Project root

For loopx, the **project root** is always the invocation cwd. This is the same directory where `.loopx/` lives (when it exists), but the project root is determined by cwd alone — it does not depend on `.loopx/` existing. This means delegation, version pinning, and all project-root-relative behavior work regardless of whether `.loopx/` has been initialized.

#### Resolution order (highest precedence first)

1. **Project root `package.json`:** If the project root has a `package.json` that lists `loopx` as a dependency (in `dependencies`, `devDependencies`, or `optionalDependencies`) and a corresponding `node_modules/.bin/loopx` exists, the global binary delegates to it.
2. **Global install:** If no local version is found, the global install runs.

Delegation happens **before command parsing**, so it is based on the project root only — not on the target workflow. Because the project root is cwd (not "the directory containing `.loopx/`"), delegation works for all commands, including those that do not require `.loopx/` to exist (e.g., `loopx version`, `loopx install`, `loopx env`).

#### Project-root `package.json` failure modes

The delegation check in step 1 above depends on reading the project-root `package.json`. The following rules define behavior when that file is problematic:

- **No `package.json` at project root:** No delegation. The global install runs. No warning.
- **Unreadable `package.json`** (e.g., permission denied): A warning is printed to stderr. Delegation is skipped and the global install runs.
- **Invalid JSON:** A warning is printed to stderr. Delegation is skipped and the global install runs.
- **Valid JSON, `loopx` declared in `dependencies`/`devDependencies`/`optionalDependencies`, but `node_modules/.bin/loopx` does not exist:** A warning is printed to stderr (the dependency is declared but the binary is missing — likely `npm install` has not been run). Delegation is skipped and the global install runs.
- **Valid JSON, `loopx` not declared in any dependency field, but `node_modules/.bin/loopx` exists:** No delegation. The dependency declaration is required for delegation — an undeclared binary is not used. No warning.

In all cases, a problematic project-root `package.json` degrades delegation but does not prevent loopx from running. The global install is always the fallback.

#### Workflow-level version declaration (runtime validation)

A workflow's `package.json` may declare a `loopx` version requirement (in `dependencies` or `devDependencies`). `optionalDependencies` is intentionally not checked at the workflow level — a version requirement declared there is ignored. Workflow-level version declarations are compatibility assertions, not optional suggestions. (Project-root delegation checks `optionalDependencies` because it follows standard npm dependency semantics for locating a local binary.)

If `loopx` is declared in **both** `dependencies` and `devDependencies` within the same `package.json`, the `dependencies` range takes precedence for version checking and the `devDependencies` range is ignored. This precedence rule applies only to **version checking** (workflow-level runtime validation and install-time validation). At the project root level, delegation depends on declaration presence and binary existence (step 1 above) — no range comparison is performed, so range precedence is not relevant to delegation.

This declaration is **not used for delegation** — delegation always happens at project root level. Instead, after delegation and command parsing, the running loopx version is checked against the workflow's declared version range:

- If the running version satisfies the declared range: execution proceeds normally.
- If the running version does **not** satisfy the declared range: loopx prints a warning to stderr and continues execution. This is a non-fatal warning, not an error — it alerts the user to a potential incompatibility without blocking work.

This avoids the chicken-and-egg problem of needing to parse the target workflow before delegating, while still giving workflow authors a way to declare version expectations.

#### `package.json` failure modes

A workflow's `package.json` may be absent, unreadable, or malformed. The following failure-mode rules apply at both runtime and install time:

- **No `package.json`:** No version check is performed. This is the normal case for workflows without dependencies or version requirements.
- **Unreadable `package.json`** (e.g., permission denied): A warning is printed to stderr. The version check is skipped (treated as no version declared). Execution / installation proceeds.
- **Invalid JSON:** A warning is printed to stderr. The version check is skipped. Execution / installation proceeds.
- **Valid JSON but `loopx` version field contains an invalid semver range:** A warning is printed to stderr. The version check is skipped. Execution / installation proceeds.
- **Valid JSON, no `loopx` dependency declared:** No version check is performed.

In all warning cases, the workflow is still usable — a broken `package.json` degrades version checking but does not block execution or installation.

**Warning timing differs by context:**

- **Runtime:** `package.json` failure warnings follow the same "first entry only" rule as version mismatch warnings (see "Cross-workflow version checking" below). The version check — and any warnings it produces — runs once on first entry into a workflow during a loop run. Subsequent entries into the same workflow do not re-read `package.json` or repeat warnings.
- **Install:** Each workflow's `package.json` is checked once during the install operation. Warnings are emitted once per affected workflow. `package.json` failure warnings (unreadable, invalid JSON, invalid semver range) do not block installation — the workflow is still installable, just without version validation. Version *mismatches* (a valid range not satisfied by the running version) are blocking errors and are included in the aggregated preflight failure report (see section 8, "Install atomicity" and "Version checking on install").

#### Removed: ancestor-directory traversal

The current behavior of searching from `cwd` upward for `node_modules/.bin/loopx` is removed. Only the project root (cwd) is checked for a local install. This makes the delegation behavior fully deterministic from the invocation directory.

#### Recursion guard

The `LOOPX_DELEGATED=1` recursion guard is preserved. The `LOOPX_BIN` variable continues to point to the resolved realpath of the effective binary post-delegation.

#### Cross-workflow version checking

When a loop enters a workflow — whether at loop start or via `goto` — the workflow's declared `loopx` version range (if any) is checked against the running version **on first entry only**. If the range is not satisfied, a warning is printed to stderr. Subsequent entries into the same workflow during the same loop run do not repeat the warning.

This means:
- The starting workflow is checked once before the first iteration.
- A workflow reached via `goto` is checked on first transition into it.
- Re-entering a previously visited workflow (e.g., via loop reset or another `goto`) does not produce a second warning.

**`-n 0` behavior:** When `-n 0` is specified, discovery, target resolution, and environment variable loading (global and `-e`) still run — the target workflow and script must exist and pass validation (name collisions, name restrictions), and env files must be readable and valid, consistent with the current SPEC (section 4.2). However, workflow-level version checking is skipped because no workflow is entered for execution. `-n 0` validates that the target is runnable, but does not perform the runtime version compatibility check.

### 6. Discovery changes

Discovery scans `.loopx/` for workflow subdirectories, then scans each workflow for script files.

#### Workflow discovery

Files placed directly inside `.loopx/` are never discovered, even if they have supported script extensions; only subdirectories are candidates for workflow discovery.

- Scan `.loopx/` for top-level subdirectories.
- A subdirectory is a workflow if it contains at least one **top-level** file (directly inside the subdirectory, not in nested subdirectories) with a supported extension.
- Subdirectories with no script files are ignored (no warning).
- Workflow names are validated against the name restriction rules.

#### Script discovery within workflows

- Scan each workflow directory for top-level files with supported extensions.
- The script name is the file's base name (filename without extension).
- Subdirectories within a workflow are ignored.
- Name collisions (e.g., `check.sh` and `check.ts` in the same workflow) follow the same rules as the current spec: fatal in `loopx run`, non-fatal warning in `loopx run -h`.

#### Discovery caching

Discovery metadata is still cached at loop start for the duration of the loop, following the same rules as the current spec (section 5.1).

#### Validation scope

The current spec's global validation model (section 5.4) is preserved. All discovered workflows and their scripts are validated at discovery time. An invalid workflow name, invalid script name, or same-base-name collision in **any** workflow under `.loopx/` is fatal for `loopx run <target>`, regardless of whether the target workflow is the one containing the error. This means `loopx run good` fails if a sibling workflow `broken` contains a name collision or an invalid script name.

For `loopx run -h`, validation remains non-fatal: all issues across all workflows are reported as warnings.

#### Symlink policy

Symlinks within `.loopx/` are followed during discovery, consistent with the current spec (section 5.1). A symlinked workflow directory or script file is treated identically to its non-symlinked equivalent. Symlink resolution does not affect workflow or script naming — names are derived from the symlink's own name, not its target.

### 7. Help changes

- **`loopx -h`:** Top-level help. Lists subcommands and general syntax. No discovery.
- **`loopx run -h`:** Discovers workflows and lists them with their scripts. If `.loopx/` does not exist, run help is still displayed with a warning that the directory was not found — the discovered-workflows section is omitted (preserving the current SPEC section 11.2 behavior). Non-fatal validation warnings are shown (name collisions, name restriction violations, etc.). If a workflow has an `index` script, it is indicated as the default entry point.
- **`loopx run ralph -h`:** Equivalent to `loopx run -h` (the `-h` short-circuit still applies — the workflow argument is ignored). This is consistent with the existing `loopx run <script> -h` behavior.

### 8. Install changes

#### CLI grammar

```
loopx install [options] <source>
```

`<source>` is required. `loopx install` with no source is a usage error (exit code 1).

**Install-scoped options:**

| Flag | Description |
|------|-------------|
| `-w <name>`, `--workflow <name>` | Install only the named workflow from a multi-workflow source. |
| `-y` | Override version mismatch and workflow collision checks (see below). |
| `-h`, `--help` | Print install help and exit. |

**Parsing rules** (parallel to `run` in current SPEC section 4.2):

- **Duplicate flags:** Repeating `-w` or `-y` is a usage error (exit code 1) — unless `-h` is present.
- **Unrecognized flags:** Unrecognized flags (e.g., `loopx install --unknown <source>`) are usage errors (exit code 1) — unless `-h` is present.
- **`install -h` short-circuit:** When `-h` is present, loopx shows install help, exits 0, and ignores all other install-level arguments unconditionally. Source is not required, flags are not validated, and no network requests are made.

#### Installing workflows from a repository

`loopx install <source>` continues to clone/download into `.loopx/`. The key change is that a repository may contain **multiple workflows** (top-level directories with script files), and install handles them as follows:

- **Single-workflow repo:** The repository root itself contains at least one file with a supported script extension (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`). **Root-level script files take precedence unconditionally:** if the root has script files, the source is single-workflow regardless of what subdirectories contain. Subdirectories (e.g., `lib/`, `src/`, `config/`) are part of the workflow's content, not separate workflows. The entire repository root is installed as a single workflow named after the repo — all files and directories at the root, including non-script files such as `package.json`, configuration, documentation, schemas, and helper directories, are copied into `.loopx/<repo-name>/`. This means a standard TypeScript project with `index.ts` at the root and a `lib/` or `src/` directory containing `.ts` files is a valid single-workflow source — the subdirectories are workflow internals, not competing workflow definitions.
- **Multi-workflow repo:** The repository root contains **no** files with supported script extensions, but contains one or more top-level directories that qualify as workflows (each containing at least one top-level file with a supported script extension). Each valid workflow directory is installed as a separate workflow in `.loopx/`. Non-script files and directories at the repository root (README, LICENSE, CI config, etc.) are ignored — they are not copied into `.loopx/`. Subdirectories that contain no top-level script files are silently skipped — they are not workflows and do not cause a failure.
- **Zero-workflow repo:** If the source contains no installable workflows (no root-level script files and no top-level subdirectories that qualify as workflows), install refuses with an error.

A multi-workflow source must not contain repo-root files with supported script extensions. Such files cause the source to be classified as single-workflow. Tooling or configuration files using supported extensions (e.g., `eslint.config.js`, `vitest.config.ts`) must live inside workflow directories or use a non-supported extension.

#### Workflow self-containment

Each workflow must be fully self-contained.

- **Multi-workflow repos:** During installation, only each workflow's own directory is copied. Repo-root support files (README, LICENSE, CI config, shared utilities, etc.) are not included. Workflow authors who need shared files must include them within each workflow directory.
- **Single-workflow repos:** The repo root is the workflow directory, so all files and directories at the root are part of the workflow and are copied. There is no "repo-root vs. workflow directory" distinction — everything in the repo is part of the workflow.

#### Install-time validation

Installable workflows must satisfy the same discovery and validation rules as runtime (section 6), with one exception: a missing `index` script is allowed. Specifically, install validates:

- **Script naming:** All script files within the workflow must have base names matching `[a-zA-Z0-9_][a-zA-Z0-9_-]*`. Invalid script names cause the install to fail.
- **Base-name collisions:** If a workflow contains scripts with the same base name but different extensions (e.g., `check.sh` and `check.ts`), the install fails. This prevents installing a workflow that would fail at runtime.
- **Workflow naming:** The derived workflow name must match name restriction rules.
- **Missing `index`:** Allowed. A workflow without an `index` script can be installed — its scripts are invoked via explicit `workflow:script` targeting.

#### Install atomicity

Multi-workflow installs are **preflight-atomic**: no workflows are written until all selected workflows pass preflight and staging completes. Once commit begins, a rare failure may leave a partial install; loopx reports which workflows were and were not committed.

**Preflight phase:** All preflight checks — name restriction violations, script-name collisions within a workflow, collisions with existing entries at `.loopx/<workflow-name>`, and version mismatches (workflow declares a `loopx` range not satisfied by the running version) — are evaluated for every workflow before any are written. If any workflow fails any preflight check, the entire install fails, no workflows are written to `.loopx/`, and a single aggregated error is displayed listing all failures across all workflows. When `-y` is present, replaceable workflow-path collisions and version mismatches are recorded during preflight but are not treated as failures; all other validation failures (invalid names, same-base-name collisions, zero-workflow sources, non-workflow destination paths) remain fatal regardless of `-y`. Directories with no script files are silently skipped (they are not workflows) and do not cause a failure.

**Write phase (stage-then-commit):** After preflight passes, writes use a stage-then-commit strategy to preserve atomicity:

1. **Stage:** All workflows are written to a temporary staging directory. For `-y` replacements, the existing workflow directories in `.loopx/` are not yet touched.
2. **Commit:** If all staging writes succeed, the commit phase begins: existing workflows targeted by `-y` are removed and staged workflows are moved (renamed) into `.loopx/`.
3. **Staging failure:** If any write fails during staging (copy error, permission denied, disk full), the staging directory is cleaned up and `.loopx/` is left unchanged. The install fails with an error identifying the failing workflow and the underlying cause.
4. **Commit failure:** If a failure occurs during the commit phase (e.g., a rename fails after some workflows have already been committed), loopx reports the error and lists which workflows were and were not committed. No automatic rollback of already-committed workflows is attempted — the commit phase involves only renames within the same filesystem, which minimizes the window for partial failure.

#### Selective workflow installation

```
loopx install -w <name> <source>
loopx install --workflow <name> <source>
```

`-w` / `--workflow` installs only the named workflow from a **multi-workflow** repository. If the named workflow does not exist in the source, it is an error.

When `-w` is used, only the selected workflow is validated. Invalid sibling workflows in the source do not block installation of the selected workflow.

`-w` is only valid for multi-workflow sources. If the source is a single-workflow repo (root-level script files), using `-w` is an error regardless of the name provided.

#### Source detection

Existing source detection rules (SPEC section 10.1) remain unchanged for `org/repo` shorthand, known git hosts, `.git` URLs, and tarball URLs. The only removal is the single-file URL fallback: any source that would previously have been classified as a single-file URL (rule 5 in section 10.1 — "any other URL") is now rejected with an error. The remaining classification rules, their ordering, and their edge cases are preserved as-is.

#### Tarball source normalization

The current SPEC (section 10.2) defines wrapper-directory stripping for tarballs: if extraction yields a single top-level directory, that directory's contents become the package root; if extraction yields multiple top-level entries, the extracted contents are used directly. This behavior is preserved.

After extraction and wrapper-directory stripping (if applicable), the result is the **source root**. The source root is then classified as single-workflow, multi-workflow, or zero-workflow using the same rules described in "Installing workflows from a repository" above — the classification logic is source-type-agnostic.

For single-workflow tarball sources, the workflow name is the **archive-name**: the URL's last path segment with archive extensions (`.tar.gz`, `.tgz`) removed and query strings and fragments stripped, consistent with the current SPEC §10.2 naming derivation. For multi-workflow tarball sources, workflow names are derived from the subdirectory names within the source root, same as for git sources.

#### Single-file URL

Single-file URL install is removed. Scripts must be part of a workflow. To install a single script, it should be in a repository as a workflow directory.

#### Collision handling on install

A workflow install targets `.loopx/<workflow-name>/`. In the workflow model, workflow name and destination path are directly coupled — a workflow named `ralph` always installs to `.loopx/ralph/`. The old spec's separate "script-name collision" and "destination-path collision" checks (section 10.3) collapse into a single path-based check.

Collision is determined by whether any filesystem entry (file, directory, or symlink) already exists at `.loopx/<workflow-name>`:

- **Path does not exist:** The workflow is installed. No collision checks are needed.
- **Path exists and is a workflow by structure:** The install is refused with an error. With `-y`, the existing entry is removed and the replacement is installed. The check is **local**: `.loopx/<workflow-name>` is a workflow if it is a directory containing at least one top-level file with a supported script extension. If `.loopx/<workflow-name>` is a symlink, the structural check follows the symlink (consistent with the discovery symlink policy in section 6) and inspects the symlink target's contents. When `-y` removes a symlinked workflow, it removes the symlink itself, not the symlink's target directory. This does not require a full discovery/validation pass over all of `.loopx/` — only the target path is inspected. Invalid sibling workflows, name collisions in other workflows, or other issues elsewhere under `.loopx/` do not affect whether `-y` can replace the target.
- **Path exists but is not a workflow by structure** (e.g., a directory with no script files, or a non-directory filesystem entry): The install is refused with an error, even with `-y`. This prevents `-y` from accidentally deleting non-workflow data.

`-y` replaces only entries that are workflows by structure at the target path. It does not replace non-workflow directories or other arbitrary filesystem entries.

#### Version checking on install

If a workflow being installed declares a `loopx` version range in its `package.json`, and the **currently running** loopx version does not satisfy that range, installation is refused with an error explaining the mismatch.

This can be overridden with `-y`:

```
loopx install -y <source>
```

With `-y`, the installation proceeds despite version mismatch and the workflow's version declaration is preserved in its own `package.json`.

**`package.json` failure modes at install:** The same `package.json` failure rules from section 5 apply. If the workflow's `package.json` is unreadable, contains invalid JSON, or has an invalid semver range, a warning is printed and the version check is skipped — the install proceeds (the workflow is still installable, just without version validation).

There is no `.loopx/package.json` manifest. Version authority lives in two places only: the project root `package.json` (for delegation, section 5) and each workflow's own `package.json` (for runtime and install-time validation).

### 9. Workflow-level `package.json`

A workflow's `package.json` serves two optional purposes:

1. **Dependency management:** The workflow can declare its own dependencies. Users manage installation themselves (`npm install` / `bun install` within the workflow directory). loopx does not auto-install dependencies.
2. **Version declaration:** The workflow can declare a `loopx` version requirement (see section 5).

The `main` field is no longer used to determine the entry point. The entry point is always the `index` script by convention (section 2). If a `package.json` contains a `main` field, it is ignored by loopx.

The `type` field (`"module"`) continues to be relevant for Node.js module resolution within the workflow.

**Failure modes:** If a workflow's `package.json` is absent, unreadable, contains invalid JSON, or declares an invalid semver range for `loopx`, see section 5 (`package.json` failure modes) for the defined behavior. In all cases, a broken `package.json` degrades version checking but does not prevent the workflow from being used or installed.

#### Module resolution for `import "loopx"` within workflows

The current behavior (SPEC section 3.3) is preserved: if a workflow has its own `node_modules/loopx`, standard module resolution applies and the workflow-local package takes precedence over the CLI-provided helpers. This is a natural consequence of running scripts with the workflow directory as cwd (section 10).

loopx does **not** override standard module resolution to force the CLI version. This means a workflow with a locally installed `loopx` may get different helper behavior than the running CLI provides. This is the same trade-off documented in the current spec for directory scripts — it is now more relevant because workflows are the primary context where local dependencies and `node_modules/` will exist.

No warning is emitted for this scenario in v1. The workflow's `package.json` version declaration (section 5) serves as the intended mechanism for surfacing version mismatches.

### 10. Script execution changes

#### Working directory

- Scripts within a workflow run with the **workflow directory** as their working directory (e.g., `.loopx/ralph/`). This is analogous to the current directory script behavior and ensures relative imports and `node_modules/` resolve naturally.
- `LOOPX_PROJECT_ROOT` continues to point to the directory where `loopx` was invoked.

#### Programmatic `RunOptions.cwd` behavior change

The current SPEC (section 9.5) defines `RunOptions.cwd` as the working directory for both script resolution (`.loopx/` discovery) **and** script execution. Under the workflow model, script execution cwd is always the workflow directory (e.g., `.loopx/ralph/`), regardless of `RunOptions.cwd`.

`RunOptions.cwd` now means **project root**: the directory from which `.loopx/` is resolved and from which `LOOPX_PROJECT_ROOT` is derived. It no longer controls the child process working directory. Scripts always execute with their workflow directory as cwd.

This is a behavioral change to the programmatic API. Code that passes `cwd` to `run()` or `runPromise()` expecting it to set the script's working directory must be updated — relative path resolution within the script will be relative to the workflow directory, and `LOOPX_PROJECT_ROOT` (sourced from `RunOptions.cwd` or `process.cwd()`) should be used for project-root-relative paths.

#### Environment

A new environment variable is injected:

| Variable | Value |
|----------|-------|
| `LOOPX_WORKFLOW` | The name of the workflow containing the currently executing script |

This allows scripts to be aware of their workflow context, which is useful for scripts that may be duplicated across workflows.

### 11. Output helper changes

The `loopx output` CLI helper gains support for the new `goto` syntax:

```bash
$LOOPX_BIN output --goto "check-ready"              # intra-workflow
$LOOPX_BIN output --goto "review-adr:request-feedback"  # cross-workflow
```

`loopx output --goto` only serializes the value into the structured output JSON; it does not validate the target format. Target validation occurs at loop execution time when the `goto` value is resolved. This keeps the CLI helper aligned with the JS/TS `output()` function, which also performs no validation — the `goto` field is already a plain string.

## Consequences

**No legacy compatibility or migration tooling.** This ADR treats the workflow model as a clean starting point. loopx does not detect, warn about, or provide automated migration for pre-workflow layouts (flat scripts, directory scripts). Legacy layouts are simply not recognized.

- **Breaking change: flat scripts removed.** Scripts placed directly in `.loopx/` as loose files are no longer discovered. Only workflow subdirectories are recognized.
- **Breaking change: directory scripts removed.** The directory script concept (`package.json` + `main` field as entry point) no longer exists. Workflows use `index` as the default entry point by convention.
- **Breaking change: invocation syntax.** `loopx run myscript` now means "run the `index` script in the `myscript` workflow," not "run the flat script named `myscript`."
- **Breaking change: programmatic API.** The `scriptName` parameter is renamed to `target` and uses `workflow:script` syntax.
- **Breaking change: single-file URL install removed.** `loopx install <single-file-url>` is no longer supported.
- **Breaking change: version delegation simplified.** Only the project root `package.json` (cwd where `loopx` is invoked) is checked for a local `loopx` dependency. Ancestor-directory traversal is removed.
- **Breaking change: working directory.** All scripts run with their workflow directory as cwd. `LOOPX_PROJECT_ROOT` provides the invocation directory for project-root-relative paths.
- **Breaking change: `RunOptions.cwd` semantics.** `RunOptions.cwd` no longer controls the script's execution working directory. It now specifies the project root (where `.loopx/` is resolved and where `LOOPX_PROJECT_ROOT` is derived from). Scripts always execute with their workflow directory as cwd regardless of `RunOptions.cwd`.
- Cross-workflow `goto` enables multi-workflow compositions where a loop can span several related workflows while always returning to its starting point.
- The workflow model naturally maps to repositories, making sharing and installation of workflow bundles straightforward.
- Version expectations can be declared per-workflow, providing compatibility signaling without runtime complexity.

## Affected SPEC Sections

When this ADR is accepted, the following SPEC sections require updates:

- **2.1 (Script)** — Rewrite to describe workflows as the organizational unit. Remove file script and directory script concepts. Add workflow detection rules and script-within-workflow rules.
- **2.2 (Loop)** — Update starting target to use `workflow:script` syntax. Document cross-workflow goto and loop reset behavior.
- **2.3 (Structured Output)** — Update `goto` field documentation to describe bare names (intra-workflow) and qualified names (`workflow:script`).
- **3.2 (Local Version Pinning)** — Replace ancestor-directory traversal with project-root-only delegation. Add workflow-level version declaration (runtime validation, non-fatal warning).
- **3.3 (Module Resolution for Scripts)** — Document that workflow-local `node_modules/loopx` takes precedence via standard module resolution, consistent with current behavior but now more central since workflows are the primary organizational unit.
- **4.1 (Running Scripts)** — Update grammar to `loopx run [options] <workflow>[:<script>]`. Document default entry point (`index`).
- **4.2 (Options)** — Add `install`-scoped options (`-w`, `-y`, `-h`). Define parsing rules: duplicate flags, unknown flags, and `-h` short-circuit for `install`, parallel to existing `run` option parsing.
- **4.3 (Subcommands / `loopx output`)** — Update `--goto` parameter documentation: the value is now a target string that accepts both bare script names (intra-workflow) and qualified `workflow:script` names (cross-workflow), not just a flat script name.
- **4.3 (Subcommands / `loopx install`)** — Add `--workflow` / `-w` flag. Document multi-workflow repo handling. Remove single-file URL install. Add `-y` flag for version mismatch and workflow collision override. Add install grammar `loopx install [options] <source>`.
- **5.1 (Discovery)** — Rewrite for two-level discovery: workflow discovery in `.loopx/`, then script discovery within each workflow. Carry forward symlink policy: symlinks are followed during discovery, names derived from the symlink's own name.
- **5.2 (Name Collision)** — Update to describe same-base-name script collisions within a workflow (e.g., `check.sh` and `check.ts` in the same workflow directory). Workflow names themselves cannot collide on a normal filesystem (directory names are unique), so workflow-level collision rules are not needed.
- **5.3 (Name Restrictions)** — Apply to both workflow names and script names. Explicitly note `:` exclusion.
- **5.4 (Validation Scope)** — Update command table for new syntax.
- **6.1 (Working Directory)** — All scripts run with their workflow directory as cwd. Remove file-script vs directory-script distinction.
- **6.4 (Directory Scripts)** — Remove entirely (replaced by workflow model).
- **7.1 (Basic Loop)** — Update to reflect workflow:script resolution, cross-workflow goto validation, and loop reset to starting target.
- **7.2 (Error Handling)** — Add error cases for missing workflow, missing script within workflow, invalid goto target (bad workflow or bad script).
- **8.3 (Injection)** — Add `LOOPX_WORKFLOW` environment variable.
- **9.1 / 9.2 (Programmatic API)** — Rename `scriptName` to `target`. Update examples to use `workflow:script` syntax.
- **9.5 (Types)** — Update `run()` and `runPromise()` signatures. Update `RunOptions.cwd` documentation: `cwd` now specifies the project root for `.loopx/` resolution and `LOOPX_PROJECT_ROOT`, not the script execution working directory.
- **10.1 (Source Detection)** — Remove rule 5 (single-file URL fallback). Existing rules 1–4 (`org/repo`, known git hosts, `.git` URLs, tarball URLs) are preserved unchanged.
- **10.2 (Source Type Details)** — Remove single-file URL details. Update git URL handling to reflect workflow classification instead of directory-script validation. Update tarball handling: preserve wrapper-directory stripping, define source root, apply workflow classification to normalized source root. Update naming derivation for both single-workflow and multi-workflow sources.
- **10 (`loopx install`)** — Rewrite for workflow-based installation. Multi-workflow repos, single-workflow repos, `--workflow` flag, version mismatch handling, single-file removal, simplified collision model.
- **11 (Help)** — Update `loopx run -h` to list workflows and their scripts. Add install help (`loopx install -h`) as a third help form alongside top-level help and run help.
- **12 (Exit Codes)** — Update examples for new syntax.
- **13 (Summary of Reserved and Special Values)** — Add `index` as the default entry point convention. Add `:` as a reserved delimiter. Add `LOOPX_WORKFLOW` environment variable.

## Test Recommendations

- Verify `loopx run ralph` runs `ralph/index.sh` (default entry point).
- Verify `loopx run ralph:check-ready` runs `ralph/check-ready.sh`.
- Verify `loopx run ralph:index` is equivalent to `loopx run ralph`.
- Verify a workflow with no `index` script errors on bare invocation (`loopx run ralph` → exit code 1).
- Verify a workflow with no `index` script works when targeting a specific script (`loopx run ralph:other`).
- Verify flat scripts in `.loopx/` root are not discovered (only workflow subdirectories).
- Verify an empty subdirectory in `.loopx/` is not recognized as a workflow.
- Verify a subdirectory with only non-script files (e.g., only `.json`) is not recognized as a workflow.
- Verify intra-workflow `goto` (bare name) resolves to the same workflow as the currently executing script.
- Verify cross-workflow `goto` (`workflow:script`) transitions to the correct workflow and script.
- Verify bare `goto` from a cross-workflow context resolves to the *executing* script's workflow, not the starting target's workflow.
- Verify cross-workflow `goto` with missing workflow is an error (exit code 1).
- Verify cross-workflow `goto` with missing script in a valid workflow is an error (exit code 1).
- Verify `goto "workflow:"` (colon with no script name) is an error.
- Verify loop resets to the original starting target after a cross-workflow transition chain.
- Verify `:` in a workflow name is rejected during discovery.
- Verify `:` in a script name is rejected during discovery.
- Verify name collisions within a workflow (e.g., `check.sh` and `check.ts`) are fatal in `loopx run`, non-fatal in `loopx run -h`.
- Verify workflow-level `package.json` `main` field is ignored (not used for entry point resolution).
- Verify version delegation checks only the project root (cwd) `package.json`, not ancestor directories.
- Verify version delegation works before `.loopx/` exists (e.g., `loopx version` in a project with local loopx but no `.loopx/` dir).
- Verify workflow-level version mismatch produces a warning (not an error) at runtime.
- Verify unreadable workflow `package.json` produces a warning and skips version check (does not block execution).
- Verify workflow `package.json` with invalid JSON produces a warning and skips version check.
- Verify workflow `package.json` with invalid semver range for `loopx` produces a warning and skips version check.
- Verify `loopx install <multi-workflow-repo>` installs all discovered workflows.
- Verify `loopx install <multi-workflow-repo>` fails atomically if any workflow fails validation.
- Verify `loopx install <multi-workflow-repo>` silently skips directories with no script files.
- Verify `loopx install -w <name> <source>` installs only the named workflow.
- Verify `loopx install -w <nonexistent> <source>` is an error.
- Verify install refuses when a workflow's declared loopx version range is not satisfied by the running version.
- Verify `loopx install -y <source>` overrides version mismatch.
- Verify install refuses on workflow name collision.
- Verify `loopx install -y <source>` overrides workflow name collision (replaces existing discovered workflow).
- Verify `loopx install -y <source>` does NOT override destination-path collision with a non-workflow entry (still an error).
- Verify single-file URL install is rejected.
- Verify `loopx install <source>` with zero installable workflows in source is an error.
- Verify `loopx install -w <name> <source>` validates only the selected workflow (invalid sibling does not block install).
- Verify install refuses a workflow containing scripts with base-name collisions (e.g., `check.sh` + `check.ts`).
- Verify install refuses a workflow containing scripts with invalid names.
- Verify install allows a workflow with no `index` script.
- Verify repo-root support files (README, LICENSE, etc.) are not copied during multi-workflow install.
- Verify single-workflow repo install copies all root-level files (including non-script files like `package.json`, config, docs) into `.loopx/<repo-name>/`.
- Verify `LOOPX_WORKFLOW` is set correctly in the script's environment.
- Verify scripts run with their workflow directory as `cwd`.
- Verify `loopx run -h` lists discovered workflows and their scripts.
- Verify `loopx run -h` does not list or warn about non-workflow files in `.loopx/` root.
- Verify programmatic `run("ralph")` runs `ralph:index`.
- Verify programmatic `run("ralph:check-ready")` runs the correct script.
- Verify `loopx output --goto "other-workflow:script"` produces valid cross-workflow goto JSON.
- Verify nested subdirectories within a workflow are ignored during script discovery.
- Verify `loopx run "a:b:c"` (multiple colons) is an error.
- Verify `loopx run ":script"` (leading colon) is an error.
- Verify `loopx run "workflow:"` (trailing colon) is an error.
- Verify `loopx run ""` (empty target) is an error.
- Verify `goto "a:b:c"` (multiple colons in goto) is an error.
- Verify `goto ":script"` (leading colon in goto) is an error.
- Verify `goto ""` (empty goto) is an error.
- Verify qualified goto `ralph:check-ready` works when issued from within the `ralph` workflow (same-workflow qualified goto).
- Verify cross-workflow version warning is printed on first entry into a mismatched workflow via `goto`.
- Verify cross-workflow version warning is not repeated on re-entry into the same workflow.
- Verify starting workflow version is checked before the first iteration.
- Verify a repo with root-level script files and subdirectories containing supported-extension files (e.g., `lib/helpers.ts`) is classified as single-workflow, not refused.
- Verify a single-workflow repo install copies subdirectories (e.g., `lib/`, `src/`) into `.loopx/<repo-name>/` as workflow content.
- Verify multi-workflow install is preflight-atomic: if one workflow collides (without `-y`), no workflows are written.
- Verify multi-workflow install staging failure leaves `.loopx/` unchanged.
- Verify `-y` replacement preserves existing workflows until the commit phase (staging failure does not remove them).
- Verify commit-phase failure reports which workflows were and were not committed.
- Verify `loopx install -w <name>` errors on a single-workflow repo source.
- Verify install checks the workflow's declared version range against the running loopx version.
- Verify symlinks within `.loopx/` are followed during workflow and script discovery.
- Verify workflow-local `node_modules/loopx` takes precedence over CLI-provided helpers for `import "loopx"`.
- Verify `loopx install` with no source is a usage error (exit code 1).
- Verify `loopx install -h` shows install help and exits 0 (no source required).
- Verify `loopx run -n 0 ralph` performs discovery and target validation but does not print workflow version warnings.
- Verify `loopx run ralph` fails if a sibling workflow has an invalid script name (global validation).
- Verify `loopx run ralph` fails if a sibling workflow has a same-base-name collision (global validation).
- Verify `loopx install -y` does not replace a non-workflow entry (e.g., a directory with no script files, a stray non-directory file) at the destination path.
- Verify installing workflow `foo` succeeds when a non-workflow file `.loopx/foo.sh` exists (different filesystem path, no collision).
- Verify `-y` replaceability is determined by a local structural check of `.loopx/<workflow-name>` only — a broken sibling workflow does not prevent `-y` from replacing an unrelated target.
- Verify `loopx install -w <name>` errors on a single-workflow repo even when subdirectories contain script files.
- Verify `loopx install -w a -w b <source>` (duplicate `-w`) is a usage error.
- Verify `loopx install --unknown <source>` (unrecognized flag) is a usage error.
- Verify `loopx install -h --unknown` (unrecognized flag with `-h`) shows help (no error).
- Verify all top-level files with supported extensions in a workflow are discovered as scripts (no exclusion mechanism).
- Verify files with supported extensions in subdirectories within a workflow (e.g., `lib/helpers.ts`) are not discovered as scripts.
- Verify programmatic `RunOptions.cwd` controls `.loopx/` resolution (project root) but does not affect script execution working directory.
- Verify scripts execute with their workflow directory as cwd even when `RunOptions.cwd` is set to a different path.
- Verify tarball install strips a single top-level wrapper directory before classifying the source as multi-/single-workflow.
- Verify tarball install with multiple top-level entries (no wrapper directory) classifies correctly without stripping.
- Verify single-workflow tarball derives the workflow name from the archive-name (URL last path segment minus extensions).
- Verify delegation skips with a warning when the project-root `package.json` is unreadable.
- Verify delegation skips with a warning when the project-root `package.json` contains invalid JSON.
- Verify delegation skips with a warning when the project-root `package.json` declares `loopx` but `node_modules/.bin/loopx` does not exist.
- Verify delegation does not occur when `node_modules/.bin/loopx` exists but the project-root `package.json` does not declare `loopx` as a dependency.
- Verify that when `loopx` is declared in both `dependencies` and `devDependencies` of a workflow `package.json`, the `dependencies` range is used for version checking.
- Verify `loopx run -h` displays help with a warning when `.loopx/` does not exist.
- Verify `-n 0` loads and validates env files (global and `-e`) before exiting with code 0.
- Verify `-y` on a symlinked workflow path follows the symlink for the structural check (inspects symlink target's contents).
- Verify `-y` on a symlinked workflow path removes the symlink itself, not the symlink's target directory.
- Verify multi-workflow install aggregates all preflight failures (validation errors, collisions, version mismatches) into a single error report.
- Verify install emits `package.json` failure warnings (unreadable, invalid JSON, invalid semver) once per affected workflow without blocking the install.
- Verify install-time `package.json` failure warnings are not suppressed by any "first entry" deduplication logic.
