---
name: loopx
description: "Create looping workflows using the loopx CLI tool (loop-extender). Use this skill whenever the user wants to build a loopx workflow, create .loopx scripts, set up agent loops, chain scripts together with goto/stop logic, or automate repetitive CLI tasks with loopx. Also trigger when the user mentions loopx, loop-extender, .loopx directory, or describes a multi-step agent pipeline that could benefit from loopx's state machine (even if they don't mention loopx by name)."
---

# loopx Workflow Builder

You help users create loopx workflows — multi-step looping pipelines built from simple scripts. Users describe what they want in plain English; you produce the `.loopx/` scripts and explain how to run them.

## What is loopx?

loopx is a CLI tool that runs scripts in a loop with structured control flow. Think of it as a state machine where each state is a script.

The core idea:
1. Scripts live in a `.loopx/` directory
2. Each script runs and returns structured JSON: `{ result?, goto?, stop? }`
3. `goto` names the next script to run (piping `result` to it via stdin)
4. `stop: true` halts the loop
5. If neither `goto` nor `stop`, the loop resets to the starting script

Install: `npm install -g loop-extender`
Run: `loopx` (runs `.loopx/default`), `loopx myscript`, or `loopx -n 10 myscript` (max 10 iterations)

## Your job

When a user describes a workflow:

1. **Break it into scripts** — each distinct step becomes a script in `.loopx/`. Name them descriptively (e.g., `generate`, `review`, `apply`).
2. **Wire them together** — use `goto` to chain scripts and `stop` to define exit conditions.
3. **Choose the right language** for each script (see below).
4. **Scaffold everything** — create the `.loopx/` directory and all scripts. Make bash scripts executable.
5. **Show how to run it** — give the user the exact `loopx` command.

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

# Return a result and move to the next script
$LOOPX_BIN output --result "some value" --goto "next-script"

# Stop the loop
$LOOPX_BIN output --result "done" --stop

# Just a result (loop resets to starting script)
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

TypeScript scripts import helpers directly from `"loopx"` (loopx's module loader handles resolution automatically — no need to install loopx as a dependency in `.loopx/`).

```typescript
import { output, input } from "loopx";

// Read piped input from previous script
const data = await input();

// Return structured output
output({ result: "processed", goto: "next-step" });
// output() calls process.exit(0) — nothing runs after it
```

For scripts that need their own npm dependencies, use a directory script:

```
.loopx/my-step/
  package.json    # { "main": "index.ts" }
  index.ts
  node_modules/   # npm install inside this directory
```

## Environment variables

loopx has a global env store and supports local `.env` overrides:

```bash
# Set global env vars (available to all loopx projects)
loopx env set API_KEY "sk-..."
loopx env set MODEL "claude-sonnet-4-20250514"

# Use a local .env file (overrides globals on conflict)
loopx -e .env.local myscript

# List / remove
loopx env list
loopx env remove API_KEY
```

Scripts receive these as normal environment variables. loopx also injects:
- `LOOPX_BIN` — path to the loopx binary
- `LOOPX_PROJECT_ROOT` — the directory where `loopx` was invoked

## Installing remote scripts

```bash
loopx install org/repo              # GitHub shorthand
loopx install https://example.com/script.ts  # Single file
loopx install https://example.com/pkg.tgz    # Tarball
```

## Workflow patterns

### Pattern 1: Agent loop with halt check

A common pattern: run an agent, then use a second agent (or the same one) to decide if the loop should stop.

```
.loopx/
  run-agent.sh      # Step 1: run the agent
  check-halt.sh     # Step 2: decide whether to stop
```

**run-agent.sh**
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

Run: `loopx run-agent`

### Pattern 2: Multi-agent review pipeline

Get feedback from one agent, have another decide if it matters, then apply or halt.

```
.loopx/
  get-feedback.sh   # Step 1: ask for feedback
  triage.sh         # Step 2: is the feedback critical?
  apply.sh          # Step 3: apply the feedback
```

**get-feedback.sh**
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

Run: `loopx get-feedback`

### Pattern 3: Simple infinite agent loop

The simplest case — just loop an agent command. No structured output needed (raw stdout becomes the `result` automatically).

```bash
#!/bin/bash
# .loopx/default.sh
cat PROMPT.md | claude --dangerously-skip-permissions -p
```

Run: `loopx` or `loopx -n 20` to cap at 20 iterations.

### Pattern 4: Conditional branching

Scripts can `goto` different targets based on conditions, enabling branching workflows.

```bash
#!/bin/bash
# .loopx/router.sh
INPUT=$(cat)

if echo "$INPUT" | grep -qi "error"; then
  $LOOPX_BIN output --result "$INPUT" --goto "handle-error"
elif echo "$INPUT" | grep -qi "needs-review"; then
  $LOOPX_BIN output --result "$INPUT" --goto "review"
else
  $LOOPX_BIN output --result "$INPUT" --goto "finalize"
fi
```

### Pattern 5: TypeScript with data processing

When you need to parse structured data, call APIs, or use npm packages.

```typescript
// .loopx/fetch-and-process.ts
import { output } from "loopx";

const res = await fetch("https://api.example.com/data");
const data = await res.json();

const summary = data.items
  .filter((item: any) => item.status === "open")
  .map((item: any) => `- ${item.title}`)
  .join("\n");

output({ result: summary, goto: "analyze" });
```

## Key details to remember

- **Iteration counting**: `-n` counts every script execution, including `goto` hops. A chain of A -> B -> C is 3 iterations.
- **stdin piping**: `result` is only piped to the next script when `goto` is present. When the loop resets (no `goto`), the starting script gets empty stdin.
- **`stop` beats `goto`**: if both are present, the loop halts.
- **Script names**: cannot be `output`, `env`, `install`, or `version` (reserved), and cannot start with `-`.
- **Self-goto is valid**: a script can `goto` itself.
- **Exit codes**: a non-zero exit code from a script causes loopx to exit with that code.
- **No config files**: loopx has no YAML/JSON config. The scripts themselves are the configuration.
- **ESM only**: all JS/TS scripts must use ES module syntax (`import`/`export`), not CommonJS.

## Programmatic API

For users embedding loopx in application code:

```typescript
import { run, runPromise } from "loopx";

// Async generator — yields each iteration's output
for await (const result of run("myscript", { maxIterations: 10 })) {
  console.log(result.result);
}

// Promise — collects all outputs
const outputs = await runPromise("myscript", { maxIterations: 5 });

// With abort signal
const ac = new AbortController();
setTimeout(() => ac.abort(), 30000);
for await (const result of run("myscript", { signal: ac.signal })) {
  console.log(result.result);
}
```

Only mention the programmatic API when the user is building a JS/TS application that needs to invoke loopx from code, not for typical CLI workflow creation.
