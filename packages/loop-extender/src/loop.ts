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

/**
 * SPEC §7.2 first-observed-trigger tracking. When loopx observes a terminal
 * trigger (abort propagated from user signal, an iteration-level error such
 * as non-zero script exit / invalid goto, or a consumer cancellation via
 * `.return()` / `.throw()`), the FIRST observation pins this slot. Later
 * observations do not displace the first. The `run()` wrapper at run.ts
 * uses this to surface the right terminal outcome under racing triggers
 * (e.g., abort-listener seam where the script's exit is observed AFTER
 * loopx has already recorded abort as first-observed).
 */
export type FirstObservedTrigger =
  | "abort"
  | "iteration"
  | "consumer"
  | null;
export interface FirstObservedRef {
  trigger: FirstObservedTrigger;
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
  /**
   * SPEC §7.2 first-observed-wins. Optional shared slot the wrapper reads
   * to determine the surfaced terminal outcome under racing triggers. When
   * provided, runLoop pins `trigger = "iteration"` (only if currently null)
   * before throwing an iteration-level error so a racing abort observed
   * later cannot reclassify the outcome as abort.
   */
  firstObservedRef?: FirstObservedRef;
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
    firstObservedRef,
  } = options;

  const pinIterationFirstObserved = (): void => {
    if (firstObservedRef && firstObservedRef.trigger === null) {
      firstObservedRef.trigger = "iteration";
    }
  };

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

  // SPEC §7.2 first-observed-wins. The abortPromise causes runLoop's
  // Promise.race to surface the abort error fast (without waiting for the
  // active child to die), but we MUST NOT let it preempt an iteration-level
  // trigger that was already observed first. Without this gate, e.g.,
  // T-TMP-38e variant a (spawn-failure seam paused, racing abort delivered
  // during pause) would short-circuit Promise.race with the abort error
  // even though `firstObservedRef.trigger === "iteration"` was pinned in
  // executeScript before the seam's pause. The gate keeps abortPromise
  // pending in that case, letting execPromise's eventual rejection (the
  // spawn-failure error) drive Promise.race instead.
  let abortPromise: Promise<never> | undefined;
  if (signal) {
    abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        if (
          !firstObservedRef ||
          firstObservedRef.trigger !== "iteration"
        ) {
          reject(makeAbortError(signal));
        }
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          if (
            firstObservedRef &&
            firstObservedRef.trigger === "iteration"
          ) {
            return;
          }
          reject(makeAbortError(signal));
        },
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
  const tmpdirResource = await createTmpdir(parent);
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
        firstObservedRef,
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
        pinIterationFirstObserved();
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
          pinIterationFirstObserved();
          throw new Error(goto.error);
        }

        let nextWorkflow: Workflow;
        let nextScript: ScriptFile | undefined;

        if (goto.kind === "bare") {
          // Bare goto → script in the current workflow (SPEC §2.2).
          nextWorkflow = currentWorkflow;
          nextScript = currentWorkflow.scripts.get(goto.script);
          if (!nextScript) {
            pinIterationFirstObserved();
            throw new Error(
              `Invalid goto target: script '${goto.script}' not found in workflow '${currentWorkflow.name}'`
            );
          }
        } else {
          const targetWf = workflows.get(goto.workflow);
          if (!targetWf) {
            pinIterationFirstObserved();
            throw new Error(
              `Invalid goto target: workflow '${goto.workflow}' not found in .loopx/`
            );
          }
          nextWorkflow = targetWf;
          nextScript = targetWf.scripts.get(goto.script);
          if (!nextScript) {
            pinIterationFirstObserved();
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
    // single attempt and at most one warning. Awaited so the
    // TEST-SPEC §1.4 cleanup-start seam pause (when configured) yields the
    // event loop, allowing the same-process driver to coordinate racing
    // terminal triggers via parent-observable markers.
    await cleanupTmpdir(tmpdirResource, cleanupState);
  }
}
