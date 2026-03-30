import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface CLIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: string | null;
}

export interface CLIOptions {
  cwd?: string;
  env?: Record<string, string>;
  runtime?: "node" | "bun";
  timeout?: number;
  input?: string;
}

/**
 * Resolve the path to the loopx binary entry point.
 * This assumes the loopx package will have a bin.js at its root.
 * For now, we use a placeholder path that will be configured when
 * the loopx implementation exists.
 */
function getLoopxBinPath(): string {
  // The loopx binary is expected to be at the root of the loopx package.
  // When the implementation exists, this will point to the actual bin.js.
  // For testing the harness itself, tests that need the CLI will need
  // the implementation to exist first.
  return resolve(process.cwd(), "node_modules/.bin/loopx");
}

export async function runCLI(
  args: string[],
  options: CLIOptions = {}
): Promise<CLIResult> {
  const {
    cwd = process.cwd(),
    env: extraEnv = {},
    runtime = "node",
    timeout = 30_000,
    input,
  } = options;

  const binPath = getLoopxBinPath();

  const command = runtime === "bun" ? "bun" : "node";
  const spawnArgs = [binPath, ...args];

  const mergedEnv = {
    ...process.env,
    ...extraEnv,
  };

  return new Promise<CLIResult>((resolvePromise, reject) => {
    const child = spawn(command, spawnArgs, {
      cwd,
      env: mergedEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeout}ms`));
    }, timeout);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 1,
        stdout,
        stderr,
        signal: signal ?? null,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export interface SignalCLIResult extends CLIResult {
  sendSignal(signal: NodeJS.Signals): void;
  waitForStderr(pattern: string | RegExp): Promise<void>;
}

export function runCLIWithSignal(
  args: string[],
  options: CLIOptions = {}
): { result: Promise<CLIResult>; sendSignal: (signal: NodeJS.Signals) => void; waitForStderr: (pattern: string | RegExp) => Promise<void> } {
  const {
    cwd = process.cwd(),
    env: extraEnv = {},
    runtime = "node",
    timeout = 30_000,
    input,
  } = options;

  const binPath = getLoopxBinPath();
  const command = runtime === "bun" ? "bun" : "node";
  const spawnArgs = [binPath, ...args];

  const mergedEnv = {
    ...process.env,
    ...extraEnv,
  };

  const child = spawn(command, spawnArgs, {
    cwd,
    env: mergedEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  const stderrListeners: Array<{ pattern: string | RegExp; resolve: () => void }> = [];

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    // Check if any waiting pattern has been matched
    for (let i = stderrListeners.length - 1; i >= 0; i--) {
      const listener = stderrListeners[i];
      const matches =
        typeof listener.pattern === "string"
          ? stderr.includes(listener.pattern)
          : listener.pattern.test(stderr);
      if (matches) {
        stderrListeners.splice(i, 1);
        listener.resolve();
      }
    }
  });

  if (input !== undefined) {
    child.stdin.write(input);
    child.stdin.end();
  } else {
    child.stdin.end();
  }

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeout);

  const result = new Promise<CLIResult>((resolvePromise, reject) => {
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 1,
        stdout,
        stderr,
        signal: signal ?? null,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  function sendSignal(signal: NodeJS.Signals) {
    child.kill(signal);
  }

  function waitForStderr(pattern: string | RegExp): Promise<void> {
    // Check if already matched
    const matches =
      typeof pattern === "string"
        ? stderr.includes(pattern)
        : pattern.test(stderr);
    if (matches) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      stderrListeners.push({ pattern, resolve });
    });
  }

  return { result, sendSignal, waitForStderr };
}
