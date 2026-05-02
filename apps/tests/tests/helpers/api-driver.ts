import { spawn } from "node:child_process";
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

    // Create node_modules/loopx symlink pointing to the actual loopx package.
    // Since this IS the loopx project, we try several resolution strategies:
    //   1. A build output directory (e.g. dist/) if it exists
    //   2. The project root itself (process.cwd()), which should contain package.json with exports
    //   3. A node_modules/loopx path as a last resort (e.g. when consumed as a dependency)
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
      // If nothing worked, the driver will fail at import time
      // which is the expected behavior for pre-implementation testing
    }

    // Decouple the spawned tooling's TMPDIR from the loopx-perceived TMPDIR.
    // tsx's IPC server / file cache does an eager `mkdirSync` against
    // `${TMPDIR}/tsx-${UID}` at module-load time, so an unwritable TMPDIR
    // (which several tmpdir tests rely on) crashes tsx before the driver
    // body runs. Strip TMPDIR from the spawned child's env (tsx then
    // inherits the harness's writable /tmp) and inject a prefix that resets
    // `process.env.TMPDIR` to the test-intended value at the top of the
    // driver body. loopx reads `os.tmpdir()` lazily at run() / runPromise()
    // call sites and inside `runLoop`, all of which execute after the
    // prefix, so loopx still observes the test's intended TMPDIR.
    const cleanedExtraEnv: Record<string, string> = { ...extraEnv };
    const intendedTmpdir = cleanedExtraEnv.TMPDIR;
    if (intendedTmpdir !== undefined) {
      delete cleanedExtraEnv.TMPDIR;
    }
    const tmpdirPrefix =
      intendedTmpdir !== undefined
        ? `process.env.TMPDIR = ${JSON.stringify(intendedTmpdir)};\n`
        : "";

    // Write the driver script
    const driverPath = join(consumerDir, "driver.ts");
    await writeFile(driverPath, tmpdirPrefix + code, "utf-8");

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

    const mergedEnv = {
      ...process.env,
      ...cleanedExtraEnv,
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
