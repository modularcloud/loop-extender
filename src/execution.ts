import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScriptEntry } from "./discovery.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOADER_REGISTER_PATH = resolve(__dirname, "loader-register.js");

// Add our node_modules/.bin to PATH so tsx is findable regardless of CWD
const LOOPX_BIN_DIR = resolve(__dirname, "..", "node_modules", ".bin");
const LOOPX_NODE_MODULES = resolve(__dirname, "..", "node_modules");

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
  const currentPath = env.PATH || process.env.PATH || "";
  const currentNodePath = env.NODE_PATH || "";

  const scriptEnv: Record<string, string> = {
    ...env,
    LOOPX_PROJECT_ROOT: projectRoot,
    LOOPX_BIN: loopxBin,
    PATH: currentPath.includes(LOOPX_BIN_DIR)
      ? currentPath
      : `${LOOPX_BIN_DIR}:${currentPath}`,
    NODE_PATH: currentNodePath
      ? `${LOOPX_NODE_MODULES}:${currentNodePath}`
      : LOOPX_NODE_MODULES,
  };

  let command: string;
  let args: string[];

  if (script.ext === ".sh") {
    command = "/bin/bash";
    args = [script.scriptPath];
  } else {
    command = "tsx";
    args = ["--import", LOADER_REGISTER_PATH, script.scriptPath];
  }

  return new Promise<ExecResult>((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason ||
          new DOMException("The operation was aborted.", "AbortError")
      );
      return;
    }

    const child = spawn(command, args, {
      cwd,
      env: scriptEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let aborted = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    if (input !== undefined && input !== "") {
      child.stdin.write(input);
    }
    child.stdin.end();

    const onAbort = () => {
      aborted = true;
      killProcessGroup(child, "SIGTERM");
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
        reject(
          signal?.reason ||
            new DOMException("The operation was aborted.", "AbortError")
        );
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
