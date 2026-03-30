import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface APIDriverResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface APIDriverOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
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

  // Create a temporary consumer directory
  const consumerDir = await mkdtemp(join(tmpdir(), "loopx-api-driver-"));

  try {
    // Create package.json for the consumer
    await writeFile(
      join(consumerDir, "package.json"),
      JSON.stringify({ type: "module", name: "loopx-api-driver" }),
      "utf-8"
    );

    // Create node_modules/loopx symlink pointing to the actual loopx package
    const nodeModulesDir = join(consumerDir, "node_modules");
    await mkdir(nodeModulesDir, { recursive: true });

    // The loopx package is expected to be installed as a dependency
    // or available at a known path. For now, symlink to wherever it is.
    const loopxPackagePath = join(process.cwd(), "node_modules", "loopx");
    try {
      await symlink(loopxPackagePath, join(nodeModulesDir, "loopx"), "dir");
    } catch {
      // If loopx is not installed yet, the driver will fail at import time
      // which is the expected behavior for pre-implementation testing
    }

    // Write the driver script
    const driverPath = join(consumerDir, "driver.ts");
    await writeFile(driverPath, code, "utf-8");

    // Spawn the driver
    const command = runtime === "bun" ? "bun" : "npx";
    const args = runtime === "bun" ? [driverPath] : ["tsx", driverPath];

    const mergedEnv = {
      ...process.env,
      ...extraEnv,
    };

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
