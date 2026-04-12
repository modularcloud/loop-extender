import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
  renameSync,
} from "node:fs";
import { join, basename, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { classifySource } from "./parsers/classify-source.js";
import {
  discoverScripts,
  SUPPORTED_EXTENSIONS,
  NAME_PATTERN,
} from "./discovery.js";
import { validateDirScriptCore } from "./validate-dir-script.js";

export async function installCommand(
  source: string,
  cwd: string
): Promise<void> {
  // Check for org/repo.git rejection
  if (
    !source.includes("://") &&
    !source.startsWith("git@") &&
    source.split("/").length === 2
  ) {
    const parts = source.split("/");
    if (parts[1].endsWith(".git")) {
      process.stderr.write(
        `Error: org/repo.git shorthand is not supported. Use the full URL: https://github.com/${parts[0]}/${parts[1]}\n`
      );
      process.exit(1);
    }
  }

  const { type, url } = classifySource(source);
  const loopxDir = join(cwd, ".loopx");
  mkdirSync(loopxDir, { recursive: true });

  switch (type) {
    case "single-file":
      await installSingleFile(url, loopxDir);
      break;
    case "git":
      await installGit(url, source, loopxDir);
      break;
    case "tarball":
      await installTarball(url, loopxDir);
      break;
  }
}

function deriveFilenameFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return basename(parsed.pathname);
  } catch {
    return basename(rawUrl);
  }
}

function deriveArchiveNameFromUrl(rawUrl: string): string {
  const filename = deriveFilenameFromUrl(rawUrl);
  return filename.replace(/\.(tar\.gz|tgz)$/, "");
}

function deriveRepoName(url: string, source: string): string {
  // For SSH URLs: git@host:org/repo.git
  if (source.startsWith("git@")) {
    const match = source.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
    const colonMatch = source.match(/:.*\/([^/]+?)(?:\.git)?$/);
    if (colonMatch) return colonMatch[1];
  }

  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    let last = segments[segments.length - 1] || "repo";
    if (last.endsWith(".git")) {
      last = last.slice(0, -4);
    }
    return last;
  } catch {
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : "repo";
  }
}

function validateName(name: string): string | null {
  if (!NAME_PATTERN.test(name)) {
    return `Script name '${name}' is invalid: must match [a-zA-Z0-9_][a-zA-Z0-9_-]*`;
  }
  return null;
}

function checkCollisions(
  name: string,
  destPath: string,
  loopxDir: string
): string | null {
  // Destination path collision
  if (existsSync(destPath)) {
    return `Destination already exists: ${basename(destPath)}`;
  }

  // Script name collision (check all candidates, including pre-existing collisions)
  const discovery = discoverScripts(loopxDir, "help");
  if (discovery.candidateNames.has(name)) {
    return `Script name '${name}' already exists in .loopx/`;
  }

  return null;
}

function validateInstalledDirScript(dirPath: string, name: string): string | null {
  const result = validateDirScriptCore(dirPath);
  if (result.valid) return null;

  const errorMap: Record<string, string> = {
    "no-pkg": `${name}: package.json not found or unreadable`,
    "unreadable": `${name}: package.json not found or unreadable`,
    "invalid-json": `${name}: package.json is invalid JSON`,
    "invalid-object": `${name}: package.json is not a valid object`,
    "no-main": `${name}: package.json missing valid 'main' field`,
    "bad-main-type": `${name}: package.json missing valid 'main' field`,
    "bad-ext": `${name}: unsupported extension '${result.detail}' for main entry`,
    "escapes": `${name}: main field escapes directory boundary`,
    "not-found": `${name}: main entry '${result.detail}' not found`,
    "not-file": `${name}: main entry '${result.detail}' not found`,
    "symlink-escape": `${name}: main field resolves outside directory boundary (symlink)`,
    "resolve-failed": `${name}: main entry cannot be resolved`,
  };

  return errorMap[result.code] || `${name}: validation failed`;
}

async function downloadUrl(
  url: string
): Promise<{ data: Buffer; ok: boolean; status: number }> {
  // Handle file:// URLs
  if (url.startsWith("file://")) {
    try {
      const filePath = url.replace(/^file:\/\//, "");
      const data = readFileSync(filePath);
      return { data: Buffer.from(data), ok: true, status: 200 };
    } catch {
      return { data: Buffer.alloc(0), ok: false, status: 404 };
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    return {
      data: Buffer.alloc(0),
      ok: false,
      status: response.status,
    };
  }
  const data = Buffer.from(await response.arrayBuffer());
  return { data, ok: true, status: response.status };
}

async function installSingleFile(
  url: string,
  loopxDir: string
): Promise<void> {
  const filename = deriveFilenameFromUrl(url);
  const ext = extname(filename);

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    process.stderr.write(
      `Error: unsupported file extension '${ext}'\n`
    );
    process.exit(1);
  }

  const name = basename(filename, ext);
  const nameError = validateName(name);
  if (nameError) {
    process.stderr.write(`Error: ${nameError}\n`);
    process.exit(1);
  }

  const destPath = join(loopxDir, filename);
  const collisionError = checkCollisions(name, destPath, loopxDir);
  if (collisionError) {
    process.stderr.write(`Error: ${collisionError}\n`);
    process.exit(1);
  }

  // Download
  let result: { data: Buffer; ok: boolean; status: number };
  try {
    result = await downloadUrl(url);
  } catch (err: unknown) {
    process.stderr.write(
      `Error: failed to download ${url}: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
    return;
  }

  if (!result.ok) {
    process.stderr.write(
      `Error: HTTP ${result.status} downloading ${url}\n`
    );
    process.exit(1);
  }

  try {
    writeFileSync(destPath, result.data);
  } catch (err: unknown) {
    try {
      rmSync(destPath, { force: true });
    } catch {}
    process.stderr.write(
      `Error: failed to write ${filename}: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

async function installGit(
  url: string,
  source: string,
  loopxDir: string
): Promise<void> {
  const repoName = deriveRepoName(url, source);
  const nameError = validateName(repoName);
  if (nameError) {
    process.stderr.write(`Error: ${nameError}\n`);
    process.exit(1);
  }

  const destPath = join(loopxDir, repoName);
  const collisionError = checkCollisions(repoName, destPath, loopxDir);
  if (collisionError) {
    process.stderr.write(`Error: ${collisionError}\n`);
    process.exit(1);
  }

  try {
    execFileSync("git", ["clone", "--depth", "1", url, destPath], {
      stdio: "pipe",
    });
  } catch (err: unknown) {
    try {
      rmSync(destPath, { recursive: true, force: true });
    } catch {}
    const stderr = (err as { stderr?: Buffer })?.stderr;
    const detail = stderr ? stderr.toString().trim() : "";
    process.stderr.write(
      `Error: git clone failed for ${url}${detail ? `\n${detail}` : ""}\n`
    );
    process.exit(1);
  }

  // Validate directory script
  const validationError = validateInstalledDirScript(destPath, repoName);
  if (validationError) {
    rmSync(destPath, { recursive: true, force: true });
    process.stderr.write(`Error: ${validationError}\n`);
    process.exit(1);
  }
}

async function installTarball(
  url: string,
  loopxDir: string
): Promise<void> {
  const archiveName = deriveArchiveNameFromUrl(url);
  const nameError = validateName(archiveName);
  if (nameError) {
    process.stderr.write(`Error: ${nameError}\n`);
    process.exit(1);
  }

  const destPath = join(loopxDir, archiveName);
  const collisionError = checkCollisions(archiveName, destPath, loopxDir);
  if (collisionError) {
    process.stderr.write(`Error: ${collisionError}\n`);
    process.exit(1);
  }

  // Download tarball
  let result: { data: Buffer; ok: boolean; status: number };
  try {
    result = await downloadUrl(url);
  } catch (err: unknown) {
    process.stderr.write(
      `Error: failed to download ${url}: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
    return;
  }

  if (!result.ok) {
    process.stderr.write(
      `Error: HTTP ${result.status} downloading ${url}\n`
    );
    process.exit(1);
  }

  // Extract to temp dir
  const tmpDir = join(loopxDir, `.tmp-${archiveName}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    const tarPath = join(tmpDir, "archive.tar.gz");
    writeFileSync(tarPath, result.data);

    try {
      execFileSync("tar", ["xzf", tarPath, "-C", tmpDir], {
        stdio: "pipe",
      });
    } catch (err: unknown) {
      const stderr = (err as { stderr?: Buffer })?.stderr;
      const detail = stderr ? stderr.toString().trim() : "";
      throw new Error(
        `Failed to extract tarball${detail ? `: ${detail}` : ""}`
      );
    }

    // Determine top-level entries (excluding the archive file)
    const entries = readdirSync(tmpDir).filter(
      (e) => e !== "archive.tar.gz"
    );

    if (entries.length === 0) {
      throw new Error("archive is empty");
    }

    if (
      entries.length === 1 &&
      statSync(join(tmpDir, entries[0])).isDirectory()
    ) {
      // Single top-level dir: unwrap
      renameSync(join(tmpDir, entries[0]), destPath);
    } else {
      // Multiple entries: move all to dest
      mkdirSync(destPath, { recursive: true });
      for (const entry of entries) {
        renameSync(join(tmpDir, entry), join(destPath, entry));
      }
    }
  } catch (err: unknown) {
    try {
      rmSync(destPath, { recursive: true, force: true });
    } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
    process.stderr.write(
      `Error: failed to extract tarball: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  // Validate directory script
  const validationError = validateInstalledDirScript(destPath, archiveName);
  if (validationError) {
    rmSync(destPath, { recursive: true, force: true });
    process.stderr.write(`Error: ${validationError}\n`);
    process.exit(1);
  }
}
