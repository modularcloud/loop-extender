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
import { join, basename, extname, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { classifySource } from "./parsers/classify-source.js";
import { discoverScripts } from "./discovery.js";

const SUPPORTED_EXTENSIONS = new Set([".sh", ".js", ".jsx", ".ts", ".tsx"]);
const RESERVED_NAMES = new Set(["output", "env", "install", "version"]);
const NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

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
      await installSingleFile(url, loopxDir, cwd);
      break;
    case "git":
      await installGit(url, source, loopxDir, cwd);
      break;
    case "tarball":
      await installTarball(url, loopxDir, cwd);
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
    // Handle trailing slash
    if (!last && segments.length > 0) {
      last = segments[segments.length - 1];
    }
    return last;
  } catch {
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : "repo";
  }
}

function validateName(name: string): string | null {
  if (RESERVED_NAMES.has(name)) {
    return `Script name '${name}' is reserved`;
  }
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

  // Script name collision
  const discovery = discoverScripts(loopxDir, "help");
  if (discovery.scripts.has(name)) {
    return `Script name '${name}' already exists in .loopx/`;
  }

  return null;
}

function validateDirScript(dirPath: string, name: string): string | null {
  const pkgPath = join(dirPath, "package.json");

  let pkgContent: string;
  try {
    pkgContent = readFileSync(pkgPath, "utf-8");
  } catch {
    return `${name}: package.json not found or unreadable`;
  }

  let pkg: unknown;
  try {
    pkg = JSON.parse(pkgContent);
  } catch {
    return `${name}: package.json is invalid JSON`;
  }

  if (typeof pkg !== "object" || pkg === null) {
    return `${name}: package.json is not a valid object`;
  }

  const pkgObj = pkg as Record<string, unknown>;

  if (!("main" in pkgObj) || typeof pkgObj.main !== "string") {
    return `${name}: package.json missing valid 'main' field`;
  }

  const mainField = pkgObj.main;
  const mainExt = extname(mainField);

  if (!SUPPORTED_EXTENSIONS.has(mainExt)) {
    return `${name}: unsupported extension '${mainExt}' for main entry`;
  }

  const mainPath = resolve(dirPath, mainField);
  const relPath = relative(dirPath, mainPath);
  if (relPath.startsWith("..")) {
    return `${name}: main field escapes directory boundary`;
  }

  if (!existsSync(mainPath)) {
    return `${name}: main entry '${mainField}' not found`;
  }

  return null;
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
  loopxDir: string,
  cwd: string
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

  writeFileSync(destPath, result.data);
}

async function installGit(
  url: string,
  source: string,
  loopxDir: string,
  cwd: string
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
  } catch {
    try {
      rmSync(destPath, { recursive: true, force: true });
    } catch {}
    process.stderr.write(`Error: git clone failed for ${url}\n`);
    process.exit(1);
  }

  // Validate directory script
  const validationError = validateDirScript(destPath, repoName);
  if (validationError) {
    rmSync(destPath, { recursive: true, force: true });
    process.stderr.write(`Error: ${validationError}\n`);
    process.exit(1);
  }
}

async function installTarball(
  url: string,
  loopxDir: string,
  cwd: string
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
    } catch {
      throw new Error("Failed to extract tarball");
    }

    // Determine top-level entries (excluding the archive file)
    const entries = readdirSync(tmpDir).filter(
      (e) => e !== "archive.tar.gz"
    );

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
  const validationError = validateDirScript(destPath, archiveName);
  if (validationError) {
    rmSync(destPath, { recursive: true, force: true });
    process.stderr.write(`Error: ${validationError}\n`);
    process.exit(1);
  }
}
