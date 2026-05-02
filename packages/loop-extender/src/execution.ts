import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import type { ScriptFile } from "./discovery.js";
import { makeAbortError } from "./abort.js";
import type { FirstObservedRef } from "./loop.js";
import { maybePauseAtTerminalTriggerWindow } from "./test-seams.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOADER_REGISTER_PATH = resolve(__dirname, "loader-register.js");

// Detect Bun runtime — when running under Bun, use Bun's native TS/JSX
// support instead of tsx (SPEC §6.3).
const isBun = !!process.versions.bun;

// Bun's default JSX runtime is "automatic" (imports from "react/jsx-runtime"),
// which breaks workflow scripts that define a local `React.createElement` shim
// (SPEC §6.3 requires .tsx/.jsx to run without pulling in React). Bun only
// exposes classic transform configuration through bunfig.toml, so we write a
// private one to a temp dir on first use and pass it via `-c` along with
// the `--jsx-factory` flags.
let bunClassicJsxConfigPath: string | null = null;
function getBunClassicJsxConfig(): string {
  if (bunClassicJsxConfigPath && existsSync(bunClassicJsxConfigPath)) {
    return bunClassicJsxConfigPath;
  }
  const dir = join(tmpdir(), `loopx-bun-jsx-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "bunfig.toml");
  writeFileSync(
    path,
    `jsx = "react"\njsx-factory = "React.createElement"\njsx-fragment = "React.Fragment"\n`,
    "utf-8"
  );
  bunClassicJsxConfigPath = path;
  return path;
}

// Add our node_modules/.bin to PATH so tsx is findable regardless of cwd.
// __dirname is the compiled dist/ directory. Three layouts must be supported:
//   - Global install: <pkg>/node_modules/.bin — `npm install -g loop-extender`
//     nests tsx under the package root (one level above __dirname).
//   - Workspace dev: <repo>/node_modules/.bin — npm workspaces hoist tsx to
//     the repo root (three levels above __dirname).
//   - Legacy flat: <__dirname>/node_modules/.bin — kept for backwards compat
//     with old dist-as-package layouts.
// Prepend all three; missing entries on PATH are harmless.
const LOOPX_LEGACY_BIN_DIR = resolve(__dirname, "node_modules", ".bin");
const LOOPX_FLAT_BIN_DIR = resolve(__dirname, "..", "node_modules", ".bin");
const LOOPX_WORKSPACE_BIN_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "node_modules",
  ".bin"
);
// NODE_PATH entries: loopx's own deps + parent dir (for global installs
// where the parent node_modules/ contains the loopx package itself) +
// workspace-root node_modules (for dev via npm workspaces).
const LOOPX_NODE_MODULES = resolve(__dirname, "..", "node_modules");
const LOOPX_PACKAGE_PARENT = resolve(__dirname, "..", "..");
const LOOPX_WORKSPACE_NODE_MODULES = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "node_modules"
);

// The npm package is published as "loop-extender" but scripts import from
// "loopx" (SPEC §3.1, §3.3). When the package is globally installed there is
// no `node_modules/loopx/` entry accessible to scripts, so Bun's NODE_PATH
// lookup fails. Create a per-process shim dir that symlinks `loopx` to the
// loop-extender package root (one level above __dirname, since __dirname is
// the compiled dist/ dir and package.json with `exports` lives at the parent)
// and prepend it to NODE_PATH.
//
// Lazy: created on first executeScript() call. Doing this at module-load time
// would crash loopx whenever TMPDIR points at an unwritable parent — which
// the SPEC §7.1 step-5-before-step-6 ordering tests deliberately exercise.
let loopxShimDir: string | null = null;
function getLoopxShimDir(): string {
  if (loopxShimDir && existsSync(join(loopxShimDir, "loopx"))) {
    return loopxShimDir;
  }
  const dir = join(tmpdir(), `loopx-nodepath-shim-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "loopx");
  // __dirname is dist/ at runtime; the canonical package root with package.json
  // (and its `exports` map) lives one level up.
  const loopxPackageRoot = resolve(__dirname, "..");
  try {
    if (lstatSync(shim)) unlinkSync(shim);
  } catch {
    // didn't exist
  }
  symlinkSync(loopxPackageRoot, shim);
  loopxShimDir = dir;
  return dir;
}

function buildLoopxNodePath(): string {
  return `${getLoopxShimDir()}:${LOOPX_NODE_MODULES}:${LOOPX_PACKAGE_PARENT}:${LOOPX_WORKSPACE_NODE_MODULES}`;
}

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

export interface ExecOptions {
  workflowName: string;
  workflowDir: string;
  projectRoot: string;
  loopxBin: string;
  tmpdir: string;
  env: Record<string, string>;
  input?: string;
  signal?: AbortSignal;
  /**
   * SPEC §7.2 first-observed-trigger tracking. When set, executeScript pins
   * `trigger = "iteration"` (only if currently null) on a spawn failure
   * (sync throw from `spawn()` or async `'error'` event) before pausing at
   * the TEST-SPEC §1.4 `child-spawn-failure` seam and propagating the
   * failure. This makes spawn failures classify as iteration-level errors
   * for the wrapper's first-observed-wins logic.
   */
  firstObservedRef?: FirstObservedRef;
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already dead
    }
  }
}

export async function executeScript(
  script: ScriptFile,
  options: ExecOptions
): Promise<ExecResult> {
  const {
    workflowName,
    workflowDir,
    projectRoot,
    loopxBin,
    tmpdir: loopxTmpdir,
    env,
    input,
    signal,
    firstObservedRef,
  } = options;

  // SPEC §6.1 (ADR-0004): scripts always run with the project root as cwd.
  // The workflow directory is exposed via LOOPX_WORKFLOW_DIR.
  const cwd = projectRoot;

  const currentPath = env.PATH ?? process.env.PATH ?? "";
  const currentNodePath = env.NODE_PATH ?? "";
  const loopxNodePath = buildLoopxNodePath();

  const scriptEnv: Record<string, string> = {
    ...env,
    LOOPX_BIN: loopxBin,
    LOOPX_PROJECT_ROOT: projectRoot,
    LOOPX_WORKFLOW: workflowName,
    LOOPX_WORKFLOW_DIR: workflowDir,
    LOOPX_TMPDIR: loopxTmpdir,
    PATH: (() => {
      const pathEntries = currentPath.split(":");
      const prepend: string[] = [];
      for (const dir of [
        LOOPX_LEGACY_BIN_DIR,
        LOOPX_FLAT_BIN_DIR,
        LOOPX_WORKSPACE_BIN_DIR,
      ]) {
        if (!pathEntries.includes(dir)) prepend.push(dir);
      }
      return prepend.length === 0
        ? currentPath
        : `${prepend.join(":")}:${currentPath}`;
    })(),
    NODE_PATH: currentNodePath
      ? `${loopxNodePath}:${currentNodePath}`
      : loopxNodePath,
  };

  let command: string;
  let args: string[];

  if (script.ext === ".sh") {
    command = "/bin/bash";
    args = [script.path];
  } else if (isBun) {
    command = "bun";
    // Bun interops CJS liberally, but SPEC §6.3 requires loopx scripts to be
    // ESM. Substitute `require` with `null` at parse time so any CJS-style
    // `require("fs")` call fails with a TypeError — matching the SPEC
    // requirement that CJS syntax "fail at execution time".
    const commonFlags = ["--define", "require:null"];
    if (script.ext === ".tsx" || script.ext === ".jsx") {
      // Configure Bun to use the classic JSX transform against a user-supplied
      // `React.createElement` factory. This runs JSX through the same path as
      // tsx + Node (classic). Bun only honors jsx config via bunfig.toml, so
      // we write one to a tmp dir and pass it via `--config=`.
      const bunfig = getBunClassicJsxConfig();
      args = [
        ...commonFlags,
        `--config=${bunfig}`,
        "--jsx-factory=React.createElement",
        "--jsx-fragment=React.Fragment",
        script.path,
      ];
    } else {
      args = [...commonFlags, script.path];
    }
  } else {
    command = "tsx";
    args = ["--import", LOADER_REGISTER_PATH, script.path];
  }

  if (signal?.aborted) {
    throw makeAbortError(signal);
  }

  // TEST-SPEC §1.4 `child-spawn-attempt` seam: pause AFTER deciding to spawn
  // (and entering the spawn-attempt path) but BEFORE actually invoking
  // `spawn()` and observing its outcome. The seam fires only when the env
  // var matches; otherwise it is a no-op. Used by T-TERM-04 variant b /
  // T-TMP-38e variant b to race an abort into the spawn-attempt window so
  // the abort listener pins first-observed before the spawn outcome is
  // observed. We deliberately do NOT recheck `signal.aborted` after the
  // pause — re-checking would short-circuit the spawn under the explicit
  // "abort wins over pre-iteration failures" rule and prevent the genuine
  // race the seam is designed to expose.
  await maybePauseAtTerminalTriggerWindow("child-spawn-attempt");

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd,
      env: scriptEnv,
      stdio: ["pipe", "pipe", "inherit"],
      detached: true,
    });
  } catch (err) {
    // SPEC §7.2 first-observed-trigger: spawn-failure is an iteration-level
    // terminal trigger. Pin BEFORE pausing at the seam so a racing abort
    // delivered during the bounded pause sees the slot occupied and does
    // not displace the spawn-failure outcome (T-TERM-04 variant a /
    // T-TMP-38e variant a).
    if (firstObservedRef && firstObservedRef.trigger === null) {
      firstObservedRef.trigger = "iteration";
    }
    // TEST-SPEC §1.4 `child-spawn-failure` seam: pause AFTER observing the
    // spawn-failure (and pinning first-observed) but BEFORE propagating the
    // error to the caller. Used by T-TERM-04 variant a / T-TMP-38e variant a
    // to race an abort into the post-observation window.
    await maybePauseAtTerminalTriggerWindow("child-spawn-failure");
    throw err;
  }

  return new Promise<ExecResult>((resolvePromise, reject) => {
    let stdout = "";
    let aborted = false;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    // stdio: ["pipe", "pipe", "inherit"] guarantees stdin/stdout pipes.
    const childStdout = child.stdout!;
    const childStdin = child.stdin!;

    childStdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    childStdin.on("error", () => {});
    if (input !== undefined && input !== "") {
      childStdin.write(input);
    }
    childStdin.end();

    const onAbort = () => {
      aborted = true;
      const forwardSignal: NodeJS.Signals =
        signal?.reason === "SIGINT" || signal?.reason === "SIGTERM"
          ? signal.reason
          : "SIGTERM";
      killProcessGroup(child, forwardSignal);
      graceTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
      }, 5000);
      graceTimer.unref();
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      // If abort was raced into during the `child-spawn-attempt` seam pause
      // (variant b of T-TMP-38e / T-TERM-04), the listener won't auto-fire
      // on an already-aborted signal. Synthetically dispatch so the active
      // child is terminated promptly.
      if (signal.aborted) {
        onAbort();
      }
    }

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);

      if (aborted) {
        reject(makeAbortError(signal));
      } else {
        resolvePromise({ stdout, exitCode: code ?? 1 });
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      // Async `'error'` path: the spawn-failure was observed asynchronously
      // (e.g., ENOENT). Mirror the sync-throw path: pin first-observed and
      // pause at the `child-spawn-failure` seam before propagating.
      void (async () => {
        if (firstObservedRef && firstObservedRef.trigger === null) {
          firstObservedRef.trigger = "iteration";
        }
        await maybePauseAtTerminalTriggerWindow("child-spawn-failure");
        reject(err);
      })();
    });
  });
}
