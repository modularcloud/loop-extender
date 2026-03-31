import type { Output, RunOptions } from "./types.js";

/**
 * Run a loopx script and yield Output for each iteration.
 *
 * Spec 9.1: Returns AsyncGenerator<Output>.
 * Snapshots cwd and options at call time.
 * Errors surfaced lazily on first next().
 */
export async function* run(
  scriptName?: string,
  options?: RunOptions
): AsyncGenerator<Output> {
  // TODO: Full implementation in Phase 6+10
  throw new Error("loopx run() is not yet implemented");
}

/**
 * Run a loopx script and collect all outputs.
 *
 * Spec 9.2: Returns Promise<Output[]>.
 */
export async function runPromise(
  scriptName?: string,
  options?: RunOptions
): Promise<Output[]> {
  const outputs: Output[] = [];
  for await (const output of run(scriptName, options)) {
    outputs.push(output);
  }
  return outputs;
}
