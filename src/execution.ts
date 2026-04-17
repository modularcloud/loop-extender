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
// Two layouts must be supported:
//   - Nested: <pkg>/node_modules/.bin — npm `install -g` produces this,
//     because the loopx package's runtime deps (tsx + its transitive deps)
//     are nested under the loopx package root.
//   - Flat: <pkg>/../node_modules/.bin — the dev-tree layout, where `dist/`
//     sits next to the repo-root `node_modules/.bin` via `resolve(__dirname, "..")`.
// Prepend both; missing entries on PATH are harmless.
const LOOPX_NESTED_BIN_DIR = resolve(__dirname, "node_modules", ".bin");
const LOOPX_FLAT_BIN_DIR = resolve(__dirname, "..", "node_modules", ".bin");
// NODE_PATH entries: loopx's own deps + parent dir (for global installs
// where the parent node_modules/ contains the loopx package itself).
const LOOPX_NODE_MODULES = resolve(__dirname, "..", "node_modules");
const LOOPX_PACKAGE_PARENT = resolve(__dirname, "..", "..");

// The npm package is published as "loop-extender" but scripts import from
// "loopx" (SPEC §3.1, §3.3). When the package is globally installed there is
// no `node_modules/loopx/` entry accessible to scripts, so Bun's NODE_PATH
// lookup fails. Create a per-process shim dir that symlinks `loopx` to the
// loopx package root (loopx's own __dirname, typically `.../loop-extender/`)
// and prepend it to NODE_PATH.
let loopxShimDir: string | null = null;
function getLoopxShimDir(): string {
  if (loopxShimDir && existsSync(join(loopxShimDir, "loopx"))) {
    return loopxShimDir;
  }
  const dir = join(tmpdir(), `loopx-nodepath-shim-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "loopx");
  // __dirname here is the loopx package root (dist/ when installed).
  const loopxPackageRoot = __dirname;
  try {
    if (lstatSync(shim)) unlinkSync(shim);
  } catch {
    // didn't exist
  }
  symlinkSync(loopxPackageRoot, shim);
  loopxShimDir = dir;
  return dir;
}

const LOOPX_NODE_PATH = `${getLoopxShimDir()}:${LOOPX_NODE_MODULES}:${LOOPX_PACKAGE_PARENT}`;

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

export interface ExecOptions {
  workflowName: string;
  workflowDir: string;
  projectRoot: string;
  loopxBin: string;
  env: Record<string, string>;
  input?: string;
  signal?: AbortSignal;
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

export function executeScript(
  script: ScriptFile,
  options: ExecOptions
): Promise<ExecResult> {
  const {
    workflowName,
    workflowDir,
    projectRoot,
    loopxBin,
    env,
    input,
    signal,
  } = options;

  // SPEC §6.1: scripts always run with the workflow directory as cwd.
  const cwd = workflowDir;

  const currentPath = env.PATH ?? process.env.PATH ?? "";
  const currentNodePath = env.NODE_PATH ?? "";

  const scriptEnv: Record<string, string> = {
    ...env,
    LOOPX_BIN: loopxBin,
    LOOPX_PROJECT_ROOT: projectRoot,
    LOOPX_WORKFLOW: workflowName,
    PATH: (() => {
      const pathEntries = currentPath.split(":");
      const prepend: string[] = [];
      if (!pathEntries.includes(LOOPX_NESTED_BIN_DIR)) {
        prepend.push(LOOPX_NESTED_BIN_DIR);
      }
      if (!pathEntries.includes(LOOPX_FLAT_BIN_DIR)) {
        prepend.push(LOOPX_FLAT_BIN_DIR);
      }
      return prepend.length === 0
        ? currentPath
        : `${prepend.join(":")}:${currentPath}`;
    })(),
    NODE_PATH: currentNodePath
      ? `${LOOPX_NODE_PATH}:${currentNodePath}`
      : LOOPX_NODE_PATH,
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

  return new Promise<ExecResult>((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError(signal));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      env: scriptEnv,
      stdio: ["pipe", "pipe", "inherit"],
      detached: true,
    });

    let stdout = "";
    let aborted = false;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stdin.on("error", () => {});
    if (input !== undefined && input !== "") {
      child.stdin.write(input);
    }
    child.stdin.end();

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
      reject(err);
    });
  });
}
