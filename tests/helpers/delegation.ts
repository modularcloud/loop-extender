import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, mkdir, chmod, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { CLIResult, CLIOptions } from "./cli.js";

export interface DelegationFixture {
  projectDir: string;
  globalBinPath: string;
  localBinPath: string;
  loopxBinJs: string;
  runGlobal(args: string[], options?: Partial<CLIOptions>): Promise<CLIResult>;
  cleanup(): Promise<void>;
}

/**
 * Resolve the path to the real loopx bin.js entry point.
 * This is the actual binary that implements delegation logic.
 * If loopx is not installed, the path will point to a non-existent file,
 * causing tests to fail as expected (no implementation yet).
 */
function resolveLoopxBinJs(): string {
  try {
    const pkgPath = resolve(process.cwd(), "node_modules/loopx/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.loopx;
    if (bin) {
      return resolve(process.cwd(), "node_modules/loopx", bin);
    }
  } catch {
    // loopx not installed yet — return fallback path
  }
  return resolve(process.cwd(), "node_modules/loopx/bin.js");
}

/**
 * Provisions realistic delegation test fixtures.
 *
 * Creates:
 * - A project directory with `.loopx/`
 * - A "global" loopx binary — a bash wrapper that execs the REAL loopx
 *   binary via node. When loopx isn't installed, this binary will fail
 *   at runtime, causing delegation tests to fail as expected.
 * - A "local" loopx binary in `<project>/node_modules/.bin/loopx` —
 *   a symlink to the real binary (or a placeholder if not installed).
 *
 * `runGlobal()` spawns the global binary directly (NOT through runCLI),
 * exercising the real delegation and realpath resolution paths.
 */
export async function withDelegationSetup(
  options: {
    localVersion?: string;
    globalVersion?: string;
  } = {}
): Promise<DelegationFixture> {
  const baseDir = await mkdtemp(join(tmpdir(), "loopx-delegation-"));
  const projectDir = join(baseDir, "project");
  await mkdir(projectDir, { recursive: true });
  await mkdir(join(projectDir, ".loopx"), { recursive: true });

  const loopxBinJs = resolveLoopxBinJs();

  // Create a "global" loopx binary — a bash script that execs the real
  // loopx bin.js via node. This exercises the actual delegation logic.
  const globalBinDir = join(baseDir, "global", "bin");
  await mkdir(globalBinDir, { recursive: true });
  const globalBinPath = join(globalBinDir, "loopx");

  await writeFile(
    globalBinPath,
    `#!/bin/bash
exec node "${loopxBinJs}" "$@"
`,
    "utf-8"
  );
  await chmod(globalBinPath, 0o755);

  // Create local node_modules/.bin/loopx
  const localBinDir = join(projectDir, "node_modules", ".bin");
  await mkdir(localBinDir, { recursive: true });
  const localBinPath = join(localBinDir, "loopx");

  // Create a placeholder local binary. Tests always replace this with
  // marker/observer scripts, so a placeholder is appropriate here.
  // (We don't symlink to the real loopx because that creates a dangling
  // symlink when loopx isn't installed, which makes writeFile fail.)
  await writeFile(localBinPath, "#!/usr/bin/env node\n", "utf-8");
  await chmod(localBinPath, 0o755);

  return {
    projectDir,
    globalBinPath,
    localBinPath,
    loopxBinJs,
    async runGlobal(
      args: string[],
      cliOptions: Partial<CLIOptions> = {}
    ): Promise<CLIResult> {
      const {
        cwd = projectDir,
        env: extraEnv = {},
        timeout = 30_000,
        input,
      } = cliOptions;

      const mergedEnv = {
        ...process.env,
        ...extraEnv,
      };

      return new Promise<CLIResult>((resolvePromise, reject) => {
        const child = spawn(globalBinPath, args, {
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
        }
        child.stdin.end();

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Global binary timed out after ${timeout}ms`));
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
    },
    async cleanup() {
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}
