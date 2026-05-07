import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  symlinkSync,
  chmodSync,
  readlinkSync,
} from "node:fs";
import { writeFile, mkdir, rm, chmod, mkdtemp } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  createTempProject,
  createBashWorkflowScript,
  createWorkflowScript,
  createWorkflowPackageJson,
  createWorkflow,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI, runCLIWithSignal } from "../helpers/cli.js";
import {
  startLocalHTTPServer,
  startLocalGitServer,
  withGitURLRewrite,
  type HTTPServer,
  type GitServer,
} from "../helpers/servers.js";
import { forEachRuntime, isRuntimeAvailable } from "../helpers/runtime.js";

// ─────────────────────────────────────────────────────────────
// Root guard — permission-based tests are meaningless under root.
// ─────────────────────────────────────────────────────────────

const IS_ROOT = process.getuid?.() === 0;

// ─────────────────────────────────────────────────────────────
// Version helpers
// ─────────────────────────────────────────────────────────────

function getRunningVersion(): string {
  const pkgPath = resolve(process.cwd(), "node_modules/loopx/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version as string;
}

function unsatisfiedRange(): string {
  return ">=999.0.0";
}

// ─────────────────────────────────────────────────────────────
// Warning predicates — name-scoped, prose-tolerant
// ─────────────────────────────────────────────────────────────

function splitLines(s: string): string[] {
  return s.split("\n");
}

function hasVersionMismatchWarning(stderr: string, workflow: string): boolean {
  return splitLines(stderr).some(
    (line) =>
      line.includes(workflow) &&
      /(version|mismatch|range|satisf)/i.test(line),
  );
}

function countVersionMismatchWarnings(
  stderr: string,
  workflow: string,
): number {
  return splitLines(stderr).filter(
    (line) =>
      line.includes(workflow) &&
      /(version|mismatch|range|satisf)/i.test(line),
  ).length;
}

function hasInvalidJsonWarning(stderr: string, workflow: string): boolean {
  return splitLines(stderr).some(
    (line) =>
      line.includes(workflow) &&
      /(invalid.*json|parse|parsing|package\.json)/i.test(line),
  );
}

function countInvalidJsonWarnings(stderr: string, workflow: string): number {
  return splitLines(stderr).filter(
    (line) =>
      line.includes(workflow) &&
      /(invalid.*json|parse|parsing|package\.json)/i.test(line),
  ).length;
}

function hasInvalidSemverWarning(stderr: string, workflow: string): boolean {
  return splitLines(stderr).some(
    (line) =>
      line.includes(workflow) &&
      /(semver|range|not.*(valid|parse))/i.test(line),
  );
}

function countInvalidSemverWarnings(stderr: string, workflow: string): number {
  return splitLines(stderr).filter(
    (line) =>
      line.includes(workflow) && /(semver|range|invalid)/i.test(line),
  ).length;
}

function hasUnreadableWarning(stderr: string, workflow: string): boolean {
  return splitLines(stderr).some(
    (line) =>
      line.includes(workflow) &&
      /(unreadable|permission|EACCES|EPERM|cannot.*read|read.*fail|denied)/i.test(
        line,
      ),
  );
}

function countUnreadableWarnings(stderr: string, workflow: string): number {
  return splitLines(stderr).filter(
    (line) =>
      line.includes(workflow) &&
      /(unreadable|permission|EACCES|EPERM|cannot.*read|read.*fail|denied)/i.test(
        line,
      ),
  ).length;
}

function countNonRegularPackageJsonWarnings(
  stderr: string,
  workflow: string,
): number {
  return splitLines(stderr).filter(
    (line) =>
      line.includes(workflow) &&
      /package\.json/i.test(line) &&
      /(non[- ]?regular|directory|not.*file|expected.*file)/i.test(line),
  ).length;
}

function hasAnyPackageJsonWarning(stderr: string, workflow: string): boolean {
  return (
    hasInvalidJsonWarning(stderr, workflow) ||
    hasInvalidSemverWarning(stderr, workflow) ||
    hasUnreadableWarning(stderr, workflow) ||
    countNonRegularPackageJsonWarnings(stderr, workflow) > 0
  );
}

function hasWarningCategoryFor(stderr: string, subject: string): boolean {
  return splitLines(stderr).some(
    (line) =>
      /^\s*(warning|notice|advisory|deprecat|migration)/i.test(line) &&
      line.includes(subject),
  );
}

// ─────────────────────────────────────────────────────────────
// Tarball helpers — build .tar.gz in memory for HTTP serving
// ─────────────────────────────────────────────────────────────

type TarEntry = string | { content: string; mode?: number };

interface MakeTarballOpts {
  wrapperDir?: string;
  permissions?: Record<string, number>;
  /** Make the archive body itself invalid (e.g., truncated). */
  corrupt?: boolean;
  empty?: boolean;
}

async function makeTarball(
  files: Record<string, TarEntry>,
  opts: MakeTarballOpts = {},
): Promise<Buffer> {
  /**
   * Builds the archive via python3's tarfile module so each entry can carry
   * an arbitrary mode (including 0o000). Standard GNU tar as a non-root user
   * cannot read mode-000 source files, so it cannot be used for the unreadable
   * package.json fixtures required by the install spec.
   */
  const tmp = await mkdtemp(join(tmpdir(), "loopx-tar-"));
  try {
    const archivePath = join(tmp, "archive.tar.gz");

    type Entry = {
      name: string;
      mode: number;
      type: "file" | "dir";
      content?: string;
    };
    const entries: Entry[] = [];
    const pushDir = (dirPath: string) => {
      if (!dirPath || dirPath === "." || dirPath === "") return;
      if (entries.some((e) => e.name === dirPath && e.type === "dir")) return;
      const parent = dirPath.split("/").slice(0, -1).join("/");
      if (parent) pushDir(parent);
      entries.push({ name: dirPath, mode: 0o755, type: "dir" });
    };

    if (!opts.empty) {
      const prefix = opts.wrapperDir ? opts.wrapperDir : "";
      if (prefix) pushDir(prefix);
      for (const [path, entry] of Object.entries(files)) {
        const archivePathForEntry = prefix ? `${prefix}/${path}` : path;
        const dirPart = archivePathForEntry
          .split("/")
          .slice(0, -1)
          .join("/");
        if (dirPart) pushDir(dirPart);

        const content = typeof entry === "string" ? entry : entry.content;
        let mode: number;
        if (typeof entry === "object" && entry.mode !== undefined) {
          mode = entry.mode;
        } else if (opts.permissions?.[path] !== undefined) {
          mode = opts.permissions[path];
        } else if (path.endsWith(".sh")) {
          mode = 0o755;
        } else {
          mode = 0o644;
        }
        entries.push({
          name: archivePathForEntry,
          mode,
          type: "file",
          content,
        });
      }
    }

    // Write manifest and payloads to disk for Python to read.
    const manifestPath = join(tmp, "manifest.json");
    const payloadDir = join(tmp, "payloads");
    await mkdir(payloadDir, { recursive: true });
    const manifest: Array<{
      name: string;
      mode: number;
      type: string;
      payload?: string;
    }> = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.type === "file") {
        const payloadFile = join(payloadDir, `p${i}`);
        await writeFile(payloadFile, e.content ?? "", "utf-8");
        manifest.push({
          name: e.name,
          mode: e.mode,
          type: "file",
          payload: payloadFile,
        });
      } else {
        manifest.push({ name: e.name, mode: e.mode, type: "dir" });
      }
    }
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");

    const pyCode = [
      "import json, tarfile, sys, io",
      "manifest_path = sys.argv[1]",
      "archive_path = sys.argv[2]",
      "with open(manifest_path) as f: manifest = json.load(f)",
      "with tarfile.open(archive_path, 'w:gz') as tf:",
      "    for e in manifest:",
      "        info = tarfile.TarInfo(e['name'])",
      "        info.mode = e['mode']",
      "        if e['type'] == 'dir':",
      "            info.type = tarfile.DIRTYPE",
      "            tf.addfile(info)",
      "        else:",
      "            with open(e['payload'], 'rb') as pf:",
      "                data = pf.read()",
      "            info.size = len(data)",
      "            tf.addfile(info, io.BytesIO(data))",
    ].join("\n");
    const pyScriptPath = join(tmp, "makearchive.py");
    await writeFile(pyScriptPath, pyCode, "utf-8");

    if (opts.empty) {
      execSync(`tar czf "${archivePath}" -T /dev/null`, { stdio: "pipe" });
    } else {
      execSync(
        `python3 "${pyScriptPath}" "${manifestPath}" "${archivePath}"`,
        { stdio: "pipe" },
      );
    }
    let buf = readFileSync(archivePath);
    if (opts.corrupt) {
      buf = buf.subarray(0, Math.max(10, Math.floor(buf.length / 3)));
    }
    return buf;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function tarballRoute(path: string, body: Buffer) {
  return { path, status: 200, contentType: "application/gzip", body };
}

// ─────────────────────────────────────────────────────────────
// npm shim helpers — observe post-commit auto-install without npm
// ─────────────────────────────────────────────────────────────

interface FakeNpmOptions {
  exitCode?: number;
  exitCodeByWorkflow?: Record<string, number>;
  stdout?: string;
  stderr?: string;
  sleepSeconds?: number;
  sleepByInvocation?: Record<number, number>;
  recordGitignoreAtStart?: boolean;
  createFiles?: string[];
  pidFile?: string;
  trapSignals?: Array<"INT" | "TERM">;
  spawnGrandchild?: boolean;
  grandchildPidFile?: string;
}

interface NpmInvocation {
  pid: string;
  cwd: string;
  argv: string[];
  start: number;
  end: number;
  gitignoreAtStart?: {
    existed: boolean;
    content?: string;
  };
}

async function withFakeNpm<T>(
  options: FakeNpmOptions,
  fn: (env: Record<string, string>, logFile: string) => Promise<T>,
): Promise<T> {
  const fakeBin = await mkdtemp(join(tmpdir(), "loopx-fake-npm-"));
  const logFile = join(fakeBin, "npm.log");
  const npmPath = join(fakeBin, "npm");
  const counterFile = join(fakeBin, "npm.count");
  const timestamp = 'date +%s%3N 2>/dev/null || node -e "console.log(Date.now())"';
  const script = [
    "#!/bin/bash",
    "set -u",
    ...(options.trapSignals?.length
      ? [`trap '' ${options.trapSignals.join(" ")}`]
      : []),
    `start=$(${timestamp})`,
    'cwd="$(pwd)"',
    'workflow="$(basename "$cwd")"',
    options.pidFile
      ? `printf '%s' "$$" > ${JSON.stringify(options.pidFile)}`
      : ":",
    options.spawnGrandchild && options.grandchildPidFile
      ? `sleep 300 & printf '%s' "$!" > ${JSON.stringify(options.grandchildPidFile)}`
      : ":",
    `count=0`,
    `if [ -f ${JSON.stringify(counterFile)} ]; then count="$(cat ${JSON.stringify(counterFile)})"; fi`,
    `count=$((count + 1))`,
    `printf '%s' "$count" > ${JSON.stringify(counterFile)}`,
    `exit_code=${options.exitCode ?? 0}`,
    ...Object.entries(options.exitCodeByWorkflow ?? {}).map(
      ([workflow, exitCode]) =>
        `if [ "$workflow" = ${JSON.stringify(workflow)} ]; then exit_code=${exitCode}; fi`,
    ),
    `sleep_seconds=${options.sleepSeconds ?? 0}`,
    ...Object.entries(options.sleepByInvocation ?? {}).map(
      ([invocation, seconds]) =>
        `if [ "$count" = ${JSON.stringify(invocation)} ]; then sleep_seconds=${seconds}; fi`,
    ),
    'args=""',
    'for arg in "$@"; do',
    '  if [ -z "$args" ]; then args="$arg"; else args="$args|$arg"; fi',
    "done",
    `printf 'start\\t%s\\t%s\\t%s\\t%s\\n' "$$" "$start" "$cwd" "$args" >> ${JSON.stringify(
      logFile,
    )}`,
    options.recordGitignoreAtStart
      ? [
          'if [ -e ".gitignore" ]; then',
          '  gitignore_content="$(cat .gitignore 2>/dev/null || true)"',
          `  printf 'gitignore\\t%s\\ttrue\\t%s\\n' "$$" "$gitignore_content" >> ${JSON.stringify(
            logFile,
          )}`,
          "else",
          `  printf 'gitignore\\t%s\\tfalse\\t\\n' "$$" >> ${JSON.stringify(
            logFile,
          )}`,
          "fi",
        ].join("\n")
      : ":",
    ...(options.createFiles ?? []).flatMap((filePath) => [
      `mkdir -p "$(dirname ${JSON.stringify(filePath)})"`,
      `printf 'created by fake npm' > ${JSON.stringify(filePath)}`,
    ]),
    options.stdout
      ? `printf '%s\\n' ${JSON.stringify(options.stdout)}`
      : ":",
    options.stderr
      ? `printf '%s\\n' ${JSON.stringify(options.stderr)} >&2`
      : ":",
    `if [ "$sleep_seconds" -gt 0 ]; then sleep "$sleep_seconds"; fi`,
    `end=$(${timestamp})`,
    `printf 'end\\t%s\\t%s\\t%s\\t%s\\n' "$$" "$end" "$cwd" "$args" >> ${JSON.stringify(
      logFile,
    )}`,
    "exit $exit_code",
    "",
  ].join("\n");

  await writeFile(npmPath, script, "utf-8");
  await chmod(npmPath, 0o755);

  try {
    return await fn(
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
      logFile,
    );
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
}

function readNpmInvocations(logFile: string): NpmInvocation[] {
  if (!existsSync(logFile)) return [];
  const records = new Map<
    string,
    {
      cwd: string;
      argv: string[];
      start?: number;
      end?: number;
      gitignoreAtStart?: { existed: boolean; content?: string };
    }
  >();

  for (const line of readFileSync(logFile, "utf-8").trim().split("\n")) {
    if (!line) continue;
    const [kind, pid, stamp, cwd, rawArgs = ""] = line.split("\t");
    const current = records.get(pid) ?? {
      cwd,
      argv: rawArgs ? rawArgs.split("|") : [],
    };
    if (kind === "start") current.start = Number(stamp);
    if (kind === "end") current.end = Number(stamp);
    if (kind === "gitignore") {
      current.gitignoreAtStart = {
        existed: stamp === "true",
        content: cwd || undefined,
      };
    }
    records.set(pid, current);
  }

  return [...records.entries()].map(([pid, record]) => ({
    pid,
    cwd: record.cwd,
    argv: record.argv,
    start: record.start ?? 0,
    end: record.end ?? 0,
    gitignoreAtStart: record.gitignoreAtStart,
  }));
}

function expectNoAutoInstallFailureReport(stderr: string): void {
  expect(stderr).not.toMatch(/auto.?install.*fail|npm install.*fail|failed.*npm/i);
}

async function createManualGitSource(
  baseDir: string,
  repoName: string,
  setup: (workDir: string) => Promise<void>,
): Promise<string> {
  const bareDir = join(baseDir, `${repoName}.git`);
  const workDir = join(baseDir, `${repoName}-work`);
  execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });
  execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "pipe" });
  await setup(workDir);
  execSync(
    `cd "${workDir}" && git add -A && git -c user.email="test@test.com" -c user.name="Test" commit -m "initial"`,
    { stdio: "pipe" },
  );
  execSync(`cd "${workDir}" && git push origin HEAD`, { stdio: "pipe" });
  return `file://${bareDir}`;
}

interface EnvRecordingInvocation {
  cwd: string;
  argv: string[];
  env: Record<string, string | undefined>;
}

async function withEnvRecordingFakeNpm<T>(
  keys: string[],
  fn: (env: Record<string, string>, logFile: string) => Promise<T>,
): Promise<T> {
  const fakeBin = await mkdtemp(join(tmpdir(), "loopx-env-npm-"));
  const logFile = join(fakeBin, "npm-env.jsonl");
  const npmPath = join(fakeBin, "npm");
  const script = [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    `const logFile = ${JSON.stringify(logFile)};`,
    `const keys = ${JSON.stringify(keys)};`,
    "const env = {};",
    "for (const key of keys) env[key] = process.env[key];",
    "fs.appendFileSync(logFile, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), env }) + '\\n');",
    "process.exit(0);",
    "",
  ].join("\n");

  await writeFile(npmPath, script, "utf-8");
  await chmod(npmPath, 0o755);
  try {
    return await fn(
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      logFile,
    );
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
}

function readEnvRecordingInvocations(logFile: string): EnvRecordingInvocation[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EnvRecordingInvocation);
}

async function withScrubbedLoopxProcessEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("LOOPX_")) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type GitignoreStateAtPause =
  | { exists: false }
  | { exists: true; type: "regular-file"; content: string }
  | { exists: true; type: string };

interface AutoInstallPauseMarker {
  window: string;
  current: string | null;
  processed: string[];
  remaining: string[];
  activeChildPid?: number;
  gitignoreStateAtPause?: GitignoreStateAtPause;
}

async function waitForAutoInstallPauseMarker(
  markerPath: string,
  timeoutMs = 5_000,
): Promise<AutoInstallPauseMarker> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) {
      return JSON.parse(
        readFileSync(markerPath, "utf-8"),
      ) as AutoInstallPauseMarker;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for auto-install pause marker: ${markerPath}`);
}

function expectWorkflowNamesCoverMarker(
  marker: AutoInstallPauseMarker,
  expectedNames: string[],
): void {
  const observed = [
    ...marker.processed,
    ...(marker.current === null ? [] : [marker.current]),
    ...marker.remaining,
  ].sort();
  expect(observed).toEqual([...expectedNames].sort());
}

function expectCommittedWorkflows(loopxDir: string, names: string[]): void {
  for (const name of names) {
    expect(existsSync(join(loopxDir, name, "index.sh"))).toBe(true);
    expect(existsSync(join(loopxDir, name, "package.json"))).toBe(true);
  }
}

function expectGitignoreMatchesPauseState(
  loopxDir: string,
  workflow: string,
  state: GitignoreStateAtPause,
): void {
  const gitignorePath = join(loopxDir, workflow, ".gitignore");
  if (!state.exists) {
    expect(existsSync(gitignorePath)).toBe(false);
    return;
  }
  const stat = lstatSync(gitignorePath);
  if (state.type === "regular-file") {
    expect(stat.isFile()).toBe(true);
    expect(readFileSync(gitignorePath).toString("base64")).toBe(state.content);
  } else if (state.type === "symlink") {
    expect(stat.isSymbolicLink()).toBe(true);
  } else if (state.type === "directory") {
    expect(stat.isDirectory()).toBe(true);
  } else if (state.type === "fifo") {
    expect(stat.isFIFO()).toBe(true);
  } else if (state.type === "socket") {
    expect(stat.isSocket()).toBe(true);
  } else {
    expect(stat.isFile()).toBe(false);
  }
}

function packageJsonWorkflowFiles(
  names: string[],
): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => [
      [`${name}/index.sh`, BASH_STOP],
      [
        `${name}/package.json`,
        JSON.stringify({ name, version: "1.0.0" }),
      ],
    ]),
  );
}

// ─────────────────────────────────────────────────────────────
// Shared fixture fragments (workflow-model)
// ─────────────────────────────────────────────────────────────

/** Bash script that exits 0 — minimal valid workflow entry point. */
const BASH_STOP = '#!/bin/bash\nprintf \'{"stop":true}\'\n';
const BASH_OK = '#!/bin/bash\nexit 0\n';

// ═════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════

describe("SPEC: Install Command (T-INST-* / ADR-0003 workflow model)", () => {
  let project: TempProject | null = null;
  let httpServer: HTTPServer | null = null;
  let gitServer: GitServer | null = null;

  afterEach(async () => {
    if (project) {
      try {
        await project.cleanup();
      } catch {
        // Permissions on unreadable-file fixtures can trip cleanup; ignore.
      }
      project = null;
    }
    if (httpServer) {
      await httpServer.close();
      httpServer = null;
    }
    if (gitServer) {
      await gitServer.close();
      gitServer = null;
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Source Detection (T-INST-01 … 08f)
  // ═══════════════════════════════════════════════════════════

  describe("Source Detection", () => {
    forEachRuntime((runtime) => {
      it("T-INST-01: org/repo shorthand is treated as a git source", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: { "index.sh": BASH_STOP },
          },
        ]);
        await withGitURLRewrite(
          {
            "https://github.com/myorg/my-workflow.git": `${gitServer.url}/my-workflow.git`,
          },
          async () => {
            const result = await runCLI(["install", "myorg/my-workflow"], {
              cwd: project!.dir,
              runtime,
            });
            expect(result.exitCode).toBe(0);
            expect(existsSync(join(project!.loopxDir, "my-workflow"))).toBe(
              true,
            );
          },
        );
      });

      it("T-INST-01a: org/repo.git shorthand is rejected (shorthand must not end in .git)", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "myorg/my-workflow.git"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(existsSync(join(project.loopxDir, "my-workflow"))).toBe(false);
      });

      it("T-INST-02: https://github.com/org/repo → git (known host)", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        await withGitURLRewrite(
          { "https://github.com/org/repo": `${gitServer.url}/repo.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/repo"],
              { cwd: project!.dir, runtime },
            );
            expect(result.exitCode).toBe(0);
            expect(existsSync(join(project!.loopxDir, "repo"))).toBe(true);
          },
        );
      });

      it("T-INST-03: https://gitlab.com/org/repo → git (known host)", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        await withGitURLRewrite(
          { "https://gitlab.com/org/repo": `${gitServer.url}/repo.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://gitlab.com/org/repo"],
              { cwd: project!.dir, runtime },
            );
            expect(result.exitCode).toBe(0);
            expect(existsSync(join(project!.loopxDir, "repo"))).toBe(true);
          },
        );
      });

      it("T-INST-04: https://bitbucket.org/org/repo → git (known host)", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        await withGitURLRewrite(
          { "https://bitbucket.org/org/repo": `${gitServer.url}/repo.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://bitbucket.org/org/repo"],
              { cwd: project!.dir, runtime },
            );
            expect(result.exitCode).toBe(0);
            expect(existsSync(join(project!.loopxDir, "repo"))).toBe(true);
          },
        );
      });

      it("T-INST-05: https://example.com/repo.git → git (.git suffix)", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        await withGitURLRewrite(
          { "https://example.com/repo.git": `${gitServer.url}/repo.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://example.com/repo.git"],
              { cwd: project!.dir, runtime },
            );
            expect(result.exitCode).toBe(0);
            expect(existsSync(join(project!.loopxDir, "repo"))).toBe(true);
          },
        );
      });

      it("T-INST-05a: non-known-host .git URL with trailing slash is rejected", async () => {
        project = await createTempProject();

        const result = await runCLI(
          ["install", "https://example.com/repo.git/"],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unsupported|invalid|source|url/i);
        expect(existsSync(join(project.loopxDir, "repo"))).toBe(false);
      });

      it("T-INST-06: http URL ending .tar.gz → tarball", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "pkg" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/pkg.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/pkg.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(true);
      });

      it("T-INST-07: http URL ending .tgz → tarball", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "pkg" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/pkg.tgz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/pkg.tgz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(true);
      });

      it("T-INST-08: http URL ending .ts → rejected (single-file URL not supported)", async () => {
        project = await createTempProject();
        httpServer = await startLocalHTTPServer([
          { path: "/script.ts", body: 'console.log("hi")' },
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/script.ts`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
      });

      it("T-INST-08a: github archive/main.tar.gz → tarball (not git)", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "archive" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/org/repo/archive/main.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/org/repo/archive/main.tar.gz`],
          { cwd: project.dir, runtime },
        );
        // Wrapper `archive/` is stripped (SPEC §10.2); name derives from the
        // URL archive-name = "main" (last path segment minus `.tar.gz`).
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "main"))).toBe(true);
      });

      it("T-INST-08c: github URL with trailing slash → git", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        await withGitURLRewrite(
          { "https://github.com/org/repo/": `${gitServer.url}/repo.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/repo/"],
              { cwd: project!.dir, runtime },
            );
            expect(result.exitCode).toBe(0);
            expect(existsSync(join(project!.loopxDir, "repo"))).toBe(true);
          },
        );
      });

      it("T-INST-08g: github URL with query string is classified as git", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        await withGitURLRewrite(
          {
            "https://github.com/org/repo": `${gitServer.url}/repo.git`,
            "https://github.com/org/repo?x=1": `${gitServer.url}/repo.git`,
          },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/repo?x=1"],
              { cwd: project!.dir, runtime },
            );
            expect(result.exitCode).toBe(0);
            expect(existsSync(join(project!.loopxDir, "repo"))).toBe(true);
          },
        );
      });

      it("T-INST-08g2: github URL with fragment is classified as git", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        await withGitURLRewrite(
          {
            "https://github.com/org/repo": `${gitServer.url}/repo.git`,
            "https://github.com/org/repo#section": `${gitServer.url}/repo.git`,
          },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/repo#section"],
              { cwd: project!.dir, runtime },
            );
            expect(result.exitCode).toBe(0);
            expect(existsSync(join(project!.loopxDir, "repo"))).toBe(true);
          },
        );
      });

      it("T-INST-08h: github .git URL with trailing slash is classified as git", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        await withGitURLRewrite(
          {
            "https://github.com/org/repo.git/": `${gitServer.url}/repo.git`,
          },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/repo.git/"],
              { cwd: project!.dir, runtime },
            );
            expect(result.exitCode).toBe(0);
            expect(existsSync(join(project!.loopxDir, "repo"))).toBe(true);
          },
        );
      });

      it("T-INST-08d: tarball URL with query string → tarball", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "pkg" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/pkg.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/pkg.tar.gz?token=abc`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(true);
      });

      it("T-INST-08e: http URL ending .js → rejected (not git or tarball)", async () => {
        project = await createTempProject();
        httpServer = await startLocalHTTPServer([
          { path: "/some-file.js", body: 'console.log("hi")' },
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/some-file.js`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-08f: github URL with extra path segments (/tree/main) → rejected", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "https://github.com/org/repo/tree/main"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it.each([
        ["T-INST-08i", "org/repo/extra"],
        ["T-INST-08j", "org/repo/"],
        ["T-INST-08k", "org//repo"],
        ["T-INST-08l", "https://github.com/org"],
        ["T-INST-08m", "https://github.com/org/repo.git/extra"],
      ] as const)("%s: invalid install source %s is rejected", async (_id, source) => {
        project = await createTempProject();

        const result = await runCLI(["install", source], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unsupported|invalid|source|url|shorthand/i);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Install CLI Parsing (T-INST-40 … 49e)
  // ═══════════════════════════════════════════════════════════

  describe("Install CLI Parsing", () => {
    forEachRuntime((runtime) => {
      it("T-INST-40: no source → usage error exit 1", async () => {
        project = await createTempProject();
        const result = await runCLI(["install"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-40a: -w ralph with no source → usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "-w", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-40b: --workflow ralph with no source → usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "--workflow", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-40c: -y with no source → usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "-y"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-40f: --no-install with no source → usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "--no-install"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/usage|source|required/i);
      });

      it("T-INST-40d: two positional sources → usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "org/repo", "org/other"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-40e: -w ralph with two positional sources → usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "-w", "ralph", "org/repo", "org/other"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-41: -h → install help, --no-install advertised with no short alias, no single-file URL advertised", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        const out = result.stdout + result.stderr;
        expect(out).toMatch(/-w|--workflow/);
        expect(out).toMatch(/-y/);
        expect(out).toMatch(/--no-install/);
        expect(out).not.toMatch(/(^|\s)-[A-Za-z],?\s+--no-install\b/);
        // Either git or tarball terminology should appear
        expect(out).toMatch(/git|tarball|repo/i);
        // Single-file URL install is removed — help must NOT advertise it
        expect(out).not.toMatch(/single[- ]file/i);
      });

      it("T-INST-41a: --help produces byte-identical output to -h", async () => {
        project = await createTempProject();
        const short = await runCLI(["install", "-h"], {
          cwd: project.dir,
          runtime,
        });
        const long = await runCLI(["install", "--help"], {
          cwd: project.dir,
          runtime,
        });
        expect(long.exitCode).toBe(short.exitCode);
        expect(long.stdout).toBe(short.stdout);
        expect(long.stderr).toBe(short.stderr);
        expect(long.exitCode).toBe(0);
      });

      it("T-INST-42: -h --unknown → help, exit 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "-h", "--unknown"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-42a: -h with valid source → help, zero HTTP requests", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "pkg" },
        );
        let requestCount = 0;
        const inner = await startLocalHTTPServer([
          tarballRoute("/pkg.tar.gz", tarball),
        ]);
        httpServer = inner;
        // Monkey-patch: create a counting proxy by observing through a second test server
        // We can't easily hook — so measure via a 404 route instead.
        const result = await runCLI(
          ["install", "-h", `${httpServer.url}/pkg.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        // The help short-circuit means nothing is installed
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(false);
        expect(readdirSync(project.loopxDir).length).toBe(0);
        void requestCount;
      });

      it("T-INST-42b: source then -h → help, .loopx/ untouched", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "pkg" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/pkg.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/pkg.tar.gz`, "-h"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(false);
      });

      it("T-INST-42c: -h with broken .loopx/ still exits 0, no discovery warnings", async () => {
        project = await createTempProject();
        // Set up a broken .loopx/ tree with multiple invalid patterns
        await createBashWorkflowScript(project, "-bad-workflow", "index", 'exit 0');
        await createBashWorkflowScript(project, "ralph", "check", 'exit 0');
        await createWorkflowScript(project, "ralph", "check", ".ts", "// same-base-name collision\n");
        await createBashWorkflowScript(project, "other", "-bad", 'exit 0');

        const result = await runCLI(["install", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        // Install help should not emit discovery/validation warnings
        expect(
          hasWarningCategoryFor(result.stderr, "-bad-workflow"),
        ).toBe(false);
        expect(hasWarningCategoryFor(result.stderr, "check.sh")).toBe(false);
      });

      it("T-INST-42d: --help with valid source → help, zero HTTP requests", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "pkg" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/pkg.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", "--help", `${httpServer.url}/pkg.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(false);
      });

      it("T-INST-42e: --help --unknown → help, exit 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "--help", "--unknown"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-42f: --help --workflow (no operand) → help, exit 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "--help", "--workflow"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-42g: -h with extra positionals → help, no network activity", async () => {
        project = await createTempProject();
        httpServer = await startLocalHTTPServer([
          { path: "/a.tar.gz", body: "ignored" },
          { path: "/b.tar.gz", body: "ignored" },
        ]);
        const result = await runCLI(
          [
            "install",
            "-h",
            `${httpServer.url}/a.tar.gz`,
            `${httpServer.url}/b.tar.gz`,
          ],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(readdirSync(project.loopxDir).length).toBe(0);
      });

      it("T-INST-42h: source source --help → help, no network activity", async () => {
        project = await createTempProject();
        httpServer = await startLocalHTTPServer([
          { path: "/a.tar.gz", body: "ignored" },
          { path: "/b.tar.gz", body: "ignored" },
        ]);
        const result = await runCLI(
          [
            "install",
            `${httpServer.url}/a.tar.gz`,
            `${httpServer.url}/b.tar.gz`,
            "--help",
          ],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(readdirSync(project.loopxDir).length).toBe(0);
      });

      it("T-INST-42i: --help -w a -w b → help, exit 0", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "--help", "-w", "a", "-w", "b"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-42j: --help -y -y → help, exit 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "--help", "-y", "-y"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-42k: rejected source (.ts URL) then -h → help, suppresses source error", async () => {
        project = await createTempProject();
        httpServer = await startLocalHTTPServer([
          { path: "/script.ts", body: 'console.log("x")' },
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/script.ts`, "-h"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(readdirSync(project.loopxDir).length).toBe(0);
        // No single-file URL rejection message should appear
        expect(result.stderr).not.toMatch(/single[- ]file/i);
      });

      it("T-INST-42l: org/repo.git then --help → help, suppresses shorthand error", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "org/repo.git", "--help"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(readdirSync(project.loopxDir).length).toBe(0);
      });

      it("T-INST-DASHDASH-01: leading -- before valid source is a usage error with no download", async () => {
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "dashsrc" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/dashsrc.tar.gz", tarball),
        ]);

        const preverify = await createTempProject();
        try {
          const ok = await runCLI(
            ["install", `${httpServer.url}/dashsrc.tar.gz`],
            { cwd: preverify.dir, runtime },
          );
          expect(ok.exitCode).toBe(0);
          expect(existsSync(join(preverify.loopxDir, "dashsrc"))).toBe(true);
        } finally {
          await preverify.cleanup();
        }

        const requestCountBefore = httpServer.requests.length;
        project = await createTempProject();
        const result = await runCLI(
          ["install", "--", `${httpServer.url}/dashsrc.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/--|usage|unknown|unrecognized/i);
        expect(result.stderr).not.toMatch(/unsupported.*source/i);
        expect(httpServer.requests).toHaveLength(requestCountBefore);
        expect(existsSync(join(project.loopxDir, "dashsrc"))).toBe(false);
        expect(readdirSync(project.loopxDir)).toEqual([]);
      });

      it("T-INST-DASHDASH-02: trailing -- after valid source is a usage error with no download", async () => {
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "dashsrc" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/dashsrc.tar.gz", tarball),
        ]);

        const preverify = await createTempProject();
        try {
          const ok = await runCLI(
            ["install", `${httpServer.url}/dashsrc.tar.gz`],
            { cwd: preverify.dir, runtime },
          );
          expect(ok.exitCode).toBe(0);
        } finally {
          await preverify.cleanup();
        }

        const requestCountBefore = httpServer.requests.length;
        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/dashsrc.tar.gz`, "--"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/--|usage|unknown|unrecognized/i);
        expect(result.stderr).not.toMatch(/unsupported.*source/i);
        expect(httpServer.requests).toHaveLength(requestCountBefore);
        expect(existsSync(join(project.loopxDir, "dashsrc"))).toBe(false);
        expect(readdirSync(project.loopxDir)).toEqual([]);
      });

      it("T-INST-DASHDASH-03: -h short-circuits -- before source", async () => {
        project = await createTempProject();
        httpServer = await startLocalHTTPServer([
          { path: "/dashsrc.tar.gz", body: "ignored" },
        ]);
        const result = await runCLI(
          ["install", "-h", "--", `${httpServer.url}/dashsrc.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toMatch(/install/i);
        expect(result.stderr).not.toMatch(/--.*(usage|unknown|unrecognized)/i);
        expect(httpServer.requests).toHaveLength(0);
        expect(readdirSync(project.loopxDir)).toEqual([]);
      });

      it("T-INST-DASHDASH-04: --help short-circuits -- before source", async () => {
        project = await createTempProject();
        httpServer = await startLocalHTTPServer([
          { path: "/dashsrc.tar.gz", body: "ignored" },
        ]);
        const result = await runCLI(
          ["install", "--help", "--", `${httpServer.url}/dashsrc.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toMatch(/install/i);
        expect(result.stderr).not.toMatch(/--.*(usage|unknown|unrecognized)/i);
        expect(httpServer.requests).toHaveLength(0);
        expect(readdirSync(project.loopxDir)).toEqual([]);
      });

      it("T-INST-43: -w a -w b <source> → usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "-w", "a", "-w", "b", "org/repo"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-43a: --workflow a --workflow b <source> → usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "--workflow", "a", "--workflow", "b", "org/repo"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-43b: -w a --workflow b <source> → usage error (mixed duplicate)", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "-w", "a", "--workflow", "b", "org/repo"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-44: -y -y <source> → usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "-y", "-y", "org/repo"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-44a / T-INST-44b: duplicate --no-install is a usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "--no-install", "--no-install", "org/repo"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-44c: --help suppresses duplicate --no-install usage errors", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "--help", "--no-install", "--no-install", "org/repo"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/usage|install/i);
        expect(result.stdout).toMatch(/--no-install/);
        expect(result.stderr).not.toMatch(/duplicate|usage/i);
      });

      it("T-INST-44d: late -h after --no-install still produces install help", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "--no-install", "-h", "org/repo"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/usage|install/i);
        expect(result.stdout).toMatch(/--no-install/);
      });

      it.each([
        ["-h"],
        ["--help"],
      ] as const)(
        "T-INST-44e: late %s suppresses preceding duplicate --no-install usage errors",
        async (helpFlag) => {
          project = await createTempProject();
          const result = await runCLI(
            [
              "install",
              "--no-install",
              "--no-install",
              helpFlag,
              "org/repo",
            ],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toMatch(/usage|install/i);
          expect(result.stdout).toMatch(/--no-install/);
          expect(result.stderr).not.toMatch(/duplicate|usage/i);
          expect(readdirSync(project.loopxDir)).toEqual([]);
        },
      );

      it.each(["-n", "-N", "-i", "-I"] as const)(
        "T-INST-44f: %s is not a short alias for --no-install",
        async (flag) => {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "repo",
              files: {
                "index.sh": BASH_STOP,
                "package.json": JSON.stringify({ name: "repo", version: "1.0.0" }),
              },
            },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const result = await runCLI(
              ["install", flag, `${gitServer!.url}/repo.git`],
              { cwd: project!.dir, runtime, env },
            );

            expect(result.exitCode).toBe(1);
            expect(result.stderr).toMatch(/unknown|unrecognized|usage|invalid/i);
            expect(readNpmInvocations(logFile)).toHaveLength(0);
            expect(existsSync(join(project!.loopxDir, "repo"))).toBe(false);
          });
        },
      );

      it("T-INST-45: --unknown <source> → usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "--unknown", "org/repo"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-45a: -x <source> → usage error (unknown short flag)", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "-x", "org/repo"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-46: -h -w a -w b → help, exit 0 (duplicate -w not rejected under help)", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "-h", "-w", "a", "-w", "b"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-47: -h -y -y → help, exit 0 (duplicate -y not rejected under help)", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "-h", "-y", "-y"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-47a: -h --no-install --no-install → help, exit 0", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "-h", "--no-install", "--no-install"],
          {
            cwd: project.dir,
            runtime,
          },
        );
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-48: -h -w (missing -w operand) → help, exit 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "-h", "-w"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-49: -w (no operand, no source) → usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "-w"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-49e: --workflow (no operand, no source) → usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "--workflow"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Late-Help Short-Circuit (T-INST-49a … 49g)
  // ═══════════════════════════════════════════════════════════

  describe("Late-Help Short-Circuit (Invalid Args Before -h)", () => {
    forEachRuntime((runtime) => {
      it("T-INST-49a: --unknown -h → help, exit 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "--unknown", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-49b: -w a -w b -h → help, exit 0", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "-w", "a", "-w", "b", "-h"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-49c: -y -y -h → help, exit 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "-y", "-y", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-49d: --unknown --help → help, exit 0", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "--unknown", "--help"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-49f: -w -h → help, exit 0 (naive parser would consume -h as -w operand)", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "-w", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-49g: --workflow --help → help, exit 0", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "--workflow", "--help"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Workflow Classification — Single-Workflow Source (T-INST-50 … 52d)
  // ═══════════════════════════════════════════════════════════

  describe("Workflow Classification — Single-Workflow Source", () => {
    forEachRuntime((runtime) => {
      it("T-INST-50: root index.ts + non-script file + pure non-script dir → single-workflow", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "my-agent",
            files: {
              "index.ts": 'console.log("hi");',
              "package.json": '{"name":"my-agent"}',
              "docs/README.md": "# Docs\n",
              "docs/notes.md": "notes\n",
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/my-agent.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        const installed = join(project.loopxDir, "my-agent");
        expect(existsSync(join(installed, "index.ts"))).toBe(true);
        expect(existsSync(join(installed, "package.json"))).toBe(true);
        expect(existsSync(join(installed, "docs"))).toBe(true);
        expect(existsSync(join(installed, "docs", "README.md"))).toBe(true);
      });

      it("T-INST-50a: root index.js → single-workflow", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "my-agent",
            files: { "index.js": 'console.log("hi");' },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/my-agent.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "my-agent", "index.js")),
        ).toBe(true);
      });

      for (const ext of [".sh", ".js", ".jsx", ".ts", ".tsx"]) {
        it(`T-INST-50b: single-workflow root classification for ${ext}`, async () => {
          project = await createTempProject();
          const body = ext === ".sh" ? BASH_STOP : 'console.log("hi");';
          gitServer = await startLocalGitServer([
            {
              name: "my-agent",
              files: { [`index${ext}`]: body },
            },
          ]);
          const result = await runCLI(
            ["install", `${gitServer!.url}/my-agent.git`],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(0);
          expect(
            existsSync(join(project.loopxDir, "my-agent", `index${ext}`)),
          ).toBe(true);
        });
      }

      it("T-INST-51: root index.ts + lib/ subdir → single-workflow, lib/ is content", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "my-agent",
            files: {
              "index.ts": 'console.log("hi");',
              "lib/helpers.ts": "export const x = 1;",
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/my-agent.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "my-agent", "lib", "helpers.ts")),
        ).toBe(true);
      });

      it("T-INST-52: root index.sh + would-be-workflow subdirs → single-workflow, subdirs are content", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "my-agent",
            files: {
              "index.sh": BASH_STOP,
              "tools/build.sh": BASH_STOP,
              "helpers/setup.ts": 'console.log("s");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/my-agent.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "my-agent", "tools", "build.sh")),
        ).toBe(true);
        expect(
          existsSync(
            join(project.loopxDir, "my-agent", "helpers", "setup.ts"),
          ),
        ).toBe(true);
        expect(existsSync(join(project.loopxDir, "tools"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "helpers"))).toBe(false);
      });

      it("T-INST-52a: root config-style file (eslint.config.js) forces single-workflow, fails on invalid script name", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "my-agent",
            files: {
              "eslint.config.js": "module.exports = {};",
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/my-agent.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        // Invalid script name errors ref the file name
        expect(result.stderr).toMatch(/eslint\.config/);
        // Sibling subdirectories were NOT installed as sibling workflows
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
      });

      it("T-INST-52c: root non-index script (setup.ts) forces single-workflow even with workflow-like subdirs", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "my-agent",
            files: {
              "setup.ts": 'console.log("s");',
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/my-agent.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "my-agent", "setup.ts")),
        ).toBe(true);
        expect(
          existsSync(
            join(project.loopxDir, "my-agent", "ralph", "index.sh"),
          ),
        ).toBe(true);
        expect(
          existsSync(
            join(project.loopxDir, "my-agent", "other", "index.sh"),
          ),
        ).toBe(true);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
      });

      it("T-INST-52d: tarball counterpart to 52a — config-style root file, single-workflow, name error", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          {
            "eslint.config.js": "module.exports = {};",
            "ralph/index.sh": BASH_STOP,
            "other/index.sh": BASH_STOP,
          },
          { wrapperDir: "my-agent" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/my-agent.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/my-agent.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/eslint\.config/);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Workflow Classification — Multi-Workflow Source (T-INST-53 … 55e)
  // ═══════════════════════════════════════════════════════════

  describe("Workflow Classification — Multi-Workflow Source", () => {
    forEachRuntime((runtime) => {
      it("T-INST-53: two subdirs with index.sh → multi-workflow", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
      });

      it("T-INST-53a: multi-workflow with subdir qualifying via index.jsx", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.jsx": 'console.log("x");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other", "index.jsx"))).toBe(
          true,
        );
      });

      it("T-INST-53b: multi-workflow with subdir qualifying via index.tsx", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.tsx": 'console.log("x");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "other", "index.tsx"))).toBe(
          true,
        );
      });

      for (const ext of [".sh", ".js", ".jsx", ".ts", ".tsx"]) {
        it(`T-INST-53c: multi-workflow subdir classification for ${ext}`, async () => {
          project = await createTempProject();
          const body = ext === ".sh" ? BASH_STOP : 'console.log("x");';
          gitServer = await startLocalGitServer([
            {
              name: "multi",
              files: {
                [`target/index${ext}`]: body,
                "other/index.sh": BASH_STOP,
              },
            },
          ]);
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(0);
          expect(
            existsSync(join(project.loopxDir, "target", `index${ext}`)),
          ).toBe(true);
          expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
        });
      }

      it("T-INST-54: multi-workflow repo-root support files not copied", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
              "README.md": "readme",
              "LICENSE": "MIT",
              "package.json": '{"name":"multi"}',
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "package.json"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "README.md"))).toBe(false);
      });

      it("T-INST-54a: multi-workflow preserves workflow-internal non-script files/subdirs", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.ts": 'console.log("r");',
              "ralph/package.json": '{"name":"ralph"}',
              "ralph/lib/helpers.ts": "export const x = 1;",
              "ralph/README.md": "# ralph",
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "ralph", "package.json")),
        ).toBe(true);
        expect(
          existsSync(join(project.loopxDir, "ralph", "lib", "helpers.ts")),
        ).toBe(true);
        expect(existsSync(join(project.loopxDir, "ralph", "README.md"))).toBe(
          true,
        );
      });

      it("T-INST-54b: multi-workflow source-root package.json ignored", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
              "package.json": "{broken",
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/package\.json/i);
      });

      it("T-INST-54c: multi-workflow does not copy root support directories", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
              "docs/README.md": "docs",
              "shared/config.json": "{}",
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "docs"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "shared"))).toBe(false);
      });

      it("T-INST-54d: tarball counterpart to 54b — source-root package.json ignored", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          {
            "ralph/index.sh": BASH_STOP,
            "other/index.sh": BASH_STOP,
            "package.json": "{broken",
          },
          { wrapperDir: "multi" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/multi.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/multi.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "package.json"))).toBe(false);
        expect(result.stderr).not.toMatch(/package\.json/i);
      });

      it("T-INST-55: subdirectories with no script files silently skipped", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
              "empty/README.md": "empty",
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
      });

      it("T-INST-55a: non-recursive workflow detection (nested scripts don't count)", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "tools/lib/helper.ts": "export const x = 1;",
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "tools"))).toBe(false);
      });

      it("T-INST-55c: subdir with only index.mjs skipped (unsupported extension)", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.mjs": 'console.log("x");',
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
        expect(hasWarningCategoryFor(result.stderr, "ralph")).toBe(false);
      });

      it("T-INST-55b: invalid-named non-workflow subdirectory silently skipped", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
              "-bad-dir/README.md": "readme",
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/-bad-dir/);
      });

      it("T-INST-55e: legacy directory-script subdirectory skipped, valid workflows installed", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "good/index.sh": BASH_STOP,
              "legacy/package.json": '{"main":"src/run.js"}',
              "legacy/src/run.js": 'console.log("x");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "good", "index.sh"))).toBe(
          true,
        );
        expect(existsSync(join(project.loopxDir, "legacy"))).toBe(false);
      });

      it("T-INST-55d: root .mjs/.cjs do not force single-workflow classification", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "index.mjs": 'console.log("x");',
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
      });

      it("T-INST-55f / T-INST-55g / T-INST-55j / T-INST-55k / T-INST-55n / T-INST-55q / T-INST-55zb / T-INST-55zc / T-INST-55zh: in-source symlinks are materialized by alias name", async () => {
        project = await createTempProject();
        const source = await createManualGitSource(
          project.dir,
          "symlink-materialization",
          async (workDir) => {
            await mkdir(join(workDir, "internal", "-target-name"), {
              recursive: true,
            });
            await writeFile(
              join(workDir, "internal", "-target-name", "index.sh"),
              "#!/bin/bash\nexit 0\n",
              "utf-8",
            );
            await chmod(join(workDir, "internal", "-target-name", "index.sh"), 0o755);
            symlinkSync("internal/-target-name", join(workDir, "alias"));

            await mkdir(join(workDir, "ralph", "lib"), { recursive: true });
            await mkdir(join(workDir, "ralph", "docs"), { recursive: true });
            await mkdir(join(workDir, "ralph", "shared-assets", "icons"), {
              recursive: true,
            });
            await writeFile(
              join(workDir, "ralph", "lib", "original-entry.sh"),
              "#!/bin/bash\nexit 0\n",
              "utf-8",
            );
            await chmod(
              join(workDir, "ralph", "lib", "original-entry.sh"),
              0o755,
            );
            await writeFile(join(workDir, "ralph", "docs", "readme.md"), "docs\n");
            await writeFile(
              join(workDir, "ralph", "shared-assets", "icons", "logo.txt"),
              "logo\n",
            );
            symlinkSync("lib/original-entry.sh", join(workDir, "ralph", "index.sh"));
            symlinkSync("docs/readme.md", join(workDir, "ralph", "readme-link.md"));
            symlinkSync("shared-assets", join(workDir, "ralph", "assets"));
            symlinkSync(
              "icons/logo.txt",
              join(workDir, "ralph", "shared-assets", "logo-link.txt"),
            );
          },
        );

        const result = await runCLI(["install", "--no-install", source], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(lstatSync(join(project.loopxDir, "alias")).isDirectory()).toBe(true);
        expect(lstatSync(join(project.loopxDir, "alias")).isSymbolicLink()).toBe(
          false,
        );
        expect(existsSync(join(project.loopxDir, "-target-name"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "internal"))).toBe(false);
        expect(lstatSync(join(project.loopxDir, "ralph", "index.sh")).isFile()).toBe(
          true,
        );
        expect(
          lstatSync(join(project.loopxDir, "ralph", "readme-link.md")).isFile(),
        ).toBe(true);
        expect(
          readFileSync(join(project.loopxDir, "ralph", "readme-link.md"), "utf-8"),
        ).toBe("docs\n");
        expect(lstatSync(join(project.loopxDir, "ralph", "assets")).isDirectory()).toBe(
          true,
        );
        expect(
          lstatSync(
            join(project.loopxDir, "ralph", "shared-assets", "logo-link.txt"),
          ).isFile(),
        ).toBe(true);
        expect(await runCLI(["run", "-n", "1", "alias"], { cwd: project.dir, runtime })).toMatchObject({
          exitCode: 0,
        });
        expect(
          await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir, runtime }),
        ).toMatchObject({ exitCode: 0 });
      });

      it("T-INST-55f2: -w selects a symlinked workflow alias and auto-install runs for the alias only", async () => {
        project = await createTempProject();
        const source = await createManualGitSource(
          project.dir,
          "symlink-selective",
          async (workDir) => {
            await mkdir(join(workDir, "internal", "real-workflow"), {
              recursive: true,
            });
            await writeFile(
              join(workDir, "internal", "real-workflow", "index.sh"),
              BASH_STOP,
            );
            await chmod(
              join(workDir, "internal", "real-workflow", "index.sh"),
              0o755,
            );
            await writeFile(
              join(workDir, "internal", "real-workflow", "package.json"),
              JSON.stringify({ name: "real-workflow", version: "1.0.0" }),
            );
            await mkdir(join(workDir, "other"), { recursive: true });
            await writeFile(join(workDir, "other", "index.sh"), BASH_STOP);
            await chmod(join(workDir, "other", "index.sh"), 0o755);
            symlinkSync("internal/real-workflow", join(workDir, "alias"));
          },
        );

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(["install", "-w", "alias", source], {
            cwd: project!.dir,
            runtime,
            env,
          });

          expect(result.exitCode).toBe(0);
          expect(lstatSync(join(project!.loopxDir, "alias")).isDirectory()).toBe(
            true,
          );
          expect(existsSync(join(project!.loopxDir, "real-workflow"))).toBe(false);
          expect(existsSync(join(project!.loopxDir, "other"))).toBe(false);
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "alias"),
          ]);
          expect(readFileSync(join(project!.loopxDir, "alias", ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
        });
      });

      it("T-INST-55z / T-INST-55za: root-level script symlink classification follows file targets but not directory targets", async () => {
        project = await createTempProject();
        const positiveSource = await createManualGitSource(
          project.dir,
          "root-script-link",
          async (workDir) => {
            await mkdir(join(workDir, "scripts"), { recursive: true });
            await writeFile(
              join(workDir, "scripts", "real-index.sh"),
              "#!/bin/bash\nexit 0\n",
              "utf-8",
            );
            await chmod(join(workDir, "scripts", "real-index.sh"), 0o755);
            symlinkSync("scripts/real-index.sh", join(workDir, "index.sh"));
          },
        );
        const positive = await runCLI(
          ["install", "--no-install", positiveSource],
          { cwd: project.dir, runtime },
        );
        expect(positive.exitCode).toBe(0);
        expect(
          lstatSync(join(project.loopxDir, "root-script-link", "index.sh")).isFile(),
        ).toBe(true);
        expect(
          await runCLI(["run", "-n", "1", "root-script-link"], {
            cwd: project.dir,
            runtime,
          }),
        ).toMatchObject({ exitCode: 0 });

        const negativeProject = await createTempProject();
        try {
          const negativeSource = await createManualGitSource(
            negativeProject.dir,
            "root-script-dir-link",
            async (workDir) => {
              await mkdir(join(workDir, "dir"), { recursive: true });
              await writeFile(join(workDir, "dir", "helper.txt"), "not a script");
              symlinkSync("dir", join(workDir, "index.sh"));
            },
          );
          const negative = await runCLI(
            ["install", "--no-install", negativeSource],
            { cwd: negativeProject.dir, runtime },
          );
          expect(negative.exitCode).toBe(1);
          expect(readdirSync(negativeProject.loopxDir)).toEqual([]);
        } finally {
          await negativeProject.cleanup();
        }
      });

      it("T-INST-55h / T-INST-55l / T-INST-55m / T-INST-55s / T-INST-55zd: selected broken, cyclic, and out-of-source symlinks are rejected atomically", async () => {
        project = await createTempProject();
        const outsideDir = await mkdtemp(join(tmpdir(), "loopx-outside-"));
        try {
          const outsideFile = join(outsideDir, "outside.sh");
          await writeFile(outsideFile, "#!/bin/bash\nexit 0\n", "utf-8");
          await chmod(outsideFile, 0o755);
          const source = await createManualGitSource(
            project.dir,
            "bad-symlinks",
            async (workDir) => {
              await mkdir(join(workDir, "broken"), { recursive: true });
              await writeFile(join(workDir, "broken", "check.sh"), BASH_STOP);
              await chmod(join(workDir, "broken", "check.sh"), 0o755);
              symlinkSync("missing-target", join(workDir, "broken", "index.sh"));

              await mkdir(join(workDir, "cycle"), { recursive: true });
              await writeFile(join(workDir, "cycle", "check.sh"), BASH_STOP);
              await chmod(join(workDir, "cycle", "check.sh"), 0o755);
              symlinkSync("a", join(workDir, "cycle", "index.sh"));
              symlinkSync("b", join(workDir, "cycle", "a"));
              symlinkSync("a", join(workDir, "cycle", "b"));

              await mkdir(join(workDir, "outside"), { recursive: true });
              await writeFile(join(workDir, "outside", "check.sh"), BASH_STOP);
              await chmod(join(workDir, "outside", "check.sh"), 0o755);
              symlinkSync(outsideFile, join(workDir, "outside", "index.sh"));

              await mkdir(join(workDir, "nested", "lib"), { recursive: true });
              await writeFile(join(workDir, "nested", "index.sh"), BASH_STOP);
              await chmod(join(workDir, "nested", "index.sh"), 0o755);
              symlinkSync("../../missing", join(workDir, "nested", "lib", "asset"));

              symlinkSync("no-such-workflow", join(workDir, "badalias"));
            },
          );

          for (const selected of ["broken", "cycle", "outside", "nested", "badalias"]) {
            const result = await runCLI(
              ["install", "--no-install", "-w", selected, source],
              { cwd: project.dir, runtime },
            );
            expect(result.exitCode).toBe(1);
            expect(existsSync(join(project.loopxDir, selected))).toBe(false);
          }
          expect(readdirSync(project.loopxDir)).toEqual([]);
          expect(existsSync(outsideFile)).toBe(true);
        } finally {
          await rm(outsideDir, { recursive: true, force: true });
        }
      });

      it("T-INST-55i / T-INST-55i2 / T-INST-55i3 / T-INST-55t: -w ignores bad symlinks outside the selected workflow but rejects them when selected", async () => {
        project = await createTempProject();
        const source = await createManualGitSource(
          project.dir,
          "selective-bad-symlinks",
          async (workDir) => {
            await mkdir(join(workDir, "ralph"), { recursive: true });
            await writeFile(join(workDir, "ralph", "index.sh"), BASH_STOP);
            await chmod(join(workDir, "ralph", "index.sh"), 0o755);
            await mkdir(join(workDir, "broken"), { recursive: true });
            await writeFile(join(workDir, "broken", "check.sh"), BASH_STOP);
            await chmod(join(workDir, "broken", "check.sh"), 0o755);
            symlinkSync("missing-target", join(workDir, "broken", "index.sh"));
            symlinkSync("missing-top-level-target", join(workDir, "badalias"));
            await mkdir(join(workDir, "support"), { recursive: true });
            symlinkSync("missing-support-target", join(workDir, "support", "asset"));
          },
        );

        const selectedGood = await runCLI(
          ["install", "--no-install", "-w", "ralph", source],
          { cwd: project.dir, runtime },
        );
        expect(selectedGood.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph", "index.sh"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "broken"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "badalias"))).toBe(false);
        expect(selectedGood.stderr).not.toMatch(/broken|badalias|support/i);

        const selectedBad = await runCLI(
          ["install", "--no-install", "-w", "broken", source],
          { cwd: project.dir, runtime },
        );
        expect(selectedBad.exitCode).toBe(1);
      });

      it("T-INST-55l2 / T-INST-55l3 / T-INST-55ze / T-INST-55zf / T-INST-55zg / T-INST-55zi / T-INST-55zj: source-symlink rejection wins before commit and auto-install", async () => {
        project = await createTempProject();
        const source = await createManualGitSource(
          project.dir,
          "faulted-symlink-targets",
          async (workDir) => {
            await mkdir(join(workDir, "ralph"), { recursive: true });
            await writeFile(join(workDir, "ralph", "index.sh"), BASH_STOP);
            await chmod(join(workDir, "ralph", "index.sh"), 0o755);
            await writeFile(
              join(workDir, "ralph", "package.json"),
              JSON.stringify({ name: "ralph", version: "1.0.0" }),
            );
            await mkdir(join(workDir, "shared"), { recursive: true });
            for (const name of [
              "asset-target",
              "alias-target",
              "pkg-target",
              "inner-target",
              "gitignore-target",
              "root-script-target",
            ]) {
              await writeFile(join(workDir, "shared", name), "placeholder");
            }
            symlinkSync("../shared/asset-target", join(workDir, "ralph", "asset"));
            symlinkSync("shared/alias-target", join(workDir, "badalias"));
            symlinkSync("../shared/pkg-target", join(workDir, "ralph", "pkg-link.json"));
            symlinkSync("../shared/gitignore-target", join(workDir, "ralph", ".gitignore"));
            await mkdir(join(workDir, "ralph", "materialized-dir"), {
              recursive: true,
            });
            symlinkSync(
              "../../shared/inner-target",
              join(workDir, "ralph", "materialized-dir", "inner-link"),
            );
            symlinkSync("shared/root-script-target", join(workDir, "check.sh"));
          },
        );

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(["install", source], {
            cwd: project!.dir,
            runtime,
            env: {
              ...env,
              NODE_ENV: "test",
              LOOPX_TEST_INSTALL_FAULT:
                "source-target-replace-with-fifo:shared/asset-target,shared/alias-target,shared/pkg-target,shared/inner-target,shared/gitignore-target,shared/root-script-target",
            },
          });

          expect(result.exitCode).toBe(1);
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          expect(readdirSync(project!.loopxDir)).toEqual([]);
          expect(result.stderr).not.toMatch(/auto.?install.*fail|npm install.*fail/i);
        });
      });

      it("T-INST-55o / T-INST-55p / T-INST-55r / T-INST-55u: symlink alias names, entry-type policy, and script collisions match runtime discovery", async () => {
        project = await createTempProject();
        const invalidAliasSource = await createManualGitSource(
          project.dir,
          "invalid-alias",
          async (workDir) => {
            await mkdir(join(workDir, "real"), { recursive: true });
            await writeFile(join(workDir, "real", "index.sh"), BASH_STOP);
            await chmod(join(workDir, "real", "index.sh"), 0o755);
            symlinkSync("real", join(workDir, "-bad-alias"));
          },
        );
        const invalidAlias = await runCLI(
          ["install", "--no-install", invalidAliasSource],
          { cwd: project.dir, runtime },
        );
        expect(invalidAlias.exitCode).toBe(1);
        expect(existsSync(join(project.loopxDir, "-bad-alias"))).toBe(false);

        const entryPolicyProject = await createTempProject();
        try {
          const entryPolicySource = await createManualGitSource(
            entryPolicyProject.dir,
            "entry-policy",
            async (workDir) => {
              await writeFile(join(workDir, "not-a-workflow-target"), "file");
              symlinkSync("not-a-workflow-target", join(workDir, "alias"));
              await mkdir(join(workDir, "ralph", "dir-target"), {
                recursive: true,
              });
              await writeFile(join(workDir, "ralph", "dir-target", ".keep"), "");
              await writeFile(join(workDir, "ralph", "check.sh"), BASH_STOP);
              await chmod(join(workDir, "ralph", "check.sh"), 0o755);
              symlinkSync("dir-target", join(workDir, "ralph", "index.sh"));
              await mkdir(join(workDir, "support-dir"), { recursive: true });
              await writeFile(join(workDir, "support-dir", "README.md"), "support");
              symlinkSync("support-dir", join(workDir, "support-alias"));
            },
          );
          const entryPolicy = await runCLI(
            ["install", "--no-install", entryPolicySource],
            { cwd: entryPolicyProject.dir, runtime },
          );
          expect(entryPolicy.exitCode).toBe(0);
          expect(existsSync(join(entryPolicyProject.loopxDir, "alias"))).toBe(false);
          expect(existsSync(join(entryPolicyProject.loopxDir, "support-alias"))).toBe(
            false,
          );
          expect(
            lstatSync(
              join(entryPolicyProject.loopxDir, "ralph", "index.sh"),
            ).isDirectory(),
          ).toBe(true);
          const missingIndex = await runCLI(
            ["run", "-n", "1", "ralph"],
            { cwd: entryPolicyProject.dir, runtime },
          );
          expect(missingIndex.exitCode).toBe(1);
          const check = await runCLI(["run", "-n", "1", "ralph:check"], {
            cwd: entryPolicyProject.dir,
            runtime,
          });
          expect(check.exitCode).toBe(0);
        } finally {
          await entryPolicyProject.cleanup();
        }

        const collisionProject = await createTempProject();
        try {
          const collisionSource = await createManualGitSource(
            collisionProject.dir,
            "symlink-collision",
            async (workDir) => {
              await mkdir(join(workDir, "ralph", "lib"), { recursive: true });
              await writeFile(join(workDir, "ralph", "check.sh"), BASH_STOP);
              await chmod(join(workDir, "ralph", "check.sh"), 0o755);
              await writeFile(
                join(workDir, "ralph", "lib", "real-check.ts"),
                "console.log('check');\n",
              );
              symlinkSync("lib/real-check.ts", join(workDir, "ralph", "check.ts"));
            },
          );
          const collision = await runCLI(
            ["install", "--no-install", collisionSource],
            { cwd: collisionProject.dir, runtime },
          );
          expect(collision.exitCode).toBe(1);
          expect(collision.stderr).toMatch(/collision|ambiguous|check/i);
          expect(existsSync(join(collisionProject.loopxDir, "ralph"))).toBe(false);
        } finally {
          await collisionProject.cleanup();
        }
      });

      it("T-INST-55v / T-INST-55v2 / T-INST-55v3 / T-INST-55w / T-INST-55x / T-INST-55x2 / T-INST-55y: package.json source symlinks materialize before package dispatch", async () => {
        project = await createTempProject();
        const validSource = await createManualGitSource(
          project.dir,
          "pkg-symlink-valid",
          async (workDir) => {
            await mkdir(join(workDir, "shared"), { recursive: true });
            await writeFile(
              join(workDir, "shared", "pkg.json"),
              JSON.stringify({ name: "ralph", version: "1.0.0" }),
            );
            await mkdir(join(workDir, "ralph"), { recursive: true });
            await writeFile(join(workDir, "ralph", "index.sh"), BASH_STOP);
            await chmod(join(workDir, "ralph", "index.sh"), 0o755);
            symlinkSync("../shared/pkg.json", join(workDir, "ralph", "package.json"));
          },
        );
        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(["install", validSource], {
            cwd: project!.dir,
            runtime,
            env,
          });
          expect(result.exitCode).toBe(0);
          expect(lstatSync(join(project!.loopxDir, "ralph", "package.json")).isFile()).toBe(
            true,
          );
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "ralph"),
          ]);
        });

        const malformedProject = await createTempProject();
        try {
          const malformedSource = await createManualGitSource(
            malformedProject.dir,
            "pkg-symlink-malformed",
            async (workDir) => {
              await mkdir(join(workDir, "shared"), { recursive: true });
              await writeFile(join(workDir, "shared", "pkg.json"), "{broken");
              await mkdir(join(workDir, "ralph"), { recursive: true });
              await writeFile(join(workDir, "ralph", "index.sh"), BASH_STOP);
              await chmod(join(workDir, "ralph", "index.sh"), 0o755);
              symlinkSync(
                "../shared/pkg.json",
                join(workDir, "ralph", "package.json"),
              );
            },
          );
          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const result = await runCLI(["install", malformedSource], {
              cwd: malformedProject.dir,
              runtime,
              env,
            });
            expect(result.exitCode).toBe(0);
            expect(readNpmInvocations(logFile)).toHaveLength(0);
            expect(countInvalidJsonWarnings(result.stderr, "ralph")).toBe(1);
            expect(
              lstatSync(
                join(malformedProject.loopxDir, "ralph", "package.json"),
              ).isFile(),
            ).toBe(true);
          });
        } finally {
          await malformedProject.cleanup();
        }

        const mismatchProject = await createTempProject();
        try {
          const mismatchSource = await createManualGitSource(
            mismatchProject.dir,
            "pkg-symlink-mismatch",
            async (workDir) => {
              await mkdir(join(workDir, "shared"), { recursive: true });
              await writeFile(
                join(workDir, "shared", "pkg.json"),
                JSON.stringify({ dependencies: { loopx: unsatisfiedRange() } }),
              );
              await mkdir(join(workDir, "ralph"), { recursive: true });
              await writeFile(join(workDir, "ralph", "index.sh"), BASH_STOP);
              await chmod(join(workDir, "ralph", "index.sh"), 0o755);
              symlinkSync(
                "../shared/pkg.json",
                join(workDir, "ralph", "package.json"),
              );
            },
          );
          const refused = await runCLI(["install", mismatchSource], {
            cwd: mismatchProject.dir,
            runtime,
          });
          expect(refused.exitCode).toBe(1);
          const forced = await runCLI(
            ["install", "-y", "--no-install", mismatchSource],
            { cwd: mismatchProject.dir, runtime },
          );
          expect(forced.exitCode).toBe(0);
          expect(
            readFileSync(
              join(mismatchProject.loopxDir, "ralph", "package.json"),
              "utf-8",
            ),
          ).toContain(unsatisfiedRange());
        } finally {
          await mismatchProject.cleanup();
        }

        const directoryProject = await createTempProject();
        try {
          const directorySource = await createManualGitSource(
            directoryProject.dir,
            "pkg-symlink-dir",
            async (workDir) => {
              await mkdir(join(workDir, "shared", "pkg-dir"), { recursive: true });
              await writeFile(join(workDir, "shared", "pkg-dir", "README"), "dir");
              await mkdir(join(workDir, "ralph"), { recursive: true });
              await writeFile(join(workDir, "ralph", "index.sh"), BASH_STOP);
              await chmod(join(workDir, "ralph", "index.sh"), 0o755);
              symlinkSync(
                "../shared/pkg-dir",
                join(workDir, "ralph", "package.json"),
              );
            },
          );
          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const result = await runCLI(["install", directorySource], {
              cwd: directoryProject.dir,
              runtime,
              env,
            });
            expect(result.exitCode).toBe(0);
            expect(readNpmInvocations(logFile)).toHaveLength(0);
            expect(
              lstatSync(
                join(directoryProject.loopxDir, "ralph", "package.json"),
              ).isDirectory(),
            ).toBe(true);
            expect(result.stderr).toMatch(/ralph|package\.json/i);
          });
        } finally {
          await directoryProject.cleanup();
        }

        const badProject = await createTempProject();
        try {
          const badSource = await createManualGitSource(
            badProject.dir,
            "pkg-symlink-bad",
            async (workDir) => {
              await mkdir(join(workDir, "ralph"), { recursive: true });
              await writeFile(join(workDir, "ralph", "index.sh"), BASH_STOP);
              await chmod(join(workDir, "ralph", "index.sh"), 0o755);
              symlinkSync("missing-pkg", join(workDir, "ralph", "package.json"));
            },
          );
          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const result = await runCLI(["install", badSource], {
              cwd: badProject.dir,
              runtime,
              env,
            });
            expect(result.exitCode).toBe(1);
            expect(readNpmInvocations(logFile)).toHaveLength(0);
            expect(readdirSync(badProject.loopxDir)).toEqual([]);
            expect(result.stderr).not.toMatch(/invalid.*json|semver/i);
          });
        } finally {
          await badProject.cleanup();
        }
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Workflow Classification — Zero-Workflow Source (T-INST-56 … 56e)
  // ═══════════════════════════════════════════════════════════

  describe("Workflow Classification — Zero-Workflow Source", () => {
    forEachRuntime((runtime) => {
      it("T-INST-56: no root scripts, no qualifying subdirs → error", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "empty",
            files: { "README.md": "nothing" },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/empty.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-56a: legacy directory-script source (package.json main) → zero-workflow", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "legacy",
            files: {
              "package.json": '{"main":"src/app/run.js"}',
              "src/app/run.js": 'console.log("x");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/legacy.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-56e: legacy directory-script rejected without migration-guidance messaging", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "legacy",
            files: {
              "package.json": '{"main":"src/app/run.js"}',
              "src/app/run.js": 'console.log("x");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/legacy.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(hasWarningCategoryFor(result.stderr, "package.json")).toBe(
          false,
        );
        expect(hasWarningCategoryFor(result.stderr, "src/app/run.js")).toBe(
          false,
        );
        expect(hasWarningCategoryFor(result.stderr, "main")).toBe(false);
      });

      it("T-INST-56c: root-only index.mjs → zero-workflow error", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "mjs-only",
            files: { "index.mjs": 'console.log("x");' },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/mjs-only.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-56d: root-only index.cjs → zero-workflow error", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "cjs-only",
            files: { "index.cjs": 'console.log("x");' },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/cjs-only.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-56b: tarball with no installable workflows → error", async () => {
        project = await createTempProject();
        // Per TEST-SPEC T-INST-56b: script files must be NESTED inside the
        // candidate subdirectory (not at its top level) so the subdirectory
        // does not qualify as a workflow. `lib/src/helpers.ts` keeps lib/'s
        // top level empty of scripts.
        const tarball = await makeTarball(
          {
            "README.md": "readme",
            "lib/src/helpers.ts": "export const x = 1;",
          },
          { wrapperDir: "empty" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/empty.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/empty.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-56f: root-only uppercase script extension is unsupported", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "uppercase-only",
            files: { "index.SH": "echo nope\n" },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/uppercase-only.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(readdirSync(project.loopxDir)).toEqual([]);
      });

      it("T-INST-56g: uppercase-extension subdirectory is skipped as non-workflow", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.TS": "console.log('nope');\n",
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
      });

      it("T-INST-56h: uppercase-extension root file is preserved as non-script content in a valid workflow", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "uppercase-content",
            files: {
              "index.sh": BASH_STOP,
              "helper.TS": "export const helper = true;\n",
            },
          },
        ]);
        const result = await runCLI(
          ["install", "--no-install", `${gitServer.url}/uppercase-content.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          readFileSync(
            join(project.loopxDir, "uppercase-content", "helper.TS"),
            "utf-8",
          ),
        ).toBe("export const helper = true;\n");
        const helper = await runCLI(
          ["run", "-n", "1", "uppercase-content:helper"],
          { cwd: project.dir, runtime },
        );
        expect(helper.exitCode).toBe(1);
      });

      it("T-INST-56i: root directory named like a script does not classify as a script file", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "script-dir-only",
            files: { "index.sh/notes.md": "directory, not script" },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/script-dir-only.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).not.toMatch(/invalid.*index/i);
        expect(readdirSync(project.loopxDir)).toEqual([]);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Selective Workflow Installation (T-INST-57 … 60s)
  // ═══════════════════════════════════════════════════════════

  describe("Selective Workflow Installation", () => {
    forEachRuntime((runtime) => {
      it("T-INST-57: -w ralph installs only ralph", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
      });

      it("T-INST-57a: --workflow ralph equivalent to -w ralph", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "--workflow", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
      });

      it("T-INST-57b: -w ralph does not copy root support files/dirs or sibling workflows", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
              "README.md": "readme",
              "package.json": '{"name":"multi"}',
              "docs/a.md": "a",
              "shared/b.json": "{}",
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "README.md"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "package.json"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "docs"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "shared"))).toBe(false);
      });

      it("T-INST-57c: -w ralph from tarball installs only ralph", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          {
            "ralph/index.sh": BASH_STOP,
            "other/index.sh": BASH_STOP,
          },
          { wrapperDir: "multi" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/multi.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${httpServer.url}/multi.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "ralph", "index.sh")),
        ).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
      });

      it("T-INST-58: -w nonexistent → error (workflow not in source)", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "nonexistent", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(existsSync(join(project.loopxDir, "nonexistent"))).toBe(false);
      });

      it("T-INST-59: -w on single-workflow source → error", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "single",
            files: {
              "index.ts": 'console.log("hi");',
              "lib/helpers.ts": "export const x = 1;",
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/single.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-59a: --workflow on single-workflow source → error", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "single",
            files: {
              "index.ts": 'console.log("hi");',
              "lib/helpers.ts": "export const x = 1;",
            },
          },
        ]);
        const result = await runCLI(
          ["install", "--workflow", "ralph", `${gitServer.url}/single.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-59b: -w on single-workflow with non-index root script → error", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "single",
            files: {
              "setup.ts": 'console.log("s");',
              "lib/helpers.ts": "export const x = 1;",
              "src/utils.js": 'console.log("u");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/single.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-60: with -w, only selected workflow validated, invalid siblings don't block", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "broken/-bad.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "broken"))).toBe(false);
      });

      it("T-INST-60a: -w, invalid script name in unselected sibling ignored", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "broken/-bad.sh": BASH_STOP,
              "broken/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-60b: -w, version mismatch in unselected sibling ignored, no warning", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
              "other/package.json": JSON.stringify({
                dependencies: { loopx: unsatisfiedRange() },
              }),
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(hasVersionMismatchWarning(result.stderr, "other")).toBe(false);
      });

      it("T-INST-60c: -w, destination collisions for unselected sibling ignored", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "other", "index", 'exit 0');
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
      });

      it("T-INST-60d: -w, invalid workflow name on unselected sibling ignored", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "-bad-name/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-60e: -w, same-base-name collision in unselected sibling ignored", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/check.sh": BASH_STOP,
              "other/check.ts": 'console.log("c");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
      });

      it("T-INST-60f: -w, broken package.json in unselected sibling emits no warning", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "broken/index.sh": BASH_STOP,
              "broken/package.json": "{broken",
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(hasAnyPackageJsonWarning(result.stderr, "broken")).toBe(false);
      });

      it("T-INST-60g: -w, selected workflow's invalid script names fatal", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "broken/-bad.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "broken", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-60h: -w, selected workflow's same-base-name collisions fatal", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "broken/check.sh": BASH_STOP,
              "broken/check.ts": 'console.log("c");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "broken", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-60i: -w, selected workflow's version mismatch blocking", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "ralph/package.json": JSON.stringify({
                dependencies: { loopx: unsatisfiedRange() },
              }),
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-60j: -w -y, selected workflow's version mismatch overridden", async () => {
        project = await createTempProject();
        const pkg = JSON.stringify({
          dependencies: { loopx: unsatisfiedRange() },
        });
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "ralph/package.json": pkg,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          [
            "install",
            "-w",
            "ralph",
            "-y",
            "--no-install",
            `${gitServer.url}/multi.git`,
          ],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        const installedPkg = readFileSync(
          join(project.loopxDir, "ralph", "package.json"),
          "utf-8",
        );
        expect(installedPkg).toContain(unsatisfiedRange());
      });

      it("T-INST-60k: -w, selected workflow's destination collision blocking", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", 'exit 0');
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-60l: -w -y, selected workflow's destination collision overridden", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          'echo "OLD_CONTENT" > /dev/null',
        );
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": '#!/bin/bash\nprintf \'{"new":true}\'\n',
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          [
            "install",
            "-w",
            "ralph",
            "-y",
            `${gitServer.url}/multi.git`,
          ],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        const content = readFileSync(
          join(project.loopxDir, "ralph", "index.sh"),
          "utf-8",
        );
        expect(content).toContain('{"new":true}');
        expect(content).not.toContain("OLD_CONTENT");
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
      });

      it("T-INST-60p: -w -y, non-workflow destination still causes failure", async () => {
        project = await createTempProject();
        // Create a plain file at .loopx/ralph (not a workflow directory)
        await writeFile(join(project.loopxDir, "ralph"), "plain file", "utf-8");
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          [
            "install",
            "-w",
            "ralph",
            "-y",
            `${gitServer.url}/multi.git`,
          ],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        // The plain file must still exist (not replaced)
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(statSync(join(project.loopxDir, "ralph")).isFile()).toBe(true);
      });

      it("T-INST-60m: -w, selecting workflow with invalid name → error", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "-bad-name/index.sh": BASH_STOP,
              "good/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "-bad-name", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-60n: --workflow long form exercises same selective-validation as -w", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "broken/-bad.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          [
            "install",
            "--workflow",
            "ralph",
            `${gitServer.url}/multi.git`,
          ],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
      });

      it("T-INST-60o: -w, selecting non-qualifying subdirectory (legacy) → error", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "good/index.sh": BASH_STOP,
              "legacy/package.json": '{"main":"src/run.js"}',
              "legacy/src/run.js": 'console.log("x");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "legacy", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-60q: -w, selected workflow's broken package.json → non-fatal warning", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "ralph/package.json": "{broken",
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(countInvalidJsonWarnings(result.stderr, "ralph")).toBe(1);
        expect(existsSync(join(project.loopxDir, "ralph", "index.sh"))).toBe(
          true,
        );
        expect(
          existsSync(join(project.loopxDir, "ralph", "package.json")),
        ).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
      });

      it.skipIf(IS_ROOT)(
        "T-INST-60r: -w, selected workflow's unreadable package.json → non-fatal warning (tarball)",
        async () => {
          project = await createTempProject();
          const tarball = await makeTarball(
            {
              "ralph/index.sh": BASH_STOP,
              "ralph/package.json": {
                content: "{}",
                mode: 0o000,
              },
              "other/index.sh": BASH_STOP,
            },
            { wrapperDir: "multi" },
          );
          httpServer = await startLocalHTTPServer([
            tarballRoute("/multi.tar.gz", tarball),
          ]);
          const result = await runCLI(
            [
              "install",
              "-w",
              "ralph",
              `${httpServer.url}/multi.tar.gz`,
            ],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(0);
          expect(countUnreadableWarnings(result.stderr, "ralph")).toBe(1);
          expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
          try {
            chmodSync(
              join(project.loopxDir, "ralph", "package.json"),
              0o644,
            );
          } catch {}
        },
      );

      it("T-INST-60s: -w, selected workflow's invalid semver range → non-fatal warning", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "ralph/package.json": JSON.stringify({
                dependencies: { loopx: "not-a-range!!!" },
              }),
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "ralph", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(countInvalidSemverWarnings(result.stderr, "ralph")).toBe(1);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
      });

      it("T-INST-60t: -w selected workflow with package.json directory emits one non-fatal warning", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "ralph/package.json/README": "directory package marker",
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          [
            "install",
            "--no-install",
            "-w",
            "ralph",
            `${gitServer.url}/multi.git`,
          ],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/ralph/i);
        expect(result.stderr).toMatch(/package\.json/i);
        expect(
          lstatSync(join(project.loopxDir, "ralph", "package.json")).isDirectory(),
        ).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
      });

      it("T-INST-60u: -w unselected sibling with package.json directory emits no warning", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "broken/index.sh": BASH_STOP,
              "broken/package.json/README": "directory package marker",
            },
          },
        ]);
        const result = await runCLI(
          [
            "install",
            "--no-install",
            "-w",
            "ralph",
            `${gitServer.url}/multi.git`,
          ],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph", "index.sh"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "broken"))).toBe(false);
        expect(result.stderr).not.toMatch(/broken|package\.json/i);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Install-time Validation (T-INST-61 … 64d, 52b)
  // ═══════════════════════════════════════════════════════════

  describe("Install-time Validation", () => {
    forEachRuntime((runtime) => {
      it("T-INST-42m: unsupported .mjs/.cjs files are copied as workflow content, not scripts", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "unsupported-content",
            files: {
              "index.sh": BASH_STOP,
              "helper.mjs": "export const helper = true;\n",
              "tool.cjs": "module.exports = { tool: true };\n",
            },
          },
        ]);

        const result = await runCLI(
          ["install", "--no-install", `${gitServer.url}/unsupported-content.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          readFileSync(
            join(project.loopxDir, "unsupported-content", "helper.mjs"),
            "utf-8",
          ),
        ).toBe("export const helper = true;\n");
        expect(
          readFileSync(
            join(project.loopxDir, "unsupported-content", "tool.cjs"),
            "utf-8",
          ),
        ).toBe("module.exports = { tool: true };\n");
        expect(result.stderr).not.toMatch(/helper\.mjs|tool\.cjs|unsupported/i);

        const indexResult = await runCLI(
          ["run", "-n", "1", "unsupported-content"],
          { cwd: project.dir, runtime },
        );
        expect(indexResult.exitCode).toBe(0);
        const helperResult = await runCLI(
          ["run", "-n", "1", "unsupported-content:helper"],
          { cwd: project.dir, runtime },
        );
        expect(helperResult.exitCode).toBe(1);
        expect(helperResult.stderr).toMatch(/not found|missing|script/i);
        const toolResult = await runCLI(
          ["run", "-n", "1", "unsupported-content:tool"],
          { cwd: project.dir, runtime },
        );
        expect(toolResult.exitCode).toBe(1);
        expect(toolResult.stderr).toMatch(/not found|missing|script/i);
      });

      it("T-INST-42n: unsupported same-base .mjs/.cjs siblings do not collide with supported scripts", async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "check-ran");
        gitServer = await startLocalGitServer([
          {
            name: "collision-immune",
            files: {
              "check.sh": `#!/bin/bash\nprintf ran > ${JSON.stringify(markerPath)}\n`,
              "check.mjs": "export const built = true;\n",
              "check.cjs": "module.exports = { built: true };\n",
            },
          },
        ]);

        const result = await runCLI(
          ["install", "--no-install", `${gitServer.url}/collision-immune.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        for (const file of ["check.sh", "check.mjs", "check.cjs"]) {
          expect(existsSync(join(project.loopxDir, "collision-immune", file))).toBe(
            true,
          );
        }
        expect(result.stderr).not.toMatch(/collision|ambiguous|check\.mjs|check\.cjs/i);

        const runResult = await runCLI(
          ["run", "-n", "1", "collision-immune:check"],
          { cwd: project.dir, runtime },
        );
        expect(runResult.exitCode).toBe(0);
        expect(readFileSync(markerPath, "utf-8")).toBe("ran");
      });

      it("T-INST-61: invalid script name (-bad.sh) → install fails", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "bad",
            files: {
              "index.sh": BASH_STOP,
              "-bad.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/bad.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-62: same-base-name collision (check.sh + check.ts) → install fails", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "bad",
            files: {
              "index.sh": BASH_STOP,
              "check.sh": BASH_STOP,
              "check.ts": 'console.log("c");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/bad.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-62a: index.sh + index.ts collision → install fails", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "bad",
            files: {
              "index.sh": BASH_STOP,
              "index.ts": 'console.log("x");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/bad.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-63: invalid derived workflow name → install fails", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "pkg" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/-bad.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/-bad.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-63a: digit-start workflow name valid at install time", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "3checks",
            files: { "check.sh": BASH_STOP },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/3checks.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "3checks"))).toBe(true);
      });

      it("T-INST-63b: install rejects workflow name containing ':'", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "pkg" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/my:workflow.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/my:workflow.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-63c: install rejects a script base name containing ':'", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "bad",
            files: {
              "index.sh": BASH_STOP,
              "check:ready.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/bad.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-63d: numeric script names valid at install time", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "numeric",
            files: {
              "index.sh": BASH_STOP,
              "1start.sh": BASH_STOP,
              "42.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/numeric.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "numeric", "1start.sh")),
        ).toBe(true);
        expect(existsSync(join(project.loopxDir, "numeric", "42.sh"))).toBe(
          true,
        );
      });

      it("T-INST-63e: install rejects multi-workflow subdir name containing ':' — atomic", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          {
            "foo:bar/index.sh": BASH_STOP,
            "other/index.sh": BASH_STOP,
          },
          { wrapperDir: "multi" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/multi.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/multi.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(existsSync(join(project.loopxDir, "foo:bar"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
      });

      it("T-INST-63f: uppercase workflow and script names are valid and case-preserved", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "MyWorkflow/index.sh": BASH_STOP,
              "MyWorkflow/CheckReady.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "--no-install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "MyWorkflow"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "myworkflow"))).toBe(false);
        expect(
          existsSync(join(project.loopxDir, "MyWorkflow", "CheckReady.sh")),
        ).toBe(true);
        const runResult = await runCLI(
          ["run", "-n", "1", "MyWorkflow:CheckReady"],
          { cwd: project.dir, runtime },
        );
        expect(runResult.exitCode).toBe(0);
      });

      it("T-INST-63g: underscore-prefix script base name is valid at install time", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "underscore-script",
            files: {
              "index.sh": BASH_STOP,
              "_check.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "--no-install", `${gitServer.url}/underscore-script.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "underscore-script", "_check.sh")),
        ).toBe(true);
        const runResult = await runCLI(
          ["run", "-n", "1", "underscore-script:_check"],
          { cwd: project.dir, runtime },
        );
        expect(runResult.exitCode).toBe(0);
      });

      it("T-INST-64: missing index script allowed for single-workflow sources", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "no-index",
            files: { "check.sh": BASH_STOP },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/no-index.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "no-index", "check.sh")),
        ).toBe(true);
      });

      it("T-INST-64b: missing index script allowed for multi-workflow sources", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "tools/check.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "tools", "check.sh"))).toBe(
          true,
        );
        expect(existsSync(join(project.loopxDir, "other", "index.sh"))).toBe(
          true,
        );
      });

      it("T-INST-64c: missing index script allowed for multi-workflow with -w scoping", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "tools/check.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-w", "tools", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "tools", "check.sh"))).toBe(
          true,
        );
        expect(existsSync(join(project.loopxDir, "other"))).toBe(false);
      });

      it("T-INST-64a: install-time validation is non-recursive (nested invalid files OK, single-workflow)", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "single",
            files: {
              "index.ts": 'console.log("r");',
              "lib/-bad.ts": 'console.log("x");',
              "lib/check.sh": BASH_STOP,
              "lib/check.ts": 'console.log("c");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/single.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "single", "lib", "-bad.ts")),
        ).toBe(true);
        expect(
          existsSync(join(project.loopxDir, "single", "lib", "check.sh")),
        ).toBe(true);
        expect(
          existsSync(join(project.loopxDir, "single", "lib", "check.ts")),
        ).toBe(true);
      });

      it("T-INST-64d: install-time validation is non-recursive (nested invalid files OK, multi-workflow)", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "ralph/lib/-bad.ts": 'console.log("x");',
              "ralph/lib/check.sh": BASH_STOP,
              "ralph/lib/check.ts": 'console.log("c");',
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "ralph", "lib", "-bad.ts")),
        ).toBe(true);
      });

      it("T-INST-64e: top-level directory with script-extension name is copied as content, not validated as a script", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "script-shaped-dir",
            files: {
              "index.sh": BASH_STOP,
              "bad.name.ts/notes.md": "directory, not script",
            },
          },
        ]);
        const result = await runCLI(
          ["install", "--no-install", `${gitServer.url}/script-shaped-dir.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          lstatSync(
            join(project.loopxDir, "script-shaped-dir", "bad.name.ts"),
          ).isDirectory(),
        ).toBe(true);
        expect(
          readFileSync(
            join(project.loopxDir, "script-shaped-dir", "bad.name.ts", "notes.md"),
            "utf-8",
          ),
        ).toBe("directory, not script");
        expect(result.stderr).not.toMatch(/bad\.name\.ts/);
        const runResult = await runCLI(
          ["run", "-n", "1", "script-shaped-dir:bad.name"],
          { cwd: project.dir, runtime },
        );
        expect(runResult.exitCode).toBe(1);
      });

      it("T-INST-52b: multi-workflow with workflow-internal config-style file fails validation", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "ralph/eslint.config.js": "module.exports = {};",
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/eslint\.config/);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Collision Handling (T-INST-65 … 71a, 97)
  // ═══════════════════════════════════════════════════════════

  describe("Collision Handling", () => {
    forEachRuntime((runtime) => {
      it("T-INST-65: path does not exist → workflow installed without collision check", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        const result = await runCLI(
          ["install", "--no-install", `${gitServer.url}/repo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "repo"))).toBe(true);
      });

      it("T-INST-66: path exists as workflow → install refused", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "repo", "index", 'exit 0');
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        const result = await runCLI(
          ["install", "--no-install", `${gitServer.url}/repo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-67: path exists as workflow with -y → replaced", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "repo",
          "index",
          'echo "OLD_CONTENT" > /dev/null',
        );
        gitServer = await startLocalGitServer([
          {
            name: "repo",
            files: {
              "index.sh": '#!/bin/bash\nprintf \'{"new":true}\'\n',
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-y", `${gitServer.url}/repo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        const content = readFileSync(
          join(project.loopxDir, "repo", "index.sh"),
          "utf-8",
        );
        expect(content).toContain('{"new":true}');
        expect(content).not.toContain("OLD_CONTENT");
      });

      it("T-INST-67a: path exists as runtime-invalid workflow with -y → replaced", async () => {
        project = await createTempProject();
        // Create an existing "workflow" with invalid content:
        await createBashWorkflowScript(project, "foo", "-bad", 'exit 0');
        await createBashWorkflowScript(project, "foo", "check", 'exit 0');
        await createWorkflowScript(
          project,
          "foo",
          "check",
          ".ts",
          'console.log("x");',
        );
        gitServer = await startLocalGitServer([
          { name: "foo", files: { "index.sh": BASH_STOP } },
        ]);
        const result = await runCLI(
          ["install", "-y", `${gitServer.url}/foo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "foo", "index.sh"))).toBe(
          true,
        );
        expect(existsSync(join(project.loopxDir, "foo", "-bad.sh"))).toBe(
          false,
        );
      });

      it("T-INST-68: path exists but not a workflow by structure → refused even with -y", async () => {
        project = await createTempProject();
        // Non-workflow directory (no top-level script files)
        await mkdir(join(project.loopxDir, "repo"), { recursive: true });
        await writeFile(
          join(project.loopxDir, "repo", "README.md"),
          "readme",
          "utf-8",
        );
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        const result = await runCLI(
          ["install", "-y", `${gitServer.url}/repo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-69: plain file at .loopx/<name> → refused even with -y", async () => {
        project = await createTempProject();
        await writeFile(
          join(project.loopxDir, "repo"),
          "not a directory",
          "utf-8",
        );
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        const result = await runCLI(
          ["install", "-y", `${gitServer.url}/repo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(statSync(join(project.loopxDir, "repo")).isFile()).toBe(true);
      });

      it("T-INST-70 T-INST-70-family: symlink to workflow directory → collision error", async () => {
        project = await createTempProject();
        const extDir = await mkdtemp(join(tmpdir(), "loopx-sym-"));
        try {
          await writeFile(join(extDir, "index.sh"), BASH_STOP, "utf-8");
          await chmod(join(extDir, "index.sh"), 0o755);
          symlinkSync(extDir, join(project.loopxDir, "foo"));
          gitServer = await startLocalGitServer([
            { name: "foo", files: { "index.sh": BASH_STOP } },
          ]);
          const result = await runCLI(
            ["install", `${gitServer.url}/foo.git`],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(1);
        } finally {
          await rm(extDir, { recursive: true, force: true });
        }
      });

      it("T-INST-70b: symlink to workflow with -y → removes symlink, not target", async () => {
        project = await createTempProject();
        const extDir = await mkdtemp(join(tmpdir(), "loopx-sym-"));
        try {
          await writeFile(join(extDir, "index.sh"), BASH_OK, "utf-8");
          await chmod(join(extDir, "index.sh"), 0o755);
          symlinkSync(extDir, join(project.loopxDir, "foo"));
          gitServer = await startLocalGitServer([
            {
              name: "foo",
              files: {
                "index.sh": '#!/bin/bash\nprintf \'{"new":true}\'\n',
              },
            },
          ]);
          const result = await runCLI(
            ["install", "-y", `${gitServer.url}/foo.git`],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(0);
          // .loopx/foo is now a regular directory
          const st = lstatSync(join(project.loopxDir, "foo"));
          expect(st.isSymbolicLink()).toBe(false);
          expect(st.isDirectory()).toBe(true);
          // The external directory is preserved
          expect(existsSync(join(extDir, "index.sh"))).toBe(true);
          const oldContent = readFileSync(join(extDir, "index.sh"), "utf-8");
          expect(oldContent).toBe(BASH_OK);
        } finally {
          await rm(extDir, { recursive: true, force: true });
        }
      });

      it("T-INST-70a: symlink to non-workflow directory → refused even with -y", async () => {
        project = await createTempProject();
        const extDir = await mkdtemp(join(tmpdir(), "loopx-sym-"));
        try {
          await mkdir(join(extDir, "lib"), { recursive: true });
          await writeFile(
            join(extDir, "lib", "helper.ts"),
            "export const x = 1;",
            "utf-8",
          );
          symlinkSync(extDir, join(project.loopxDir, "foo"));
          gitServer = await startLocalGitServer([
            { name: "foo", files: { "index.sh": BASH_STOP } },
          ]);
          const result = await runCLI(
            ["install", "-y", `${gitServer.url}/foo.git`],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(1);
        } finally {
          await rm(extDir, { recursive: true, force: true });
        }
      });

      it("T-INST-70c: symlink to file → refused even with -y", async () => {
        project = await createTempProject();
        const extDir = await mkdtemp(join(tmpdir(), "loopx-sym-"));
        try {
          const targetFile = join(extDir, "target.txt");
          await writeFile(targetFile, "data", "utf-8");
          symlinkSync(targetFile, join(project.loopxDir, "foo"));
          gitServer = await startLocalGitServer([
            { name: "foo", files: { "index.sh": BASH_STOP } },
          ]);
          const result = await runCLI(
            ["install", "-y", `${gitServer.url}/foo.git`],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(1);
        } finally {
          await rm(extDir, { recursive: true, force: true });
        }
      });

      it("T-INST-70d: symlink to validly-structured-but-invalid workflow with -y → replaced", async () => {
        project = await createTempProject();
        const extDir = await mkdtemp(join(tmpdir(), "loopx-sym-"));
        try {
          // Structurally a workflow (has index.sh) but would fail validation
          await writeFile(join(extDir, "index.sh"), BASH_OK, "utf-8");
          await chmod(join(extDir, "index.sh"), 0o755);
          await writeFile(join(extDir, "-bad.sh"), BASH_OK, "utf-8");
          await chmod(join(extDir, "-bad.sh"), 0o755);
          await writeFile(join(extDir, "check.sh"), BASH_OK, "utf-8");
          await chmod(join(extDir, "check.sh"), 0o755);
          await writeFile(
            join(extDir, "check.ts"),
            'console.log("c");',
            "utf-8",
          );
          symlinkSync(extDir, join(project.loopxDir, "foo"));
          gitServer = await startLocalGitServer([
            {
              name: "foo",
              files: {
                "index.sh": '#!/bin/bash\nprintf \'{"new":true}\'\n',
              },
            },
          ]);
          const result = await runCLI(
            ["install", "-y", `${gitServer.url}/foo.git`],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(0);
          const st = lstatSync(join(project.loopxDir, "foo"));
          expect(st.isSymbolicLink()).toBe(false);
          expect(st.isDirectory()).toBe(true);
          // External target still exists
          expect(existsSync(join(extDir, "-bad.sh"))).toBe(true);
        } finally {
          await rm(extDir, { recursive: true, force: true });
        }
      });

      it("T-INST-70e: broken symlink destination is refused even with -y and preserved", async () => {
        project = await createTempProject();
        const target = join(tmpdir(), `loopx-missing-${Date.now()}-${process.pid}`);
        const dest = join(project.loopxDir, "foo");
        symlinkSync(target, dest);
        gitServer = await startLocalGitServer([
          { name: "foo", files: { "index.sh": BASH_STOP } },
        ]);

        const first = await runCLI(["install", `${gitServer.url}/foo.git`], {
          cwd: project.dir,
          runtime,
        });
        expect(first.exitCode).toBe(1);
        expect(lstatSync(dest).isSymbolicLink()).toBe(true);
        expect(readlinkSync(dest)).toBe(target);
        expect(existsSync(target)).toBe(false);

        const forced = await runCLI(
          ["install", "-y", `${gitServer.url}/foo.git`],
          { cwd: project.dir, runtime },
        );
        expect(forced.exitCode).toBe(1);
        expect(lstatSync(dest).isSymbolicLink()).toBe(true);
        expect(readlinkSync(dest)).toBe(target);
        expect(existsSync(target)).toBe(false);
      });

      it("T-INST-71: broken non-workflow siblings do not affect collision eval", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "foo", "index", 'exit 0');
        await mkdir(join(project.loopxDir, "broken"), { recursive: true });
        await writeFile(
          join(project.loopxDir, "broken", "README.md"),
          "readme",
          "utf-8",
        );
        gitServer = await startLocalGitServer([
          {
            name: "foo",
            files: { "index.sh": '#!/bin/bash\nprintf \'{"new":true}\'\n' },
          },
        ]);
        const result = await runCLI(
          ["install", "-y", `${gitServer.url}/foo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        const content = readFileSync(
          join(project.loopxDir, "foo", "index.sh"),
          "utf-8",
        );
        expect(content).toContain('{"new":true}');
      });

      it("T-INST-71a: invalid sibling workflows do not affect collision eval", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "foo", "index", 'exit 0');
        await createBashWorkflowScript(project, "broken", "check", 'exit 0');
        await createWorkflowScript(
          project,
          "broken",
          "check",
          ".ts",
          'console.log("x");',
        );
        gitServer = await startLocalGitServer([
          {
            name: "foo",
            files: {
              "index.sh": '#!/bin/bash\nprintf \'{"new":true}\'\n',
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-y", `${gitServer.url}/foo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        const content = readFileSync(
          join(project.loopxDir, "foo", "index.sh"),
          "utf-8",
        );
        expect(content).toContain('{"new":true}');
      });

      it("T-INST-97: .loopx/foo.sh file does not collide with installing workflow foo", async () => {
        project = await createTempProject();
        await writeFile(join(project.loopxDir, "foo.sh"), BASH_OK, "utf-8");
        gitServer = await startLocalGitServer([
          { name: "foo", files: { "index.sh": BASH_STOP } },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/foo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "foo", "index.sh"))).toBe(
          true,
        );
        // The loose file still exists
        expect(existsSync(join(project.loopxDir, "foo.sh"))).toBe(true);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Version Checking on Install (T-INST-72 … 76a)
  // ═══════════════════════════════════════════════════════════

  describe("Version Checking on Install", () => {
    forEachRuntime((runtime) => {
      it("T-INST-72: workflow declares mismatched loopx range → install refused", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "wf",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                dependencies: { loopx: unsatisfiedRange() },
              }),
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/wf.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-73: -y overrides version mismatch, declaration preserved", async () => {
        project = await createTempProject();
        const pkg = JSON.stringify({
          dependencies: { loopx: unsatisfiedRange() },
        });
        gitServer = await startLocalGitServer([
          {
            name: "wf",
            files: {
              "index.sh": BASH_STOP,
              "package.json": pkg,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-y", "--no-install", `${gitServer.url}/wf.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        const installedPkg = readFileSync(
          join(project.loopxDir, "wf", "package.json"),
          "utf-8",
        );
        expect(installedPkg).toContain(unsatisfiedRange());
      });

      it("T-INST-72a: no-index workflow version mismatch → install refused", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "wf",
            files: {
              "check.sh": BASH_STOP,
              "package.json": JSON.stringify({
                dependencies: { loopx: unsatisfiedRange() },
              }),
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/wf.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-73a: -y overrides no-index workflow version mismatch", async () => {
        project = await createTempProject();
        const pkg = JSON.stringify({
          dependencies: { loopx: unsatisfiedRange() },
        });
        gitServer = await startLocalGitServer([
          {
            name: "wf",
            files: {
              "check.sh": BASH_STOP,
              "package.json": pkg,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-y", "--no-install", `${gitServer.url}/wf.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "wf", "check.sh"))).toBe(
          true,
        );
        const installedPkg = readFileSync(
          join(project.loopxDir, "wf", "package.json"),
          "utf-8",
        );
        expect(installedPkg).toContain(unsatisfiedRange());
      });

      it.skipIf(IS_ROOT)(
        "T-INST-74: workflow package.json unreadable → warning, proceeds (tarball)",
        async () => {
          project = await createTempProject();
          const tarball = await makeTarball(
            {
              "index.sh": BASH_STOP,
              "package.json": { content: "{}", mode: 0o000 },
            },
            { wrapperDir: "wf" },
          );
          httpServer = await startLocalHTTPServer([
            tarballRoute("/wf.tar.gz", tarball),
          ]);
          const result = await runCLI(
            ["install", `${httpServer.url}/wf.tar.gz`],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(0);
          expect(hasUnreadableWarning(result.stderr, "wf")).toBe(true);
          try {
            chmodSync(join(project.loopxDir, "wf", "package.json"), 0o644);
          } catch {}
        },
      );

      it.skipIf(IS_ROOT)(
        "T-INST-74a: no-index workflow unreadable package.json → warning, proceeds",
        async () => {
          project = await createTempProject();
          const tarball = await makeTarball(
            {
              "check.sh": BASH_STOP,
              "package.json": { content: "{}", mode: 0o000 },
            },
            { wrapperDir: "wf" },
          );
          httpServer = await startLocalHTTPServer([
            tarballRoute("/wf.tar.gz", tarball),
          ]);
          const result = await runCLI(
            ["install", `${httpServer.url}/wf.tar.gz`],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(0);
          expect(hasUnreadableWarning(result.stderr, "wf")).toBe(true);
          expect(existsSync(join(project.loopxDir, "wf", "check.sh"))).toBe(
            true,
          );
          try {
            chmodSync(join(project.loopxDir, "wf", "package.json"), 0o644);
          } catch {}
        },
      );

      it("T-INST-75: workflow package.json invalid JSON → warning, proceeds", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "wf",
            files: {
              "index.sh": BASH_STOP,
              "package.json": "{broken",
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/wf.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(hasInvalidJsonWarning(result.stderr, "wf")).toBe(true);
        expect(existsSync(join(project.loopxDir, "wf", "index.sh"))).toBe(
          true,
        );
      });

      it("T-INST-75a: no-index workflow invalid-JSON package.json → warning, proceeds", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "wf",
            files: {
              "check.sh": BASH_STOP,
              "package.json": "{broken",
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/wf.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(hasInvalidJsonWarning(result.stderr, "wf")).toBe(true);
        expect(existsSync(join(project.loopxDir, "wf", "check.sh"))).toBe(
          true,
        );
      });

      it("T-INST-76: workflow package.json invalid semver range → warning, proceeds", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "wf",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                dependencies: { loopx: "not-a-range!!!" },
              }),
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/wf.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(hasInvalidSemverWarning(result.stderr, "wf")).toBe(true);
      });

      it("T-INST-76a: no-index workflow invalid-semver package.json → warning, proceeds", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "wf",
            files: {
              "check.sh": BASH_STOP,
              "package.json": JSON.stringify({
                dependencies: { loopx: "not-a-range!!!" },
              }),
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/wf.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(hasInvalidSemverWarning(result.stderr, "wf")).toBe(true);
        expect(existsSync(join(project.loopxDir, "wf", "check.sh"))).toBe(
          true,
        );
      });

      it("T-INST-76b: no-index workflow with package.json directory warns and proceeds", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "wf",
            files: {
              "check.sh": BASH_STOP,
              "package.json/README": "directory package marker",
            },
          },
        ]);
        const result = await runCLI(
          ["install", "--no-install", `${gitServer.url}/wf.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/wf/i);
        expect(result.stderr).toMatch(/package\.json/i);
        expect(existsSync(join(project.loopxDir, "wf", "check.sh"))).toBe(true);
        expect(lstatSync(join(project.loopxDir, "wf", "package.json")).isDirectory()).toBe(
          true,
        );
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Install Atomicity (T-INST-77 … 80j)
  // ═══════════════════════════════════════════════════════════

  describe("Install Atomicity", () => {
    forEachRuntime((runtime) => {
      it("T-INST-77: multi-workflow all pass preflight → all installed", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
      });

      it("T-INST-78: one workflow fails preflight → entire install fails, .loopx/ unchanged", async () => {
        project = await createTempProject();
        // Existing workflow at .loopx/ralph will cause collision for ralph
        await createBashWorkflowScript(project, "ralph", "index", 'exit 0');
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh":
                '#!/bin/bash\nprintf \'{"new":true}\'\n',
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const beforeOther = existsSync(join(project.loopxDir, "other"));
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        // The pre-existing ralph/ is unchanged
        const ralphContent = readFileSync(
          join(project.loopxDir, "ralph", "index.sh"),
          "utf-8",
        );
        expect(ralphContent).not.toContain('{"new":true}');
        // other/ was not written (atomic)
        expect(existsSync(join(project.loopxDir, "other"))).toBe(beforeOther);
      });

      it(
        "T-INST-79: staging failure leaves .loopx/ unchanged (tarball)",
        async () => {
          project = await createTempProject();
          const tarball = await makeTarball(
            {
              "ralph/index.sh": BASH_STOP,
              "broken/index.sh": BASH_STOP,
              "broken/data.txt": "secret",
            },
            { wrapperDir: "multi" },
          );
          httpServer = await startLocalHTTPServer([
            tarballRoute("/multi.tar.gz", tarball),
          ]);
          const result = await runCLI(
            ["install", `${httpServer.url}/multi.tar.gz`],
            {
              cwd: project.dir,
              runtime,
              env: {
                NODE_ENV: "test",
                LOOPX_TEST_INSTALL_FAULT: "staging-fail:broken",
              },
            },
          );
          expect(result.exitCode).toBe(1);
          expect(existsSync(join(project.loopxDir, "ralph"))).toBe(false);
          expect(existsSync(join(project.loopxDir, "broken"))).toBe(false);
        },
      );

      it("T-INST-79a: staging failure removes the temporary staging directory", async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "stage-marker.json");
        const tarball = await makeTarball(
          {
            "ralph/index.sh": BASH_STOP,
            "broken/index.sh": BASH_STOP,
            "broken/data.txt": "secret",
          },
          { wrapperDir: "multi" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/multi.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/multi.tar.gz`],
          {
            cwd: project.dir,
            runtime,
            env: {
              NODE_ENV: "test",
              LOOPX_TEST_INSTALL_FAULT: "staging-fail:broken",
              LOOPX_TEST_INSTALL_STAGE_MARKER: markerPath,
            },
          },
        );
        expect(result.exitCode).toBe(1);
        const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
        expect(marker.stageDir).toContain("loopx-install-stage-");
        expect(existsSync(marker.stageDir)).toBe(false);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "broken"))).toBe(false);
      });

      it("T-INST-80: -y succeeds despite collisions and version mismatches", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          'echo "OLD" > /dev/null',
        );
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh":
                '#!/bin/bash\nprintf \'{"new":true}\'\n',
              "other/index.sh": BASH_STOP,
              "other/package.json": JSON.stringify({
                dependencies: { loopx: unsatisfiedRange() },
              }),
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-y", "--no-install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        const ralphContent = readFileSync(
          join(project.loopxDir, "ralph", "index.sh"),
          "utf-8",
        );
        expect(ralphContent).toContain('{"new":true}');
        const otherPkg = readFileSync(
          join(project.loopxDir, "other", "package.json"),
          "utf-8",
        );
        expect(otherPkg).toContain(unsatisfiedRange());
      });

      it("T-INST-80a: multiple preflight failures → single aggregated error", async () => {
        project = await createTempProject();
        // Pre-existing collision for A
        await createBashWorkflowScript(project, "alpha", "index", 'exit 0');
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh":
                '#!/bin/bash\nprintf \'{"new":true}\'\n',
              "beta/-bad.sh": BASH_STOP,
              "gamma/index.sh": BASH_STOP,
              "gamma/package.json": JSON.stringify({
                dependencies: { loopx: unsatisfiedRange() },
              }),
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        // No new workflows were written
        expect(existsSync(join(project.loopxDir, "beta"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "gamma"))).toBe(false);
        // The pre-existing alpha/ is unchanged
        const alphaContent = readFileSync(
          join(project.loopxDir, "alpha", "index.sh"),
          "utf-8",
        );
        expect(alphaContent).not.toContain('{"new":true}');
      });

      it(
        "T-INST-80b: -y replacement preserves existing workflow when staging fails (tarball)",
        async () => {
          project = await createTempProject();
          await createBashWorkflowScript(
            project,
            "ralph",
            "index",
            'echo "PRESERVED" > /dev/null',
          );
          const tarball = await makeTarball(
            {
              "ralph/index.sh":
                '#!/bin/bash\nprintf \'{"new":true}\'\n',
              "other/index.sh": BASH_STOP,
              "other/data.txt": "secret",
            },
            { wrapperDir: "multi" },
          );
          httpServer = await startLocalHTTPServer([
            tarballRoute("/multi.tar.gz", tarball),
          ]);
          const result = await runCLI(
            ["install", "-y", `${httpServer.url}/multi.tar.gz`],
            {
              cwd: project.dir,
              runtime,
              env: {
                NODE_ENV: "test",
                LOOPX_TEST_INSTALL_FAULT: "staging-fail:other",
              },
            },
          );
          expect(result.exitCode).toBe(1);
          const ralphContent = readFileSync(
            join(project.loopxDir, "ralph", "index.sh"),
            "utf-8",
          );
          expect(ralphContent).toContain("PRESERVED");
          expect(ralphContent).not.toContain('{"new":true}');
        },
      );

      it("T-INST-80c: commit-phase failure reports which workflows were/were not committed", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "beta/index.sh": BASH_STOP,
              "gamma/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          {
            cwd: project.dir,
            runtime,
            env: {
              NODE_ENV: "test",
              LOOPX_TEST_INSTALL_FAULT: "commit-fail-after:1",
            },
          },
        );
        expect(result.exitCode).toBe(1);
        // Exactly one workflow directory exists (the one committed before failure)
        const loopxDir = project!.loopxDir;
        const names = readdirSync(loopxDir).filter((name) =>
          statSync(join(loopxDir, name)).isDirectory(),
        );
        expect(names.length).toBe(1);
      });

      it("T-INST-80c2: commit-phase failure skips post-commit auto-install", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: packageJsonWorkflowFiles(["alpha", "beta", "gamma"]),
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            {
              cwd: project!.dir,
              runtime,
              env: {
                ...env,
                NODE_ENV: "test",
                LOOPX_TEST_INSTALL_FAULT: "commit-fail-after:1",
              },
            },
          );
          expect(result.exitCode).toBe(1);

          const names = readdirSync(project!.loopxDir).filter((name) =>
            statSync(join(project!.loopxDir, name)).isDirectory(),
          );
          expect(names).toHaveLength(1);
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          expect(
            existsSync(join(project!.loopxDir, names[0], ".gitignore")),
          ).toBe(false);
        });
      });

      it.skipIf(IS_ROOT)(
        "T-INST-80d: package.json warning is once-per-workflow (tarball)",
        async () => {
          project = await createTempProject();
          const tarball = await makeTarball(
            {
              "ralph/index.sh": BASH_STOP,
              "ralph/package.json": { content: "{}", mode: 0o000 },
              "other/index.sh": BASH_STOP,
              "other/package.json": { content: "{}", mode: 0o000 },
            },
            { wrapperDir: "multi" },
          );
          httpServer = await startLocalHTTPServer([
            tarballRoute("/multi.tar.gz", tarball),
          ]);
          const result = await runCLI(
            ["install", `${httpServer.url}/multi.tar.gz`],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(0);
          expect(countUnreadableWarnings(result.stderr, "ralph")).toBe(1);
          expect(countUnreadableWarnings(result.stderr, "other")).toBe(1);
          try {
            chmodSync(join(project.loopxDir, "ralph", "package.json"), 0o644);
            chmodSync(join(project.loopxDir, "other", "package.json"), 0o644);
          } catch {}
        },
      );

      it("T-INST-80e: invalid semver warning is once-per-workflow", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "ralph/package.json": JSON.stringify({
                dependencies: { loopx: "bad-range-1" },
              }),
              "other/index.sh": BASH_STOP,
              "other/package.json": JSON.stringify({
                dependencies: { loopx: "bad-range-2" },
              }),
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(countInvalidSemverWarnings(result.stderr, "ralph")).toBe(1);
        expect(countInvalidSemverWarnings(result.stderr, "other")).toBe(1);
      });

      it("T-INST-80f: invalid JSON warning is once-per-workflow", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "ralph/package.json": "{broken-1",
              "other/index.sh": BASH_STOP,
              "other/package.json": "{broken-2",
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(countInvalidJsonWarnings(result.stderr, "ralph")).toBe(1);
        expect(countInvalidJsonWarnings(result.stderr, "other")).toBe(1);
      });

      it("T-INST-80f2: package.json directory warning is once-per-workflow and skips auto-install", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json/README": "directory marker",
              "beta/index.sh": BASH_STOP,
              "beta/package.json/README": "directory marker",
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, env },
          );
          expect(result.exitCode).toBe(0);
          expect(lstatSync(join(project!.loopxDir, "alpha", "package.json")).isDirectory()).toBe(
            true,
          );
          expect(lstatSync(join(project!.loopxDir, "beta", "package.json")).isDirectory()).toBe(
            true,
          );
          expect(countNonRegularPackageJsonWarnings(result.stderr, "alpha")).toBe(1);
          expect(countNonRegularPackageJsonWarnings(result.stderr, "beta")).toBe(1);
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          expect(existsSync(join(project!.loopxDir, "alpha", ".gitignore"))).toBe(
            false,
          );
          expect(existsSync(join(project!.loopxDir, "beta", ".gitignore"))).toBe(
            false,
          );
          expectNoAutoInstallFailureReport(result.stderr);
        });
      });

      it("T-INST-80g: -y does not override zero-workflow source", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "empty",
            files: { "README.md": "nothing" },
          },
        ]);
        const result = await runCLI(
          ["install", "-y", `${gitServer.url}/empty.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-80h: -y does not override invalid script names", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "bad",
            files: {
              "index.sh": BASH_STOP,
              "-bad.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-y", `${gitServer.url}/bad.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-80i: -y does not override same-base-name collisions within a workflow", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "bad",
            files: {
              "index.sh": BASH_STOP,
              "check.sh": BASH_STOP,
              "check.ts": 'console.log("c");',
            },
          },
        ]);
        const result = await runCLI(
          ["install", "-y", `${gitServer.url}/bad.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-80j: -y does not override invalid workflow name", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "bad.name",
            files: { "index.sh": BASH_STOP },
          },
        ]);
        const result = await runCLI(
          ["install", "-y", `${gitServer.url}/bad.name.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Tarball Install (T-INST-81 … 86a, 85a, 85b)
  // ═══════════════════════════════════════════════════════════

  describe("Tarball Install", () => {
    forEachRuntime((runtime) => {
      it("T-INST-81: multi-workflow tarball install with exact name derivation", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          {
            "ralph/index.sh": BASH_STOP,
            "other/index.sh": BASH_STOP,
          },
          { wrapperDir: "multi" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/multi.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/multi.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "ralph", "index.sh")),
        ).toBe(true);
        expect(
          existsSync(join(project.loopxDir, "other", "index.sh")),
        ).toBe(true);
      });

      it("T-INST-82: wrapper-directory stripping for multi-workflow tarball", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          {
            "ralph/index.sh": BASH_STOP,
            "other/index.sh": BASH_STOP,
          },
          { wrapperDir: "pkg" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/pkg.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/pkg.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(false);
      });

      it("T-INST-83: no wrapper-directory stripping for multi-entry tarball", async () => {
        project = await createTempProject();
        const tarball = await makeTarball({
          "ralph/index.sh": BASH_STOP,
          "other/index.sh": BASH_STOP,
        });
        httpServer = await startLocalHTTPServer([
          tarballRoute("/multi.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/multi.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
      });

      it("T-INST-83b: single directory plus sibling root file does not trigger wrapper stripping", async () => {
        project = await createTempProject();
        const tarball = await makeTarball({
          "pkg/index.sh": BASH_STOP,
          "README.md": "readme",
        });
        httpServer = await startLocalHTTPServer([
          tarballRoute("/archive.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/archive.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "pkg", "index.sh"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "archive"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "README.md"))).toBe(false);
      });

      it("T-INST-83a: multi-workflow tarball self-containment", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          {
            "ralph/index.sh": BASH_STOP,
            "other/index.sh": BASH_STOP,
            "README.md": "readme",
            "LICENSE": "MIT",
            "docs/guide.md": "# guide",
            "shared/config.json": "{}",
          },
          { wrapperDir: "multi" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/multi.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/multi.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "README.md"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "LICENSE"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "docs"))).toBe(false);
        expect(existsSync(join(project.loopxDir, "shared"))).toBe(false);
      });

      it("T-INST-84: .tgz extension handled identically", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          {
            "ralph/index.sh": BASH_STOP,
            "other/index.sh": BASH_STOP,
          },
          { wrapperDir: "multi" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/multi.tgz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/multi.tgz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
      });

      it("T-INST-85: single-workflow tarball name derived from archive name", async () => {
        project = await createTempProject();
        const tarball = await makeTarball({ "index.sh": BASH_STOP });
        httpServer = await startLocalHTTPServer([
          tarballRoute("/my-agent.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/my-agent.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "my-agent", "index.sh")),
        ).toBe(true);
      });

      it("T-INST-86: tarball URL with query string → query stripped", async () => {
        project = await createTempProject();
        const tarball = await makeTarball({ "index.sh": BASH_STOP });
        httpServer = await startLocalHTTPServer([
          tarballRoute("/my-agent.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/my-agent.tar.gz?token=abc`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "my-agent"))).toBe(true);
      });

      it("T-INST-86a: tarball URL with fragment → fragment stripped", async () => {
        project = await createTempProject();
        const tarball = await makeTarball({ "index.sh": BASH_STOP });
        httpServer = await startLocalHTTPServer([
          tarballRoute("/pkg.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/pkg.tar.gz#v1`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(true);
      });

      it("T-INST-85a: single-workflow tarball with wrapper-directory stripping", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          {
            "index.sh": BASH_STOP,
            "check.sh": BASH_STOP,
          },
          { wrapperDir: "wrapper" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/my-agent.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/my-agent.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "my-agent", "index.sh")),
        ).toBe(true);
        expect(
          existsSync(join(project.loopxDir, "my-agent", "check.sh")),
        ).toBe(true);
        expect(existsSync(join(project.loopxDir, "wrapper"))).toBe(false);
      });

      it("T-INST-85b: single-workflow tarball with root scripts plus subdirs", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          {
            "index.sh": BASH_STOP,
            "check.sh": BASH_STOP,
            "lib/helpers.ts": "export const x = 1;",
            "src/utils.js": 'console.log("u");',
            "package.json": '{"name":"my-agent"}',
            "README.md": "readme",
          },
          { wrapperDir: "wrapper" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/my-agent.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/my-agent.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(
          existsSync(join(project.loopxDir, "my-agent", "index.sh")),
        ).toBe(true);
        expect(
          existsSync(
            join(project.loopxDir, "my-agent", "lib", "helpers.ts"),
          ),
        ).toBe(true);
        expect(
          existsSync(join(project.loopxDir, "my-agent", "src", "utils.js")),
        ).toBe(true);
        expect(
          existsSync(join(project.loopxDir, "my-agent", "package.json")),
        ).toBe(true);
        expect(
          existsSync(join(project.loopxDir, "my-agent", "README.md")),
        ).toBe(true);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Git Install (T-INST-87 … 89)
  // ═══════════════════════════════════════════════════════════

  describe("Git Install", () => {
    forEachRuntime((runtime) => {
      it("T-INST-87: shallow clone (--depth 1), only 1 commit", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        const result = await runCLI(
          ["install", "--no-install", `${gitServer.url}/repo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        // Installed workflow has no .git directory (it's excluded)
        // but the install should not attempt deep history fetches.
        expect(existsSync(join(project.loopxDir, "repo", ".git"))).toBe(false);
      });

      it("T-INST-88: single-workflow git name derived from repo URL minus .git", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "my-agent",
            files: { "index.sh": BASH_STOP },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/my-agent.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "my-agent"))).toBe(true);
      });

      it("T-INST-89: multi-workflow git names derived from subdirectory names", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "ralph/index.sh": BASH_STOP,
              "other/index.sh": BASH_STOP,
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/multi.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Common Rules (T-INST-90 … 97b)
  // ═══════════════════════════════════════════════════════════

  describe("Common Rules", () => {
    forEachRuntime((runtime) => {
      it("T-INST-90: .loopx/ created if it doesn't exist", async () => {
        project = await createTempProject({ withLoopxDir: false });
        gitServer = await startLocalGitServer([
          { name: "repo", files: { "index.sh": BASH_STOP } },
        ]);
        const result = await runCLI(
          ["install", "--no-install", `${gitServer.url}/repo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(project.loopxDir)).toBe(true);
        expect(existsSync(join(project.loopxDir, "repo"))).toBe(true);
      });

      it("T-INST-91: no npm install / bun install after clone/extract", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "repo",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                dependencies: { "left-pad": "^1.0.0" },
              }),
            },
          },
        ]);
        const result = await runCLI(
          ["install", "--no-install", `${gitServer.url}/repo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        // No node_modules created from the install
        expect(
          existsSync(join(project.loopxDir, "repo", "node_modules")),
        ).toBe(false);
      });

      it("T-INST-92: HTTP 404 during tarball download → error, no partial directory", async () => {
        project = await createTempProject();
        httpServer = await startLocalHTTPServer([
          { path: "/pkg.tar.gz", status: 404, body: "not found" },
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/pkg.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(false);
      });

      it("T-INST-92a: HTTP 500 during tarball download → error, no partial directory", async () => {
        project = await createTempProject();
        httpServer = await startLocalHTTPServer([
          { path: "/pkg.tar.gz", status: 500, body: "server error" },
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/pkg.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/download|http|500|tarball|fetch/i);
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(false);
        expect(readdirSync(project.loopxDir)).toEqual([]);
      });

      it("T-INST-92b: HTTP redirect is not followed and leaves .loopx unchanged", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "real" },
        );
        httpServer = await startLocalHTTPServer([
          {
            path: "/redirect.tar.gz",
            body: "",
            handler(req, res) {
              res.writeHead(302, {
                Location: `http://${req.headers.host}/real.tar.gz`,
              });
              res.end();
            },
          },
          tarballRoute("/real.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/redirect.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/download|http|302|redirect|fetch/i);
        expect(existsSync(join(project.loopxDir, "real"))).toBe(false);
        expect(readdirSync(project.loopxDir)).toEqual([]);
        expect(httpServer.requests.filter((path) => path === "/real.tar.gz")).toHaveLength(0);
      });

      it("T-INST-92c: transport reset during tarball download → error, no partial directory", async () => {
        project = await createTempProject();
        httpServer = await startLocalHTTPServer([
          {
            path: "/reset.tar.gz",
            body: "",
            handler(req) {
              req.socket.destroy();
            },
          },
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/reset.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/download|network|socket|reset|fetch/i);
        expect(existsSync(join(project.loopxDir, "reset"))).toBe(false);
        expect(readdirSync(project.loopxDir)).toEqual([]);
      });

      it("T-INST-93: git clone failure (non-existent repo) → error, no partial directory", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "file:///nonexistent/repo.git"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(existsSync(join(project.loopxDir, "repo"))).toBe(false);
      });

      it("T-INST-94: tarball extraction failure (corrupt archive) → error", async () => {
        project = await createTempProject();
        const corrupt = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "pkg", corrupt: true },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/pkg.tar.gz", corrupt),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/pkg.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(false);
      });

      it("T-INST-95: empty tarball → error", async () => {
        project = await createTempProject();
        const empty = await makeTarball({}, { empty: true });
        httpServer = await startLocalHTTPServer([
          tarballRoute("/empty.tar.gz", empty),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/empty.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-96: successful single-workflow git install → runnable via loopx run", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: { "index.sh": BASH_STOP },
          },
        ]);
        const installResult = await runCLI(
          ["install", `${gitServer.url}/ralph.git`],
          { cwd: project.dir, runtime },
        );
        expect(installResult.exitCode).toBe(0);
        const runResult = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(runResult.exitCode).toBe(0);
      });

      it("T-INST-97a: single-workflow install failure cleanup", async () => {
        project = await createTempProject();
        // A tarball that extracts successfully but whose workflow derived-name is invalid
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "pkg" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/-bad.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/-bad.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(existsSync(join(project.loopxDir, "-bad"))).toBe(false);
      });

      it("T-INST-97a2: preflight failure leaves pre-existing .loopx content unchanged", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "keep", "index", 'echo "KEEP"\n');
        const keepBefore = readFileSync(
          join(project.loopxDir, "keep", "index.sh"),
          "utf-8",
        );
        const tarball = await makeTarball(
          { "index.sh": BASH_STOP },
          { wrapperDir: "pkg" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/bad.name.tar.gz", tarball),
        ]);
        const result = await runCLI(
          ["install", `${httpServer.url}/bad.name.tar.gz`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(readdirSync(project.loopxDir)).toEqual(["keep"]);
        expect(readFileSync(join(project.loopxDir, "keep", "index.sh"), "utf-8")).toBe(
          keepBefore,
        );
        expect(existsSync(join(project.loopxDir, "bad.name"))).toBe(false);
      });

      it("T-INST-97b: successful install does not create .loopx/package.json", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: { "index.sh": BASH_STOP },
          },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/ralph.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "package.json"))).toBe(false);
      });

      it("T-INST-97c: installing foo succeeds when .loopx/foo.sh exists", async () => {
        project = await createTempProject();
        await writeFile(join(project.loopxDir, "foo.sh"), BASH_STOP, "utf-8");
        gitServer = await startLocalGitServer([
          { name: "foo", files: { "index.sh": BASH_STOP } },
        ]);
        const result = await runCLI(
          ["install", `${gitServer.url}/foo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "foo", "index.sh"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "foo.sh"))).toBe(true);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Post-commit auto-install (T-INST-110 … 110h)
  // ═══════════════════════════════════════════════════════════

  describe("Post-commit Auto-install", () => {
    forEachRuntime((runtime) => {
      it("T-INST-110: npm install runs once per package workflow, sequentially", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm(
          { exitCode: 0, sleepSeconds: 1 },
          async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              { cwd: project!.dir, runtime, env, timeout: 10_000 },
            );

            expect(result.exitCode).toBe(0);
            const invocations = readNpmInvocations(logFile);
            expect(invocations).toHaveLength(2);
            expect(invocations.map((i) => i.cwd).sort()).toEqual([
              join(project!.loopxDir, "alpha"),
              join(project!.loopxDir, "beta"),
            ]);
            expect(invocations.map((i) => i.argv)).toEqual([
              ["install"],
              ["install"],
            ]);

            const ordered = [...invocations].sort((a, b) => a.start - b.start);
            expect(ordered[1].start).toBeGreaterThanOrEqual(ordered[0].end);
            expectNoAutoInstallFailureReport(result.stderr);
          },
        );
      });

      it("T-INST-110a: workflows without top-level package.json are skipped silently", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "beta/index.sh": BASH_STOP,
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          const invocations = readNpmInvocations(logFile);
          expect(invocations).toHaveLength(1);
          expect(invocations[0].cwd).toBe(join(project!.loopxDir, "alpha"));
          expect(invocations[0].argv).toEqual(["install"]);
          expect(result.stderr).not.toMatch(/beta.*package\.json/i);
        });
      });

      it("T-INST-110b: -w scopes auto-install to the selected workflow", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", "-w", "alpha", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          const invocations = readNpmInvocations(logFile);
          expect(invocations).toHaveLength(1);
          expect(invocations[0].cwd).toBe(join(project!.loopxDir, "alpha"));
          expect(invocations[0].argv).toEqual(["install"]);
          expect(existsSync(join(project!.loopxDir, "beta"))).toBe(false);
        });
      });

      it("T-INST-110c: package.json presence alone triggers auto-install and .gitignore synthesis", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "minimal-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "minimal-workflow",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/minimal-workflow.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          const invocations = readNpmInvocations(logFile);
          expect(invocations).toHaveLength(1);
          expect(invocations[0].cwd).toBe(
            join(project!.loopxDir, "minimal-workflow"),
          );
          expect(invocations[0].argv).toEqual(["install"]);
          expect(
            readFileSync(
              join(project!.loopxDir, "minimal-workflow", ".gitignore"),
              "utf-8",
            ),
          ).toMatch(/^node_modules\s*$/);
          expectNoAutoInstallFailureReport(result.stderr);
        });
      });

      it("T-INST-110d: no-index workflow with package.json still triggers auto-install", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "tools",
            files: {
              "check.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "tools",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/tools.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          const invocations = readNpmInvocations(logFile);
          expect(invocations).toHaveLength(1);
          expect(invocations[0].cwd).toBe(join(project!.loopxDir, "tools"));
          expect(invocations[0].argv).toEqual(["install"]);
          expect(
            readFileSync(join(project!.loopxDir, "tools", ".gitignore"), "utf-8"),
          ).toMatch(/^node_modules\s*$/);
          expect(existsSync(join(project!.loopxDir, "tools", "index.sh"))).toBe(
            false,
          );
        });
      });

      it("T-INST-110e: nested package.json alone does not trigger auto-install", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "nested-only",
            files: {
              "index.sh": BASH_STOP,
              "lib/package.json": JSON.stringify({
                name: "nested-lib",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/nested-only.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          expect(
            existsSync(join(project!.loopxDir, "nested-only", ".gitignore")),
          ).toBe(false);
          expect(
            readFileSync(
              join(project!.loopxDir, "nested-only", "lib", "package.json"),
              "utf-8",
            ),
          ).toBe(JSON.stringify({ name: "nested-lib", version: "1.0.0" }));
        });
      });

      it("T-INST-110f: -w selected no-index workflow still triggers auto-install", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "tools/check.sh": BASH_STOP,
              "tools/package.json": JSON.stringify({
                name: "tools",
                version: "1.0.0",
              }),
              "other/index.sh": BASH_STOP,
              "other/package.json": JSON.stringify({
                name: "other",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", "-w", "tools", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          const invocations = readNpmInvocations(logFile);
          expect(invocations).toHaveLength(1);
          expect(invocations[0].cwd).toBe(join(project!.loopxDir, "tools"));
          expect(invocations[0].argv).toEqual(["install"]);
          expect(
            readFileSync(join(project!.loopxDir, "tools", ".gitignore"), "utf-8"),
          ).toMatch(/^node_modules\s*$/);
          expect(existsSync(join(project!.loopxDir, "tools", "check.sh"))).toBe(
            true,
          );
          expect(existsSync(join(project!.loopxDir, "tools", "index.sh"))).toBe(
            false,
          );
          expect(existsSync(join(project!.loopxDir, "other"))).toBe(false);
        });
      });

      it("T-INST-110g: tarball source with top-level package.json triggers auto-install", async () => {
        project = await createTempProject();
        const tarball = await makeTarball(
          {
            "index.sh": BASH_STOP,
            "package.json": JSON.stringify({
              name: "tarball-workflow",
              version: "1.0.0",
            }),
          },
          { wrapperDir: "tarball-workflow" },
        );
        httpServer = await startLocalHTTPServer([
          tarballRoute("/tarball-workflow.tar.gz", tarball),
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${httpServer!.url}/tarball-workflow.tar.gz`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          const installed = join(project!.loopxDir, "tarball-workflow");
          expect(readFileSync(join(installed, "index.sh"), "utf-8")).toBe(
            BASH_STOP,
          );
          expect(readFileSync(join(installed, "package.json"), "utf-8")).toBe(
            JSON.stringify({ name: "tarball-workflow", version: "1.0.0" }),
          );
          const invocations = readNpmInvocations(logFile);
          expect(invocations).toHaveLength(1);
          expect(invocations[0].cwd).toBe(installed);
          expect(invocations[0].argv).toEqual(["install"]);
          expect(readFileSync(join(installed, ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
        });
      });

      it("T-INST-110h: symlinked workflow directory with package.json triggers auto-install after materialization", async () => {
        project = await createTempProject();
        const bareDir = join(project.dir, "symlinked.git");
        const workDir = join(project.dir, "symlinked-work");
        execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });
        execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "pipe" });
        await mkdir(join(workDir, "internal", "real-workflow"), {
          recursive: true,
        });
        await writeFile(
          join(workDir, "internal", "real-workflow", "index.sh"),
          BASH_STOP,
          "utf-8",
        );
        await chmod(join(workDir, "internal", "real-workflow", "index.sh"), 0o755);
        await writeFile(
          join(workDir, "internal", "real-workflow", "package.json"),
          JSON.stringify({ name: "real-workflow", version: "1.0.0" }),
          "utf-8",
        );
        symlinkSync("internal/real-workflow", join(workDir, "alias"));
        execSync(
          `cd "${workDir}" && git add -A && git -c user.email="test@test.com" -c user.name="Test" commit -m "initial"`,
          { stdio: "pipe" },
        );
        execSync(`cd "${workDir}" && git push origin HEAD`, { stdio: "pipe" });

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(["install", `file://${bareDir}`], {
            cwd: project!.dir,
            runtime,
            env,
          });

          expect(result.exitCode).toBe(0);
          const installed = join(project!.loopxDir, "alias");
          expect(lstatSync(installed).isSymbolicLink()).toBe(false);
          expect(lstatSync(join(installed, "index.sh")).isFile()).toBe(true);
          expect(lstatSync(join(installed, "package.json")).isFile()).toBe(true);
          const invocations = readNpmInvocations(logFile);
          expect(invocations).toHaveLength(1);
          expect(invocations[0].cwd).toBe(installed);
          expect(invocations[0].argv).toEqual(["install"]);
          expect(readFileSync(join(installed, ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
          expect(existsSync(join(project!.loopxDir, "internal"))).toBe(false);
        });
      });

      it("T-INST-111: --no-install suppresses npm install and .gitignore synthesis only", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "no-install",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "no-install",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", "--no-install", `${gitServer!.url}/no-install.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          expect(
            existsSync(join(project!.loopxDir, "no-install", ".gitignore")),
          ).toBe(false);
          expect(
            existsSync(join(project!.loopxDir, "no-install", "index.sh")),
          ).toBe(true);
          expect(
            existsSync(join(project!.loopxDir, "no-install", "package.json")),
          ).toBe(true);
        });
      });

      it("T-INST-111a: --no-install preserves a pre-existing .gitignore unchanged", async () => {
        project = await createTempProject();
        const gitignore = "dist/\n";
        gitServer = await startLocalGitServer([
          {
            name: "custom-ignore",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "custom-ignore",
                version: "1.0.0",
              }),
              ".gitignore": gitignore,
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", "--no-install", `${gitServer!.url}/custom-ignore.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          expect(
            readFileSync(
              join(project!.loopxDir, "custom-ignore", ".gitignore"),
              "utf-8",
            ),
          ).toBe(gitignore);
        });
      });

      it("T-INST-111b: --no-install does not suppress fatal preflight validation", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "mismatch",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "mismatch",
                version: "1.0.0",
                dependencies: { loopx: unsatisfiedRange() },
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", "--no-install", `${gitServer!.url}/mismatch.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(1);
          expect(hasVersionMismatchWarning(result.stderr, "mismatch")).toBe(
            true,
          );
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          expect(existsSync(join(project!.loopxDir, "mismatch"))).toBe(false);
        });
      });

      it("T-INST-111c: --no-install does not suppress nonfatal package.json parse warnings", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "malformed",
            files: {
              "index.sh": BASH_STOP,
              "package.json": "{broken",
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", "--no-install", `${gitServer!.url}/malformed.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          expect(countInvalidJsonWarnings(result.stderr, "malformed")).toBe(1);
          expect(
            existsSync(join(project!.loopxDir, "malformed", ".gitignore")),
          ).toBe(false);
          expect(
            readFileSync(
              join(project!.loopxDir, "malformed", "package.json"),
              "utf-8",
            ),
          ).toBe("{broken");
          expect(
            existsSync(join(project!.loopxDir, "malformed", "index.sh")),
          ).toBe(true);
        });
      });

      it("T-INST-111d: --no-install suppresses auto-install for every workflow in a multi-source", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
              "gamma/index.sh": BASH_STOP,
              "gamma/package.json": JSON.stringify({
                name: "gamma",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", "--no-install", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          for (const name of ["alpha", "beta", "gamma"]) {
            expect(existsSync(join(project!.loopxDir, name, "index.sh"))).toBe(
              true,
            );
            expect(
              existsSync(join(project!.loopxDir, name, "package.json")),
            ).toBe(true);
            expect(existsSync(join(project!.loopxDir, name, ".gitignore"))).toBe(
              false,
            );
          }
          expectNoAutoInstallFailureReport(result.stderr);
        });
      });

      it("T-INST-111e: --no-install and -w commits only the selected workflow without auto-install", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
              "gamma/index.sh": BASH_STOP,
              "gamma/package.json": JSON.stringify({
                name: "gamma",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            [
              "install",
              "--no-install",
              "-w",
              "beta",
              `${gitServer!.url}/multi.git`,
            ],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          expect(existsSync(join(project!.loopxDir, "beta", "index.sh"))).toBe(
            true,
          );
          expect(
            existsSync(join(project!.loopxDir, "beta", "package.json")),
          ).toBe(true);
          expect(existsSync(join(project!.loopxDir, "beta", ".gitignore"))).toBe(
            false,
          );
          expect(existsSync(join(project!.loopxDir, "alpha"))).toBe(false);
          expect(existsSync(join(project!.loopxDir, "gamma"))).toBe(false);
          expectNoAutoInstallFailureReport(result.stderr);
        });
      });

      it("T-INST-112: missing .gitignore is synthesized before npm install starts", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "synthesize-ignore",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "synthesize-ignore",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm(
          { exitCode: 0, recordGitignoreAtStart: true },
          async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/synthesize-ignore.git`],
              { cwd: project!.dir, runtime, env },
            );

            expect(result.exitCode).toBe(0);
            const installed = join(project!.loopxDir, "synthesize-ignore");
            expect(readFileSync(join(installed, ".gitignore"), "utf-8")).toMatch(
              /^node_modules\s*$/,
            );
            const invocations = readNpmInvocations(logFile);
            expect(invocations).toHaveLength(1);
            expect(invocations[0].cwd).toBe(installed);
            expect(invocations[0].argv).toEqual(["install"]);
            expect(invocations[0].gitignoreAtStart).toEqual({
              existed: true,
              content: "node_modules",
            });
          },
        );
      });

      it("T-INST-112a: existing regular .gitignore is left unchanged and npm still runs", async () => {
        project = await createTempProject();
        const gitignore = "dist/\n# my custom comment\n";
        gitServer = await startLocalGitServer([
          {
            name: "existing-ignore",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "existing-ignore",
                version: "1.0.0",
              }),
              ".gitignore": gitignore,
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/existing-ignore.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          const installed = join(project!.loopxDir, "existing-ignore");
          expect(readFileSync(join(installed, ".gitignore"), "utf-8")).toBe(
            gitignore,
          );
          expect(result.stderr).not.toMatch(/node_modules.*gitignore/i);
          const invocations = readNpmInvocations(logFile);
          expect(invocations).toHaveLength(1);
          expect(invocations[0].cwd).toBe(installed);
          expect(invocations[0].argv).toEqual(["install"]);
        });
      });

      it("T-INST-112a2: source .gitignore symlink to regular file materializes as regular file", async () => {
        project = await createTempProject();
        const gitignore = "dist/\n# project-custom\n";
        const source = await createManualGitSource(
          project.dir,
          "symlink-gitignore-workflow",
          async (workDir) => {
            await writeFile(join(workDir, "index.sh"), BASH_STOP, "utf-8");
            await chmod(join(workDir, "index.sh"), 0o755);
            await writeFile(
              join(workDir, "package.json"),
              JSON.stringify({
                name: "symlink-gitignore-workflow",
                version: "1.0.0",
              }),
              "utf-8",
            );
            await writeFile(join(workDir, "gitignore-template"), gitignore, "utf-8");
            symlinkSync("gitignore-template", join(workDir, ".gitignore"));
          },
        );

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(["install", source], {
            cwd: project!.dir,
            runtime,
            env,
          });

          expect(result.exitCode).toBe(0);
          const installed = join(project!.loopxDir, "symlink-gitignore-workflow");
          expect(lstatSync(join(installed, ".gitignore")).isFile()).toBe(true);
          expect(
            lstatSync(join(installed, ".gitignore")).isSymbolicLink(),
          ).toBe(false);
          expect(readFileSync(join(installed, ".gitignore"), "utf-8")).toBe(
            gitignore,
          );
          expect(readFileSync(join(installed, "gitignore-template"), "utf-8")).toBe(
            gitignore,
          );
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            installed,
          ]);
          expectNoAutoInstallFailureReport(result.stderr);
        });
      });

      it("T-INST-112a3: source .gitignore symlink to directory materializes and fails safeguard", async () => {
        project = await createTempProject();
        const source = await createManualGitSource(
          project.dir,
          "multi",
          async (workDir) => {
            await mkdir(join(workDir, "alpha", "gitignore-dir"), {
              recursive: true,
            });
            await mkdir(join(workDir, "beta"), { recursive: true });
            await writeFile(join(workDir, "alpha", "index.sh"), BASH_STOP, "utf-8");
            await chmod(join(workDir, "alpha", "index.sh"), 0o755);
            await writeFile(
              join(workDir, "alpha", "package.json"),
              JSON.stringify({ name: "alpha", version: "1.0.0" }),
              "utf-8",
            );
            await writeFile(
              join(workDir, "alpha", "gitignore-dir", "README"),
              "kept",
              "utf-8",
            );
            symlinkSync("gitignore-dir", join(workDir, "alpha", ".gitignore"));
            await writeFile(join(workDir, "beta", "index.sh"), BASH_STOP, "utf-8");
            await chmod(join(workDir, "beta", "index.sh"), 0o755);
            await writeFile(
              join(workDir, "beta", "package.json"),
              JSON.stringify({ name: "beta", version: "1.0.0" }),
              "utf-8",
            );
          },
        );

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(["install", source], {
            cwd: project!.dir,
            runtime,
            env,
          });

          expect(result.exitCode).toBe(1);
          expect(
            lstatSync(join(project!.loopxDir, "alpha", ".gitignore")).isDirectory(),
          ).toBe(true);
          expect(
            readFileSync(
              join(project!.loopxDir, "alpha", ".gitignore", "README"),
              "utf-8",
            ),
          ).toBe("kept");
          expect(
            readFileSync(
              join(project!.loopxDir, "alpha", "gitignore-dir", "README"),
              "utf-8",
            ),
          ).toBe("kept");
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "beta"),
          ]);
          expect(result.stderr).toMatch(/alpha/i);
          expect(result.stderr).toMatch(/gitignore/i);
          expect(readFileSync(join(project!.loopxDir, "beta", ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
        });
      });

      it("T-INST-112a4: cross-boundary .gitignore symlink to regular file materializes", async () => {
        project = await createTempProject();
        const gitignore = "dist/\n# project-custom\n";
        const source = await createManualGitSource(
          project.dir,
          "cross-file",
          async (workDir) => {
            await mkdir(join(workDir, "ralph"), { recursive: true });
            await mkdir(join(workDir, "shared"), { recursive: true });
            await writeFile(join(workDir, "ralph", "index.sh"), BASH_STOP, "utf-8");
            await chmod(join(workDir, "ralph", "index.sh"), 0o755);
            await writeFile(
              join(workDir, "ralph", "package.json"),
              JSON.stringify({ name: "ralph", version: "1.0.0" }),
              "utf-8",
            );
            await writeFile(
              join(workDir, "shared", "gitignore-template"),
              gitignore,
              "utf-8",
            );
            symlinkSync(
              "../shared/gitignore-template",
              join(workDir, "ralph", ".gitignore"),
            );
          },
        );

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(["install", source], {
            cwd: project!.dir,
            runtime,
            env,
          });

          expect(result.exitCode).toBe(0);
          const installed = join(project!.loopxDir, "ralph");
          expect(lstatSync(join(installed, ".gitignore")).isFile()).toBe(true);
          expect(readFileSync(join(installed, ".gitignore"), "utf-8")).toBe(
            gitignore,
          );
          expect(existsSync(join(project!.loopxDir, "shared"))).toBe(false);
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            installed,
          ]);
          expectNoAutoInstallFailureReport(result.stderr);
        });
      });

      it("T-INST-112a5: cross-boundary .gitignore symlink to directory materializes and fails", async () => {
        project = await createTempProject();
        const source = await createManualGitSource(
          project.dir,
          "cross-dir",
          async (workDir) => {
            await mkdir(join(workDir, "alpha"), { recursive: true });
            await mkdir(join(workDir, "beta"), { recursive: true });
            await mkdir(join(workDir, "shared", "gitignore-dir"), {
              recursive: true,
            });
            await writeFile(join(workDir, "alpha", "index.sh"), BASH_STOP, "utf-8");
            await chmod(join(workDir, "alpha", "index.sh"), 0o755);
            await writeFile(
              join(workDir, "alpha", "package.json"),
              JSON.stringify({ name: "alpha", version: "1.0.0" }),
              "utf-8",
            );
            await writeFile(
              join(workDir, "shared", "gitignore-dir", "README"),
              "kept",
              "utf-8",
            );
            symlinkSync(
              "../shared/gitignore-dir",
              join(workDir, "alpha", ".gitignore"),
            );
            await writeFile(join(workDir, "beta", "index.sh"), BASH_STOP, "utf-8");
            await chmod(join(workDir, "beta", "index.sh"), 0o755);
            await writeFile(
              join(workDir, "beta", "package.json"),
              JSON.stringify({ name: "beta", version: "1.0.0" }),
              "utf-8",
            );
          },
        );

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(["install", source], {
            cwd: project!.dir,
            runtime,
            env,
          });

          expect(result.exitCode).toBe(1);
          expect(
            lstatSync(join(project!.loopxDir, "alpha", ".gitignore")).isDirectory(),
          ).toBe(true);
          expect(
            readFileSync(
              join(project!.loopxDir, "alpha", ".gitignore", "README"),
              "utf-8",
            ),
          ).toBe("kept");
          expect(existsSync(join(project!.loopxDir, "shared"))).toBe(false);
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "beta"),
          ]);
          expect(result.stderr).toMatch(/alpha/i);
          expect(result.stderr).toMatch(/gitignore/i);
        });
      });

      it("T-INST-112b: .gitignore synthesis is skipped without top-level package.json", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "no-package",
            files: {
              "index.sh": BASH_STOP,
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/no-package.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          expect(
            existsSync(join(project!.loopxDir, "no-package", ".gitignore")),
          ).toBe(false);
          expect(
            existsSync(join(project!.loopxDir, "no-package", "index.sh")),
          ).toBe(true);
        });
      });

      it("T-INST-112e: directory .gitignore is a safeguard failure and does not stop other workflows", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "alpha/.gitignore/README": "kept",
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(1);
          expect(lstatSync(join(project!.loopxDir, "alpha", ".gitignore")).isDirectory()).toBe(
            true,
          );
          expect(
            readFileSync(
              join(project!.loopxDir, "alpha", ".gitignore", "README"),
              "utf-8",
            ),
          ).toBe("kept");
          const invocations = readNpmInvocations(logFile);
          expect(invocations).toHaveLength(1);
          expect(invocations[0].cwd).toBe(join(project!.loopxDir, "beta"));
          expect(invocations[0].argv).toEqual(["install"]);
          expect(result.stderr).toMatch(/alpha/i);
          expect(result.stderr).toMatch(/gitignore/i);
          expect(readFileSync(join(project!.loopxDir, "beta", ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
        });
      });

      it("T-INST-112f: --no-install skips safeguard lstat even for directory .gitignore", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "directory-ignore",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "directory-ignore",
                version: "1.0.0",
              }),
              ".gitignore/README": "kept",
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            [
              "install",
              "--no-install",
              `${gitServer!.url}/directory-ignore.git`,
            ],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          expect(
            lstatSync(
              join(project!.loopxDir, "directory-ignore", ".gitignore"),
            ).isDirectory(),
          ).toBe(true);
          expectNoAutoInstallFailureReport(result.stderr);
        });
      });

      it.each([
        ["regular-file-target", ".gitignore-target", true],
        ["broken", "does-not-exist", false],
        ["cycle", ".gitignore-loop", true],
      ] as const)(
        "T-INST-112g: symlink .gitignore safeguard failure (%s)",
        async (kind, expectedTarget, targetExists) => {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "multi",
              files: {
                "alpha/index.sh": BASH_STOP,
                "alpha/package.json": JSON.stringify({
                  name: "alpha",
                  version: "1.0.0",
                }),
                "beta/index.sh": BASH_STOP,
                "beta/package.json": JSON.stringify({
                  name: "beta",
                  version: "1.0.0",
                }),
              },
            },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: {
                  ...env,
                  NODE_ENV: "test",
                  LOOPX_TEST_AUTOINSTALL_FAULT: `gitignore-replace-with-symlink:alpha=${kind}`,
                },
              },
            );

            expect(result.exitCode).toBe(1);
            expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
              join(project!.loopxDir, "beta"),
            ]);
            expect(result.stderr).toMatch(/alpha/i);
            expect(result.stderr).toMatch(/gitignore/i);
            const linkPath = join(project!.loopxDir, "alpha", ".gitignore");
            expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
            expect(readlinkSync(linkPath)).toBe(expectedTarget);
            expect(
              existsSync(join(project!.loopxDir, "alpha", expectedTarget)),
            ).toBe(targetExists);
            if (kind === "cycle") {
              expect(
                lstatSync(
                  join(project!.loopxDir, "alpha", ".gitignore-loop"),
                ).isSymbolicLink(),
              ).toBe(true);
            }
            expect(readFileSync(join(project!.loopxDir, "beta", ".gitignore"), "utf-8")).toMatch(
              /^node_modules\s*$/,
            );
          });
        },
      );

      it("T-INST-112l: no-package workflow skips safeguard before lstat on directory .gitignore", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/.gitignore/README": "kept",
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          const invocations = readNpmInvocations(logFile);
          expect(invocations).toHaveLength(1);
          expect(invocations[0].cwd).toBe(join(project!.loopxDir, "beta"));
          expectNoAutoInstallFailureReport(result.stderr);
          expect(
            lstatSync(join(project!.loopxDir, "alpha", ".gitignore")).isDirectory(),
          ).toBe(true);
          expect(
            existsSync(join(project!.loopxDir, "alpha", "index.sh")),
          ).toBe(true);
          expect(readFileSync(join(project!.loopxDir, "beta", ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
        });
      });

      it("T-INST-112m: malformed package.json skips safeguard before lstat on directory .gitignore", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": "{broken",
              "alpha/.gitignore/README": "kept",
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          const invocations = readNpmInvocations(logFile);
          expect(invocations).toHaveLength(1);
          expect(invocations[0].cwd).toBe(join(project!.loopxDir, "beta"));
          expect(countInvalidJsonWarnings(result.stderr, "alpha")).toBe(1);
          expectNoAutoInstallFailureReport(result.stderr);
          expect(
            lstatSync(join(project!.loopxDir, "alpha", ".gitignore")).isDirectory(),
          ).toBe(true);
          expect(
            readFileSync(join(project!.loopxDir, "alpha", "package.json"), "utf-8"),
          ).toBe("{broken");
          expect(readFileSync(join(project!.loopxDir, "beta", ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
        });
      });

      it("T-INST-112c / T-INST-112d: .gitignore write failure skips npm, continues, and does not roll back", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
              "gamma/index.sh": BASH_STOP,
              "gamma/package.json": JSON.stringify({
                name: "gamma",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            {
              cwd: project!.dir,
              runtime,
              env: {
                ...env,
                NODE_ENV: "test",
                LOOPX_TEST_AUTOINSTALL_FAULT:
                  "gitignore-write-fail:beta,gamma",
              },
            },
          );

          expect(result.exitCode).toBe(1);
          const invocations = readNpmInvocations(logFile);
          expect(invocations.map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "alpha"),
          ]);
          expect(result.stderr).toMatch(/beta/i);
          expect(result.stderr).toMatch(/gamma/i);
          expect(result.stderr).toMatch(/gitignore/i);
          expect(result.stderr).not.toMatch(/alpha.*gitignore/i);
          expect(readFileSync(join(project!.loopxDir, "alpha", ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
          for (const name of ["beta", "gamma"]) {
            expect(existsSync(join(project!.loopxDir, name, "index.sh"))).toBe(
              true,
            );
            expect(
              existsSync(join(project!.loopxDir, name, "package.json")),
            ).toBe(true);
            expect(existsSync(join(project!.loopxDir, name, ".gitignore"))).toBe(
              false,
            );
          }
        });
      });

      it("T-INST-112h: .gitignore lstat failure skips npm and leaves no synthesized file", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
              "gamma/index.sh": BASH_STOP,
              "gamma/package.json": JSON.stringify({
                name: "gamma",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            {
              cwd: project!.dir,
              runtime,
              env: {
                ...env,
                NODE_ENV: "test",
                LOOPX_TEST_AUTOINSTALL_FAULT: "gitignore-lstat-fail:beta,gamma",
              },
            },
          );

          expect(result.exitCode).toBe(1);
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "alpha"),
          ]);
          expect(result.stderr).toMatch(/beta/i);
          expect(result.stderr).toMatch(/gamma/i);
          expect(result.stderr).toMatch(/gitignore/i);
          expect(readFileSync(join(project!.loopxDir, "alpha", ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
          expect(existsSync(join(project!.loopxDir, "beta", ".gitignore"))).toBe(
            false,
          );
          expect(
            existsSync(join(project!.loopxDir, "gamma", ".gitignore")),
          ).toBe(false);
        });
      });

      it.each([
        ["T-INST-112i", "gitignore-replace-with-fifo:alpha", "isFIFO"],
        ["T-INST-112j", "gitignore-replace-with-socket:alpha", "isSocket"],
      ] as const)(
        "%s: non-regular %s .gitignore is a safeguard failure",
        async (_id, fault, statMethod) => {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "multi",
              files: {
                "alpha/index.sh": BASH_STOP,
                "alpha/package.json": JSON.stringify({
                  name: "alpha",
                  version: "1.0.0",
                }),
                "beta/index.sh": BASH_STOP,
                "beta/package.json": JSON.stringify({
                  name: "beta",
                  version: "1.0.0",
                }),
              },
            },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: {
                  ...env,
                  NODE_ENV: "test",
                  LOOPX_TEST_AUTOINSTALL_FAULT: fault,
                },
              },
            );

            expect(result.exitCode).toBe(1);
            expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
              join(project!.loopxDir, "beta"),
            ]);
            expect(result.stderr).toMatch(/alpha/i);
            expect(result.stderr).toMatch(/gitignore/i);
            expect(lstatSync(join(project!.loopxDir, "alpha", ".gitignore"))[statMethod]()).toBe(
              true,
            );
            expect(readFileSync(join(project!.loopxDir, "beta", ".gitignore"), "utf-8")).toMatch(
              /^node_modules\s*$/,
            );
          });
        },
      );

      it.skipIf(process.env.CI || process.env.LOOPX_RUN_PRIVILEGED_LOCAL_TESTS !== "1")(
        "T-INST-112-block: block/character device .gitignore is a safeguard failure",
        async () => {
          for (const [fault, statMethod] of [
            ["gitignore-replace-with-char-device:alpha", "isCharacterDevice"],
            ["gitignore-replace-with-block-device:alpha", "isBlockDevice"],
          ] as const) {
            project = await createTempProject();
            gitServer = await startLocalGitServer([
              {
                name: "multi",
                files: {
                  "alpha/index.sh": BASH_STOP,
                  "alpha/package.json": JSON.stringify({
                    name: "alpha",
                    version: "1.0.0",
                  }),
                  "beta/index.sh": BASH_STOP,
                  "beta/package.json": JSON.stringify({
                    name: "beta",
                    version: "1.0.0",
                  }),
                },
              },
            ]);

            await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
              const result = await runCLI(
                ["install", `${gitServer!.url}/multi.git`],
                {
                  cwd: project!.dir,
                  runtime,
                  env: {
                    ...env,
                    NODE_ENV: "test",
                    LOOPX_TEST_AUTOINSTALL_FAULT: fault,
                  },
                },
              );

              expect(result.exitCode).toBe(1);
              expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
                join(project!.loopxDir, "beta"),
              ]);
              expect(result.stderr).toMatch(/alpha/i);
              expect(result.stderr).toMatch(/gitignore/i);
              expect(lstatSync(join(project!.loopxDir, "alpha", ".gitignore"))[statMethod]()).toBe(
                true,
              );
            });

            await gitServer.close().catch(() => {});
            gitServer = null;
            await project.cleanup().catch(() => {});
            project = null;
          }
        },
      );

      it("T-INST-112k: unreadable regular .gitignore is not inspected or chmodded", async () => {
        if (IS_ROOT) {
          expect(IS_ROOT).toBe(true);
          return;
        }
        project = await createTempProject();
        const gitignore = "dist/\n# my-content\n";
        gitServer = await startLocalGitServer([
          {
            name: "unreadable-ignore",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "unreadable-ignore",
                version: "1.0.0",
              }),
              ".gitignore": gitignore,
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/unreadable-ignore.git`],
            {
              cwd: project!.dir,
              runtime,
              env: {
                ...env,
                NODE_ENV: "test",
                LOOPX_TEST_AUTOINSTALL_FAULT:
                  "gitignore-make-unreadable:unreadable-ignore",
              },
            },
          );

          expect(result.exitCode).toBe(0);
          const installed = join(project!.loopxDir, "unreadable-ignore");
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            installed,
          ]);
          expectNoAutoInstallFailureReport(result.stderr);
          const gitignorePath = join(installed, ".gitignore");
          expect(lstatSync(gitignorePath).isFile()).toBe(true);
          expect(lstatSync(gitignorePath).mode & 0o777).toBe(0);
          await chmod(gitignorePath, 0o644);
          expect(readFileSync(gitignorePath, "utf-8")).toBe(gitignore);
        });
      });

      it("T-INST-112n: lstat failure on an existing regular .gitignore makes no further changes", async () => {
        if (IS_ROOT) {
          expect(IS_ROOT).toBe(true);
          return;
        }
        project = await createTempProject();
        const alphaGitignore = "dist/\n# my-pre-existing-content\n";
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "alpha/.gitignore": alphaGitignore,
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            {
              cwd: project!.dir,
              runtime,
              env: {
                ...env,
                NODE_ENV: "test",
                LOOPX_TEST_AUTOINSTALL_FAULT:
                  "gitignore-make-unreadable:alpha;gitignore-lstat-fail:alpha",
              },
            },
          );

          expect(result.exitCode).toBe(1);
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "beta"),
          ]);
          expect(result.stderr).toMatch(/alpha/i);
          expect(result.stderr).toMatch(/gitignore/i);
          const alphaGitignorePath = join(project!.loopxDir, "alpha", ".gitignore");
          expect(lstatSync(alphaGitignorePath).mode & 0o777).toBe(0);
          await chmod(alphaGitignorePath, 0o644);
          expect(readFileSync(alphaGitignorePath, "utf-8")).toBe(alphaGitignore);
          expect(readFileSync(join(project!.loopxDir, "beta", ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
        });
      });

      it("T-INST-112o: partial .gitignore write failure preserves partial bytes and mode", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
              "gamma/index.sh": BASH_STOP,
              "gamma/package.json": JSON.stringify({
                name: "gamma",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            {
              cwd: project!.dir,
              runtime,
              env: {
                ...env,
                NODE_ENV: "test",
                LOOPX_TEST_AUTOINSTALL_FAULT:
                  "gitignore-partial-write-fail:beta,gamma",
              },
            },
          );

          expect(result.exitCode).toBe(1);
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "alpha"),
          ]);
          expect(result.stderr).toMatch(/beta/i);
          expect(result.stderr).toMatch(/gamma/i);
          expect(readFileSync(join(project!.loopxDir, "alpha", ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
          for (const name of ["beta", "gamma"]) {
            const partialPath = join(project!.loopxDir, name, ".gitignore");
            const modePath = join(
              project!.loopxDir,
              name,
              ".gitignore.seam-observed-mode",
            );
            expect(lstatSync(partialPath).isFile()).toBe(true);
            expect(readFileSync(partialPath, "utf-8")).toBe("node");
            expect(lstatSync(partialPath).mode & 0o777).toBe(
              Number(readFileSync(modePath, "utf-8")),
            );
          }
        });
      });

      it.each([
        ["T-INST-113", "invalid-json", "{broken", "invalid-json"],
        [
          "T-INST-113b",
          "invalid-semver",
          JSON.stringify({ dependencies: { loopx: "not-a-range!!!" } }),
          "invalid-semver",
        ],
        [
          "T-INST-113g",
          "non-string-loopx-range",
          JSON.stringify({ dependencies: { loopx: 42 } }),
          "invalid-semver",
        ],
      ] as const)(
        "%s: malformed package.json skips auto-install silently (%s)",
        async (_id, name, packageJson, warningKind) => {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name,
              files: {
                "index.sh": BASH_STOP,
                "package.json": packageJson,
              },
            },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/${name}.git`],
              { cwd: project!.dir, runtime, env },
            );

            expect(result.exitCode).toBe(0);
            expect(readNpmInvocations(logFile)).toHaveLength(0);
            if (warningKind === "invalid-json") {
              expect(countInvalidJsonWarnings(result.stderr, name)).toBe(1);
            } else {
              expect(countInvalidSemverWarnings(result.stderr, name)).toBe(1);
            }
            expect(existsSync(join(project!.loopxDir, name, ".gitignore"))).toBe(
              false,
            );
            expectNoAutoInstallFailureReport(result.stderr);
            expect(readFileSync(join(project!.loopxDir, name, "package.json"), "utf-8")).toBe(
              packageJson,
            );
          });
        },
      );

      it("T-INST-113a: unreadable committed package.json skips auto-install with one warning", async () => {
        if (IS_ROOT) {
          expect(IS_ROOT).toBe(true);
          return;
        }
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({ name: "ralph", version: "1.0.0" }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/ralph.git`],
            {
              cwd: project!.dir,
              runtime,
              env: {
                ...env,
                NODE_ENV: "test",
                LOOPX_TEST_AUTOINSTALL_FAULT:
                  "package-json-make-unreadable:ralph",
              },
            },
          );

          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          expect(countUnreadableWarnings(result.stderr, "ralph")).toBe(1);
          expect(existsSync(join(project!.loopxDir, "ralph", ".gitignore"))).toBe(
            false,
          );
          const packagePath = join(project!.loopxDir, "ralph", "package.json");
          expect(lstatSync(packagePath).mode & 0o777).toBe(0);
          await chmod(packagePath, 0o644);
          expectNoAutoInstallFailureReport(result.stderr);
        });
      });

      it.each([
        [
          "T-INST-113d",
          "ignored-optional",
          { optionalDependencies: { loopx: "not-a-range!!!" } },
        ],
        [
          "T-INST-113d2",
          "ignored-peer",
          { peerDependencies: { loopx: "not-a-range!!!" } },
        ],
        [
          "T-INST-113e",
          "dependency-precedence",
          {
            dependencies: { loopx: "*" },
            devDependencies: { loopx: "not-a-range!!!" },
          },
        ],
        [
          "T-INST-113f",
          "unrelated-invalid-range",
          { dependencies: { "not-loopx": "not-a-range!!!" } },
        ],
      ] as const)(
        "%s: ignored invalid package ranges do not skip auto-install",
        async (_id, name, packageJson) => {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name,
              files: {
                "index.sh": BASH_STOP,
                "package.json": JSON.stringify(packageJson),
              },
            },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/${name}.git`],
              { cwd: project!.dir, runtime, env },
            );

            expect(result.exitCode).toBe(0);
            expect(hasAnyPackageJsonWarning(result.stderr, name)).toBe(false);
            expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
              join(project!.loopxDir, name),
            ]);
            expect(readFileSync(join(project!.loopxDir, name, ".gitignore"), "utf-8")).toMatch(
              /^node_modules\s*$/,
            );
          });
        },
      );

      it("T-INST-113c: multi-workflow install continues past invalid JSON package.json", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": "{broken",
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "beta"),
          ]);
          expect(countInvalidJsonWarnings(result.stderr, "alpha")).toBe(1);
          expect(existsSync(join(project!.loopxDir, "alpha", ".gitignore"))).toBe(
            false,
          );
          expect(readFileSync(join(project!.loopxDir, "beta", ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
          expectNoAutoInstallFailureReport(result.stderr);
          expect(existsSync(join(project!.loopxDir, "alpha"))).toBe(true);
          expect(existsSync(join(project!.loopxDir, "beta"))).toBe(true);
        });
      });

      it.each([
        [
          "T-INST-113c2",
          "invalid-semver",
          JSON.stringify({ dependencies: { loopx: "not-a-range!!!" } }),
          "invalid-semver",
          undefined,
        ],
        [
          "T-INST-113c2",
          "non-string-range",
          JSON.stringify({ dependencies: { loopx: 42 } }),
          "invalid-semver",
          undefined,
        ],
        [
          "T-INST-113c2",
          "unreadable",
          JSON.stringify({ name: "alpha", version: "1.0.0" }),
          "unreadable",
          "package-json-make-unreadable:alpha",
        ],
      ] as const)(
        "%s: multi-workflow continuation for malformed package cause %s",
        async (_id, variant, alphaPackageJson, warningKind, fault) => {
          if (variant === "unreadable" && IS_ROOT) {
            expect(IS_ROOT).toBe(true);
            return;
          }
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "multi",
              files: {
                "alpha/index.sh": BASH_STOP,
                "alpha/package.json": alphaPackageJson,
                "beta/index.sh": BASH_STOP,
                "beta/package.json": JSON.stringify({
                  name: "beta",
                  version: "1.0.0",
                }),
              },
            },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: fault
                  ? {
                      ...env,
                      NODE_ENV: "test",
                      LOOPX_TEST_AUTOINSTALL_FAULT: fault,
                    }
                  : env,
              },
            );

            expect(result.exitCode).toBe(0);
            expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
              join(project!.loopxDir, "beta"),
            ]);
            if (warningKind === "unreadable") {
              expect(countUnreadableWarnings(result.stderr, "alpha")).toBe(1);
              await chmod(join(project!.loopxDir, "alpha", "package.json"), 0o644);
            } else {
              expect(countInvalidSemverWarnings(result.stderr, "alpha")).toBe(1);
            }
            expect(existsSync(join(project!.loopxDir, "alpha", ".gitignore"))).toBe(
              false,
            );
            expect(readFileSync(join(project!.loopxDir, "beta", ".gitignore"), "utf-8")).toMatch(
              /^node_modules\s*$/,
            );
            expectNoAutoInstallFailureReport(result.stderr);
          });
        },
      );

      it("T-INST-113h: directory package.json skips only that workflow", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json/README": "not a regular file",
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "beta"),
          ]);
          expect(lstatSync(join(project!.loopxDir, "alpha", "package.json")).isDirectory()).toBe(
            true,
          );
          expect(result.stderr).toMatch(/alpha/i);
          expect(result.stderr).toMatch(/package\.json/i);
          expect(existsSync(join(project!.loopxDir, "alpha", ".gitignore"))).toBe(
            false,
          );
          expect(readFileSync(join(project!.loopxDir, "beta", ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
          expectNoAutoInstallFailureReport(result.stderr);
        });
      });

      it.each([
        [
          "T-INST-113i",
          "package-json-replace-with-symlink:alpha=regular-file-target",
          "isSymbolicLink",
        ],
        [
          "T-INST-113i",
          "package-json-replace-with-symlink:alpha=broken",
          "isSymbolicLink",
        ],
        [
          "T-INST-113i",
          "package-json-replace-with-symlink:alpha=cycle",
          "isSymbolicLink",
        ],
        ["T-INST-113j", "package-json-replace-with-fifo:alpha", "isFIFO"],
        ["T-INST-113k", "package-json-replace-with-socket:alpha", "isSocket"],
      ] as const)(
        "%s: non-regular committed package.json skips auto-install (%s)",
        async (_id, fault, statMethod) => {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "multi",
              files: {
                "alpha/index.sh": BASH_STOP,
                "alpha/package.json": JSON.stringify({
                  name: "alpha",
                  version: "1.0.0",
                }),
                "beta/index.sh": BASH_STOP,
                "beta/package.json": JSON.stringify({
                  name: "beta",
                  version: "1.0.0",
                }),
              },
            },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: {
                  ...env,
                  NODE_ENV: "test",
                  LOOPX_TEST_AUTOINSTALL_FAULT: fault,
                },
              },
            );

            expect(result.exitCode).toBe(0);
            expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
              join(project!.loopxDir, "beta"),
            ]);
            expect(lstatSync(join(project!.loopxDir, "alpha", "package.json"))[statMethod]()).toBe(
              true,
            );
            expect(result.stderr).toMatch(/alpha/i);
            expect(result.stderr).toMatch(/package\.json/i);
            expect(existsSync(join(project!.loopxDir, "alpha", ".gitignore"))).toBe(
              false,
            );
            expect(readFileSync(join(project!.loopxDir, "beta", ".gitignore"), "utf-8")).toMatch(
              /^node_modules\s*$/,
            );
            expectNoAutoInstallFailureReport(result.stderr);
          });
        },
      );

      it.skipIf(process.env.CI || process.env.LOOPX_RUN_PRIVILEGED_LOCAL_TESTS !== "1")(
        "T-INST-113-package: block/character device committed package.json skips auto-install",
        async () => {
          for (const [fault, statMethod] of [
            ["package-json-replace-with-char-device:alpha", "isCharacterDevice"],
            ["package-json-replace-with-block-device:alpha", "isBlockDevice"],
          ] as const) {
            project = await createTempProject();
            gitServer = await startLocalGitServer([
              {
                name: "multi",
                files: {
                  "alpha/index.sh": BASH_STOP,
                  "alpha/package.json": JSON.stringify({
                    name: "alpha",
                    version: "1.0.0",
                  }),
                  "beta/index.sh": BASH_STOP,
                  "beta/package.json": JSON.stringify({
                    name: "beta",
                    version: "1.0.0",
                  }),
                },
              },
            ]);

            await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
              const result = await runCLI(
                ["install", `${gitServer!.url}/multi.git`],
                {
                  cwd: project!.dir,
                  runtime,
                  env: {
                    ...env,
                    NODE_ENV: "test",
                    LOOPX_TEST_AUTOINSTALL_FAULT: fault,
                  },
                },
              );

              expect(result.exitCode).toBe(0);
              expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
                join(project!.loopxDir, "beta"),
              ]);
              expect(lstatSync(join(project!.loopxDir, "alpha", "package.json"))[statMethod]()).toBe(
                true,
              );
              expect(result.stderr).toMatch(/alpha/i);
              expect(result.stderr).toMatch(/package\.json/i);
              expect(existsSync(join(project!.loopxDir, "alpha", ".gitignore"))).toBe(
                false,
              );
              expectNoAutoInstallFailureReport(result.stderr);
            });

            await gitServer.close().catch(() => {});
            gitServer = null;
            await project.cleanup().catch(() => {});
            project = null;
          }
        },
      );

      it.each([
        [
          "invalid-json",
          { "alpha/package.json": "{broken" },
          "invalid-json",
          undefined,
        ],
        [
          "unreadable",
          {
            "alpha/package.json": JSON.stringify({
              name: "alpha",
              version: "1.0.0",
            }),
          },
          "unreadable",
          "package-json-make-unreadable:alpha",
        ],
        [
          "invalid-semver",
          {
            "alpha/package.json": JSON.stringify({
              dependencies: { loopx: "not-a-range!!!" },
            }),
          },
          "invalid-semver",
          undefined,
        ],
        [
          "non-string-range",
          {
            "alpha/package.json": JSON.stringify({
              dependencies: { loopx: 42 },
            }),
          },
          "invalid-semver",
          undefined,
        ],
        [
          "non-regular-directory",
          { "alpha/package.json/README": "not a regular file" },
          "package-json",
          undefined,
        ],
      ] as const)(
        "T-INST-113l: -w selected malformed package.json skips auto-install (%s)",
        async (variant, alphaFiles, warningKind, fault) => {
          if (variant === "unreadable" && IS_ROOT) {
            expect(IS_ROOT).toBe(true);
            return;
          }
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "multi",
              files: {
                "alpha/index.sh": BASH_STOP,
                ...alphaFiles,
                "beta/index.sh": BASH_STOP,
                "beta/package.json": JSON.stringify({
                  name: "beta",
                  version: "1.0.0",
                }),
              },
            },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const result = await runCLI(
              ["install", "-w", "alpha", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: fault
                  ? {
                      ...env,
                      NODE_ENV: "test",
                      LOOPX_TEST_AUTOINSTALL_FAULT: fault,
                    }
                  : env,
              },
            );

            expect(result.exitCode).toBe(0);
            expect(readNpmInvocations(logFile)).toHaveLength(0);
            if (warningKind === "invalid-json") {
              expect(countInvalidJsonWarnings(result.stderr, "alpha")).toBe(1);
            } else if (warningKind === "invalid-semver") {
              expect(countInvalidSemverWarnings(result.stderr, "alpha")).toBe(1);
            } else if (warningKind === "unreadable") {
              expect(countUnreadableWarnings(result.stderr, "alpha")).toBe(1);
              await chmod(join(project!.loopxDir, "alpha", "package.json"), 0o644);
            } else {
              expect(result.stderr).toMatch(/alpha/i);
              expect(result.stderr).toMatch(/package\.json/i);
            }
            expect(existsSync(join(project!.loopxDir, "alpha", "index.sh"))).toBe(
              true,
            );
            if (variant === "non-regular-directory") {
              expect(
                lstatSync(
                  join(project!.loopxDir, "alpha", "package.json"),
                ).isDirectory(),
              ).toBe(true);
            } else {
              expect(
                existsSync(join(project!.loopxDir, "alpha", "package.json")),
              ).toBe(true);
            }
            expect(existsSync(join(project!.loopxDir, "beta"))).toBe(false);
            expect(existsSync(join(project!.loopxDir, "alpha", ".gitignore"))).toBe(
              false,
            );
            expectNoAutoInstallFailureReport(result.stderr);
          });
        },
      );

      it.each([
        [
          "T-INST-113m",
          "package-json-remove:alpha",
          "{ \"name\": \"alpha\", \"version\": \"1.0.0\" }",
          false,
        ],
        [
          "T-INST-113n",
          "package-json-replace-with-valid:alpha",
          "{broken",
          true,
        ],
      ] as const)(
        "%s: auto-install re-evaluates committed package.json state",
        async (_id, fault, alphaPackageJson, alphaShouldRun) => {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "multi",
              files: {
                "alpha/index.sh": BASH_STOP,
                "alpha/package.json": alphaPackageJson,
                "beta/index.sh": BASH_STOP,
                "beta/package.json": JSON.stringify({
                  name: "beta",
                  version: "1.0.0",
                }),
              },
            },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: {
                  ...env,
                  NODE_ENV: "test",
                  LOOPX_TEST_AUTOINSTALL_FAULT: fault,
                },
              },
            );

            expect(result.exitCode).toBe(0);
            const cwds = readNpmInvocations(logFile)
              .map((i) => i.cwd)
              .sort();
            expect(cwds).toEqual(
              alphaShouldRun
                ? [
                    join(project!.loopxDir, "alpha"),
                    join(project!.loopxDir, "beta"),
                  ].sort()
                : [join(project!.loopxDir, "beta")],
            );
            if (alphaShouldRun) {
              expect(countInvalidJsonWarnings(result.stderr, "alpha")).toBe(1);
              expect(
                readFileSync(
                  join(project!.loopxDir, "alpha", "package.json"),
                  "utf-8",
                ),
              ).toMatch(/"dependencies"\s*:\s*\{\s*"loopx"\s*:\s*"\*"/);
              expect(readFileSync(join(project!.loopxDir, "alpha", ".gitignore"), "utf-8")).toMatch(
                /^node_modules\s*$/,
              );
            } else {
              expect(result.stderr).not.toMatch(/alpha.*package\.json/i);
              expect(
                existsSync(join(project!.loopxDir, "alpha", "package.json")),
              ).toBe(false);
              expect(
                existsSync(join(project!.loopxDir, "alpha", ".gitignore")),
              ).toBe(false);
            }
            expect(readFileSync(join(project!.loopxDir, "beta", ".gitignore"), "utf-8")).toMatch(
              /^node_modules\s*$/,
            );
            expectNoAutoInstallFailureReport(result.stderr);
          });
        },
      );

      it("T-INST-114: npm install non-zero exits aggregate, continue, and leave commits", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
              "gamma/index.sh": BASH_STOP,
              "gamma/package.json": JSON.stringify({
                name: "gamma",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm(
          { exitCode: 0, exitCodeByWorkflow: { beta: 1, gamma: 1 } },
          async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              { cwd: project!.dir, runtime, env },
            );

            expect(result.exitCode).toBe(1);
            expect(readNpmInvocations(logFile).map((i) => i.cwd).sort()).toEqual(
              [
                join(project!.loopxDir, "alpha"),
                join(project!.loopxDir, "beta"),
                join(project!.loopxDir, "gamma"),
              ].sort(),
            );
            expect(result.stderr).toMatch(/beta/i);
            expect(result.stderr).toMatch(/gamma/i);
            expect(result.stderr).toMatch(/npm|install|exit|failed/i);
            expect(result.stderr).not.toMatch(/alpha.*failed/i);
            for (const name of ["alpha", "beta", "gamma"]) {
              expect(existsSync(join(project!.loopxDir, name, "index.sh"))).toBe(
                true,
              );
              expect(
                existsSync(join(project!.loopxDir, name, "package.json")),
              ).toBe(true);
            }
          },
        );
      });

      it("T-INST-114a / T-INST-114c: npm spawn failures aggregate after safeguards synthesize .gitignore", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
              "gamma/index.sh": BASH_STOP,
              "gamma/package.json": JSON.stringify({
                name: "gamma",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            {
              cwd: project!.dir,
              runtime,
              env: {
                ...env,
                NODE_ENV: "test",
                LOOPX_TEST_AUTOINSTALL_FAULT:
                  "npm-spawn-fail:alpha,beta,gamma",
              },
            },
          );

          expect(result.exitCode).toBe(1);
          expect(readNpmInvocations(logFile)).toHaveLength(0);
          for (const name of ["alpha", "beta", "gamma"]) {
            expect(result.stderr).toMatch(new RegExp(name, "i"));
            expect(existsSync(join(project!.loopxDir, name, "index.sh"))).toBe(
              true,
            );
            expect(readFileSync(join(project!.loopxDir, name, ".gitignore"), "utf-8")).toMatch(
              /^node_modules\s*$/,
            );
          }
          expect(result.stderr).toMatch(/spawn|ENOENT|npm/i);
        });
      });

      it("T-INST-114b: per-workflow npm spawn failure continues to later workflows", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
              "gamma/index.sh": BASH_STOP,
              "gamma/package.json": JSON.stringify({
                name: "gamma",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            {
              cwd: project!.dir,
              runtime,
              env: {
                ...env,
                NODE_ENV: "test",
                LOOPX_TEST_AUTOINSTALL_FAULT: "npm-spawn-fail:beta,gamma",
              },
            },
          );

          expect(result.exitCode).toBe(1);
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "alpha"),
          ]);
          expect(result.stderr).toMatch(/beta/i);
          expect(result.stderr).toMatch(/gamma/i);
          expect(result.stderr).toMatch(/spawn|ENOENT|npm/i);
          expect(result.stderr).not.toMatch(/alpha.*spawn|alpha.*ENOENT/i);
        });
      });

      it("T-INST-114d: mixed safeguard, npm non-zero, and spawn failures preserve categories", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
              "gamma/index.sh": BASH_STOP,
              "gamma/package.json": JSON.stringify({
                name: "gamma",
                version: "1.0.0",
              }),
              "delta/index.sh": BASH_STOP,
              "delta/package.json": JSON.stringify({
                name: "delta",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm(
          { exitCode: 0, exitCodeByWorkflow: { beta: 1 } },
          async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: {
                  ...env,
                  NODE_ENV: "test",
                  LOOPX_TEST_AUTOINSTALL_FAULT:
                    "gitignore-write-fail:alpha;npm-spawn-fail:gamma",
                },
              },
            );

            expect(result.exitCode).toBe(1);
            expect(readNpmInvocations(logFile).map((i) => i.cwd).sort()).toEqual(
              [
                join(project!.loopxDir, "beta"),
                join(project!.loopxDir, "delta"),
              ].sort(),
            );
            expect(result.stderr).toMatch(/alpha/i);
            expect(result.stderr).toMatch(/gitignore/i);
            expect(result.stderr).toMatch(/beta/i);
            expect(result.stderr).toMatch(/exit|non.?zero|failed/i);
            expect(result.stderr).toMatch(/gamma/i);
            expect(result.stderr).toMatch(/spawn|ENOENT|npm/i);
            expect(result.stderr).not.toMatch(/delta.*failed/i);
            expect(existsSync(join(project!.loopxDir, "alpha", ".gitignore"))).toBe(
              false,
            );
            for (const name of ["beta", "gamma", "delta"]) {
              expect(readFileSync(join(project!.loopxDir, name, ".gitignore"), "utf-8")).toMatch(
                /^node_modules\s*$/,
              );
            }
          },
        );
      });

      it("T-INST-115: npm install inherits loopx process.env unchanged without env-file or protocol injection", async () => {
        project = await createTempProject();
        const configHome = join(project.dir, "xdg");
        await mkdir(join(configHome, "loopx"), { recursive: true });
        await writeFile(
          join(configHome, "loopx", "env"),
          "INJECTED_GLOBAL=yes\nPATH=/fake/env-file-path\n",
          "utf-8",
        );
        gitServer = await startLocalGitServer([
          {
            name: "env-probe",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "env-probe",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withScrubbedLoopxProcessEnv(async () => {
          await withEnvRecordingFakeNpm(
            [
              "MYVAR",
              "INJECTED_GLOBAL",
              "PATH",
              "TMPDIR",
              "PWD",
              "LOOPX_BIN",
              "LOOPX_PROJECT_ROOT",
              "LOOPX_WORKFLOW",
              "LOOPX_WORKFLOW_DIR",
              "LOOPX_TMPDIR",
            ],
            async (env, logFile) => {
              const result = await runCLI(
                ["install", `${gitServer!.url}/env-probe.git`],
                {
                  cwd: project!.dir,
                  runtime,
                  env: {
                    ...env,
                    MYVAR: "inherited",
                    PWD: project!.dir,
                    TMPDIR: tmpdir(),
                    XDG_CONFIG_HOME: configHome,
                  },
                },
              );

              expect(result.exitCode).toBe(0);
              const [invocation] = readEnvRecordingInvocations(logFile);
              expect(invocation.cwd).toBe(join(project!.loopxDir, "env-probe"));
              expect(invocation.argv).toEqual(["install"]);
              expect(invocation.env.MYVAR).toBe("inherited");
              expect(invocation.env.INJECTED_GLOBAL).toBeUndefined();
              expect(invocation.env.PATH).toBe(env.PATH);
              expect(invocation.env.TMPDIR).toBe(tmpdir());
              expect(invocation.env.PWD).toBe(project!.dir);
              for (const key of [
                "LOOPX_BIN",
                "LOOPX_PROJECT_ROOT",
                "LOOPX_WORKFLOW",
                "LOOPX_WORKFLOW_DIR",
                "LOOPX_TMPDIR",
              ]) {
                expect(invocation.env[key]).toBeUndefined();
              }
            },
          );
        });
      });

      it("T-INST-115a: inherited LOOPX protocol variables pass through to npm unchanged", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "protocol-pass",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "protocol-pass",
                version: "1.0.0",
              }),
            },
          },
        ]);

        const inherited = {
          LOOPX_BIN: "/inherited-bin/loopx",
          LOOPX_TMPDIR: "/inherited-tmp",
          LOOPX_WORKFLOW: "/inherited-workflow",
          LOOPX_PROJECT_ROOT: "/inherited-project-root",
          LOOPX_WORKFLOW_DIR: "/inherited-workflow-dir",
        };

        await withEnvRecordingFakeNpm(
          Object.keys(inherited),
          async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/protocol-pass.git`],
              {
                cwd: project!.dir,
                runtime,
                env: { ...env, ...inherited },
              },
            );

            expect(result.exitCode).toBe(0);
            const [invocation] = readEnvRecordingInvocations(logFile);
            for (const [key, value] of Object.entries(inherited)) {
              expect(invocation.env[key]).toBe(value);
            }
          },
        );
      });

      it("T-INST-115b: inherited LOOPX_DELEGATED passes through to npm unchanged", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "delegated-pass",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "delegated-pass",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withEnvRecordingFakeNpm(
          ["LOOPX_DELEGATED"],
          async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/delegated-pass.git`],
              {
                cwd: project!.dir,
                runtime,
                env: { ...env, LOOPX_DELEGATED: "1" },
              },
            );

            expect(result.exitCode).toBe(0);
            const [invocation] = readEnvRecordingInvocations(logFile);
            expect(invocation.env.LOOPX_DELEGATED).toBe("1");
            expect(result.stderr).not.toMatch(/delegat|recurs/i);
          },
        );
      });

      it("T-INST-115c: unreadable global env file does not affect loopx install", async () => {
        if (IS_ROOT) {
          expect(IS_ROOT).toBe(true);
          return;
        }
        project = await createTempProject();
        const configHome = join(project.dir, "xdg");
        const envFile = join(configHome, "loopx", "env");
        await mkdir(dirname(envFile), { recursive: true });
        await writeFile(envFile, "READABLE_TEST_KEY=value\n", "utf-8");
        await chmod(envFile, 0);
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({ name: "ralph", version: "1.0.0" }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/ralph.git`],
            {
              cwd: project!.dir,
              runtime,
              env: { ...env, XDG_CONFIG_HOME: configHome },
            },
          );

          await chmod(envFile, 0o644);
          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "ralph"),
          ]);
          expect(result.stderr).not.toMatch(/env|EACCES|permission|unreadable/i);
          expect(existsSync(join(project!.loopxDir, "ralph", "index.sh"))).toBe(
            true,
          );
        });
      });

      it("T-INST-115d: malformed global env file emits no parser warning during install", async () => {
        project = await createTempProject();
        const configHome = join(project.dir, "xdg");
        const envFile = join(configHome, "loopx", "env");
        await mkdir(dirname(envFile), { recursive: true });
        await writeFile(envFile, "1BAD=val\nKEY WITH SPACES=val\n", "utf-8");
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({ name: "ralph", version: "1.0.0" }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/ralph.git`],
            {
              cwd: project!.dir,
              runtime,
              env: { ...env, XDG_CONFIG_HOME: configHome },
            },
          );

          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "ralph"),
          ]);
          expect(result.stderr).not.toMatch(/invalid.*env|invalid.*key|ignored/i);
          expect(existsSync(join(project!.loopxDir, "ralph", "index.sh"))).toBe(
            true,
          );
        });
      });

      it.each([
        ["T-INST-116", "SIGINT", 130],
        ["T-INST-116a", "SIGTERM", 143],
      ] as const)(
        "%s: signal during npm install terminates npm child",
        async (_id, signal, expectedExit) => {
          project = await createTempProject();
          const pidFile = join(project.dir, `${signal}-npm.pid`);
          gitServer = await startLocalGitServer([
            {
              name: "ralph",
              files: {
                "index.sh": BASH_STOP,
                "package.json": JSON.stringify({
                  name: "ralph",
                  version: "1.0.0",
                }),
              },
            },
          ]);

          await withFakeNpm(
            {
              sleepSeconds: 30,
              pidFile,
              stderr: "ready",
            },
            async (env) => {
              const handle = runCLIWithSignal(
                ["install", `${gitServer!.url}/ralph.git`],
                { cwd: project!.dir, runtime, env, timeout: 15_000 },
              );
              await handle.waitForStderr("ready", { timeoutMs: 5_000 });
              const npmPid = Number(readFileSync(pidFile, "utf-8"));
              handle.sendSignal(signal);
              const result = await handle.result;
              expect(result.exitCode).toBe(expectedExit);
              expect(isProcessAlive(npmPid)).toBe(false);
            },
          );
        },
      );

      it.each([
        ["T-INST-116b", "SIGINT", 130],
        ["T-INST-116b2", "SIGTERM", 143],
      ] as const)(
        "%s: signal during first npm install leaves remaining workflows unprocessed",
        async (_id, signal, expectedExit) => {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "multi",
              files: {
                "alpha/index.sh": BASH_STOP,
                "alpha/package.json": JSON.stringify({
                  name: "alpha",
                  version: "1.0.0",
                }),
                "beta/index.sh": BASH_STOP,
                "beta/package.json": JSON.stringify({
                  name: "beta",
                  version: "1.0.0",
                }),
                "gamma/index.sh": BASH_STOP,
                "gamma/package.json": JSON.stringify({
                  name: "gamma",
                  version: "1.0.0",
                }),
              },
            },
          ]);

          await withFakeNpm(
            { sleepSeconds: 30, stderr: "ready" },
            async (env, logFile) => {
              const handle = runCLIWithSignal(
                ["install", `${gitServer!.url}/multi.git`],
                { cwd: project!.dir, runtime, env, timeout: 15_000 },
              );
              await handle.waitForStderr("ready", { timeoutMs: 5_000 });
              handle.sendSignal(signal);
              const result = await handle.result;
              expect(result.exitCode).toBe(expectedExit);
              const invocations = readNpmInvocations(logFile);
              expect(invocations).toHaveLength(1);
              const first = invocations[0].cwd.split("/").at(-1)!;
              for (const name of ["alpha", "beta", "gamma"]) {
                expect(existsSync(join(project!.loopxDir, name, "index.sh"))).toBe(
                  true,
                );
                expect(
                  existsSync(join(project!.loopxDir, name, "package.json")),
                ).toBe(true);
                expect(existsSync(join(project!.loopxDir, name, ".gitignore"))).toBe(
                  name === first,
                );
              }
            },
          );
        },
      );

      it.each([
        ["T-INST-116d", "SIGINT", 130],
        ["T-INST-116d2", "SIGTERM", 143],
      ] as const)(
        "%s: signal does not clean partial node_modules state",
        async (_id, signal, expectedExit) => {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "ralph",
              files: {
                "index.sh": BASH_STOP,
                "package.json": JSON.stringify({
                  name: "ralph",
                  version: "1.0.0",
                }),
              },
            },
          ]);

          await withFakeNpm(
            {
              sleepSeconds: 30,
              stderr: "ready",
              createFiles: ["node_modules/partial-file"],
            },
            async (env) => {
              const handle = runCLIWithSignal(
                ["install", `${gitServer!.url}/ralph.git`],
                { cwd: project!.dir, runtime, env, timeout: 15_000 },
              );
              await handle.waitForStderr("ready", { timeoutMs: 5_000 });
              handle.sendSignal(signal);
              const result = await handle.result;
              expect(result.exitCode).toBe(expectedExit);
              expect(
                existsSync(
                  join(project!.loopxDir, "ralph", "node_modules", "partial-file"),
                ),
              ).toBe(true);
            },
          );
        },
      );

      it.each([
        ["T-INST-116c", "SIGTERM", 143, ["TERM", "INT"] as const],
        ["T-INST-116f", "SIGINT", 130, ["INT", "TERM"] as const],
      ] as const)(
        "%s: signal grace period escalates when npm child ignores %s",
        async (_id, signal, expectedExit, trapSignals) => {
          project = await createTempProject();
          const pidFile = join(project.dir, `${signal}-trapped-npm.pid`);
          gitServer = await startLocalGitServer([
            {
              name: "ralph",
              files: {
                "index.sh": BASH_STOP,
                "package.json": JSON.stringify({
                  name: "ralph",
                  version: "1.0.0",
                }),
              },
            },
          ]);

          await withFakeNpm(
            {
              sleepSeconds: 30,
              stderr: "ready",
              pidFile,
              trapSignals: [...trapSignals],
            },
            async (env) => {
              const handle = runCLIWithSignal(
                ["install", `${gitServer!.url}/ralph.git`],
                { cwd: project!.dir, runtime, env, timeout: 15_000 },
              );
              await handle.waitForStderr("ready", { timeoutMs: 5_000 });
              const npmPid = Number(readFileSync(pidFile, "utf-8"));
              const started = Date.now();
              handle.sendSignal(signal);
              const result = await handle.result;
              const elapsedMs = Date.now() - started;
              expect(result.exitCode).toBe(expectedExit);
              expect(elapsedMs).toBeGreaterThanOrEqual(4_000);
              expect(elapsedMs).toBeLessThan(8_000);
              expect(isProcessAlive(npmPid)).toBe(false);
              expectNoAutoInstallFailureReport(result.stderr);
            },
          );
        },
      );

      it.each([
        ["T-INST-116e", "SIGTERM", 143],
        ["T-INST-116g", "SIGINT", 130],
      ] as const)(
        "%s: signal during npm install reaches npm child process group",
        async (_id, signal, expectedExit) => {
          project = await createTempProject();
          const pidFile = join(project.dir, `${signal}-npm.pid`);
          const grandchildPidFile = join(project.dir, `${signal}-grandchild.pid`);
          gitServer = await startLocalGitServer([
            {
              name: "ralph",
              files: {
                "index.sh": BASH_STOP,
                "package.json": JSON.stringify({
                  name: "ralph",
                  version: "1.0.0",
                }),
              },
            },
          ]);

          await withFakeNpm(
            {
              sleepSeconds: 30,
              stderr: "ready",
              pidFile,
              spawnGrandchild: true,
              grandchildPidFile,
            },
            async (env) => {
              const handle = runCLIWithSignal(
                ["install", `${gitServer!.url}/ralph.git`],
                { cwd: project!.dir, runtime, env, timeout: 15_000 },
              );
              await handle.waitForStderr("ready", { timeoutMs: 5_000 });
              const npmPid = Number(readFileSync(pidFile, "utf-8"));
              const grandchildPid = Number(
                readFileSync(grandchildPidFile, "utf-8"),
              );
              handle.sendSignal(signal);
              const result = await handle.result;
              expect(result.exitCode).toBe(expectedExit);
              expect(isProcessAlive(npmPid)).toBe(false);
              expect(isProcessAlive(grandchildPid)).toBe(false);
            },
          );
        },
      );

      it.each([
        ["T-INST-116n", "SIGINT", 130],
        ["T-INST-116n2", "SIGTERM", 143],
      ] as const)(
        "%s: signal before first auto-install workflow prevents all safeguards and spawns",
        async (_id, signal, expectedExit) => {
          const names = ["alpha", "beta", "gamma"];
          project = await createTempProject();
          const markerPath = join(project.dir, `${signal}-before-first.json`);
          gitServer = await startLocalGitServer([
            { name: "multi", files: packageJsonWorkflowFiles(names) },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const handle = runCLIWithSignal(
              ["install", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: {
                  ...env,
                  NODE_ENV: "test",
                  LOOPX_TEST_AUTOINSTALL_PAUSE: "before-first-workflow",
                  LOOPX_TEST_AUTOINSTALL_PAUSE_MARKER: markerPath,
                },
                timeout: 15_000,
              },
            );
            const marker = await waitForAutoInstallPauseMarker(markerPath);
            expect(marker.window).toBe("before-first-workflow");
            expect(marker.processed).toEqual([]);
            expect(marker.current).not.toBeNull();
            expectWorkflowNamesCoverMarker(marker, names);
            handle.sendSignal(signal);

            const result = await handle.result;
            expect(result.exitCode).toBe(expectedExit);
            expect(readNpmInvocations(logFile)).toHaveLength(0);
            expectCommittedWorkflows(project!.loopxDir, names);
            for (const name of names) {
              expect(existsSync(join(project!.loopxDir, name, ".gitignore"))).toBe(
                false,
              );
            }
            expectNoAutoInstallFailureReport(result.stderr);
          });
        },
      );

      it.each([
        ["T-INST-116h", "SIGINT", 130],
        ["T-INST-116h2", "SIGTERM", 143],
      ] as const)(
        "%s: signal between auto-install workflows stops remaining safeguards and spawns",
        async (_id, signal, expectedExit) => {
          const names = ["alpha", "beta", "gamma"];
          project = await createTempProject();
          const markerPath = join(project.dir, `${signal}-between.json`);
          gitServer = await startLocalGitServer([
            { name: "multi", files: packageJsonWorkflowFiles(names) },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const handle = runCLIWithSignal(
              ["install", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: {
                  ...env,
                  NODE_ENV: "test",
                  LOOPX_TEST_AUTOINSTALL_PAUSE: "between-workflows-after-first",
                  LOOPX_TEST_AUTOINSTALL_PAUSE_MARKER: markerPath,
                },
                timeout: 15_000,
              },
            );
            const marker = await waitForAutoInstallPauseMarker(markerPath);
            expect(marker.window).toBe("between-workflows-after-first");
            expect(marker.processed).toHaveLength(1);
            expect(marker.current).not.toBeNull();
            expectWorkflowNamesCoverMarker(marker, names);
            handle.sendSignal(signal);

            const result = await handle.result;
            expect(result.exitCode).toBe(expectedExit);
            expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
              join(project!.loopxDir, marker.processed[0]),
            ]);
            expectCommittedWorkflows(project!.loopxDir, names);
            for (const name of names) {
              expect(existsSync(join(project!.loopxDir, name, ".gitignore"))).toBe(
                name === marker.processed[0],
              );
            }
            expectNoAutoInstallFailureReport(result.stderr);
          });
        },
      );

      it.each([
        ["T-INST-116i", "SIGINT", 130],
        ["T-INST-116i2", "SIGTERM", 143],
      ] as const)(
        "%s: signal in pre-spawn safeguard window preserves marker-captured .gitignore state",
        async (_id, signal, expectedExit) => {
          const names = ["alpha", "beta", "gamma"];
          project = await createTempProject();
          const markerPath = join(project.dir, `${signal}-pre-spawn.json`);
          gitServer = await startLocalGitServer([
            { name: "multi", files: packageJsonWorkflowFiles(names) },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const handle = runCLIWithSignal(
              ["install", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: {
                  ...env,
                  NODE_ENV: "test",
                  LOOPX_TEST_AUTOINSTALL_PAUSE: "pre-spawn-first",
                  LOOPX_TEST_AUTOINSTALL_PAUSE_MARKER: markerPath,
                },
                timeout: 15_000,
              },
            );
            const marker = await waitForAutoInstallPauseMarker(markerPath);
            expect(marker.window).toBe("pre-spawn-first");
            expect(marker.processed).toEqual([]);
            expect(marker.current).not.toBeNull();
            expect(marker.gitignoreStateAtPause).toBeDefined();
            expectWorkflowNamesCoverMarker(marker, names);
            handle.sendSignal(signal);

            const result = await handle.result;
            expect(result.exitCode).toBe(expectedExit);
            expect(readNpmInvocations(logFile)).toHaveLength(0);
            expectCommittedWorkflows(project!.loopxDir, names);
            expectGitignoreMatchesPauseState(
              project!.loopxDir,
              marker.current!,
              marker.gitignoreStateAtPause!,
            );
            for (const name of names.filter((name) => name !== marker.current)) {
              expect(existsSync(join(project!.loopxDir, name, ".gitignore"))).toBe(
                false,
              );
            }
            expectNoAutoInstallFailureReport(result.stderr);
          });
        },
      );

      it.each([
        ["T-INST-116j", "SIGTERM", 143, 0],
        ["T-INST-116j2", "SIGINT", 130, 1],
        ["T-INST-116j3", "SIGTERM", 143, 1],
      ] as const)(
        "%s: signal after first npm child exit stops before the next workflow",
        async (_id, signal, expectedExit, npmExitCode) => {
          const names = ["alpha", "beta", "gamma"];
          project = await createTempProject();
          const markerPath = join(project.dir, `${signal}-post-exit.json`);
          gitServer = await startLocalGitServer([
            { name: "multi", files: packageJsonWorkflowFiles(names) },
          ]);

          await withFakeNpm({ exitCode: npmExitCode }, async (env, logFile) => {
            const handle = runCLIWithSignal(
              ["install", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: {
                  ...env,
                  NODE_ENV: "test",
                  LOOPX_TEST_AUTOINSTALL_PAUSE: "post-exit-first",
                  LOOPX_TEST_AUTOINSTALL_PAUSE_MARKER: markerPath,
                },
                timeout: 15_000,
              },
            );
            const marker = await waitForAutoInstallPauseMarker(markerPath);
            expect(marker.window).toBe("post-exit-first");
            expect(marker.processed).toEqual([]);
            expect(marker.current).not.toBeNull();
            expectWorkflowNamesCoverMarker(marker, names);
            handle.sendSignal(signal);

            const result = await handle.result;
            expect(result.exitCode).toBe(expectedExit);
            expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
              join(project!.loopxDir, marker.current!),
            ]);
            expectCommittedWorkflows(project!.loopxDir, names);
            expect(readFileSync(join(project!.loopxDir, marker.current!, ".gitignore"), "utf-8")).toMatch(
              /^node_modules\s*$/,
            );
            for (const name of [...marker.remaining, ...marker.processed]) {
              expect(existsSync(join(project!.loopxDir, name, ".gitignore"))).toBe(
                false,
              );
            }
            expectNoAutoInstallFailureReport(result.stderr);
          });
        },
      );

      it.each([
        ["T-INST-116k", "SIGINT", 130],
        ["T-INST-116k2", "SIGTERM", 143],
      ] as const)(
        "%s: signal after safeguard failure suppresses the not-yet-emitted aggregate report",
        async (_id, signal, expectedExit) => {
          const names = ["alpha", "beta", "gamma"];
          project = await createTempProject();
          const markerPath = join(project.dir, `${signal}-post-safeguard.json`);
          gitServer = await startLocalGitServer([
            { name: "multi", files: packageJsonWorkflowFiles(names) },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const handle = runCLIWithSignal(
              ["install", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: {
                  ...env,
                  NODE_ENV: "test",
                  LOOPX_TEST_AUTOINSTALL_FAULT:
                    "gitignore-replace-with-fifo:alpha,beta,gamma",
                  LOOPX_TEST_AUTOINSTALL_PAUSE: "post-safeguard-failure-first",
                  LOOPX_TEST_AUTOINSTALL_PAUSE_MARKER: markerPath,
                },
                timeout: 15_000,
              },
            );
            const marker = await waitForAutoInstallPauseMarker(markerPath);
            expect(marker.window).toBe("post-safeguard-failure-first");
            expect(marker.current).not.toBeNull();
            expectWorkflowNamesCoverMarker(marker, names);
            handle.sendSignal(signal);

            const result = await handle.result;
            expect(result.exitCode).toBe(expectedExit);
            expect(readNpmInvocations(logFile)).toHaveLength(0);
            expectCommittedWorkflows(project!.loopxDir, names);
            expect(
              lstatSync(join(project!.loopxDir, marker.current!, ".gitignore")).isFIFO(),
            ).toBe(true);
            for (const name of marker.remaining) {
              expect(existsSync(join(project!.loopxDir, name, ".gitignore"))).toBe(
                false,
              );
            }
            expectNoAutoInstallFailureReport(result.stderr);
          });
        },
      );

      it.each([
        ["T-INST-116m", "SIGINT", 130],
        ["T-INST-116m2", "SIGTERM", 143],
      ] as const)(
        "%s: signal after npm spawn failure suppresses the not-yet-emitted aggregate report",
        async (_id, signal, expectedExit) => {
          const names = ["alpha", "beta", "gamma"];
          project = await createTempProject();
          const markerPath = join(project.dir, `${signal}-post-spawn-failure.json`);
          gitServer = await startLocalGitServer([
            { name: "multi", files: packageJsonWorkflowFiles(names) },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const handle = runCLIWithSignal(
              ["install", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: {
                  ...env,
                  NODE_ENV: "test",
                  LOOPX_TEST_AUTOINSTALL_FAULT:
                    "npm-spawn-fail:alpha,beta,gamma",
                  LOOPX_TEST_AUTOINSTALL_PAUSE: "post-spawn-failure-first",
                  LOOPX_TEST_AUTOINSTALL_PAUSE_MARKER: markerPath,
                },
                timeout: 15_000,
              },
            );
            const marker = await waitForAutoInstallPauseMarker(markerPath);
            expect(marker.window).toBe("post-spawn-failure-first");
            expect(marker.current).not.toBeNull();
            expectWorkflowNamesCoverMarker(marker, names);
            handle.sendSignal(signal);

            const result = await handle.result;
            expect(result.exitCode).toBe(expectedExit);
            expect(readNpmInvocations(logFile)).toHaveLength(0);
            expectCommittedWorkflows(project!.loopxDir, names);
            expect(readFileSync(join(project!.loopxDir, marker.current!, ".gitignore"), "utf-8")).toMatch(
              /^node_modules\s*$/,
            );
            for (const name of marker.remaining) {
              expect(existsSync(join(project!.loopxDir, name, ".gitignore"))).toBe(
                false,
              );
            }
            expectNoAutoInstallFailureReport(result.stderr);
          });
        },
      );

      it.each([
        ["T-INST-116l", "SIGINT", 130],
        ["T-INST-116l2", "SIGTERM", 143],
      ] as const)(
        "%s: signal after aggregate report preserves the already-emitted report",
        async (_id, signal, expectedExit) => {
          const names = ["alpha", "beta", "gamma"];
          project = await createTempProject();
          const markerPath = join(project.dir, `${signal}-post-aggregate.json`);
          gitServer = await startLocalGitServer([
            { name: "multi", files: packageJsonWorkflowFiles(names) },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const handle = runCLIWithSignal(
              ["install", `${gitServer!.url}/multi.git`],
              {
                cwd: project!.dir,
                runtime,
                env: {
                  ...env,
                  NODE_ENV: "test",
                  LOOPX_TEST_AUTOINSTALL_FAULT:
                    "gitignore-write-fail:alpha,beta,gamma",
                  LOOPX_TEST_AUTOINSTALL_PAUSE: "post-aggregate-report",
                  LOOPX_TEST_AUTOINSTALL_PAUSE_MARKER: markerPath,
                },
                timeout: 15_000,
              },
            );
            const marker = await waitForAutoInstallPauseMarker(markerPath);
            expect(marker.window).toBe("post-aggregate-report");
            expect(marker.current).toBeNull();
            expect(marker.remaining).toEqual([]);
            expect(marker.processed.sort()).toEqual([...names].sort());
            handle.sendSignal(signal);

            const result = await handle.result;
            expect(result.exitCode).toBe(expectedExit);
            expect(readNpmInvocations(logFile)).toHaveLength(0);
            expectCommittedWorkflows(project!.loopxDir, names);
            for (const name of names) {
              expect(result.stderr).toMatch(new RegExp(name, "i"));
              expect(result.stderr).toMatch(/gitignore/i);
            }
          });
        },
      );

      it.each([
        ["T-INST-116o", "SIGINT", 130],
        ["T-INST-116o2", "SIGTERM", 143],
      ] as const)(
        "%s: signal during active npm child after a prior failure suppresses aggregate report",
        async (_id, signal, expectedExit) => {
          const names = ["alpha", "beta", "gamma"];
          project = await createTempProject();
          const markerPath = join(project.dir, `${signal}-active-after-failure.json`);
          gitServer = await startLocalGitServer([
            { name: "multi", files: packageJsonWorkflowFiles(names) },
          ]);

          await withFakeNpm(
            { exitCode: 1, sleepByInvocation: { 2: 30, 3: 30 } },
            async (env) => {
              const handle = runCLIWithSignal(
                ["install", `${gitServer!.url}/multi.git`],
                {
                  cwd: project!.dir,
                  runtime,
                  env: {
                    ...env,
                    NODE_ENV: "test",
                    LOOPX_TEST_AUTOINSTALL_PAUSE: "child-active-after-failure",
                    LOOPX_TEST_AUTOINSTALL_PAUSE_MARKER: markerPath,
                  },
                  timeout: 15_000,
                },
              );
              const marker = await waitForAutoInstallPauseMarker(markerPath);
              expect(marker.window).toBe("child-active-after-failure");
              expect(marker.current).not.toBeNull();
              expect(marker.processed.length).toBeGreaterThanOrEqual(1);
              expect(marker.activeChildPid).toEqual(expect.any(Number));
              expectWorkflowNamesCoverMarker(marker, names);
              handle.sendSignal(signal);

              const result = await handle.result;
              expect(result.exitCode).toBe(expectedExit);
              expect(isProcessAlive(marker.activeChildPid!)).toBe(false);
              expectCommittedWorkflows(project!.loopxDir, names);
              expectNoAutoInstallFailureReport(result.stderr);
            },
          );
        },
      );

      it.each([
        [
          "T-INST-116o3",
          "gitignore safeguard failure",
          "gitignore-write-fail-first",
          "SIGINT",
          130,
        ],
        [
          "T-INST-116o4",
          "npm spawn failure",
          "npm-spawn-fail-first",
          "SIGTERM",
          143,
        ],
      ] as const)(
        "%s: signal during active npm child after prior %s suppresses aggregate report",
        async (_id, _kind, fault, signal, expectedExit) => {
          const names = ["alpha", "beta", "gamma"];
          project = await createTempProject();
          const markerPath = join(
            project.dir,
            `${signal}-${_id}-active-after-failure.json`,
          );
          gitServer = await startLocalGitServer([
            { name: "multi", files: packageJsonWorkflowFiles(names) },
          ]);

          await withFakeNpm(
            { exitCode: 0, sleepByInvocation: { 1: 30, 2: 30 } },
            async (env) => {
              const handle = runCLIWithSignal(
                ["install", `${gitServer!.url}/multi.git`],
                {
                  cwd: project!.dir,
                  runtime,
                  env: {
                    ...env,
                    NODE_ENV: "test",
                    LOOPX_TEST_AUTOINSTALL_FAULT: fault,
                    LOOPX_TEST_AUTOINSTALL_PAUSE: "child-active-after-failure",
                    LOOPX_TEST_AUTOINSTALL_PAUSE_MARKER: markerPath,
                  },
                  timeout: 15_000,
                },
              );
              const marker = await waitForAutoInstallPauseMarker(markerPath);
              expect(marker.window).toBe("child-active-after-failure");
              expect(marker.current).not.toBeNull();
              expect(marker.processed).toHaveLength(1);
              expect(marker.activeChildPid).toEqual(expect.any(Number));
              expectWorkflowNamesCoverMarker(marker, names);
              handle.sendSignal(signal);

              const result = await handle.result;
              expect(result.exitCode).toBe(expectedExit);
              expect(isProcessAlive(marker.activeChildPid!)).toBe(false);
              expectCommittedWorkflows(project!.loopxDir, names);
              expectNoAutoInstallFailureReport(result.stderr);
            },
          );
        },
      );

      it("T-INST-117: auto-install failures do not remove committed workflow files", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
              "gamma/index.sh": BASH_STOP,
              "gamma/package.json": JSON.stringify({
                name: "gamma",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm(
          { exitCode: 0, exitCodeByWorkflow: { beta: 1 } },
          async (env) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              { cwd: project!.dir, runtime, env },
            );

            expect(result.exitCode).toBe(1);
            for (const name of ["alpha", "beta", "gamma"]) {
              expect(existsSync(join(project!.loopxDir, name, "index.sh"))).toBe(
                true,
              );
              expect(
                existsSync(join(project!.loopxDir, name, "package.json")),
              ).toBe(true);
              expect(readFileSync(join(project!.loopxDir, name, ".gitignore"), "utf-8")).toMatch(
                /^node_modules\s*$/,
              );
            }
          },
        );
      });

      it("T-INST-117a: partial node_modules from failed npm install is not cleaned up", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({ name: "ralph", version: "1.0.0" }),
            },
          },
        ]);

        await withFakeNpm(
          { exitCode: 1, createFiles: ["node_modules/partial-file"] },
          async (env) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/ralph.git`],
              { cwd: project!.dir, runtime, env },
            );

            expect(result.exitCode).toBe(1);
            expect(
              existsSync(
                join(project!.loopxDir, "ralph", "node_modules", "partial-file"),
              ),
            ).toBe(true);
          },
        );
      });

      it("T-INST-117b: install -y after auto-install failure reinstalls from scratch and reruns npm", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({ name: "ralph", version: "1.0.0" }),
            },
          },
        ]);

        await withFakeNpm(
          { exitCode: 1, createFiles: ["node_modules/partial-file"] },
          async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/ralph.git`],
              { cwd: project!.dir, runtime, env },
            );
            expect(result.exitCode).toBe(1);
            expect(readNpmInvocations(logFile)).toHaveLength(1);
            expect(
              existsSync(
                join(project!.loopxDir, "ralph", "node_modules", "partial-file"),
              ),
            ).toBe(true);
          },
        );

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", "-y", `${gitServer!.url}/ralph.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          expect(
            existsSync(
              join(project!.loopxDir, "ralph", "node_modules", "partial-file"),
            ),
          ).toBe(false);
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "ralph"),
          ]);
          expect(readFileSync(join(project!.loopxDir, "ralph", ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
        });
      });

      it.each([
        [
          "T-INST-118",
          "pnpm-signals",
          {
            "package.json": JSON.stringify({
              packageManager: "pnpm@8.6.0",
              dependencies: {},
            }),
            "pnpm-lock.yaml": "lock",
          },
        ],
        [
          "T-INST-118a",
          "bun-lock",
          {
            "package.json": JSON.stringify({ name: "bun-lock", version: "1.0.0" }),
            "bun.lockb": "",
          },
        ],
        [
          "T-INST-118b",
          "yarn-lock",
          {
            "package.json": JSON.stringify({ name: "yarn-lock", version: "1.0.0" }),
            "yarn.lock": "",
          },
        ],
        [
          "T-INST-118c",
          "all-manager-signals",
          {
            "package.json": JSON.stringify({ packageManager: "yarn@3.6.1" }),
            "bun.lockb": "",
            "pnpm-lock.yaml": "lock",
            "yarn.lock": "",
          },
        ],
      ] as const)("%s: package-manager signals still run npm install", async (_id, name, extraFiles) => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name,
            files: {
              "index.sh": BASH_STOP,
              ...extraFiles,
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/${name}.git`],
            {
              cwd: project!.dir,
              runtime,
              env: {
                ...env,
                PATH: env.PATH.split(":")
                  .filter((segment) => !/pnpm|yarn|bun/.test(segment))
                  .join(":"),
              },
            },
          );

          expect(result.exitCode).toBe(0);
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, name),
          ]);
          expect(readNpmInvocations(logFile)[0].argv).toEqual(["install"]);
        });
      });

      it("T-INST-119: npm stdout/stderr stream through unchanged and no progress indicator is added", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "stream-markers",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "stream-markers",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm(
          {
            exitCode: 0,
            stdout: "npm-stdout-MARKER\n",
            stderr: "npm-stderr-MARKER\n",
          },
          async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/stream-markers.git`],
              { cwd: project!.dir, runtime, env },
            );

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toMatch(/(^|\n)npm-stdout-MARKER\n/);
            expect(result.stderr).toMatch(/(^|\n)npm-stderr-MARKER\n/);
            expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
              /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\[[#=\-\s]{4,}\]|\b\d{1,3}%\b/,
            );
            expect(readNpmInvocations(logFile)).toHaveLength(1);
          },
        );
      });

      it.each([
        ["T-INST-119a", "stdout", "npm-streaming-MARKER\n", 0],
        ["T-INST-119a-stderr", "stderr", "npm-streaming-stderr-MARKER\n", 0],
        ["T-INST-119c", "stdout", "npm-failure-stdout-MARKER\n", 1],
        ["T-INST-119c", "stderr", "npm-failure-stderr-MARKER\n", 1],
      ] as const)(
        "%s: npm %s streams in real time before child exit",
        async (_id, stream, marker, exitCode) => {
          project = await createTempProject();
          const pidFile = join(project.dir, `${stream}-npm.pid`);
          gitServer = await startLocalGitServer([
            {
              name: "streaming",
              files: {
                "index.sh": BASH_STOP,
                "package.json": JSON.stringify({
                  name: "streaming",
                  version: "1.0.0",
                }),
              },
            },
          ]);

          await withFakeNpm(
            {
              exitCode,
              sleepSeconds: 5,
              pidFile,
              stdout: stream === "stdout" ? marker : undefined,
              stderr: stream === "stderr" ? marker : undefined,
            },
            async (env) => {
              const handle = runCLIWithSignal(
                ["install", `${gitServer!.url}/streaming.git`],
                { cwd: project!.dir, runtime, env, timeout: 10_000 },
              );
              const pattern = new RegExp(
                `(^|\\n)${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
              );
              if (stream === "stdout") {
                await handle.waitForStdout(pattern, { timeoutMs: 2_000 });
              } else {
                await handle.waitForStderr(pattern, { timeoutMs: 2_000 });
              }
              const npmPid = Number(readFileSync(pidFile, "utf-8"));
              expect(isProcessAlive(npmPid)).toBe(true);
              const result = await handle.result;
              expect(result.exitCode).toBe(exitCode);
            },
          );
        },
      );

      it("T-INST-119b: npm failure stdout/stderr marker bytes appear in final output", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "failure-output",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "failure-output",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm(
          {
            exitCode: 1,
            stdout: "npm-failure-stdout-MARKER\n",
            stderr: "npm-failure-stderr-MARKER\n",
          },
          async (env, logFile) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/failure-output.git`],
              { cwd: project!.dir, runtime, env },
            );

            expect(result.exitCode).toBe(1);
            expect(result.stdout).toMatch(/(^|\n)npm-failure-stdout-MARKER\n/);
            expect(result.stderr).toMatch(/(^|\n)npm-failure-stderr-MARKER\n/);
            expect(readNpmInvocations(logFile)).toHaveLength(1);
          },
        );
      });

      it("T-INST-119d: npm byte-shape passthrough preserves intra-line marker payload", async () => {
        project = await createTempProject();
        const payload = "prefix\tmiddle  spaced unicode-check ascii-tail";
        gitServer = await startLocalGitServer([
          {
            name: "byte-shape",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "byte-shape",
                version: "1.0.0",
              }),
            },
          },
        ]);

        await withFakeNpm(
          {
            exitCode: 0,
            stdout: `${payload}\n`,
            stderr: `${payload}\n`,
          },
          async (env) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/byte-shape.git`],
              { cwd: project!.dir, runtime, env },
            );

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain(`${payload}\n`);
            expect(result.stderr).toContain(`${payload}\n`);
            expect(result.stdout).not.toContain(payload.replace(/\t/g, " "));
          },
        );
      });

      it.each([
        ["T-INST-120", true, false, false],
        ["T-INST-120a", true, true, false],
        ["T-INST-120c", false, false, false],
        ["T-INST-120d", true, false, true],
      ] as const)(
        "%s: -y replacement runs fresh against replacement package/gitignore state",
        async (_id, replacementHasPackage, replacementHasGitignore, noInstall) => {
          project = await createTempProject();
          await createBashWorkflowScript(project, "ralph", "index", "exit 0");
          await createWorkflowPackageJson(project, "ralph", {
            name: "old-ralph",
            version: "1.0.0",
          });
          await mkdir(join(project.loopxDir, "ralph", "node_modules"), {
            recursive: true,
          });
          await writeFile(
            join(project.loopxDir, "ralph", "node_modules", "old-marker"),
            "old",
            "utf-8",
          );
          await writeFile(
            join(project.loopxDir, "ralph", ".gitignore"),
            "node_modules\n",
            "utf-8",
          );

          const files: Record<string, string> = {
            "index.sh": BASH_STOP,
          };
          if (replacementHasPackage) {
            files["package.json"] = JSON.stringify({
              name: "ralph",
              version: "1.0.0",
            });
          }
          if (replacementHasGitignore) {
            files[".gitignore"] = "dist/\n# custom\n";
          }
          gitServer = await startLocalGitServer([{ name: "ralph", files }]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const args = ["install", "-y"];
            if (noInstall) args.push("--no-install");
            args.push(`${gitServer!.url}/ralph.git`);
            const result = await runCLI(args, {
              cwd: project!.dir,
              runtime,
              env,
            });

            expect(result.exitCode).toBe(0);
            expect(
              existsSync(
                join(project!.loopxDir, "ralph", "node_modules", "old-marker"),
              ),
            ).toBe(false);
            expect(existsSync(join(project!.loopxDir, "ralph", "index.sh"))).toBe(
              true,
            );
            expect(readNpmInvocations(logFile)).toHaveLength(
              replacementHasPackage && !noInstall ? 1 : 0,
            );
            if (replacementHasPackage) {
              expect(
                existsSync(join(project!.loopxDir, "ralph", "package.json")),
              ).toBe(true);
            } else {
              expect(
                existsSync(join(project!.loopxDir, "ralph", "package.json")),
              ).toBe(false);
            }
            const gitignorePath = join(project!.loopxDir, "ralph", ".gitignore");
            if (replacementHasGitignore) {
              expect(readFileSync(gitignorePath, "utf-8")).toBe(
                "dist/\n# custom\n",
              );
            } else if (replacementHasPackage && !noInstall) {
              expect(readFileSync(gitignorePath, "utf-8")).toMatch(
                /^node_modules\s*$/,
              );
            } else {
              expect(existsSync(gitignorePath)).toBe(false);
            }
          });
        },
      );

      it("T-INST-120b: -y override of version mismatch still runs auto-install", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "ralph",
                version: "1.0.0",
                dependencies: { loopx: unsatisfiedRange() },
              }),
            },
          },
        ]);

        await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
          const result = await runCLI(
            ["install", "-y", `${gitServer!.url}/ralph.git`],
            { cwd: project!.dir, runtime, env },
          );

          expect(result.exitCode).toBe(0);
          expect(readFileSync(join(project!.loopxDir, "ralph", "package.json"), "utf-8")).toContain(
            unsatisfiedRange(),
          );
          expect(readNpmInvocations(logFile).map((i) => i.cwd)).toEqual([
            join(project!.loopxDir, "ralph"),
          ]);
          expect(readFileSync(join(project!.loopxDir, "ralph", ".gitignore"), "utf-8")).toMatch(
            /^node_modules\s*$/,
          );
        });
      });

      it.each([
        ["invalid-json", { "package.json": "{broken" }, "invalid-json", undefined],
        [
          "invalid-semver",
          {
            "package.json": JSON.stringify({
              dependencies: { loopx: "not-a-range!!!" },
            }),
          },
          "invalid-semver",
          undefined,
        ],
        [
          "non-string-range",
          {
            "package.json": JSON.stringify({
              dependencies: { loopx: 42 },
            }),
          },
          "invalid-semver",
          undefined,
        ],
        [
          "non-regular-directory",
          { "package.json/README": "not regular" },
          "package-json",
          undefined,
        ],
        [
          "unreadable",
          {
            "package.json": JSON.stringify({
              name: "ralph",
              version: "1.0.0",
            }),
          },
          "unreadable",
          "package-json-make-unreadable:ralph",
        ],
      ] as const)(
        "T-INST-120e: -y replacement with malformed package skips fresh auto-install (%s)",
        async (variant, replacementFiles, warningKind, fault) => {
          if (variant === "unreadable" && IS_ROOT) {
            expect(IS_ROOT).toBe(true);
            return;
          }
          project = await createTempProject();
          await createBashWorkflowScript(project, "ralph", "index", "exit 0");
          await createWorkflowPackageJson(project, "ralph", {
            name: "old-ralph",
            version: "1.0.0",
          });
          await mkdir(join(project.loopxDir, "ralph", "node_modules"), {
            recursive: true,
          });
          await writeFile(
            join(project.loopxDir, "ralph", "node_modules", "old-marker"),
            "old",
            "utf-8",
          );
          await writeFile(
            join(project.loopxDir, "ralph", ".gitignore"),
            "node_modules\n",
            "utf-8",
          );
          gitServer = await startLocalGitServer([
            {
              name: "ralph",
              files: {
                "index.sh": BASH_STOP,
                ...replacementFiles,
              },
            },
          ]);

          await withFakeNpm({ exitCode: 0 }, async (env, logFile) => {
            const result = await runCLI(
              ["install", "-y", `${gitServer!.url}/ralph.git`],
              {
                cwd: project!.dir,
                runtime,
                env: fault
                  ? {
                      ...env,
                      NODE_ENV: "test",
                      LOOPX_TEST_AUTOINSTALL_FAULT: fault,
                    }
                  : env,
              },
            );

            expect(result.exitCode).toBe(0);
            expect(
              existsSync(
                join(project!.loopxDir, "ralph", "node_modules", "old-marker"),
              ),
            ).toBe(false);
            expect(readNpmInvocations(logFile)).toHaveLength(0);
            if (warningKind === "invalid-json") {
              expect(countInvalidJsonWarnings(result.stderr, "ralph")).toBe(1);
            } else if (warningKind === "invalid-semver") {
              expect(countInvalidSemverWarnings(result.stderr, "ralph")).toBe(1);
            } else if (warningKind === "unreadable") {
              expect(countUnreadableWarnings(result.stderr, "ralph")).toBe(1);
              await chmod(join(project!.loopxDir, "ralph", "package.json"), 0o644);
            } else {
              expect(result.stderr).toMatch(/ralph/i);
              expect(result.stderr).toMatch(/package\.json/i);
            }
            expect(existsSync(join(project!.loopxDir, "ralph", ".gitignore"))).toBe(
              false,
            );
            expectNoAutoInstallFailureReport(result.stderr);
          });
        },
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Global Install Smoke Test (T-INST-GLOBAL-01, 01a)
  // ═══════════════════════════════════════════════════════════

  describe("Global Install", () => {
    it("T-INST-GLOBAL-01: full global install lifecycle with import 'loopx' (Node)", async () => {
      const projectRoot = resolve(process.cwd());
      const tmpBase = await mkdtemp(
        join(tmpdir(), "loopx-global-"),
      );
      const globalPrefix = join(tmpBase, "global");
      const fixtureDir = join(tmpBase, "fixture-project");
      const loopxDir = join(fixtureDir, ".loopx");
      const ralphDir = join(loopxDir, "ralph");

      await mkdir(globalPrefix, { recursive: true });
      await mkdir(ralphDir, { recursive: true });

      try {
        const loopxPkgDir = resolve(projectRoot, "node_modules", "loopx");
        if (!existsSync(loopxPkgDir)) {
          throw new Error(
            `node_modules/loopx missing — run 'npm run build' first`,
          );
        }

        const packOutput = execSync("npm pack --json", {
          cwd: loopxPkgDir,
          stdio: "pipe",
        })
          .toString()
          .trim();
        const packResult = JSON.parse(packOutput);
        const tgzFilename = Array.isArray(packResult)
          ? packResult[0].filename
          : packResult.filename;
        const tgzPath = join(loopxPkgDir, tgzFilename);

        execSync(
          `npm install -g --prefix "${globalPrefix}" "${tgzPath}"`,
          { stdio: "pipe" },
        );

        const loopxPkg = JSON.parse(
          readFileSync(join(loopxPkgDir, "package.json"), "utf-8"),
        );
        const pkgName = loopxPkg.name as string;

        // SPEC §4.10 guard: installed package root must be a real directory,
        // not a symlink back into the dev tree (`npm install -g .` from a
        // local same-filesystem path would create such a symlink).
        const installedPkgRoot = join(
          globalPrefix,
          "lib",
          "node_modules",
          pkgName,
        );
        expect(lstatSync(installedPkgRoot).isSymbolicLink()).toBe(false);

        // Fixture: workflow `ralph` with an index.ts that imports loopx
        const indexTs =
          'import { output } from "loopx";\noutput({ stop: true });\n';
        await writeFile(join(ralphDir, "index.ts"), indexTs, "utf-8");

        const binPath = join(globalPrefix, "bin", "loopx");
        // SPEC §4.10: scrubbed spawn env — must not leak dev-tree binaries
        // (e.g. tsx from ./node_modules/.bin) into the installed loopx, so
        // the test actually catches missing published dependencies.
        const scrubbedEnv: Record<string, string> = {
          HOME: process.env.HOME ?? "",
          PATH: [
            join(globalPrefix, "bin"),
            dirname(process.execPath),
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
          ].join(":"),
        };
        if (process.env.TMPDIR) scrubbedEnv.TMPDIR = process.env.TMPDIR;
        if (process.env.GIT_CONFIG_GLOBAL) {
          scrubbedEnv.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL;
        }

        // Run ralph — no -n, relies on output({stop:true}) to exit
        execSync(`"${binPath}" run ralph`, {
          cwd: fixtureDir,
          stdio: "pipe",
          env: scrubbedEnv,
          timeout: 30_000,
        });
        // execSync throws on non-zero exit — reaching here means exit 0
      } finally {
        await rm(tmpBase, { recursive: true, force: true });
      }
    });

    it.skipIf(!isRuntimeAvailable("bun"))(
      "T-INST-GLOBAL-01a: [Bun] full global install lifecycle with import 'loopx'",
      async () => {
        const projectRoot = resolve(process.cwd());
        const tmpBase = await mkdtemp(
          join(tmpdir(), "loopx-global-bun-"),
        );
        const globalPrefix = join(tmpBase, "global");
        const fixtureDir = join(tmpBase, "fixture-project");
        const loopxDir = join(fixtureDir, ".loopx");
        const ralphDir = join(loopxDir, "ralph");

        await mkdir(globalPrefix, { recursive: true });
        await mkdir(ralphDir, { recursive: true });

        try {
          const loopxPkgDir = resolve(projectRoot, "node_modules", "loopx");
          if (!existsSync(loopxPkgDir)) {
            throw new Error(
              `node_modules/loopx missing — run 'npm run build' first`,
            );
          }

          const packOutput = execSync("npm pack --json", {
            cwd: loopxPkgDir,
            stdio: "pipe",
          })
            .toString()
            .trim();
          const packResult = JSON.parse(packOutput);
          const tgzFilename = Array.isArray(packResult)
            ? packResult[0].filename
            : packResult.filename;
          const tgzPath = join(loopxPkgDir, tgzFilename);

          execSync(
            `npm install -g --prefix "${globalPrefix}" "${tgzPath}"`,
            { stdio: "pipe" },
          );

          const loopxPkg = JSON.parse(
            readFileSync(join(loopxPkgDir, "package.json"), "utf-8"),
          );
          const pkgName = loopxPkg.name as string;

          // SPEC §4.10 guard: installed package root must be a real directory,
          // not a symlink back into the dev tree.
          const installedPkgRoot = join(
            globalPrefix,
            "lib",
            "node_modules",
            pkgName,
          );
          expect(lstatSync(installedPkgRoot).isSymbolicLink()).toBe(false);

          const indexTs =
            'import { output } from "loopx";\noutput({ stop: true });\n';
          await writeFile(join(ralphDir, "index.ts"), indexTs, "utf-8");

          const binJsPath = join(installedPkgRoot, "bin.js");

          // Resolve the Bun interpreter's directory so we can scrub PATH
          // without losing the ability to spawn `bun` from the installed
          // loopx (execution.ts runs JS/TS workflow scripts via `bun`).
          const bunDir = dirname(
            execSync("command -v bun", { stdio: "pipe" })
              .toString()
              .trim(),
          );

          // SPEC §4.10: scrubbed spawn env — must not leak dev-tree binaries
          // (e.g. tsx, bun devDependencies) into the installed loopx.
          const scrubbedEnv: Record<string, string> = {
            HOME: process.env.HOME ?? "",
            PATH: [
              join(globalPrefix, "bin"),
              bunDir,
              "/usr/local/bin",
              "/usr/bin",
              "/bin",
            ].join(":"),
          };
          if (process.env.TMPDIR) scrubbedEnv.TMPDIR = process.env.TMPDIR;
          if (process.env.GIT_CONFIG_GLOBAL) {
            scrubbedEnv.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL;
          }

          execSync(`bun "${binJsPath}" run ralph`, {
            cwd: fixtureDir,
            stdio: "pipe",
            env: scrubbedEnv,
            timeout: 30_000,
          });
        } finally {
          await rm(tmpBase, { recursive: true, force: true });
        }
      },
    );
  });
});
