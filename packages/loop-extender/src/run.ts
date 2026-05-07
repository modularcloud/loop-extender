import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { Output, RunOptions } from "./types.js";
import { discoverScripts } from "./discovery.js";
import { runLoop, type LoopStartingTarget } from "./loop.js";
import { loadGlobalEnv, loadLocalEnv, mergeEnv } from "./env.js";
import { parseTarget } from "./target-validation.js";
import { makeAbortError } from "./abort.js";
import { getLoopxBin, ensureLoopxPackageJson } from "./bin-path.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
 *     root, LOOPX_PROJECT_ROOT, and the script execution cwd (§6.1).
 *   - target is a required string of shape `workflow[:script]`.
 *   - Errors are surfaced lazily on first iteration.
 */
export function run(
  target: string,
  options?: RunOptions
): AsyncGenerator<Output> {
  return createRunGenerator(target, options, undefined, undefined);
}

function createRunGenerator(
  target: string,
  options: RunOptions | undefined,
  tmpParent: string | undefined,
  processEnv: Record<string, string | undefined> | undefined
): AsyncGenerator<Output> {
  const snapshot = snapshotRunOptions(options);
  snapshot.processEnv = processEnv;
  const loopxBin = getLoopxBin();

  const internalAc = new AbortController();
  const combinedAc = new AbortController();
  const forwardAbort = () => combinedAc.abort(makeAbortError(snapshot.signal as AbortSignal));
  internalAc.signal.addEventListener("abort", forwardAbort, { once: true });
  if (!snapshot.error && snapshot.signal) {
    try {
      snapshot.signal.addEventListener(
        "abort",
        () => combinedAc.abort(makeAbortError(snapshot.signal as AbortSignal)),
        { once: true }
      );
    } catch (err) {
      snapshot.error = err;
    }
  }

  const gen = runInternal(target, snapshot, combinedAc.signal, loopxBin, tmpParent);

  let returnCalled = false;
  let started = false;

  const wrapper: AsyncGenerator<Output> = {
    next: async () => {
      started = true;
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
      const wasExternallyAborted = combinedAc.signal.aborted;
      returnCalled = true;
      if (!started) {
        return { done: true, value } as IteratorResult<Output>;
      }
      internalAc.abort();
      try {
        const result = await gen.return(value as Output);
        if (wasExternallyAborted) {
          throw makeAbortError(combinedAc.signal);
        }
        return result;
      } catch {
        if (wasExternallyAborted) {
          throw makeAbortError(combinedAc.signal);
        }
        return { done: true, value: undefined } as IteratorResult<Output>;
      }
    },
    throw: async (err: unknown) => {
      const wasExternallyAborted = combinedAc.signal.aborted;
      if (!started) {
        return await gen.throw(err);
      }
      returnCalled = true;
      if (wasExternallyAborted) {
        throw makeAbortError(combinedAc.signal);
      }
      internalAc.abort();
      try {
        return await gen.return(undefined as unknown as Output);
      } catch {
        if (wasExternallyAborted) {
          throw makeAbortError(combinedAc.signal);
        }
        return { done: true, value: undefined } as IteratorResult<Output>;
      }
    },
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

interface RunOptionsSnapshot {
  cwd: string;
  maxIterations?: number;
  envFile?: string;
  env: Record<string, string>;
  signal?: AbortSignalLike;
  processEnv?: Record<string, string | undefined>;
  error?: unknown;
}

interface AbortSignalLike {
  aborted: boolean;
  reason?: unknown;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean }
  ): void;
  removeEventListener?(
    type: "abort",
    listener: () => void,
    options?: unknown
  ): void;
}

function snapshotRunOptions(options: RunOptions | undefined): RunOptionsSnapshot {
  const snapshot: RunOptionsSnapshot = {
    cwd: process.cwd(),
    env: {},
  };
  try {
    if (
      options !== undefined &&
      (typeof options !== "object" || options === null || Array.isArray(options))
    ) {
      throw new Error("Invalid options: RunOptions must be an object");
    }
    const opts = options as RunOptions | undefined;
    const signal = opts?.signal as unknown;
    if (signal !== undefined) {
      snapshot.signal = validateSignal(signal);
      if (snapshot.signal.aborted) {
        return snapshot;
      }
    }
    const env = opts?.env;
    const cwd = opts?.cwd;
    const envFile = opts?.envFile;
    const maxIterations = opts?.maxIterations;

    if (cwd !== undefined) {
      if (typeof cwd !== "string") {
        throw new Error("Invalid cwd: must be a string");
      }
      snapshot.cwd = cwd.startsWith("/") ? cwd : resolve(process.cwd(), cwd);
    }
    if (envFile !== undefined) {
      if (typeof envFile !== "string") {
        throw new Error("Invalid envFile: must be a string");
      }
      snapshot.envFile = envFile;
    }
    if (maxIterations !== undefined) {
      snapshot.maxIterations = maxIterations;
    }
    if (env !== undefined) {
      if (typeof env !== "object" || env === null || Array.isArray(env)) {
        throw new Error("Invalid env: must be an object");
      }
      const captured: Record<string, string> = {};
      for (const key of Object.keys(env)) {
        const value = (env as Record<string, unknown>)[key];
        if (typeof value !== "string") {
          throw new Error(`Invalid env value for ${key}: must be a string`);
        }
        captured[key] = value;
      }
      snapshot.env = captured;
    }
  } catch (err) {
    snapshot.error = err;
  }
  return snapshot;
}

function validateSignal(signal: unknown): AbortSignalLike {
  if (typeof signal !== "object" || signal === null) {
    throw new Error("Invalid signal: must be AbortSignal-compatible");
  }
  const candidate = signal as Partial<AbortSignalLike>;
  const aborted = candidate.aborted;
  if (typeof aborted !== "boolean") {
    throw new Error("Invalid signal: aborted must be boolean");
  }
  if (typeof candidate.addEventListener !== "function") {
    throw new Error("Invalid signal: addEventListener must be a function");
  }
  return candidate as AbortSignalLike;
}

async function* runInternal(
  target: string | undefined,
  snapshot: RunOptionsSnapshot,
  signal: AbortSignal,
  loopxBin: string,
  tmpParent: string | undefined
): AsyncGenerator<Output> {
  if (snapshot.error) {
    throw snapshot.error;
  }

  const { cwd, maxIterations, envFile } = snapshot;

  if (snapshot.signal?.aborted || signal.aborted) {
    throw makeAbortError((snapshot.signal ?? signal) as AbortSignal);
  }

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
  const baseEnv = snapshot.processEnv ?? process.env;
  const globalResult = loadGlobalEnv(baseEnv);
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

  const mergedEnv = mergeEnv(globalEnv, localEnv, baseEnv);
  Object.assign(mergedEnv, snapshot.env);

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
    tmpParent,
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
  const processEnv = { ...process.env };
  const gen = createRunGenerator(
    target,
    options,
    processEnv.TMPDIR ?? tmpdir(),
    processEnv
  );
  const outputs: Output[] = [];

  await Promise.resolve();
  for await (const output of gen) {
    outputs.push(output);
  }
  return outputs;
}
