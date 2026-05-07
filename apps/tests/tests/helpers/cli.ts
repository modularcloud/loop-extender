import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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
 * Reads the loopx package.json bin field to find the actual JS file,
 * avoiding the shell shim at node_modules/.bin/loopx which cannot
 * be spawned via `node`.
 */
function getLoopxBinPath(): string {
  // Try to resolve the actual JS entry point from the loopx package
  try {
    const pkgPath = resolve(process.cwd(), "node_modules/loopx/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.loopx;
    if (bin) {
      return resolve(process.cwd(), "node_modules/loopx", bin);
    }
  } catch {
    // loopx not installed yet
  }
  // Fallback: assume bin.js at package root
  return resolve(process.cwd(), "node_modules/loopx/bin.js");
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

export function runCLIWithSignal(
  args: string[],
  options: CLIOptions = {}
): {
  result: Promise<CLIResult>;
  sendSignal: (signal: NodeJS.Signals) => void;
  waitForStderr: (
    pattern: string | RegExp,
    options?: { timeoutMs?: number },
  ) => Promise<void>;
  waitForStdout: (
    pattern: string | RegExp,
    options?: { timeoutMs?: number },
  ) => Promise<void>;
} {
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
  let childExited = false;
  const stdoutListeners: Array<{
    pattern: string | RegExp;
    resolve: () => void;
    reject: (err: Error) => void;
    timer?: NodeJS.Timeout;
  }> = [];
  const stderrListeners: Array<{
    pattern: string | RegExp;
    resolve: () => void;
    reject: (err: Error) => void;
    timer?: NodeJS.Timeout;
  }> = [];

  function matchesPattern(buffer: string, pattern: string | RegExp): boolean {
    return typeof pattern === "string"
      ? buffer.includes(pattern)
      : pattern.test(buffer);
  }

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    for (let i = stdoutListeners.length - 1; i >= 0; i--) {
      const listener = stdoutListeners[i];
      if (matchesPattern(stdout, listener.pattern)) {
        stdoutListeners.splice(i, 1);
        if (listener.timer) clearTimeout(listener.timer);
        listener.resolve();
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    // Check if any waiting pattern has been matched
    for (let i = stderrListeners.length - 1; i >= 0; i--) {
      const listener = stderrListeners[i];
      if (matchesPattern(stderr, listener.pattern)) {
        stderrListeners.splice(i, 1);
        if (listener.timer) clearTimeout(listener.timer);
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
      childExited = true;
      for (const listener of stdoutListeners) {
        if (listener.timer) clearTimeout(listener.timer);
        listener.reject(
          new Error(
            `Child exited (code=${code}, signal=${signal}) before stdout matched pattern: ${listener.pattern}`
          )
        );
      }
      stdoutListeners.length = 0;
      // Reject any pending stderr listeners — the pattern will never match
      for (const listener of stderrListeners) {
        if (listener.timer) clearTimeout(listener.timer);
        listener.reject(
          new Error(
            `Child exited (code=${code}, signal=${signal}) before stderr matched pattern: ${listener.pattern}`
          )
        );
      }
      stderrListeners.length = 0;
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

  function waitForOutput(
    streamName: "stdout" | "stderr",
    buffer: () => string,
    listeners: typeof stdoutListeners,
    pattern: string | RegExp,
    waitOptions: { timeoutMs?: number } = {},
  ): Promise<void> {
    // Check if already matched
    if (matchesPattern(buffer(), pattern)) {
      return Promise.resolve();
    }

    if (childExited) {
      return Promise.reject(
        new Error(
          `Child already exited before ${streamName} matched pattern: ${pattern}`
        )
      );
    }

    return new Promise<void>((resolve, reject) => {
      const listener: (typeof listeners)[number] = { pattern, resolve, reject };
      if (waitOptions.timeoutMs !== undefined) {
        listener.timer = setTimeout(() => {
          const index = listeners.indexOf(listener);
          if (index !== -1) listeners.splice(index, 1);
          reject(
            new Error(
              `Timed out after ${waitOptions.timeoutMs}ms waiting for ${streamName} pattern: ${pattern}`
            )
          );
        }, waitOptions.timeoutMs);
      }
      listeners.push(listener);
    });
  }

  function waitForStderr(
    pattern: string | RegExp,
    waitOptions?: { timeoutMs?: number },
  ): Promise<void> {
    return waitForOutput("stderr", () => stderr, stderrListeners, pattern, waitOptions);
  }

  function waitForStdout(
    pattern: string | RegExp,
    waitOptions?: { timeoutMs?: number },
  ): Promise<void> {
    return waitForOutput("stdout", () => stdout, stdoutListeners, pattern, waitOptions);
  }

  return { result, sendSignal, waitForStderr, waitForStdout };
}
