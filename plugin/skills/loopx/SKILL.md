---
name: loopx
description: "Create looping workflows using the loopx CLI tool (loop-extender). Use this skill whenever the user wants to build a loopx workflow, create .loopx scripts, set up agent loops, chain scripts together with goto/stop logic, or automate repetitive CLI tasks with loopx. Also trigger when the user mentions loopx, loop-extender, .loopx directory, or describes a multi-step agent pipeline that could benefit from loopx's state machine (even if they don't mention loopx by name)."
---

# loopx Workflow Builder

You help users create loopx workflows — multi-step looping pipelines built from simple scripts. Users describe what they want in plain English; you produce a `.loopx/<workflow>/` directory of scripts and explain how to run them.

## What is loopx?

loopx is a CLI tool that runs scripts in a loop with structured control flow. Think of it as a state machine where each state is a script.

The core idea:
1. A **workflow** is a named subdirectory of `.loopx/` containing one or more script files.
2. Each script runs and returns structured JSON: `{ result?, goto?, stop? }`.
3. `goto` names the next script to run (piping `result` to it via stdin).
4. `stop: true` halts the loop.
5. If neither `goto` nor `stop`, the loop resets to the starting target.
6. A workflow's **default entry point** is a script named `index` (e.g., `index.sh`, `index.ts`). `loopx run <workflow>` invokes that script.

**Layout:**
```
.loopx/
  my-workflow/
    index.sh          ← default entry point (loopx run my-workflow)
    check-ready.sh    ← targeted explicitly (loopx run my-workflow:check-ready)
    lib/
      helpers.sh      ← not discovered — subdirectories are workflow internals
    package.json      ← optional (deps, loopx version pinning)
```

Loose files placed directly in `.loopx/` (outside any workflow) are never discovered. Subdirectories inside a workflow are also not scanned — that's where shared helpers, configs, or schema files belong.

Install: `npm install -g loop-extender`
Run:
- `loopx run my-workflow` — runs `my-workflow/index.*`
- `loopx run my-workflow:check-ready` — runs `my-workflow/check-ready.*`
- `loopx run -n 10 my-workflow` — cap at 10 total iterations

## Your job

When a user describes a looping pipeline:

1. **Name the workflow** — pick a short, descriptive directory name (e.g., `review-adr`, `ralph`, `triage`). This becomes `.loopx/<name>/`. Names must match `[a-zA-Z0-9_][a-zA-Z0-9_-]*`.
2. **Break it into scripts** — each distinct step is a file inside the workflow. Always include one named `index.*` so bare `loopx run <workflow>` works.
3. **Wire them together** — use `goto` to chain scripts and `stop` to define exit conditions. Bare `goto` names target scripts in the same workflow.
4. **Choose the right language** for each script (see below).
5. **Scaffold everything** — create `.loopx/<workflow>/` and its files. Make bash scripts executable.
6. **Show how to run it** — give the user the exact `loopx run` command.

## Bash vs TypeScript

**Default to bash** for scripts that primarily shell out to CLI tools, pipe text around, or do simple string checks. Most agent-wrapping workflows are bash.

**Reach for TypeScript** when:
- You need npm libraries (HTTP clients, parsers, SDKs)
- Complex data transformation or JSON manipulation is involved
- The logic is genuinely hard to express in bash (nested conditionals, async operations, structured error handling)
- You subjectively judge that bash would be fragile or hard to read for the task

**Always respect user preference** — if they ask for TypeScript or bash specifically, use that.

## Bash scripts

Bash scripts use `$LOOPX_BIN output` to return structured output. This is a helper that prints the right JSON to stdout.

```bash
#!/bin/bash

# Return a result and jump to another script in the same workflow
$LOOPX_BIN output --result "some value" --goto "next-script"

# Cross-workflow goto (targets a script in a different workflow)
$LOOPX_BIN output --result "handoff" --goto "other-workflow:some-script"

# Stop the loop
$LOOPX_BIN output --result "done" --stop

# Just a result (loop resets to the starting target)
$LOOPX_BIN output --result "hello"
```

Reading input from a previous script (when another script used `goto` to reach this one):

```bash
#!/bin/bash
INPUT=$(cat)
# INPUT now contains the result from the previous script
```

Important: `$LOOPX_BIN` is an environment variable loopx injects — always use it instead of hardcoding a path.

## TypeScript scripts

TypeScript scripts import helpers directly from `"loopx"` (loopx's module loader handles resolution automatically — no install needed just to use these helpers).

```typescript
import { output, input } from "loopx";

// Read piped input from previous script
const data = await input();

// Return structured output
output({ result: "processed", goto: "next-step" });
// output() calls process.exit(0) — nothing runs after it
```

If your workflow needs npm dependencies, drop a `package.json` inside the workflow directory and run `npm install` (or `bun install`) there. Dependencies stay local to the workflow:

```
.loopx/my-workflow/
  index.ts
  package.json         # dependencies go here
  node_modules/        # created by `npm install` inside this directory
```

Notes:
- The `main` field in a workflow's `package.json` is ignored — the entry point is always `index.*` by convention.
- `package.json` may optionally declare a `loopx` version range in `dependencies` or `devDependencies`. If the running loopx doesn't satisfy it, you get a non-fatal warning.
- loopx does not auto-install dependencies — users run `npm install` themselves.

## Environment variables

loopx has a global env store and supports local `.env` overrides:

```bash
# Set global env vars (available to all loopx projects)
loopx env set API_KEY "sk-..."
loopx env set MODEL "claude-sonnet-4-20250514"

# Use a local .env file (overrides globals on conflict)
loopx run -e .env.local my-workflow

# List / remove
loopx env list
loopx env remove API_KEY
```

Scripts receive these as normal environment variables. loopx also injects:
- `LOOPX_BIN` — path to the loopx binary
- `LOOPX_PROJECT_ROOT` — the directory where `loopx` was invoked (the project root)
- `LOOPX_WORKFLOW` — the name of the workflow containing the currently executing script (handy when the same script file is reused across workflows)

Scripts run with the **workflow directory** (e.g., `.loopx/my-workflow/`) as their working directory. Relative imports and local `node_modules/` resolve naturally there. Use `LOOPX_PROJECT_ROOT` whenever you need paths relative to the invocation directory instead.

## Installing workflows

```bash
loopx install org/repo                        # GitHub shorthand
loopx install https://github.com/org/repo.git # Direct .git URL
loopx install https://example.com/pkg.tgz     # Tarball
```

A source can contain one or many workflows:

- **Single-workflow source** — the repo/tarball root has at least one script file at the top level. The whole thing installs as `.loopx/<source-name>/`, including subdirectories (like `lib/`, `src/`) as workflow internals.
- **Multi-workflow source** — no script files at the root, but top-level subdirectories qualify as workflows. Each valid workflow installs as its own entry under `.loopx/`. Non-workflow files at the repo root (README, LICENSE, CI config, etc.) are not copied — each workflow must be self-contained.

Install-scoped flags:

| Flag | What it does |
|------|--------------|
| `-w <name>` / `--workflow <name>` | Install only the named workflow from a multi-workflow source. |
| `-y` | Replace an existing workflow at the same path, and bypass loopx-version-range mismatches. |
| `-h` / `--help` | Print install help and exit. |

Single-file URL install is **not supported** — scripts must live inside a workflow.

## Common patterns

### Pattern 1: Agent loop with halt check

Run an agent, then use a second agent (or the same one) to decide if the loop should stop.

```
.loopx/
  run-agent/
    index.sh        # Step 1: run the agent
    check-halt.sh   # Step 2: decide whether to stop
```

**index.sh**
```bash
#!/bin/bash
RESULT=$(cat PROMPT.md | claude -p --model sonnet 2>/dev/null)
$LOOPX_BIN output --result "$RESULT" --goto "check-halt"
```

**check-halt.sh**
```bash
#!/bin/bash
AGENT_OUTPUT=$(cat)
RECENT_COMMIT=$(git log -1 --pretty=format:"%s%n%b" 2>/dev/null)

VERDICT=$(printf "Agent output:\n%s\n\nMost recent commit:\n%s\n\nShould this loop continue or halt? Reply with exactly HALT or CONTINUE. HALT if the task appears complete or no meaningful progress is being made." "$AGENT_OUTPUT" "$RECENT_COMMIT" | claude -p --model sonnet 2>/dev/null)

if echo "$VERDICT" | grep -qi "HALT"; then
  $LOOPX_BIN output --result "Loop halted. Last output: $AGENT_OUTPUT" --stop
else
  $LOOPX_BIN output --result "Continuing..."
fi
```

Run: `loopx run run-agent` (executes `index.sh`, loops back to `index.sh` after `check-halt.sh` finishes with no `goto`).

### Pattern 2: Multi-step review pipeline

Get feedback from one agent, have another decide if it matters, then apply or halt.

```
.loopx/
  review/
    index.sh       # Step 1: ask for feedback
    triage.sh      # Step 2: is the feedback critical?
    apply.sh       # Step 3: apply the feedback
```

**index.sh**
```bash
#!/bin/bash
FEEDBACK=$(cat SPEC.md | codex -p "Review this spec. List specific, actionable improvements." 2>/dev/null)
$LOOPX_BIN output --result "$FEEDBACK" --goto "triage"
```

**triage.sh**
```bash
#!/bin/bash
FEEDBACK=$(cat)

VERDICT=$(printf "Feedback on our spec:\n%s\n\nIs any of this feedback critical enough to apply right now? Reply CRITICAL if yes, SKIP if it's minor or cosmetic." "$FEEDBACK" | claude -p --model sonnet 2>/dev/null)

if echo "$VERDICT" | grep -qi "CRITICAL"; then
  $LOOPX_BIN output --result "$FEEDBACK" --goto "apply"
else
  $LOOPX_BIN output --result "Feedback was non-critical. Halting." --stop
fi
```

**apply.sh**
```bash
#!/bin/bash
FEEDBACK=$(cat)

printf "Apply this feedback to SPEC.md:\n%s\n\nRead SPEC.md, make the changes, and write the updated file." "$FEEDBACK" | claude -p --model sonnet --allowedTools "Edit,Read" 2>/dev/null

$LOOPX_BIN output --result "Applied feedback. Looping for another round."
```

Run: `loopx run review`.

### Pattern 3: Simple infinite agent loop

The simplest case — just loop an agent command. No structured output needed (raw stdout becomes the `result` automatically).

```
.loopx/
  agent/
    index.sh
```

```bash
#!/bin/bash
# .loopx/agent/index.sh
cat PROMPT.md | claude --dangerously-skip-permissions -p
```

Run: `loopx run agent` or `loopx run -n 20 agent` to cap at 20 iterations.

### Pattern 4: Conditional branching

A script can `goto` different targets based on runtime conditions.

```bash
#!/bin/bash
# .loopx/my-workflow/router.sh
INPUT=$(cat)

if echo "$INPUT" | grep -qi "error"; then
  $LOOPX_BIN output --result "$INPUT" --goto "handle-error"
elif echo "$INPUT" | grep -qi "needs-review"; then
  $LOOPX_BIN output --result "$INPUT" --goto "review"
else
  $LOOPX_BIN output --result "$INPUT" --goto "finalize"
fi
```

All three targets resolve within `my-workflow/` (`handle-error.sh`, `review.sh`, `finalize.sh`) — bare names always stay inside the executing script's workflow.

### Pattern 5: TypeScript with data processing

When you need to parse structured data, call APIs, or use npm packages.

```typescript
// .loopx/fetch-and-process/index.ts
import { output } from "loopx";

const res = await fetch("https://api.example.com/data");
const data = await res.json();

const summary = data.items
  .filter((item: any) => item.status === "open")
  .map((item: any) => `- ${item.title}`)
  .join("\n");

output({ result: summary, goto: "analyze" });
```

### Pattern 6: Cross-workflow composition

Use qualified `goto` (`workflow:script`) to hand off to a different workflow. The loop still resets to the **original starting target** when a chain ends, regardless of which workflow it ended in.

```bash
#!/bin/bash
# .loopx/ralph/index.sh — starting target is ralph:index
RESULT=$(do-some-work)
$LOOPX_BIN output --result "$RESULT" --goto "review-adr:request-feedback"
```

After the `review-adr` chain finishes, control returns to `ralph:index`. If a script inside `review-adr` issues a **bare** `goto "apply-feedback"`, it targets `review-adr:apply-feedback` — bare names always bind to the executing script's workflow, not the starting target's workflow.

## Key details to remember

- **Iteration counting**: `-n` counts every script execution, including `goto` hops. A chain of A → B → C is 3 iterations.
- **stdin piping**: `result` is piped to the next script only when `goto` is present. When the loop resets (no `goto`), the starting script gets empty stdin.
- **`stop` beats `goto`**: if both are present, the loop halts.
- **Default entry point is `index`**: every workflow should have an `index.*` unless users will always target scripts explicitly (`loopx run foo:bar`). Bare invocation of a workflow without `index` errors out.
- **Naming**: workflow and script names must match `[a-zA-Z0-9_][a-zA-Z0-9_-]*`. The colon `:` is reserved as the `workflow:script` delimiter.
- **Goto scope**: bare names resolve in the **executing script's workflow** (not the starting workflow). Use the qualified form `other-workflow:script` to cross workflows.
- **Self-goto is valid**: a script can `goto` itself.
- **Exit codes**: a non-zero exit code from a script causes loopx to exit with that code.
- **No config files**: loopx has no YAML/JSON config. The scripts themselves are the configuration.
- **ESM only**: all JS/TS scripts must use ES module syntax (`import`/`export`), not CommonJS.
- **Subdirectories inside a workflow are invisible to discovery**. That makes them perfect for shared helpers (`lib/`, `helpers/`), but anything inside them can't be used as a `goto` target.

## Programmatic API

For users embedding loopx in application code:

```typescript
import { run, runPromise } from "loopx";

// Async generator — yields each iteration's output.
// A bare target ("my-workflow") runs the workflow's `index` script.
for await (const result of run("my-workflow", { maxIterations: 10 })) {
  console.log(result.result);
}

// Qualified target runs a specific script
const outputs = await runPromise("my-workflow:check-ready", { maxIterations: 5 });

// With abort signal
const ac = new AbortController();
setTimeout(() => ac.abort(), 30000);
for await (const result of run("my-workflow", { signal: ac.signal })) {
  console.log(result.result);
}
```

`RunOptions.cwd` specifies the **project root** — where `.loopx/` is resolved and where `LOOPX_PROJECT_ROOT` comes from. It does *not* set the script's own working directory: scripts always execute with their workflow directory as cwd.

Only mention the programmatic API when the user is building a JS/TS application that needs to invoke loopx from code, not for typical CLI workflow creation.
