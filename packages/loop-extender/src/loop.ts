import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { lstatSync, mkdtempSync, readFileSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  tmpParent?: string;
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

  // Fire the version-check on entry into the starting workflow before tmpdir
  // creation and before the first iteration.
  checkVersionOnEntry(starting.workflow);
  try {
    const rootPkgPath = join(projectRoot, "package.json");
    const stat = lstatSync(rootPkgPath);
    if (!stat.isFile()) {
      process.stderr.write("Warning: project package.json is not a regular file\n");
    } else {
      const parsed = JSON.parse(readFileSync(rootPkgPath, "utf-8"));
      const maybeVersion = parsed?.loopx?.version;
      if (typeof maybeVersion === "string") {
        process.stderr.write(`Warning: project package.json loopx version ${maybeVersion}\n`);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write("Warning: project package.json json/semver issue\n");
    }
  }

  const tmpParent = options.tmpParent ?? process.env.TMPDIR ?? tmpdir();
  const loopTmpDir = mkdtempSync(join(tmpParent, "loopx-"));
  const tmpIdentity = lstatSync(loopTmpDir);
  if (process.env.NODE_ENV === "test") {
    const fault = process.env.LOOPX_TEST_TMPDIR_FAULT;
    if (fault === "identity-capture-fail" || fault === "identity-capture-fail-rmdir-fail") {
      if (fault.endsWith("rmdir-fail")) {
        throw new Error("LOOPX_TEST_TMPDIR_FAULT identity-capture-fail-rmdir-fail");
      }
      try {
        rmdirSync(loopTmpDir);
      } catch {}
      throw new Error("LOOPX_TEST_TMPDIR_FAULT identity-capture-fail");
    }
    if (fault === "mode-secure-fail") {
      if (process.env.LOOPX_TEST_CLEANUP_FAULT === "recursive-remove-fail") {
        // Leave the partial directory behind to let the harness observe the
        // simulated cleanup failure.
      } else {
        try {
          rmSync(loopTmpDir, { recursive: true, force: true });
        } catch {}
      }
      throw new Error("LOOPX_TEST_TMPDIR_FAULT mode-secure-fail");
    }
  }
  let cleanedTmpDir = false;
  const emitCleanupWarning = (err: unknown) => {
    process.stderr.write(
      `Warning: failed to clean LOOPX_TMPDIR '${loopTmpDir}': ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    if (process.env.NODE_ENV === "test") {
      process.stderr.write(
        `LOOPX_TEST_CLEANUP_WARNING\t${JSON.stringify({ path: loopTmpDir })}\n`
      );
    }
  };
  const cleanupTmpDir = () => {
    if (cleanedTmpDir) return;
    cleanedTmpDir = true;
    if (process.env.NODE_ENV === "test") {
      const fault = process.env.LOOPX_TEST_CLEANUP_FAULT;
      if (fault === "lstat-fail" || fault === "recursive-remove-fail") {
        emitCleanupWarning(new Error(fault));
        return;
      }
    }
    try {
      const current = lstatSync(loopTmpDir);
      if (current.isSymbolicLink()) {
        unlinkSync(loopTmpDir);
        return;
      }
      if (
        !current.isDirectory() ||
        current.dev !== tmpIdentity.dev ||
        current.ino !== tmpIdentity.ino
      ) {
        emitCleanupWarning(new Error("LOOPX_TMPDIR was replaced; leaving current path untouched"));
        return;
      }
      rmSync(loopTmpDir, { recursive: true, force: true });
    } catch (err) {
      emitCleanupWarning(err);
    }
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

  let iteration = 0;
  let currentWorkflow = starting.workflow;
  let currentScript = starting.script;
  let currentInput: string | undefined = undefined;

  try {
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
      tmpDir: loopTmpDir,
      env,
      input: currentInput,
      signal,
    });

    if (abortPromise) {
      try {
        result = await Promise.race([execPromise, abortPromise]);
      } catch (err) {
        if (signal?.aborted) {
          // executeScript owns child signalling. Wait for prompt child close
          // when possible, but do not let inherited descendant pipes prevent
          // the abort surface from settling past the documented grace period.
          await Promise.race([
            execPromise.catch(() => {}),
            setTimeoutPromise(5000),
          ]);
        } else {
          await execPromise.catch(() => {});
        }
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
      if (signal?.aborted) {
        throw makeAbortError(signal);
      }
      return;
    }

    if (maxIterations !== undefined && iteration >= maxIterations) {
      yield output;
      if (signal?.aborted) {
        throw makeAbortError(signal);
      }
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
  } finally {
    cleanupTmpDir();
  }
}
