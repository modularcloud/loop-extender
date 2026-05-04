import { writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Writes a well-formed .env file with KEY=VALUE lines.
 */
export async function createEnvFile(
  path: string,
  vars: Record<string, string>
): Promise<void> {
  const lines = Object.entries(vars).map(([key, value]) => `${key}=${value}`);
  await writeFile(path, lines.join("\n") + "\n", "utf-8");
}

/**
 * Writes raw text to a file with no transformation.
 * For testing malformed env content.
 */
export async function writeEnvFileRaw(
  path: string,
  content: string
): Promise<void> {
  await writeFile(path, content, "utf-8");
}

/**
 * Sets XDG_CONFIG_HOME to a temp directory, writes a global env file
 * with the given vars, runs fn, then cleans up.
 */
export async function withGlobalEnv(
  vars: Record<string, string>,
  fn: () => Promise<void>
): Promise<void> {
  const tempConfigHome = await mkdtemp(join(tmpdir(), "loopx-config-"));
  const loopxConfigDir = join(tempConfigHome, "loopx");
  await mkdir(loopxConfigDir, { recursive: true });

  const envFilePath = join(loopxConfigDir, "env");
  await createEnvFile(envFilePath, vars);

  const originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempConfigHome;

  try {
    await fn();
  } finally {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    await rm(tempConfigHome, { recursive: true, force: true });
  }
}

/**
 * Sets XDG_CONFIG_HOME to a temp directory, writes a global env file with
 * raw verbatim content (no key/value transformation), runs fn, then cleans up.
 *
 * Use this when the test needs to seed the global env file with
 * intentionally-malformed content (invalid keys, lines without `=`, etc.) to
 * exercise parser-warning paths. Plain `withGlobalEnv` writes through
 * `createEnvFile` which composes well-formed `KEY=VALUE` lines from a record.
 */
export async function withGlobalEnvRawContent(
  rawContent: string,
  fn: () => Promise<void>
): Promise<void> {
  const tempConfigHome = await mkdtemp(join(tmpdir(), "loopx-config-"));
  const loopxConfigDir = join(tempConfigHome, "loopx");
  await mkdir(loopxConfigDir, { recursive: true });

  const envFilePath = join(loopxConfigDir, "env");
  await writeEnvFileRaw(envFilePath, rawContent);

  const originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempConfigHome;

  try {
    await fn();
  } finally {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    await rm(tempConfigHome, { recursive: true, force: true });
  }
}

/**
 * Sets HOME to a temp directory and optionally unsets XDG_CONFIG_HOME,
 * then runs fn, then restores.
 */
export async function withIsolatedHome(
  fn: () => Promise<void>
): Promise<void> {
  const tempHome = await mkdtemp(join(tmpdir(), "loopx-home-"));

  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  process.env.HOME = tempHome;
  delete process.env.XDG_CONFIG_HOME;

  try {
    await fn();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    await rm(tempHome, { recursive: true, force: true });
  }
}
