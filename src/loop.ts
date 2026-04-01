import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import type { Output } from "./types.js";
import type { ScriptEntry } from "./discovery.js";
import { executeScript, type ExecResult } from "./execution.js";
import { parseOutput } from "./parsers/parse-output.js";
import { makeAbortError } from "./abort.js";

export interface LoopOptions {
  maxIterations?: number;
  env: Record<string, string>;
  projectRoot: string;
  loopxBin: string;
  signal?: AbortSignal;
}

export async function* runLoop(
  startingTarget: ScriptEntry,
  scripts: Map<string, ScriptEntry>,
  options: LoopOptions
): AsyncGenerator<Output> {
  const { maxIterations, env, projectRoot, loopxBin, signal } = options;

  if (maxIterations === 0) {
    return;
  }

  // Create a persistent abort promise that rejects when the signal aborts.
  // Once rejected, it stays rejected, so Promise.race will pick it up
  // on the next iteration even if the signal fired between iterations.
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
    // Prevent unhandled rejection warning (handlers are also attached via Promise.race)
    abortPromise.catch(() => {});
  }

  let iteration = 0;
  let currentTarget = startingTarget;
  let currentInput: string | undefined = undefined;

  while (true) {
    // Check abort signal synchronously
    if (signal?.aborted) {
      throw makeAbortError(signal);
    }

    // Execute current target, racing against abort if signal is provided
    let result: ExecResult;
    const execPromise = executeScript(currentTarget, {
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
        // If abortPromise won the race, wait for the execution to complete
        // so the child process cleanup (SIGTERM → grace period → SIGKILL) can finish
        await execPromise.catch(() => {});
        throw err;
      }
    } else {
      result = await execPromise;
    }

    // Non-zero exit: stop immediately, don't parse output
    if (result.exitCode !== 0) {
      throw new Error(
        `Script '${currentTarget.name}' exited with code ${result.exitCode}`
      );
    }

    // Parse stdout as structured output
    const output = parseOutput(result.stdout);
    iteration++;

    // stop: true takes priority
    if (output.stop === true) {
      yield output;
      return;
    }

    // Check if max iterations reached
    if (maxIterations !== undefined && iteration >= maxIterations) {
      yield output;
      return;
    }

    // Yield the output
    yield output;

    // Yield to event loop between iterations. setTimeout(0) goes through
    // the timer phase, allowing pending abort timers to fire. The ~1ms
    // minimum delay ensures fast scripts don't starve the event loop.
    if (signal && !signal.aborted) {
      await setTimeoutPromise(0);
    }

    // Check abort after yield
    if (signal?.aborted) {
      throw makeAbortError(signal);
    }

    // Determine next target
    if (output.goto) {
      const gotoScript = scripts.get(output.goto);
      if (!gotoScript) {
        throw new Error(
          `Invalid goto target: '${output.goto}' not found in .loopx/`
        );
      }
      currentTarget = gotoScript;
      currentInput = output.result ?? "";
    } else {
      currentTarget = startingTarget;
      currentInput = undefined;
    }
  }
}
