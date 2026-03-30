import { mkdtemp, writeFile, mkdir, symlink, chmod, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runCLI, type CLIResult, type CLIOptions } from "./cli.js";

export interface DelegationFixture {
  projectDir: string;
  globalBinPath: string;
  localBinPath: string;
  runGlobal(args: string[], options?: CLIOptions): Promise<CLIResult>;
  cleanup(): Promise<void>;
}

/**
 * Provisions realistic delegation test fixtures:
 * creates actual launcher files and symlinks in node_modules/.bin/loopx
 * within a temp project.
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

  // Create a "global" loopx binary
  const globalBinDir = join(baseDir, "global", "bin");
  await mkdir(globalBinDir, { recursive: true });
  const globalBinPath = join(globalBinDir, "loopx");

  // The global binary is a script that delegates to local if found.
  // For testing, we point it at the actual loopx bin.js (when it exists).
  const loopxBinJs = resolve(process.cwd(), "node_modules", ".bin", "loopx");
  await writeFile(
    globalBinPath,
    `#!/usr/bin/env node\nrequire("${loopxBinJs}");\n`,
    "utf-8"
  );
  await chmod(globalBinPath, 0o755);

  // Create local node_modules/.bin/loopx
  const localBinDir = join(projectDir, "node_modules", ".bin");
  await mkdir(localBinDir, { recursive: true });
  const localBinPath = join(localBinDir, "loopx");

  // Symlink local bin to the actual loopx binary
  try {
    await symlink(loopxBinJs, localBinPath);
  } catch {
    // If loopx is not installed, create a placeholder
    await writeFile(localBinPath, "#!/usr/bin/env node\n", "utf-8");
    await chmod(localBinPath, 0o755);
  }

  return {
    projectDir,
    globalBinPath,
    localBinPath,
    async runGlobal(args: string[], cliOptions?: CLIOptions) {
      return runCLI(args, {
        cwd: projectDir,
        ...cliOptions,
      });
    },
    async cleanup() {
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}
