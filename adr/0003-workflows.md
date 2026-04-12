# ADR-0003: Workflow-Based Script Organization

**Status:** Proposed

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
    helpers.ts            ← non-entry script
    package.json          ← optional (for dependencies, version pinning)
```

#### Workflow detection

A subdirectory of `.loopx/` is recognized as a workflow if it contains at least one file with a supported script extension (`.sh`, `.js`, `.jsx`, `.ts`, `.tsx`). Subdirectories that contain no script files are ignored during discovery.

#### Workflow naming

Workflow names follow the same restrictions as current script names: must match `[a-zA-Z0-9_][a-zA-Z0-9_-]*`. Additionally, workflow names must not contain `:` (already excluded by the existing pattern, but called out explicitly since `:` is now a syntactic delimiter).

#### Script naming within workflows

Script names (the base name of a file without its extension) follow the same naming rules as workflow names: `[a-zA-Z0-9_][a-zA-Z0-9_-]*`, no `:`.

#### Non-script files

Files without supported extensions (e.g., `.json`, `.schema.json`, `.md`, `.txt`) inside a workflow directory are allowed and ignored by discovery. This supports patterns like schema files, documentation, or configuration that live alongside scripts.

#### Directory scripts are removed

The "directory script" concept (a directory with `package.json` + `main` field acting as a single script) is removed. All subdirectories of `.loopx/` are now workflows. If a workflow needs dependencies, it may include a `package.json` and `node_modules/` — but the `main` field no longer determines the entry point. The entry point is determined by convention (see section 2).

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

### 4. Goto semantics

#### Intra-workflow goto (bare name)

A `goto` value without a colon targets a script in the **same workflow as the currently executing script**:

```json
{ "goto": "check-ready" }
```

If the current script is in the `ralph` workflow, this transitions to `ralph:check-ready`.

#### Cross-workflow goto (qualified name)

A `goto` value with a colon targets a specific script in a different workflow:

```json
{ "goto": "review-adr:request-feedback" }
```

This transitions to the `request-feedback` script in the `review-adr` workflow. The target workflow must exist in the cached discovery results; otherwise it is an invalid `goto` target (error, exit code 1).

A cross-workflow `goto` with no script name after the colon (e.g., `{ "goto": "review-adr:" }`) is an error. To target the default entry point of another workflow, use `{ "goto": "review-adr:index" }`.

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

#### Resolution order (highest precedence first)

1. **Project root `package.json`:** If the directory containing `.loopx/` has a `package.json` that lists `loopx` as a dependency (in `dependencies`, `devDependencies`, or `optionalDependencies`) and a corresponding `node_modules/.bin/loopx` exists, the global binary delegates to it.
2. **Global install:** If no local version is found, the global install runs.

Delegation happens **before command parsing**, so it is based on the project root only — not on the target workflow.

#### Workflow-level version declaration (runtime validation)

A workflow's `package.json` may declare a `loopx` version requirement (in `dependencies` or `devDependencies`). This is **not used for delegation** — delegation always happens at project root level. Instead, after delegation and command parsing, the running loopx version is checked against the workflow's declared version range:

- If the running version satisfies the declared range: execution proceeds normally.
- If the running version does **not** satisfy the declared range: loopx prints a warning to stderr and continues execution. This is a non-fatal warning, not an error — it alerts the user to a potential incompatibility without blocking work.

This avoids the chicken-and-egg problem of needing to parse the target workflow before delegating, while still giving workflow authors a way to declare version expectations.

#### Removed: ancestor-directory traversal

The current behavior of searching from `cwd` upward for `node_modules/.bin/loopx` is removed. Only the project root (the directory containing `.loopx/`) is checked for a local install. This makes the delegation behavior fully deterministic from the project structure.

#### Recursion guard

The `LOOPX_DELEGATED=1` recursion guard is preserved. The `LOOPX_BIN` variable continues to point to the resolved realpath of the effective binary post-delegation.

### 6. Discovery changes

Discovery scans `.loopx/` for workflow subdirectories, then scans each workflow for script files.

#### Workflow discovery

- Scan `.loopx/` for top-level subdirectories.
- A subdirectory is a workflow if it contains at least one file with a supported extension.
- Subdirectories with no script files are ignored (no warning).
- Workflow names are validated against the name restriction rules.

#### Script discovery within workflows

- Scan each workflow directory for top-level files with supported extensions.
- The script name is the file's base name (filename without extension).
- Subdirectories within a workflow are ignored.
- Name collisions (e.g., `check.sh` and `check.ts` in the same workflow) follow the same rules as the current spec: fatal in `loopx run`, non-fatal warning in `loopx run -h`.

#### Discovery caching

Discovery metadata is still cached at loop start for the duration of the loop, following the same rules as the current spec (section 5.1).

### 7. Help changes

- **`loopx -h`:** Top-level help. Lists subcommands and general syntax. No discovery.
- **`loopx run -h`:** Discovers workflows and lists them with their scripts. Non-fatal validation warnings are shown (name collisions, name restriction violations, etc.). If a workflow has an `index` script, it is indicated as the default entry point.
- **`loopx run ralph -h`:** Equivalent to `loopx run -h` (the `-h` short-circuit still applies — the workflow argument is ignored). This is consistent with the existing `loopx run <script> -h` behavior.

### 8. Install changes

#### Installing workflows from a repository

`loopx install <source>` continues to clone/download into `.loopx/`. The key change is that a repository may contain **multiple workflows** (top-level directories with script files), and install handles them as follows:

- **Multi-workflow repo:** Each valid workflow directory in the repository root is installed as a separate workflow in `.loopx/`. Invalid directories (no script files, name restriction violations) are skipped with a warning. Valid workflows are installed.
- **Single-workflow repo:** If the repository root itself contains script files (not in subdirectories), the repository is installed as a single workflow named after the repo.

#### Selective workflow installation

```
loopx install --workflow <name> <source>
loopx install -w <name> <source>
```

`--workflow` / `-w` installs only the named workflow from a multi-workflow repository. If the named workflow does not exist in the source, it is an error.

#### Single-file URL

Single-file URL install is removed. Scripts must be part of a workflow. To install a single script, it should be in a repository as a workflow directory.

#### Version mismatch on install

If `.loopx/package.json` exists and declares a `loopx` version, and the source being installed also declares a `loopx` version that conflicts, installation is refused with an error explaining the mismatch. This can be overridden with `-y`:

```
loopx install -y <source>
```

With `-y`, the installation proceeds and the source's version declaration is preserved in its own workflow `package.json`, but the `.loopx/package.json` is not modified.

#### Name collision on install

If a workflow with the same name already exists in `.loopx/`, installation is refused with an error. This can be overridden with `-y`, which replaces the existing workflow.

### 9. Workflow-level `package.json`

A workflow's `package.json` serves two optional purposes:

1. **Dependency management:** The workflow can declare its own dependencies. Users manage installation themselves (`npm install` / `bun install` within the workflow directory). loopx does not auto-install dependencies.
2. **Version declaration:** The workflow can declare a `loopx` version requirement (see section 5).

The `main` field is no longer used to determine the entry point. The entry point is always the `index` script by convention (section 2). If a `package.json` contains a `main` field, it is ignored by loopx.

The `type` field (`"module"`) continues to be relevant for Node.js module resolution within the workflow.

### 10. Script execution changes

#### Working directory

- Scripts within a workflow run with the **workflow directory** as their working directory (e.g., `.loopx/ralph/`). This is analogous to the current directory script behavior and ensures relative imports and `node_modules/` resolve naturally.
- `LOOPX_PROJECT_ROOT` continues to point to the directory where `loopx` was invoked.

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

The `output()` JS/TS function requires no changes — the `goto` field is already a plain string.

## Consequences

- **Breaking change: flat scripts removed.** All existing `.loopx/` setups with flat file scripts must migrate to a workflow structure. A script like `.loopx/myscript.sh` must move into a workflow directory (e.g., `.loopx/myworkflow/myscript.sh`).
- **Breaking change: directory scripts removed.** Directory scripts with `package.json` + `main` must be restructured as workflows with an `index` entry point.
- **Breaking change: invocation syntax.** `loopx run myscript` now means "run the `index` script in the `myscript` workflow," not "run the flat script named `myscript`."
- **Breaking change: programmatic API.** The `scriptName` parameter is renamed to `target` and uses `workflow:script` syntax.
- **Breaking change: single-file URL install removed.** `loopx install <single-file-url>` is no longer supported.
- **Breaking change: version delegation simplified.** Projects relying on ancestor-directory traversal for version delegation must ensure the `loopx` dependency is in the project root `package.json` (the directory containing `.loopx/`).
- Cross-workflow `goto` enables multi-workflow compositions where a loop can span several related workflows while always returning to its starting point.
- The workflow model naturally maps to repositories, making sharing and installation of workflow bundles straightforward.
- Version expectations can be declared per-workflow, providing compatibility signaling without runtime complexity.

## Affected SPEC Sections

When this ADR is accepted, the following SPEC sections require updates:

- **2.1 (Script)** — Rewrite to describe workflows as the organizational unit. Remove file script and directory script concepts. Add workflow detection rules and script-within-workflow rules.
- **2.2 (Loop)** — Update starting target to use `workflow:script` syntax. Document cross-workflow goto and loop reset behavior.
- **2.3 (Structured Output)** — Update `goto` field documentation to describe bare names (intra-workflow) and qualified names (`workflow:script`).
- **3.2 (Local Version Pinning)** — Replace ancestor-directory traversal with project-root-only delegation. Add workflow-level version declaration (runtime validation, non-fatal warning).
- **4.1 (Running Scripts)** — Update grammar to `loopx run [options] <workflow>[:<script>]`. Document default entry point (`index`).
- **4.3 (Subcommands / `loopx install`)** — Add `--workflow` / `-w` flag. Document multi-workflow repo handling. Remove single-file URL install. Add `-y` flag for version mismatch and name collision override.
- **5.1 (Discovery)** — Rewrite for two-level discovery: workflow discovery in `.loopx/`, then script discovery within each workflow.
- **5.2 (Name Collision)** — Update to describe collisions within a workflow (same base name, different extensions) and workflow-level name collisions in `.loopx/`.
- **5.3 (Name Restrictions)** — Apply to both workflow names and script names. Explicitly note `:` exclusion.
- **5.4 (Validation Scope)** — Update command table for new syntax.
- **6.1 (Working Directory)** — All scripts run with their workflow directory as cwd. Remove file-script vs directory-script distinction.
- **6.4 (Directory Scripts)** — Remove entirely (replaced by workflow model).
- **7.1 (Basic Loop)** — Update to reflect workflow:script resolution, cross-workflow goto validation, and loop reset to starting target.
- **7.2 (Error Handling)** — Add error cases for missing workflow, missing script within workflow, invalid goto target (bad workflow or bad script).
- **8.3 (Injection)** — Add `LOOPX_WORKFLOW` environment variable.
- **9.1 / 9.2 (Programmatic API)** — Rename `scriptName` to `target`. Update examples to use `workflow:script` syntax.
- **9.5 (Types)** — Update `run()` and `runPromise()` signatures.
- **10 (`loopx install`)** — Rewrite for workflow-based installation. Multi-workflow repos, `--workflow` flag, version mismatch handling, single-file removal.
- **11 (Help)** — Update `loopx run -h` to list workflows and their scripts.
- **12 (Exit Codes)** — Update examples for new syntax.
- **13 (Summary of Reserved and Special Values)** — Add `index` as the default entry point convention. Add `:` as a reserved delimiter.

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
- Verify version delegation checks only the project root `package.json`, not ancestor directories.
- Verify workflow-level version mismatch produces a warning (not an error) at runtime.
- Verify `loopx install <multi-workflow-repo>` installs all valid workflows.
- Verify `loopx install <multi-workflow-repo>` skips invalid directories with warnings.
- Verify `loopx install -w <name> <source>` installs only the named workflow.
- Verify `loopx install -w <nonexistent> <source>` is an error.
- Verify install refuses on version mismatch with `.loopx/package.json`.
- Verify `loopx install -y <source>` overrides version mismatch.
- Verify install refuses on workflow name collision.
- Verify `loopx install -y <source>` overrides workflow name collision (replaces existing).
- Verify single-file URL install is rejected.
- Verify `LOOPX_WORKFLOW` is set correctly in the script's environment.
- Verify scripts run with their workflow directory as `cwd`.
- Verify `loopx run -h` lists discovered workflows and their scripts.
- Verify programmatic `run("ralph")` runs `ralph:index`.
- Verify programmatic `run("ralph:check-ready")` runs the correct script.
- Verify `loopx output --goto "other-workflow:script"` produces valid cross-workflow goto JSON.
- Verify nested subdirectories within a workflow are ignored during script discovery.
