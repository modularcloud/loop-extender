import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScriptEntry } from "./discovery.js";
import { makeAbortError } from "./abort.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOADER_REGISTER_PATH = resolve(__dirname, "loader-register.js");

// Detect Bun runtime — when running under Bun, use Bun's native TS/JSX
// support instead of tsx (Spec 6.3)
const isBun = !!process.versions.bun;

// Add our node_modules/.bin to PATH so tsx is findable regardless of CWD
const LOOPX_BIN_DIR = resolve(__dirname, "..", "node_modules", ".bin");
// NODE_PATH entries: loopx's own deps + parent dir (for global installs where
// the parent node_modules/ contains the loopx package itself)
const LOOPX_NODE_MODULES = resolve(__dirname, "..", "node_modules");
const LOOPX_PACKAGE_PARENT = resolve(__dirname, "..", "..");
const LOOPX_NODE_PATH = `${LOOPX_NODE_MODULES}:${LOOPX_PACKAGE_PARENT}`;

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

export interface ExecOptions {
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
  script: ScriptEntry,
  options: ExecOptions
): Promise<ExecResult> {
  const { projectRoot, loopxBin, env, input, signal } = options;

  const cwd = script.type === "directory" ? script.dirPath! : projectRoot;

  // Add loopx's node_modules/.bin to PATH so tsx is findable from any CWD.
  // Add NODE_PATH so require("loopx") works in CJS contexts (tsx transforms
  // import to require for files without "type":"module").
  const currentPath = env.PATH ?? process.env.PATH ?? "";
  const currentNodePath = env.NODE_PATH ?? "";

  const scriptEnv: Record<string, string> = {
    ...env,
    PATH: currentPath.split(":").includes(LOOPX_BIN_DIR)
      ? currentPath
      : `${LOOPX_BIN_DIR}:${currentPath}`,
    NODE_PATH: currentNodePath
      ? `${LOOPX_NODE_PATH}:${currentNodePath}`
      : LOOPX_NODE_PATH,
  };

  let command: string;
  let args: string[];

  if (script.ext === ".sh") {
    command = "/bin/bash";
    args = [script.scriptPath];
  } else if (isBun) {
    command = "bun";
    args = [script.scriptPath];
  } else {
    command = "tsx";
    args = ["--import", LOADER_REGISTER_PATH, script.scriptPath];
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
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    if (input !== undefined && input !== "") {
      child.stdin.write(input);
    }
    child.stdin.end();

    const onAbort = () => {
      aborted = true;
      // Forward the original signal if provided as abort reason (CLI path),
      // otherwise default to SIGTERM (programmatic API / AbortSignal path)
      const forwardSignal: NodeJS.Signals =
        signal?.reason === "SIGINT" || signal?.reason === "SIGTERM"
          ? signal.reason
          : "SIGTERM";
      killProcessGroup(child, forwardSignal);
      graceTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
      }, 5000);
      // Don't reject immediately — wait for child to actually exit.
      // The loop uses Promise.race with an abortPromise for fast detection.
      // The grace period (SIGTERM → 5s → SIGKILL) needs time to complete.
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("close", (code) => {
      if (graceTimer) clearTimeout(graceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);

      if (aborted) {
        reject(makeAbortError(signal));
      } else {
        resolvePromise({ stdout, exitCode: code ?? 1 });
      }
    });

    child.on("error", (err) => {
      if (graceTimer) clearTimeout(graceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}
