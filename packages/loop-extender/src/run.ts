import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Output, RunOptions } from "./types.js";
import { discoverScripts } from "./discovery.js";
import { runLoop, type LoopStartingTarget } from "./loop.js";
import { loadGlobalEnv, loadLocalEnv, mergeEnv } from "./env.js";
import { parseTarget } from "./target-validation.js";
import { makeAbortError } from "./abort.js";
import { getLoopxBin, ensureLoopxPackageJson } from "./bin-path.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Internal options carried alongside the public `RunOptions` to plumb
 * snapshot-timing carve-outs through `run()` → `runInternal()` → `runLoop()`.
 * Not part of the public API.
 */
interface InternalRunOptions {
  /** Tmpdir parent captured eagerly at the `runPromise()` call site. */
  tmpdirParent?: string;
}

function getRunningVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "package.json"), "utf-8")
    );
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Run a loopx target and yield Output for each iteration.
 *
 * Per SPEC §9.1/9.5:
 *   - RunOptions.cwd is snapshotted at call time; it specifies the project
 *     root (for `.loopx/` resolution and LOOPX_PROJECT_ROOT), NOT the script
 *     execution cwd. Scripts always execute with their workflow directory
 *     as cwd (§6.1).
 *   - target is a required string of shape `workflow[:script]`.
 *   - Errors are surfaced lazily on first iteration.
 */
export function run(
  target: string,
  options?: RunOptions
): AsyncGenerator<Output> {
  return runWithInternal(target, options, undefined);
}

function runWithInternal(
  target: string,
  options: RunOptions | undefined,
  internal: InternalRunOptions | undefined
): AsyncGenerator<Output> {
  const cwd = options?.cwd ?? process.cwd();
  const maxIterations = options?.maxIterations;
  const envFile = options?.envFile;
  const externalSignal = options?.signal;
  const loopxBin = getLoopxBin();

  const internalAc = new AbortController();
  const effectiveSignal: AbortSignal = externalSignal
    ? AbortSignal.any([externalSignal, internalAc.signal])
    : internalAc.signal;

  const gen = runInternal(
    target,
    cwd,
    maxIterations,
    envFile,
    effectiveSignal,
    loopxBin,
    internal?.tmpdirParent
  );

  let returnCalled = false;

  const wrapper: AsyncGenerator<Output> = {
    next: async () => {
      try {
        return await gen.next();
      } catch (err) {
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
  target: string | undefined,
  cwd: string,
  maxIterations: number | undefined,
  envFile: string | undefined,
  signal: AbortSignal,
  loopxBin: string,
  tmpdirParent: string | undefined
): AsyncGenerator<Output> {
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

  if (signal.aborted) {
    throw makeAbortError(signal);
  }

  const loopxDir = join(cwd, ".loopx");

  // Discovery (global validation per SPEC §5.4)
  const discovery = discoverScripts(loopxDir, "run");
  if (discovery.errors.length > 0) {
    throw new Error(discovery.errors.join("; "));
  }
  for (const w of discovery.warnings) {
    process.stderr.write(w + "\n");
  }

  // Load env (SPEC §8)
  const globalResult = loadGlobalEnv();
  const globalEnv = globalResult.vars;
  for (const w of globalResult.warnings) {
    process.stderr.write(`Warning: ${w}\n`);
  }

  let localEnv: Record<string, string> = {};
  if (envFile) {
    const envFilePath = resolve(cwd, envFile);
    const localResult = loadLocalEnv(envFilePath);
    localEnv = localResult.vars;
    for (const w of localResult.warnings) {
      process.stderr.write(`Warning: ${w}\n`);
    }
  }

  const mergedEnv = mergeEnv(globalEnv, localEnv);

  ensureLoopxPackageJson(loopxDir);

  if (
    target === undefined ||
    target === null ||
    typeof target !== "string"
  ) {
    throw new Error("target is required and must be a string");
  }

  // Parse the target
  const parsed = parseTarget(target);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  const workflow = discovery.workflows.get(parsed.workflow);
  if (!workflow) {
    throw new Error(
      `Workflow '${parsed.workflow}' not found in .loopx/`
    );
  }

  let scriptName: string;
  if (parsed.script === null) {
    if (!workflow.hasIndex || !workflow.scripts.get("index")) {
      throw new Error(
        `Workflow '${parsed.workflow}' has no default entry point ('index' script)`
      );
    }
    scriptName = "index";
  } else {
    scriptName = parsed.script;
  }

  const scriptFile = workflow.scripts.get(scriptName);
  if (!scriptFile) {
    throw new Error(
      `Script '${scriptName}' not found in workflow '${parsed.workflow}'`
    );
  }

  // -n 0 / maxIterations: 0 — validates but does not enter the loop
  // (workflow-level version checking is skipped per SPEC §3.2).
  if (maxIterations === 0) {
    return;
  }

  const starting: LoopStartingTarget = { workflow, script: scriptFile };

  yield* runLoop(starting, discovery.workflows, {
    maxIterations,
    env: mergedEnv,
    projectRoot: cwd,
    loopxBin,
    runningVersion: getRunningVersion(),
    signal,
    tmpdirParent,
  });
}

/**
 * Run a loopx target and collect all outputs (SPEC §9.2).
 * When a signal is provided, the promise rejects on abort.
 */
export async function runPromise(
  target: string,
  options?: RunOptions
): Promise<Output[]> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw makeAbortError(signal);
  }

  // SPEC §9.2: tmpdir-parent snapshot is EAGER under runPromise — captured
  // synchronously at the call site. Mutations to process.env.TMPDIR after
  // runPromise() returns must not affect the tmpdir parent for this run.
  const eagerTmpdirParent = osTmpdir();

  const gen = runWithInternal(target, options, {
    tmpdirParent: eagerTmpdirParent,
  });
  const outputs: Output[] = [];

  if (signal) {
    const abortPromise = new Promise<IteratorResult<Output>>((_, reject) => {
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
