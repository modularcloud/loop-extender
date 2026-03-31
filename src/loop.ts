import type { Output } from "./types.js";
import type { ScriptEntry } from "./discovery.js";
import { executeScript } from "./execution.js";
import { parseOutput } from "./parsers/parse-output.js";

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

  let iteration = 0;
  let currentTarget = startingTarget;
  let currentInput: string | undefined = undefined;

  while (true) {
    // Check abort signal
    if (signal?.aborted) {
      throw signal.reason || new DOMException("The operation was aborted.", "AbortError");
    }

    // Execute current target
    const result = await executeScript(currentTarget, {
      projectRoot,
      loopxBin,
      env,
      input: currentInput,
      signal,
    });

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

    // Determine next target
    if (output.goto) {
      // Validate goto target
      const gotoScript = scripts.get(output.goto);
      if (!gotoScript) {
        throw new Error(
          `Invalid goto target: '${output.goto}' not found in .loopx/`
        );
      }
      currentTarget = gotoScript;
      // Pipe result to next script via stdin
      currentInput = output.result ?? "";
    } else {
      // No goto: reset to starting target with empty stdin
      currentTarget = startingTarget;
      currentInput = undefined;
    }
  }
}
