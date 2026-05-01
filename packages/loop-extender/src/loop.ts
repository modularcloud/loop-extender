import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { tmpdir as osTmpdir } from "node:os";
import type { Output } from "./types.js";
import type { Workflow, ScriptFile } from "./discovery.js";
import { executeScript, type ExecResult } from "./execution.js";
import { parseOutput } from "./parsers/parse-output.js";
import { parseGoto } from "./target-validation.js";
import { checkWorkflowVersion, formatWarning } from "./version-check.js";
import { makeAbortError } from "./abort.js";
import {
  createTmpdir,
  cleanupTmpdir,
  newCleanupState,
} from "./tmpdir.js";

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
  /**
   * Optional pre-captured tmpdir parent (SPEC §7.4 / §9.2). When provided,
   * loopx uses this value for `mkdtemp(<parent>/loopx-)` instead of reading
   * `os.tmpdir()` at loop entry. `runPromise()` captures it eagerly at the
   * call site; `run()` and the CLI leave it undefined so we read
   * `os.tmpdir()` lazily here.
   */
  tmpdirParent?: string;
}

export async function* runLoop(
  starting: LoopStartingTarget,
  workflows: Map<string, Workflow>,
  options: LoopOptions
): AsyncGenerator<Output> {
  const {
    maxIterations,
    env,
    projectRoot,
    loopxBin,
    runningVersion,
    signal,
    tmpdirParent,
  } = options;

  // SPEC §7.1 step 4: -n 0 / maxIterations: 0 — exit before version check
  // and tmpdir creation.
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

  // SPEC §7.1 step 5: workflow-level version check on the starting workflow.
  // Runs before tmpdir creation so the warning surfaces even if step 6 fails
  // (T-TMP-12f..12h).
  checkVersionOnEntry(starting.workflow);

  // SPEC §7.1 step 6 / §7.4: create LOOPX_TMPDIR after the version check and
  // immediately before the first child spawn. Errors here propagate; cleanup
  // of any partial directory is handled inside createTmpdir without masking
  // the original creation error.
  const parent = tmpdirParent ?? osTmpdir();
  const tmpdirResource = createTmpdir(parent);
  const cleanupState = newCleanupState();

  try {
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
        tmpdir: tmpdirResource.path,
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
        currentWorkflow = starting.workflow;
        currentScript = starting.script;
        currentInput = undefined;
      }
    }
  } finally {
    // SPEC §7.4 cleanup triggers: every terminal outcome (normal completion,
    // script-error, invalid goto, abort, consumer .return()/.throw()) reaches
    // this finally because the generator's machinery runs finally before the
    // throw / return propagates. Idempotent — newCleanupState() guarantees a
    // single attempt and at most one warning.
    cleanupTmpdir(tmpdirResource, cleanupState);
  }
}
