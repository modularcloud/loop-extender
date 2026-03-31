import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, accessSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScriptEntry } from "./discovery.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOADER_REGISTER_PATH = resolve(__dirname, "loader-register.js");

// Resolve tsx binary path from the loopx installation
function findTsx(): string {
  try {
    const req = createRequire(import.meta.url);
    const tsxPkgPath = req.resolve("tsx/package.json");
    const tsxPkg = JSON.parse(readFileSync(tsxPkgPath, "utf-8"));
    const bin =
      typeof tsxPkg.bin === "string" ? tsxPkg.bin : tsxPkg.bin?.tsx;
    if (bin) return resolve(dirname(tsxPkgPath), bin);
  } catch {}
  // Fallback: look in node_modules/.bin relative to our package
  const candidate = resolve(__dirname, "..", "node_modules", ".bin", "tsx");
  try {
    accessSync(candidate);
    return candidate;
  } catch {}
  return "tsx";
}

const TSX_PATH = findTsx();

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

  // NODE_PATH ensures require("loopx") works in CJS contexts (when tsx
  // transforms import to require for files without "type":"module").
  // The --import hook handles ESM resolution separately.
  const nodeModulesDir = resolve(__dirname, "..", "node_modules");

  const scriptEnv: Record<string, string> = {
    ...env,
    LOOPX_PROJECT_ROOT: projectRoot,
    LOOPX_BIN: loopxBin,
    NODE_PATH: env.NODE_PATH
      ? `${nodeModulesDir}:${env.NODE_PATH}`
      : nodeModulesDir,
  };

  let command: string;
  let args: string[];

  if (script.ext === ".sh") {
    command = "/bin/bash";
    args = [script.scriptPath];
  } else {
    command = process.execPath; // node
    args = [TSX_PATH, "--import", LOADER_REGISTER_PATH, script.scriptPath];
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
