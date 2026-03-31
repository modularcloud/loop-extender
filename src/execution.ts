import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScriptEntry } from "./discovery.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the loader registration module for --import
const LOADER_REGISTER_PATH = resolve(__dirname, "loader-register.js");

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

export function executeScript(
  script: ScriptEntry,
  options: ExecOptions
): Promise<ExecResult> {
  const { projectRoot, loopxBin, env, input, signal } = options;

  // Working directory
  const cwd =
    script.type === "directory" ? script.dirPath! : projectRoot;

  // Build environment
  const scriptEnv: Record<string, string> = {
    ...env,
    LOOPX_PROJECT_ROOT: projectRoot,
    LOOPX_BIN: loopxBin,
  };

  // Determine command and args based on extension
  let command: string;
  let args: string[];

  if (script.ext === ".sh") {
    command = "/bin/bash";
    args = [script.scriptPath];
  } else {
    // JS/TS: use tsx with --import for module resolution
    command = "tsx";
    args = ["--import", LOADER_REGISTER_PATH, script.scriptPath];
  }

  return new Promise<ExecResult>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: scriptEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    // Pass stderr through to parent
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    // Write input to stdin
    if (input !== undefined && input !== "") {
      child.stdin.write(input);
    }
    child.stdin.end();

    // Handle abort signal
    if (signal) {
      const onAbort = () => {
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => {
        signal.removeEventListener("abort", onAbort);
      });
    }

    child.on("close", (code) => {
      resolvePromise({
        stdout,
        exitCode: code ?? 1,
      });
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Execute a script and terminate with signal handling.
 * Returns the exec result, or the signal that killed it.
 */
export function executeScriptWithSignals(
  script: ScriptEntry,
  options: ExecOptions
): {
  result: Promise<ExecResult>;
  kill: (signal: NodeJS.Signals) => void;
  pid: () => number | undefined;
} {
  const { projectRoot, loopxBin, env, input } = options;

  const cwd =
    script.type === "directory" ? script.dirPath! : projectRoot;

  const scriptEnv: Record<string, string> = {
    ...env,
    LOOPX_PROJECT_ROOT: projectRoot,
    LOOPX_BIN: loopxBin,
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

  const child = spawn(command, args, {
    cwd,
    env: scriptEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  let stdout = "";

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

  const result = new Promise<ExecResult>((resolvePromise, reject) => {
    child.on("close", (code) => {
      resolvePromise({
        stdout,
        exitCode: code ?? 1,
      });
    });
    child.on("error", reject);
  });

  return {
    result,
    kill: (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already dead
        }
      }
    },
    pid: () => child.pid,
  };
}
