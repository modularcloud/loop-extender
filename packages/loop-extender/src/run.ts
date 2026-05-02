import { join, resolve, isAbsolute, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Output, RunOptions } from "./types.js";
import { discoverScripts } from "./discovery.js";
import { runLoop, type LoopStartingTarget } from "./loop.js";
import {
  getGlobalEnvPath,
  loadGlobalEnv,
  loadLocalEnv,
  mergeEnv,
} from "./env.js";
import { parseTarget } from "./target-validation.js";
import { makeAbortError } from "./abort.js";
import { getLoopxBin, ensureLoopxPackageJson } from "./bin-path.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface InternalRunOptions {
  tmpdirParent?: string;
  /**
   * Eagerly captured snapshot of `process.env` (SPEC §9.2). When set, the
   * inherited environment used in `mergeEnv` is read from this snapshot
   * rather than the live `process.env`, pinning observed values to the
   * runPromise() call site.
   */
  inheritedEnv?: Record<string, string>;
  /**
   * Eagerly resolved global loopx env file path (SPEC §9.2). When set,
   * `loadGlobalEnv` consults this path verbatim instead of re-resolving from
   * `XDG_CONFIG_HOME` / `HOME` at iteration time.
   */
  globalEnvPath?: string;
}

interface OptionSnapshot {
  error?: unknown;
  signal?: AbortSignal;
  env?: Record<string, string>;
  cwd?: string;
  envFile?: string;
  maxIterations?: number;
}

function isAbortSignalCompatible(signal: unknown): boolean {
  if (signal === null) return false;
  const t = typeof signal;
  if (t !== "object" && t !== "function") return false;
  let aborted: unknown;
  try {
    aborted = (signal as { aborted?: unknown }).aborted;
  } catch {
    return false;
  }
  if (typeof aborted !== "boolean") return false;
  let ael: unknown;
  try {
    ael = (signal as { addEventListener?: unknown }).addEventListener;
  } catch {
    return false;
  }
  if (typeof ael !== "function") return false;
  return true;
}

function snapshotEnv(envRaw: unknown): Record<string, string> {
  if (envRaw === null) {
    throw new TypeError("RunOptions.env must not be null");
  }
  if (Array.isArray(envRaw)) {
    throw new TypeError("RunOptions.env must not be an array");
  }
  const t = typeof envRaw;
  if (t === "function") {
    throw new TypeError("RunOptions.env must not be a function");
  }
  if (t !== "object") {
    throw new TypeError(`RunOptions.env must be an object, got ${t}`);
  }

  const out: Record<string, string> = {};
  // Object.keys() returns own enumerable string-keyed properties; for Proxy
  // it invokes the ownKeys + getOwnPropertyDescriptor traps, which may throw
  // and propagate naturally to the caller (captured into snap.error).
  const keys = Object.keys(envRaw as object);
  for (const key of keys) {
    // [[Get]] — invokes any accessor getter or proxy get trap (may throw).
    const value = (envRaw as Record<string, unknown>)[key];
    if (typeof value !== "string") {
      throw new TypeError(
        `RunOptions.env[${JSON.stringify(key)}] must be a string, got ${typeof value}`
      );
    }
    out[key] = value;
  }
  return out;
}

function snapshotOptions(options: unknown): OptionSnapshot {
  const snap: OptionSnapshot = {};

  if (options === undefined) return snap;
  if (options === null) {
    snap.error = new TypeError("RunOptions must not be null");
    return snap;
  }
  if (Array.isArray(options)) {
    snap.error = new TypeError("RunOptions must not be an array");
    return snap;
  }
  const ot = typeof options;
  if (ot === "function") {
    snap.error = new TypeError("RunOptions must not be a function");
    return snap;
  }
  if (ot !== "object") {
    snap.error = new TypeError(`RunOptions must be an object, got ${ot}`);
    return snap;
  }

  const opts = options as Record<string, unknown>;

  // SPEC §9.1: signal is read FIRST before any other field, so an
  // already-aborted signal is captured before any other option-field read
  // can produce a snapshot exception.
  let signalRaw: unknown;
  try {
    signalRaw = opts.signal;
  } catch (e) {
    snap.error = e;
    return snap;
  }
  if (signalRaw !== undefined) {
    if (!isAbortSignalCompatible(signalRaw)) {
      snap.error = new TypeError(
        "RunOptions.signal must be an AbortSignal-compatible object"
      );
      return snap;
    }
    snap.signal = signalRaw as AbortSignal;
  }

  // Order among remaining fields is implementation-defined per SPEC §9.1.
  // We do cwd before envFile so envFile can be resolved against the snapshot
  // cwd at call time per SPEC §9.5.
  let cwdRaw: unknown;
  try {
    cwdRaw = opts.cwd;
  } catch (e) {
    snap.error = e;
    return snap;
  }
  if (cwdRaw !== undefined) {
    if (typeof cwdRaw !== "string") {
      snap.error = new TypeError(
        `RunOptions.cwd must be a string, got ${typeof cwdRaw}`
      );
      return snap;
    }
    try {
      snap.cwd = isAbsolute(cwdRaw)
        ? cwdRaw
        : resolve(process.cwd(), cwdRaw);
    } catch (e) {
      snap.error = e;
      return snap;
    }
  }

  let envFileRaw: unknown;
  try {
    envFileRaw = opts.envFile;
  } catch (e) {
    snap.error = e;
    return snap;
  }
  if (envFileRaw !== undefined) {
    if (typeof envFileRaw !== "string") {
      snap.error = new TypeError(
        `RunOptions.envFile must be a string, got ${typeof envFileRaw}`
      );
      return snap;
    }
    snap.envFile = envFileRaw;
  }

  let envRaw: unknown;
  try {
    envRaw = opts.env;
  } catch (e) {
    snap.error = e;
    return snap;
  }
  if (envRaw !== undefined) {
    try {
      snap.env = snapshotEnv(envRaw);
    } catch (e) {
      snap.error = e;
      return snap;
    }
  }

  let maxIterRaw: unknown;
  try {
    maxIterRaw = opts.maxIterations;
  } catch (e) {
    snap.error = e;
    return snap;
  }
  if (maxIterRaw !== undefined) {
    if (
      typeof maxIterRaw !== "number" ||
      !Number.isInteger(maxIterRaw) ||
      maxIterRaw < 0 ||
      Number.isNaN(maxIterRaw)
    ) {
      snap.error = new Error(
        `Invalid maxIterations: must be a non-negative integer, got ${String(maxIterRaw)}`
      );
      return snap;
    }
    snap.maxIterations = maxIterRaw as number;
  }

  return snap;
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
 *   - Options are snapshotted at call time. Throwing getters / proxy traps
 *     are captured rather than escaping at the call site, and surface via
 *     the standard pre-iteration error path on first next().
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
  target: unknown,
  options: RunOptions | undefined,
  internal: InternalRunOptions | undefined
): AsyncGenerator<Output> {
  const snap = snapshotOptions(options);

  // Default cwd to process.cwd() at call time per SPEC §9.5.
  if (snap.error === undefined && snap.cwd === undefined) {
    try {
      snap.cwd = process.cwd();
    } catch (e) {
      snap.error = e;
    }
  }

  const loopxBin = getLoopxBin();

  const internalAc = new AbortController();

  // Wire user signal → internal abort propagation. SPEC §9.5: addEventListener
  // must return without throwing; if it throws, capture as a snapshot error.
  if (snap.error === undefined && snap.signal) {
    if (snap.signal.aborted) {
      try {
        internalAc.abort(snap.signal.reason);
      } catch {
        /* ignore */
      }
    } else {
      try {
        snap.signal.addEventListener(
          "abort",
          () => {
            try {
              internalAc.abort(snap.signal!.reason);
            } catch {
              /* ignore */
            }
          },
          { once: true }
        );
      } catch (e) {
        snap.error = e;
      }
    }
  }

  const effectiveSignal: AbortSignal = internalAc.signal;

  const gen = runInternal(
    target,
    snap,
    effectiveSignal,
    loopxBin,
    internal?.tmpdirParent,
    internal?.inheritedEnv,
    internal?.globalEnvPath
  );

  let returnCalled = false;
  let settled = false;
  let yieldCount = 0;
  // SPEC §9.3 abort-after-final-yield: tracks whether the most recently
  // yielded Output was final (stop:true or maxIterations reached). When set,
  // an abort observed before the next consumer interaction surfaces the
  // abort error (with cleanup first) rather than allowing silent completion.
  let postFinalYield = false;

  const surfacePostFinalYieldAbort = async (): Promise<never> => {
    // Drive inner gen to settlement so its `finally` runs cleanupTmpdir
    // before the abort error reaches the consumer (SPEC §9.3 / §7.4 ordering).
    try {
      await gen.return(undefined as unknown as Output);
    } catch {
      // Cleanup-time errors are swallowed; abort error takes precedence.
    }
    throw makeAbortError(snap.signal ?? internalAc.signal);
  };

  const wrapper: AsyncGenerator<Output> = {
    next: async () => {
      if (settled) {
        return { done: true, value: undefined } as IteratorResult<Output>;
      }
      // SPEC §9.3 abort-after-final-yield: an AbortSignal that aborts after
      // the final Output but before settlement surfaces the abort error on
      // the next interaction. The first-observed-wins guard (!returnCalled)
      // ensures a prior consumer .return()/.throw() retains its silent
      // completion outcome.
      if (postFinalYield && internalAc.signal.aborted && !returnCalled) {
        settled = true;
        await surfacePostFinalYieldAbort();
      }
      try {
        const result = await gen.next();
        if (!result.done && result.value !== undefined) {
          yieldCount++;
          if (
            result.value.stop === true ||
            (snap.maxIterations !== undefined &&
              yieldCount === snap.maxIterations)
          ) {
            postFinalYield = true;
          }
        }
        if (result.done) settled = true;
        return result;
      } catch (err) {
        settled = true;
        if (returnCalled) {
          return { done: true, value: undefined } as IteratorResult<Output>;
        }
        throw err;
      }
    },
    return: async (value?: Output) => {
      if (settled) {
        returnCalled = true;
        return { done: true, value: undefined } as IteratorResult<Output>;
      }
      // SPEC §9.3 abort-after-final-yield: abort observed before this
      // .return() displaces silent completion; abort error surfaces (with
      // cleanup first).
      if (postFinalYield && internalAc.signal.aborted && !returnCalled) {
        settled = true;
        returnCalled = true;
        await surfacePostFinalYieldAbort();
      }
      returnCalled = true;
      internalAc.abort();
      try {
        const result = await gen.return(value as Output);
        settled = true;
        return result;
      } catch {
        settled = true;
        return { done: true, value: undefined } as IteratorResult<Output>;
      }
    },
    // SPEC §9.1 consumer-driven cancellation: `.throw()` after first `next()`
    // terminates the active child process group (via abort) and ensures no
    // further iterations start. When no child is active (between iterations,
    // after final yield, post-yield), this produces silent clean completion
    // — the consumer-supplied error is not surfaced. For the active-child
    // case the settlement form is implementation-defined; we choose silent
    // completion for symmetry with `.return()`.
    //
    // SPEC §9.3 abort-after-final-yield carve-out: when an abort has already
    // been observed in the post-final-yield window before this .throw()
    // arrives, the abort error displaces both silent completion AND the
    // consumer-supplied error.
    throw: async (_err: unknown) => {
      if (settled) {
        returnCalled = true;
        return { done: true, value: undefined } as IteratorResult<Output>;
      }
      if (postFinalYield && internalAc.signal.aborted && !returnCalled) {
        settled = true;
        returnCalled = true;
        await surfacePostFinalYieldAbort();
      }
      returnCalled = true;
      internalAc.abort();
      try {
        const result = await gen.return(undefined as unknown as Output);
        settled = true;
        return result;
      } catch {
        settled = true;
        return { done: true, value: undefined } as IteratorResult<Output>;
      }
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async [Symbol.asyncDispose](): Promise<void> {
      if (settled) {
        returnCalled = true;
        return;
      }
      returnCalled = true;
      internalAc.abort();
      try {
        await gen.return(undefined as unknown as Output);
        settled = true;
      } catch {
        settled = true;
        // Swallow errors during dispose
      }
    },
  };
  return wrapper;
}

async function* runInternal(
  target: unknown,
  snap: OptionSnapshot,
  signal: AbortSignal,
  loopxBin: string,
  tmpdirParent: string | undefined,
  inheritedEnv: Record<string, string> | undefined,
  globalEnvPath: string | undefined
): AsyncGenerator<Output> {
  // SPEC §9.3 abort precedence: if a usable signal was captured and is
  // aborted (or aborts later), it displaces all other pre-iteration failures.
  if (snap.signal?.aborted) {
    throw makeAbortError(snap.signal);
  }

  // Surface any captured option-snapshot error.
  if (snap.error !== undefined) {
    throw snap.error;
  }

  if (signal.aborted) {
    throw makeAbortError(signal);
  }

  const cwd = snap.cwd!;
  const loopxDir = join(cwd, ".loopx");

  // Discovery (global validation per SPEC §5.4)
  const discovery = discoverScripts(loopxDir, "run");
  if (discovery.errors.length > 0) {
    throw new Error(discovery.errors.join("; "));
  }
  for (const w of discovery.warnings) {
    process.stderr.write(w + "\n");
  }

  // Load env (SPEC §8). globalEnvPath / inheritedEnv (when supplied) are the
  // eager snapshots threaded down from runPromise() per SPEC §9.2; for run()
  // and the CLI they remain undefined and process.env is read lazily here on
  // the first next() call (SPEC §9.1).
  const globalResult = loadGlobalEnv(globalEnvPath);
  const globalEnv = globalResult.vars;
  for (const w of globalResult.warnings) {
    process.stderr.write(`Warning: ${w}\n`);
  }

  let localEnv: Record<string, string> = {};
  if (snap.envFile !== undefined) {
    const envFilePath = isAbsolute(snap.envFile)
      ? snap.envFile
      : resolve(cwd, snap.envFile);
    const localResult = loadLocalEnv(envFilePath);
    localEnv = localResult.vars;
    for (const w of localResult.warnings) {
      process.stderr.write(`Warning: ${w}\n`);
    }
  }

  // SPEC §8.3 precedence (highest wins):
  //   1. protocol vars (LOOPX_*) — applied in execution.ts
  //   2. RunOptions.env
  //   3. local env file (-e / RunOptions.envFile)
  //   4. global loopx env
  //   5. inherited process.env
  //
  // mergeEnv yields tiers 5→4→3 (process.env, global, local). RunOptions.env
  // overlays tier 2 here. Protocol vars overlay tier 1 in executeScript.
  const mergedEnv: Record<string, string> = {
    ...mergeEnv(globalEnv, localEnv, inheritedEnv),
    ...(snap.env ?? {}),
  };

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
  if (snap.maxIterations === 0) {
    return;
  }

  const starting: LoopStartingTarget = { workflow, script: scriptFile };

  yield* runLoop(starting, discovery.workflows, {
    maxIterations: snap.maxIterations,
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
  // SPEC §9.2: tmpdir-parent snapshot is EAGER under runPromise — captured
  // synchronously at the call site. Mutations to process.env.TMPDIR after
  // runPromise() returns must not affect the tmpdir parent for this run.
  const eagerTmpdirParent = osTmpdir();

  // SPEC §9.2: the inherited `process.env` snapshot is EAGER under
  // runPromise — captured synchronously at the call site as a shallow copy.
  // Mutations to process.env after runPromise() returns are not observed by
  // the spawned scripts. The shallow copy is reused for every iteration of
  // the run (T-API-72 / T-API-72a).
  const eagerInheritedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };

  // SPEC §9.2: global env file path resolution (XDG_CONFIG_HOME / HOME) also
  // uses the eager schedule. We resolve the path here against the just-taken
  // process.env snapshot so that XDG_CONFIG_HOME / HOME mutations after
  // runPromise() returns do not redirect the global env file lookup.
  const eagerGlobalEnvPath = getGlobalEnvPath(eagerInheritedEnv);

  // SPEC §9.5 / §9.2: option snapshot (incl. cwd, env, envFile, signal,
  // maxIterations) is also eager at call site. runWithInternal() runs
  // snapshotOptions() and captures the cwd default synchronously, so calling
  // it here — before the microtask boundary below — pins those values to
  // their call-site values (T-API-14c, T-API-14d).
  const gen = runWithInternal(target, options, {
    tmpdirParent: eagerTmpdirParent,
    inheritedEnv: eagerInheritedEnv,
    globalEnvPath: eagerGlobalEnvPath,
  });

  // SPEC §9.2: "LOOPX_TMPDIR itself is created asynchronously after return,
  // during the same pre-iteration sequence used by the CLI and run()." The
  // first await suspends runPromise and yields control back to the caller
  // before any iteration work runs. Without this microtask boundary,
  // evaluating `for await (const output of gen)` would synchronously call
  // the wrapper's `next()`, which synchronously runs runInternal + runLoop
  // bodies up to the first internal await — invoking createTmpdir before
  // runPromise() has returned and violating the SPEC §9.2 contract
  // (T-TMP-27a verifies this).
  await Promise.resolve();

  const outputs: Output[] = [];
  for await (const output of gen) {
    outputs.push(output);
  }
  return outputs;
}
