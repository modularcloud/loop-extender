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
  waitForStderr: (pattern: string | RegExp, opts?: { timeoutMs?: number }) => Promise<void>;
  waitForStdout: (pattern: string | RegExp, opts?: { timeoutMs?: number }) => Promise<void>;
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
  const stderrListeners: Array<{ pattern: string | RegExp; resolve: () => void; reject: (err: Error) => void }> = [];
  const stdoutListeners: Array<{ pattern: string | RegExp; resolve: () => void; reject: (err: Error) => void }> = [];

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    for (let i = stdoutListeners.length - 1; i >= 0; i--) {
      const listener = stdoutListeners[i];
      const matches =
        typeof listener.pattern === "string"
          ? stdout.includes(listener.pattern)
          : listener.pattern.test(stdout);
      if (matches) {
        stdoutListeners.splice(i, 1);
        listener.resolve();
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
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
      childExited = true;
      for (const listener of stderrListeners) {
        listener.reject(
          new Error(
            `Child exited (code=${code}, signal=${signal}) before stderr matched pattern: ${listener.pattern}`
          )
        );
      }
      stderrListeners.length = 0;
      for (const listener of stdoutListeners) {
        listener.reject(
          new Error(
            `Child exited (code=${code}, signal=${signal}) before stdout matched pattern: ${listener.pattern}`
          )
        );
      }
      stdoutListeners.length = 0;
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

  function waitForPattern(
    bufferGetter: () => string,
    listeners: typeof stderrListeners,
    streamName: "stdout" | "stderr",
    pattern: string | RegExp,
    opts?: { timeoutMs?: number }
  ): Promise<void> {
    const matches =
      typeof pattern === "string"
        ? bufferGetter().includes(pattern)
        : pattern.test(bufferGetter());
    if (matches) {
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
      const entry = {
        pattern,
        resolve: () => {
          if (timer) clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      };
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (opts?.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const idx = listeners.indexOf(entry);
          if (idx >= 0) listeners.splice(idx, 1);
          reject(
            new Error(
              `Timed out after ${opts.timeoutMs}ms waiting for ${streamName} pattern: ${pattern}`
            )
          );
        }, opts.timeoutMs);
      }
      listeners.push(entry);
    });
  }

  function waitForStderr(
    pattern: string | RegExp,
    opts?: { timeoutMs?: number }
  ): Promise<void> {
    return waitForPattern(() => stderr, stderrListeners, "stderr", pattern, opts);
  }

  function waitForStdout(
    pattern: string | RegExp,
    opts?: { timeoutMs?: number }
  ): Promise<void> {
    return waitForPattern(() => stdout, stdoutListeners, "stdout", pattern, opts);
  }

  return { result, sendSignal, waitForStderr, waitForStdout };
}
