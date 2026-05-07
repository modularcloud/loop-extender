import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile, mkdir, symlink, rm, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// apps/tests/tests/helpers → walk up three levels to the repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const LOOPX_PACKAGE_ROOT = resolve(REPO_ROOT, "packages/loop-extender");

export interface APIDriverResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface APIDriverOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
}

export interface LiveAPIDriverHandle {
  child: ChildProcessWithoutNullStreams;
  writeStdin(data: string): void;
  waitForStderr(pattern: string | RegExp, timeout?: number): Promise<void>;
  waitForExit(timeout?: number): Promise<APIDriverResult>;
}

async function createConsumerDriver(code: string): Promise<{
  consumerDir: string;
  driverPath: string;
}> {
  const consumerDir = await mkdtemp(join(tmpdir(), "loopx-api-driver-"));

  await writeFile(
    join(consumerDir, "package.json"),
    JSON.stringify({ type: "module", name: "loopx-api-driver" }),
    "utf-8"
  );

  const nodeModulesDir = join(consumerDir, "node_modules");
  await mkdir(nodeModulesDir, { recursive: true });

  const candidates = [
    LOOPX_PACKAGE_ROOT,
    resolve(REPO_ROOT, "node_modules", "loopx"),
    resolve(process.cwd(), "dist"),
    resolve(process.cwd()),
    join(process.cwd(), "node_modules", "loopx"),
  ];

  let linked = false;
  for (const candidate of candidates) {
    try {
      await access(join(candidate, "package.json"));
      await symlink(candidate, join(nodeModulesDir, "loopx"), "dir");
      linked = true;
      break;
    } catch {
      // candidate doesn't have a package.json or symlink failed, try next
    }
  }

  if (!linked) {
    // If nothing worked, the driver will fail at import time.
  }

  const driverPath = join(consumerDir, "driver.ts");
  await writeFile(driverPath, code, "utf-8");

  return { consumerDir, driverPath };
}

/**
 * Spawns a driver script under the specified runtime that imports from the
 * loopx package, runs the provided code string, and prints JSON results to stdout.
 *
 * Creates a temporary consumer directory with a package.json and a symlinked
 * node_modules/loopx pointing to the build output. This ensures that
 * `import { run } from "loopx"` exercises the actual package exports.
 */
export async function runAPIDriver(
  runtime: "node" | "bun",
  code: string,
  options: APIDriverOptions = {}
): Promise<APIDriverResult> {
  const { cwd, env: extraEnv = {}, timeout = 30_000 } = options;

  const runtimeEnvAssignments: string[] = [];
  let childOnlyEnv = { ...extraEnv };
  if (runtime === "node" && Object.prototype.hasOwnProperty.call(childOnlyEnv, "TMPDIR")) {
    if (childOnlyEnv.TMPDIR === undefined) {
      runtimeEnvAssignments.push("delete process.env.TMPDIR;");
    } else {
      runtimeEnvAssignments.push(
        `process.env.TMPDIR = ${JSON.stringify(childOnlyEnv.TMPDIR)};`
      );
    }
    delete childOnlyEnv.TMPDIR;
  }

  const effectiveCode =
    runtimeEnvAssignments.length > 0
      ? `${runtimeEnvAssignments.join("\n")}\n${code}`
      : code;

  const { consumerDir, driverPath } = await createConsumerDriver(effectiveCode);

  try {
    // Spawn the driver. Under Node, invoke the repo's own `tsx` binary by
    // absolute path rather than via `npx tsx`: with npm 11+, `npx` refuses
    // to auto-install a missing package when the cwd already has a
    // `node_modules/` directory, and consumer dirs here always do (for the
    // `loopx` symlink). Resolving tsx via an absolute path sidesteps that
    // quirk and makes the driver's runtime independent of the consumer's
    // own tsx installation state.
    const command = runtime === "bun"
      ? "bun"
      : resolve(REPO_ROOT, "node_modules", ".bin", "tsx");
    const args = [driverPath];

    const mergedEnv = { ...process.env };
    for (const [key, value] of Object.entries(childOnlyEnv)) {
      if (value === undefined) {
        delete mergedEnv[key];
      } else {
        mergedEnv[key] = value;
      }
    }

    return await new Promise<APIDriverResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: cwd ?? consumerDir,
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

      child.stdin.end();

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`API driver timed out after ${timeout}ms`));
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    await rm(consumerDir, { recursive: true, force: true });
  }
}

export async function runAPIDriverLive(
  runtime: "node" | "bun",
  code: string,
  options: APIDriverOptions = {}
): Promise<LiveAPIDriverHandle> {
  const { cwd, env: extraEnv = {}, timeout = 30_000 } = options;
  const { consumerDir, driverPath } = await createConsumerDriver(code);
  const command = runtime === "bun"
    ? "bun"
    : resolve(REPO_ROOT, "node_modules", ".bin", "tsx");
  const mergedEnv = { ...process.env };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) {
      delete mergedEnv[key];
    } else {
      mergedEnv[key] = value;
    }
  }
  const child = spawn(command, [driverPath], {
    cwd: cwd ?? consumerDir,
    env: mergedEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let settled: APIDriverResult | null = null;
  let settledError: Error | null = null;

  const stderrWaiters: Array<{
    pattern: string | RegExp;
    resolve(): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }> = [];

  function matches(pattern: string | RegExp, text: string): boolean {
    return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
  }

  function flushStderrWaiters() {
    for (let index = stderrWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = stderrWaiters[index]!;
      if (matches(waiter.pattern, stderr)) {
        clearTimeout(waiter.timer);
        stderrWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  const exitPromise = new Promise<APIDriverResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`API driver timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      flushStderrWaiters();
    });

    child.on("close", async (code) => {
      clearTimeout(timer);
      for (const waiter of stderrWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`API driver exited before stderr matched ${String(waiter.pattern)}. stderr: ${stderr}`));
      }
      await rm(consumerDir, { recursive: true, force: true }).catch(() => {});
      settled = { exitCode: code ?? 1, stdout, stderr };
      resolve(settled);
    });

    child.on("error", async (error) => {
      clearTimeout(timer);
      for (const waiter of stderrWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      await rm(consumerDir, { recursive: true, force: true }).catch(() => {});
      settledError = error;
      reject(error);
    });
  });

  return {
    child,
    writeStdin(data: string) {
      child.stdin.write(data);
      child.stdin.end();
    },
    waitForStderr(pattern: string | RegExp, waitTimeout = timeout) {
      if (matches(pattern, stderr)) return Promise.resolve();
      if (settled) {
        return Promise.reject(new Error(`API driver already exited before stderr matched ${String(pattern)}. stderr: ${stderr}`));
      }
      if (settledError) return Promise.reject(settledError);
      return new Promise<void>((resolveWaiter, rejectWaiter) => {
        const timer = setTimeout(() => {
          const index = stderrWaiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) stderrWaiters.splice(index, 1);
          rejectWaiter(new Error(`Timed out waiting for stderr to match ${String(pattern)}. stderr: ${stderr}`));
        }, waitTimeout);
        stderrWaiters.push({
          pattern,
          resolve: resolveWaiter,
          reject: rejectWaiter,
          timer,
        });
      });
    },
    waitForExit(waitTimeout = timeout) {
      if (settled) return Promise.resolve(settled);
      if (settledError) return Promise.reject(settledError);
      return Promise.race([
        exitPromise,
        new Promise<APIDriverResult>((_, reject) => {
          setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`Timed out waiting for API driver exit after ${waitTimeout}ms`));
          }, waitTimeout);
        }),
      ]);
    },
  };
}
