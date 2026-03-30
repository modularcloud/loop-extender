import { mkdtemp, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface TempProject {
  dir: string;
  loopxDir: string;
  cleanup(): Promise<void>;
}

export async function createTempProject(
  options: { withLoopxDir?: boolean } = {}
): Promise<TempProject> {
  const { withLoopxDir = true } = options;
  const dir = await mkdtemp(join(tmpdir(), "loopx-test-"));
  const loopxDir = join(dir, ".loopx");

  if (withLoopxDir) {
    await mkdir(loopxDir, { recursive: true });
  }

  return {
    dir,
    loopxDir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function createScript(
  project: TempProject,
  name: string,
  ext: string,
  content: string
): Promise<string> {
  const filename = `${name}${ext}`;
  const filePath = join(project.loopxDir, filename);
  await writeFile(filePath, content, "utf-8");

  if (ext === ".sh") {
    await chmod(filePath, 0o755);
  }

  return filePath;
}

export async function createDirScript(
  project: TempProject,
  name: string,
  main: string,
  files: Record<string, string>
): Promise<string> {
  const scriptDir = join(project.loopxDir, name);
  await mkdir(scriptDir, { recursive: true });

  const packageJson = JSON.stringify({ main }, null, 2);
  await writeFile(join(scriptDir, "package.json"), packageJson, "utf-8");

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(scriptDir, filePath);
    const parentDir = join(fullPath, "..");
    await mkdir(parentDir, { recursive: true });
    await writeFile(fullPath, content, "utf-8");

    if (filePath.endsWith(".sh")) {
      await chmod(fullPath, 0o755);
    }
  }

  return scriptDir;
}

export async function createBashScript(
  project: TempProject,
  name: string,
  body: string
): Promise<string> {
  const content = `#!/bin/bash\n${body}\n`;
  return createScript(project, name, ".sh", content);
}
