import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import type { Output } from "./types.js";
import type { Workflow, ScriptFile } from "./discovery.js";
import { executeScript, type ExecResult } from "./execution.js";
import { parseOutput } from "./parsers/parse-output.js";
import { parseGoto } from "./target-validation.js";
import { checkWorkflowVersion, formatWarning } from "./version-check.js";
import { makeAbortError } from "./abort.js";

export interface LoopStartingTarget {
  workflow: Workflow;
  script: ScriptFile; // resolved starting script (e.g., index or explicit)
}

export interface LoopOptions {
  maxIterations?: number;
  env: Record<string, string>;
  projectRoot: string;
  loopxBin: string;
  runningVersion: string;
  signal?: AbortSignal;
}

export async function* runLoop(
  starting: LoopStartingTarget,
  workflows: Map<string, Workflow>,
  options: LoopOptions
): AsyncGenerator<Output> {
  const { maxIterations, env, projectRoot, loopxBin, runningVersion, signal } =
    options;

  if (maxIterations === 0) {
    return;
  }

  // Per SPEC §3.2: "first entry only" dedupe for workflow-level version checks.
  const visitedWorkflows = new Set<string>();
  const checkVersionOnEntry = (wf: Workflow) => {
    if (visitedWorkflows.has(wf.name)) return;
    visitedWorkflows.add(wf.name);
    const result = checkWorkflowVersion(wf.dir, runningVersion);
    const warning = formatWarning(result, wf.name);
    if (warning) process.stderr.write(warning + "\n");
  };

  let abortPromise: Promise<never> | undefined;
  if (signal) {
    abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(makeAbortError(signal));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(makeAbortError(signal)),
        { once: true }
      );
    });
    abortPromise.catch(() => {});
  }

  // Fire the version-check on entry into the starting workflow before the
  // first iteration (SPEC §3.2: "the starting workflow is checked once before
  // the first iteration").
  checkVersionOnEntry(starting.workflow);

  let iteration = 0;
  let currentWorkflow = starting.workflow;
  let currentScript = starting.script;
  let currentInput: string | undefined = undefined;

  while (true) {
    if (signal?.aborted) {
      throw makeAbortError(signal);
    }

    let result: ExecResult;
    const execPromise = executeScript(currentScript, {
      workflowName: currentWorkflow.name,
      workflowDir: currentWorkflow.dir,
      projectRoot,
      loopxBin,
      env,
      input: currentInput,
      signal,
    });

    if (abortPromise) {
      try {
        result = await Promise.race([execPromise, abortPromise]);
      } catch (err) {
        await execPromise.catch(() => {});
        throw err;
      }
    } else {
      result = await execPromise;
    }

    if (result.exitCode !== 0) {
      throw new Error(
        `Script '${currentWorkflow.name}:${currentScript.name}' exited with code ${result.exitCode}`
      );
    }

    const output = parseOutput(result.stdout);
    iteration++;

    if (output.stop === true) {
      yield output;
      return;
    }

    if (maxIterations !== undefined && iteration >= maxIterations) {
      yield output;
      return;
    }

    yield output;

    if (signal && !signal.aborted) {
      await setTimeoutPromise(0);
    }

    if (signal?.aborted) {
      throw makeAbortError(signal);
    }

    // Determine next target
    if (output.goto !== undefined) {
      const goto = parseGoto(output.goto);
      if (!goto.ok) {
        throw new Error(goto.error);
      }

      let nextWorkflow: Workflow;
      let nextScript: ScriptFile | undefined;

      if (goto.kind === "bare") {
        // Bare goto → script in the current workflow (SPEC §2.2).
        nextWorkflow = currentWorkflow;
        nextScript = currentWorkflow.scripts.get(goto.script);
        if (!nextScript) {
          throw new Error(
            `Invalid goto target: script '${goto.script}' not found in workflow '${currentWorkflow.name}'`
          );
        }
      } else {
        const targetWf = workflows.get(goto.workflow);
        if (!targetWf) {
          throw new Error(
            `Invalid goto target: workflow '${goto.workflow}' not found in .loopx/`
          );
        }
        nextWorkflow = targetWf;
        nextScript = targetWf.scripts.get(goto.script);
        if (!nextScript) {
          throw new Error(
            `Invalid goto target: script '${goto.script}' not found in workflow '${targetWf.name}'`
          );
        }
      }

      if (nextWorkflow !== currentWorkflow) {
        checkVersionOnEntry(nextWorkflow);
      }

      currentWorkflow = nextWorkflow;
      currentScript = nextScript;
      currentInput = output.result ?? "";
    } else {
      // Loop reset: return to starting target (SPEC §2.2).
      if (starting.workflow !== currentWorkflow) {
        // We're entering the starting workflow again — re-entry, no version
        // check (already on the visited set).
      }
      currentWorkflow = starting.workflow;
      currentScript = starting.script;
      currentInput = undefined;
    }
  }
}
