import { join, resolve } from "node:path";
import { realpathSync, existsSync, writeFileSync } from "node:fs";
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
 *
 * Options are snapshotted at call time (Spec 9.1).
 * Returns a custom AsyncGenerator that supports cancellation via .return().
 */
export function run(
  scriptName?: string,
  options?: RunOptions
): AsyncGenerator<Output> {
  // Snapshot all options at call time (before any async work)
  const cwd = options?.cwd || process.cwd();
  const maxIterations = options?.maxIterations;
  const envFile = options?.envFile;
  const externalSignal = options?.signal;
  const loopxBin = getLoopxBin();

  // Internal abort controller for generator.return() cancellation
  const internalAc = new AbortController();

  // Combine external signal with internal
  let effectiveSignal: AbortSignal;
  if (externalSignal) {
    effectiveSignal = AbortSignal.any([externalSignal, internalAc.signal]);
  } else {
    effectiveSignal = internalAc.signal;
  }

  const gen = runInternal(
    scriptName,
    cwd,
    maxIterations,
    envFile,
    effectiveSignal,
    loopxBin
  );

  // Wrap generator to intercept .return() for cancellation
  let returnCalled = false;

  const wrapper: AsyncGenerator<Output> = {
    next: async () => {
      try {
        return await gen.next();
      } catch (err) {
        // If return() was called, swallow the abort error
        if (returnCalled) {
          return { done: true, value: undefined } as IteratorResult<Output>;
        }
        throw err;
      }
    },
    return: async (value?: Output) => {
      returnCalled = true;
      internalAc.abort();
      try {
        return await gen.return(value as Output);
      } catch {
        return { done: true, value: undefined } as IteratorResult<Output>;
      }
    },
    throw: (err: unknown) => gen.throw(err),
    [Symbol.asyncIterator]() {
      return this;
    },
    async [Symbol.asyncDispose](): Promise<void> {
      returnCalled = true;
      internalAc.abort();
      try {
        await gen.return(undefined as unknown as Output);
      } catch {
        // Swallow errors during dispose
      }
    },
  };
  return wrapper;
}

async function* runInternal(
  scriptName: string | undefined,
  cwd: string,
  maxIterations: number | undefined,
  envFile: string | undefined,
  signal: AbortSignal,
  loopxBin: string
): AsyncGenerator<Output> {
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
  }

  // Check abort signal
  if (signal.aborted) {
    throw (
      signal.reason ||
      new DOMException("The operation was aborted.", "AbortError")
    );
  }

  const loopxDir = join(cwd, ".loopx");

  // Discover scripts
  const discovery = discoverScripts(loopxDir, "run");
  if (discovery.errors.length > 0) {
    throw new Error(discovery.errors.join("; "));
  }

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

  // Ensure .loopx/package.json exists with "type": "module" so that tsx
  // treats scripts as ESM (required for top-level await, Spec 6.3).
  const loopxPkg = join(loopxDir, "package.json");
  if (!existsSync(loopxPkg)) {
    writeFileSync(loopxPkg, '{"type":"module"}\n', "utf-8");
  }

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

  // maxIterations: 0 validates then exits (mirrors CLI -n 0)
  if (maxIterations === 0) {
    return;
  }

  // Run the loop
  try {
    yield* runLoop(startingTarget, discovery.scripts, {
      maxIterations,
      env: mergedEnv,
      projectRoot: cwd,
      loopxBin,
      signal,
    });
  } catch (err) {
    // If abort was due to internal cancellation (generator.return()),
    // silently complete instead of throwing
    if (
      err instanceof DOMException &&
      err.name === "AbortError" &&
      signal.aborted
    ) {
      // Check if external signal was the cause
      // (in that case we should still throw)
      // internalAc abort vs externalSignal abort
      // We can't distinguish here directly, so just rethrow
      throw err;
    }
    throw err;
  }
}

/**
 * Run a loopx script and collect all outputs.
 * When a signal is provided, the promise rejects on abort.
 */
export async function runPromise(
  scriptName?: string,
  options?: RunOptions
): Promise<Output[]> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw (
      signal.reason ||
      new DOMException("The operation was aborted.", "AbortError")
    );
  }

  const gen = run(scriptName, options);
  const outputs: Output[] = [];

  if (signal) {
    // Create a persistent abort promise that rejects when the signal aborts.
    // Once rejected, it stays rejected, causing Promise.race to immediately
    // reject on the next gen.next() call - even for very fast scripts.
    const abortPromise = new Promise<IteratorResult<Output>>((_, reject) => {
      if (signal.aborted) {
        reject(
          signal.reason ||
            new DOMException("The operation was aborted.", "AbortError")
        );
        return;
      }
      signal.addEventListener(
        "abort",
        () =>
          reject(
            signal.reason ||
              new DOMException("The operation was aborted.", "AbortError")
          ),
        { once: true }
      );
    });
    abortPromise.catch(() => {}); // prevent unhandled rejection warning

    try {
      while (true) {
        const iterResult = await Promise.race([gen.next(), abortPromise]);
        if (iterResult.done) break;
        outputs.push(iterResult.value);
      }
      return outputs;
    } catch (err) {
      await gen.return(undefined as unknown as Output).catch(() => {});
      throw err;
    }
  }

  for await (const output of gen) {
    outputs.push(output);
  }
  return outputs;
}
