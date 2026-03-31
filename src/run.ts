import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { Output, RunOptions } from "./types.js";
import { discoverScripts } from "./discovery.js";
import { runLoop } from "./loop.js";
import { loadGlobalEnv, loadLocalEnv, mergeEnv } from "./env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getLoopxBin(): string {
  try {
    return realpathSync(resolve(__dirname, "bin.js"));
  } catch {
    return resolve(__dirname, "bin.js");
  }
}

/**
 * Run a loopx script and yield Output for each iteration.
 * Snapshots cwd and options at call time.
 * Errors surfaced lazily on first next().
 */
export async function* run(
  scriptName?: string,
  options?: RunOptions
): AsyncGenerator<Output> {
  const cwd = options?.cwd || process.cwd();
  const maxIterations = options?.maxIterations;
  const envFile = options?.envFile;
  const signal = options?.signal;
  const loopxBin = getLoopxBin();

  // Validate maxIterations
  if (maxIterations !== undefined) {
    if (
      typeof maxIterations !== "number" ||
      !Number.isInteger(maxIterations) ||
      maxIterations < 0 ||
      Number.isNaN(maxIterations)
    ) {
      throw new Error(
        `Invalid maxIterations: must be a non-negative integer, got ${maxIterations}`
      );
    }
    if (maxIterations === 0) {
      return;
    }
  }

  // Check abort signal
  if (signal?.aborted) {
    throw signal.reason || new DOMException("The operation was aborted.", "AbortError");
  }

  const loopxDir = join(cwd, ".loopx");

  // Discover scripts
  const discovery = discoverScripts(loopxDir, "run");
  if (discovery.errors.length > 0) {
    throw new Error(discovery.errors.join("; "));
  }

  // Print warnings to stderr
  for (const w of discovery.warnings) {
    process.stderr.write(w + "\n");
  }

  // Load env
  let globalEnv: Record<string, string> = {};
  let localEnv: Record<string, string> = {};

  const globalResult = loadGlobalEnv();
  globalEnv = globalResult.vars;

  if (envFile) {
    const envFilePath = resolve(cwd, envFile);
    const localResult = loadLocalEnv(envFilePath);
    localEnv = localResult.vars;
  }

  const mergedEnv = mergeEnv(globalEnv, localEnv, loopxBin, cwd);

  // Resolve starting target
  const name = scriptName || "default";
  const startingTarget = discovery.scripts.get(name);
  if (!startingTarget) {
    if (!scriptName) {
      throw new Error(
        "No default script found. Create .loopx/default.ts or specify a script name."
      );
    }
    throw new Error(`Script '${name}' not found in .loopx/`);
  }

  // Run the loop
  const loop = runLoop(startingTarget, discovery.scripts, {
    maxIterations,
    env: mergedEnv,
    projectRoot: cwd,
    loopxBin,
    signal,
  });

  try {
    for await (const output of loop) {
      yield output;
    }
  } catch (err) {
    throw err;
  }
}

/**
 * Run a loopx script and collect all outputs.
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
