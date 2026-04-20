import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  writeFile,
  mkdir,
  chmod,
  rm,
  realpath,
  symlink,
  readdir,
  mkdtemp,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execSync } from "node:child_process";
import { withDelegationSetup, type DelegationFixture } from "../helpers/delegation.js";
import {
  createTempProject,
  createBashWorkflowScript,
  createWorkflowPackageJson,
  type TempProject,
} from "../helpers/fixtures.js";
import type { CLIResult } from "../helpers/cli.js";
import { signalReadyThenSleep } from "../helpers/fixture-scripts.js";
import {
  startLocalGitServer,
  type GitServer,
} from "../helpers/servers.js";

// ───────────────────────────────────────────────────────────────
// Root guard — permission-based tests are meaningless under root.
// ───────────────────────────────────────────────────────────────

const IS_ROOT = process.getuid?.() === 0;

// ───────────────────────────────────────────────────────────────
// Warning-shape predicates — tolerant of specific wording while
// pinning down failure-mode semantics. Delegation warnings are about
// the project-root `package.json`, so predicates match against lines
// containing "package.json" or other failure-mode keywords.
// ───────────────────────────────────────────────────────────────

function hasDelegationWarning(stderr: string): boolean {
  return /(package\.json|delegat|loopx)/i.test(stderr) &&
    /(unreadable|invalid.*json|parse|permission|EACCES|EPERM|denied|missing|warn)/i.test(stderr);
}

function hasUnreadableDelegationWarning(stderr: string): boolean {
  return /(unreadable|permission|EACCES|EPERM|cannot.*read|read.*fail|denied)/i.test(stderr);
}

function hasInvalidJsonDelegationWarning(stderr: string): boolean {
  return /(invalid.*json|parse|parsing|package\.json)/i.test(stderr);
}

function hasMissingBinaryWarning(stderr: string): boolean {
  return /(missing|not.*found|node_modules|\.bin|install|dependenc)/i.test(stderr) &&
    /warn/i.test(stderr);
}

// ───────────────────────────────────────────────────────────────
// Helpers local to delegation tests
// ───────────────────────────────────────────────────────────────

/**
 * Resolve the path to the real loopx bin.js entry point.
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
    // loopx not installed
  }
  return resolve(process.cwd(), "node_modules/loopx/bin.js");
}

/**
 * Spawn a binary directly and capture its output.
 */
function spawnBinary(
  binPath: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeout?: number } = {},
): Promise<CLIResult> {
  const { cwd = process.cwd(), env: extraEnv = {}, timeout = 30_000 } = options;

  const mergedEnv = {
    ...process.env,
    ...extraEnv,
  };

  return new Promise<CLIResult>((resolvePromise, reject) => {
    const child = spawn(binPath, args, {
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

    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Binary timed out after ${timeout}ms`));
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
}

/**
 * Spawn a binary with signal-delivery handles. Used by T-DEL-10 and T-DEL-11.
 */
function spawnGlobalWithSignal(
  binPath: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): {
  result: Promise<CLIResult>;
  sendSignal: (sig: NodeJS.Signals) => void;
  waitForStderr: (pattern: string) => Promise<void>;
} {
  const mergedEnv = { ...process.env, ...(options.env ?? {}) };

  const child = spawn(binPath, args, {
    cwd: options.cwd,
    env: mergedEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true, // Own process group so signals reach all descendants
  });
  child.stdin.end();

  let stderr = "";
  type Listener = { pattern: string; resolve: () => void; reject: (e: Error) => void };
  const listeners: Listener[] = [];

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    for (const l of [...listeners]) {
      if (stderr.includes(l.pattern)) {
        listeners.splice(listeners.indexOf(l), 1);
        l.resolve();
      }
    }
  });

  const result = new Promise<CLIResult>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("spawnGlobalWithSignal: timed out after 30s"));
    }, 30_000);

    child.on("close", (code, sig) => {
      clearTimeout(timer);
      for (const l of listeners) {
        l.reject(new Error("Process exited before stderr pattern matched"));
      }
      let exitCode = code ?? 1;
      if (code === null && sig) {
        const sigNums: Record<string, number> = {
          SIGINT: 2,
          SIGTERM: 15,
          SIGKILL: 9,
        };
        exitCode = 128 + (sigNums[sig] ?? 15);
      }
      resolvePromise({
        exitCode,
        stdout: "",
        stderr,
        signal: sig ?? null,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  return {
    result,
    sendSignal: (sig) => process.kill(-child.pid!, sig),
    waitForStderr: (pattern) => {
      if (stderr.includes(pattern)) return Promise.resolve();
      return new Promise<void>((resolvePromise, reject) => {
        listeners.push({ pattern, resolve: resolvePromise, reject });
      });
    },
  };
}

/**
 * Create a shell script at `path` that writes `markerValue` to `markerPath`
 * when executed. Used to prove that the local binary was invoked.
 */
async function createMarkerBinary(
  path: string,
  markerPath: string,
  markerValue: string,
): Promise<void> {
  const content = `#!/bin/bash
printf '%s' '${markerValue}' > "${markerPath}"
`;
  await writeFile(path, content, "utf-8");
  await chmod(path, 0o755);
}

/**
 * Create a shell script at `path` that writes the value of `$<varname>` to
 * `markerPath` when executed. Used to prove environment propagation.
 */
async function createEnvObserverBinary(
  path: string,
  varname: string,
  markerPath: string,
): Promise<void> {
  const content = `#!/bin/bash
printf '%s' "\$${varname}" > "${markerPath}"
`;
  await writeFile(path, content, "utf-8");
  await chmod(path, 0o755);
}

/**
 * Create a "global" loopx wrapper script at `path`. The wrapper uses
 * `exec node <realBinJs>` so it exercises the real delegation logic.
 */
async function createGlobalWrapper(path: string): Promise<void> {
  const loopxBinJs = resolveLoopxBinJs();
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(
    path,
    `#!/bin/bash
exec node "${loopxBinJs}" "$@"
`,
    "utf-8",
  );
  await chmod(path, 0o755);
}

/**
 * Create a project-root package.json declaring `loopx` in `dependencies`.
 * Defaults to `"*"` — tests that need a specific range pass it explicitly.
 */
async function writeProjectPackageJson(
  projectDir: string,
  content: Record<string, unknown> | string,
): Promise<string> {
  const pkgPath = join(projectDir, "package.json");
  const body =
    typeof content === "string" ? content : JSON.stringify(content, null, 2);
  await writeFile(pkgPath, body, "utf-8");
  return pkgPath;
}

/**
 * Install a functional local loopx package under `projectDir/node_modules/loopx`
 * with the given version. All files other than `package.json` are symlinked
 * from the real `node_modules/loopx/` so the local binary is a working CLI.
 * Also creates `.bin/loopx` as a bash wrapper that execs this local `bin.js`.
 *
 * Used by T-DEL-24 / T-DEL-25 where the local binary must behave as a real
 * loopx CLI AND report a specific version for workflow-level version checks.
 */
async function installFunctionalLocalLoopx(
  projectDir: string,
  version: string,
): Promise<{ loopxDir: string; binPath: string }> {
  const sourceDir = resolve(process.cwd(), "node_modules/loopx");
  const loopxDir = join(projectDir, "node_modules", "loopx");
  await mkdir(loopxDir, { recursive: true });

  const entries = await readdir(sourceDir);
  for (const entry of entries) {
    if (entry === "package.json") continue;
    await symlink(join(sourceDir, entry), join(loopxDir, entry));
  }

  const sourcePkg = JSON.parse(
    readFileSync(join(sourceDir, "package.json"), "utf-8"),
  );
  const customPkg = { ...sourcePkg, version };
  await writeFile(
    join(loopxDir, "package.json"),
    JSON.stringify(customPkg, null, 2),
    "utf-8",
  );

  // Resolve bin path from the (custom) package.json so this helper survives
  // layout changes (e.g. bin moving from package root → ./dist/bin.js after
  // the monorepo restructure).
  const binField =
    typeof customPkg.bin === "string" ? customPkg.bin : customPkg.bin?.loopx;
  const resolvedBinJs = resolve(loopxDir, binField ?? "bin.js");

  const binDir = join(projectDir, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, "loopx");
  await writeFile(
    binPath,
    `#!/bin/bash
exec node "${resolvedBinJs}" "$@"
`,
    "utf-8",
  );
  await chmod(binPath, 0o755);

  return { loopxDir, binPath };
}

/** Restore read/write permissions recursively so cleanup does not leave stale files. */
function restorePerms(dir: string): void {
  try {
    execSync(`chmod -R u+rw "${dir}"`, { stdio: "ignore" });
  } catch {
    // best-effort
  }
}

// ═══════════════════════════════════════════════════════════════
// Tests — SPEC §4.12 / ADR-0003 §5 (CLI Delegation)
// ═══════════════════════════════════════════════════════════════

describe("SPEC: CLI Delegation (T-DEL-* — §4.12)", () => {
  let fixture: DelegationFixture | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (fixture) {
      restorePerms(fixture.projectDir);
      await fixture.cleanup();
      fixture = null;
    }
    for (const dir of tempDirs) {
      restorePerms(dir);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tempDirs.length = 0;
  });

  // ─────────────────────────────────────────────
  // Positive delegation
  // ─────────────────────────────────────────────

  it("T-DEL-01: global delegates to local node_modules/.bin/loopx when project-root package.json declares loopx", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test-project",
      dependencies: { loopx: "*" },
    });
    const markerPath = join(fixture.projectDir, "del-01-marker.txt");
    await createMarkerBinary(
      fixture.localBinPath,
      markerPath,
      "local-binary-invoked",
    );

    await fixture.runGlobal([]);

    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("local-binary-invoked");
  });

  // ─────────────────────────────────────────────
  // T-DEL-02: No ancestor traversal
  // ─────────────────────────────────────────────

  it("T-DEL-02: delegation checks CWD only, not ancestor directories", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "loopx-del02-"));
    tempDirs.push(baseDir);

    const parentDir = join(baseDir, "parent");
    const childDir = join(parentDir, "child");
    await mkdir(childDir, { recursive: true });
    await mkdir(join(childDir, ".loopx"), { recursive: true });

    // Parent: package.json declaring loopx + local bin (so ancestor traversal
    // WOULD pick it up if the implementation did that).
    await writeProjectPackageJson(parentDir, {
      name: "parent",
      dependencies: { loopx: "*" },
    });
    const parentBinDir = join(parentDir, "node_modules", ".bin");
    await mkdir(parentBinDir, { recursive: true });
    const parentLocalBin = join(parentBinDir, "loopx");
    const markerPath = join(baseDir, "del-02-marker.txt");
    await createMarkerBinary(parentLocalBin, markerPath, "parent-local-invoked");

    // Child: NO package.json, NO local bin.
    const globalBinPath = join(baseDir, "global", "bin", "loopx");
    await createGlobalWrapper(globalBinPath);

    const result = await spawnBinary(globalBinPath, ["version"], {
      cwd: childDir,
    });

    expect(result.exitCode).toBe(0);
    // Parent's binary must NOT have been invoked (no ancestor traversal).
    expect(existsSync(markerPath)).toBe(false);
    // Running from child prints global's version.
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  // ─────────────────────────────────────────────
  // T-DEL-03: Delegation works before .loopx/ exists
  // ─────────────────────────────────────────────

  it("T-DEL-03: delegation works before .loopx/ exists (CWD-based, not .loopx-based)", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "loopx-del03-"));
    tempDirs.push(baseDir);

    const projectDir = join(baseDir, "project");
    await mkdir(projectDir, { recursive: true });
    // NOTE: NO .loopx/ directory is created.

    await writeProjectPackageJson(projectDir, {
      name: "proj",
      dependencies: { loopx: "*" },
    });

    const localBinDir = join(projectDir, "node_modules", ".bin");
    await mkdir(localBinDir, { recursive: true });
    const localBinPath = join(localBinDir, "loopx");
    const markerPath = join(baseDir, "del-03-marker.txt");
    await createMarkerBinary(localBinPath, markerPath, "local-ran");

    const globalBinPath = join(baseDir, "global", "bin", "loopx");
    await createGlobalWrapper(globalBinPath);

    await spawnBinary(globalBinPath, ["version"], { cwd: projectDir });

    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("local-ran");
    expect(existsSync(join(projectDir, ".loopx"))).toBe(false);
  });

  // ─────────────────────────────────────────────
  // T-DEL-04 / T-DEL-09: LOOPX_DELEGATED recursion guard
  // ─────────────────────────────────────────────

  it("T-DEL-04: LOOPX_DELEGATED=1 prevents delegation", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });
    const markerPath = join(fixture.projectDir, "del-04-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    const result = await fixture.runGlobal(["version"], {
      env: { LOOPX_DELEGATED: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("T-DEL-09: LOOPX_DELEGATED=\"\" (empty string) prevents delegation", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });
    const markerPath = join(fixture.projectDir, "del-09-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    const result = await fixture.runGlobal(["version"], {
      env: { LOOPX_DELEGATED: "" },
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
  });

  // ─────────────────────────────────────────────
  // T-DEL-05 / T-DEL-07: Delegated environment
  // ─────────────────────────────────────────────

  it("T-DEL-05: after delegation, LOOPX_BIN is the resolved realpath of the local binary", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });
    const markerPath = join(fixture.projectDir, "del-05-marker.txt");
    await createEnvObserverBinary(fixture.localBinPath, "LOOPX_BIN", markerPath);

    await fixture.runGlobal([]);

    expect(existsSync(markerPath)).toBe(true);
    const recordedBin = readFileSync(markerPath, "utf-8");
    const expectedRealpath = await realpath(fixture.localBinPath);
    expect(recordedBin).toBe(expectedRealpath);
  });

  it("T-DEL-07: LOOPX_DELEGATED=1 is set in the delegated process", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });
    const markerPath = join(fixture.projectDir, "del-07-marker.txt");
    await writeFile(
      fixture.localBinPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const val = process.env["LOOPX_DELEGATED"];
const data = val === undefined
  ? { present: false }
  : { present: true, value: val };
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(data));
`,
      "utf-8",
    );
    await chmod(fixture.localBinPath, 0o755);

    await fixture.runGlobal([]);

    expect(existsSync(markerPath)).toBe(true);
    const content = JSON.parse(readFileSync(markerPath, "utf-8"));
    expect(content).toEqual({ present: true, value: "1" });
  });

  // ─────────────────────────────────────────────
  // T-DEL-06: import from "loopx" resolves to local (delegated-to) version
  // ─────────────────────────────────────────────

  it("T-DEL-06: after delegation, import from 'loopx' resolves to the local package", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "loopx-del06-"));
    tempDirs.push(baseDir);

    const projectDir = join(baseDir, "project");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, ".loopx"), { recursive: true });

    await writeProjectPackageJson(projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });

    const markerPath = join(baseDir, "del-06-marker.txt");

    const localLoopxDir = join(projectDir, "node_modules", "loopx");
    await mkdir(localLoopxDir, { recursive: true });
    await writeFile(
      join(localLoopxDir, "package.json"),
      JSON.stringify({
        name: "loopx",
        version: "99.0.0-local-test",
        type: "module",
        main: "index.js",
        exports: { ".": "./index.js" },
      }),
      "utf-8",
    );
    await writeFile(
      join(localLoopxDir, "index.js"),
      `export const __loopxSentinel = "99.0.0-local-test";
export function output(data) { process.stdout.write(JSON.stringify(data)); }
export function input() { return Promise.resolve(""); }
`,
      "utf-8",
    );

    const localBinDir = join(projectDir, "node_modules", ".bin");
    await mkdir(localBinDir, { recursive: true });
    const localBinPath = join(localBinDir, "loopx");
    await writeFile(
      localBinPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const loopxPkg = await import("loopx");
const sentinel = loopxPkg.__loopxSentinel ?? "unknown";
writeFileSync(${JSON.stringify(markerPath)}, sentinel);
`,
      "utf-8",
    );
    await chmod(localBinPath, 0o755);

    const globalBinPath = join(baseDir, "global", "bin", "loopx");
    await createGlobalWrapper(globalBinPath);

    await spawnBinary(globalBinPath, [], { cwd: projectDir });

    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("99.0.0-local-test");
  });

  // ─────────────────────────────────────────────
  // T-DEL-08: Delegation happens before command handling
  // ─────────────────────────────────────────────

  it("T-DEL-08: delegation happens before command handling (version handled by local)", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });
    const markerPath = join(fixture.projectDir, "del-08-marker.txt");
    await writeFile(
      fixture.localBinPath,
      `#!/bin/bash
printf '%s' 'delegated' > "${markerPath}"
echo "99.0.0-local"
`,
      "utf-8",
    );
    await chmod(fixture.localBinPath, 0o755);

    const result = await fixture.runGlobal(["version"]);

    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("delegated");
    expect(result.stdout.trim()).toBe("99.0.0-local");
  });

  // ─────────────────────────────────────────────
  // T-DEL-10 / T-DEL-11: Signal exit codes preserved across delegation
  // ─────────────────────────────────────────────

  it("T-DEL-10: delegation preserves SIGINT exit code (130)", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });
    const pidMarker = join(fixture.projectDir, "pid-marker.txt");

    // Replace local binary with a functional loopx wrapper.
    await writeFile(
      fixture.localBinPath,
      `#!/bin/bash\nexec node "${fixture.loopxBinJs}" "$@"\n`,
      "utf-8",
    );
    await chmod(fixture.localBinPath, 0o755);

    // Workflow with a sleeper script.
    const workflowDir = join(fixture.projectDir, ".loopx", "sleeper");
    await mkdir(workflowDir, { recursive: true });
    const scriptPath = join(workflowDir, "index.sh");
    await writeFile(scriptPath, signalReadyThenSleep(pidMarker), "utf-8");
    await chmod(scriptPath, 0o755);

    const { result, sendSignal, waitForStderr } = spawnGlobalWithSignal(
      fixture.globalBinPath,
      ["run", "-n", "1", "sleeper"],
      { cwd: fixture.projectDir },
    );

    await waitForStderr("ready");
    sendSignal("SIGINT");

    const outcome = await result;
    expect(outcome.exitCode).toBe(130);
  });

  it("T-DEL-11: delegation preserves SIGTERM exit code (143)", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });
    const pidMarker = join(fixture.projectDir, "pid-marker.txt");

    await writeFile(
      fixture.localBinPath,
      `#!/bin/bash\nexec node "${fixture.loopxBinJs}" "$@"\n`,
      "utf-8",
    );
    await chmod(fixture.localBinPath, 0o755);

    const workflowDir = join(fixture.projectDir, ".loopx", "sleeper");
    await mkdir(workflowDir, { recursive: true });
    const scriptPath = join(workflowDir, "index.sh");
    await writeFile(scriptPath, signalReadyThenSleep(pidMarker), "utf-8");
    await chmod(scriptPath, 0o755);

    const { result, sendSignal, waitForStderr } = spawnGlobalWithSignal(
      fixture.globalBinPath,
      ["run", "-n", "1", "sleeper"],
      { cwd: fixture.projectDir },
    );

    await waitForStderr("ready");
    sendSignal("SIGTERM");

    const outcome = await result;
    expect(outcome.exitCode).toBe(143);
  });

  // ─────────────────────────────────────────────
  // Project-root package.json failure modes
  // ─────────────────────────────────────────────

  it("T-DEL-12: no package.json at project root → no delegation, no warning, exit 0", async () => {
    fixture = await withDelegationSetup();
    // Intentionally do NOT write a package.json.
    const markerPath = join(fixture.projectDir, "del-12-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    const result = await fixture.runGlobal(["version"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    // No delegation warning — absence of package.json is the normal "no local version" case.
    expect(/warn/i.test(result.stderr)).toBe(false);
  });

  it.skipIf(IS_ROOT)(
    "T-DEL-13: unreadable package.json → warning on stderr, delegation skipped",
    async () => {
      fixture = await withDelegationSetup();
      const pkgPath = await writeProjectPackageJson(fixture.projectDir, {
        name: "test",
        dependencies: { loopx: "*" },
      });
      const markerPath = join(fixture.projectDir, "del-13-marker.txt");
      await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");
      await chmod(pkgPath, 0o000);

      const result = await fixture.runGlobal(["version"]);

      expect(result.exitCode).toBe(0);
      // Global ran (no delegation).
      expect(existsSync(markerPath)).toBe(false);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(hasUnreadableDelegationWarning(result.stderr)).toBe(true);
    },
  );

  it("T-DEL-14: invalid JSON in package.json → warning on stderr, delegation skipped", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, "{broken");
    const markerPath = join(fixture.projectDir, "del-14-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    const result = await fixture.runGlobal(["version"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(hasInvalidJsonDelegationWarning(result.stderr)).toBe(true);
  });

  it("T-DEL-14a: invalid JSON + `loopx install -h` → warning, install help, exit 0", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, "{broken");
    const markerPath = join(fixture.projectDir, "del-14a-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    const result = await fixture.runGlobal(["install", "-h"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
    expect(hasInvalidJsonDelegationWarning(result.stderr)).toBe(true);
    // Install help output (matches "install" or "usage" in stdout).
    expect(/install|usage/i.test(result.stdout)).toBe(true);
  });

  it("T-DEL-14b: invalid JSON + bare `loopx` → warning, top-level help, exit 0", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, "{broken");
    const markerPath = join(fixture.projectDir, "del-14b-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    const result = await fixture.runGlobal([]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
    expect(hasInvalidJsonDelegationWarning(result.stderr)).toBe(true);
    // Top-level help output.
    expect(/usage|subcommand|loopx/i.test(result.stdout)).toBe(true);
  });

  it("T-DEL-15: loopx declared but node_modules/.bin/loopx does not exist → warning, delegation skipped", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });
    // Remove the local bin to simulate "declared but not installed".
    await rm(fixture.localBinPath, { force: true });

    const result = await fixture.runGlobal(["version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(hasMissingBinaryWarning(result.stderr)).toBe(true);
  });

  it("T-DEL-16: node_modules/.bin/loopx exists but loopx not declared in any dependency field → no delegation, no warning", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      // NOTE: No loopx declaration.
      dependencies: { "some-other": "1.0.0" },
    });
    const markerPath = join(fixture.projectDir, "del-16-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    const result = await fixture.runGlobal(["version"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    // No warning — "declared but no binary" and "not declared" are distinct paths.
    expect(/warn/i.test(result.stderr)).toBe(false);
  });

  // ─────────────────────────────────────────────
  // Dependency-field coverage for delegation
  // ─────────────────────────────────────────────

  it("T-DEL-17: loopx declared only in optionalDependencies → delegation occurs", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      optionalDependencies: { loopx: "*" },
    });
    const markerPath = join(fixture.projectDir, "del-17-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    await fixture.runGlobal([]);

    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("local-ran");
  });

  it("T-DEL-18: loopx declared only in devDependencies → delegation occurs", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      devDependencies: { loopx: "*" },
    });
    const markerPath = join(fixture.projectDir, "del-18-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    await fixture.runGlobal([]);

    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("local-ran");
  });

  // ─────────────────────────────────────────────
  // T-DEL-19: Presence-based, not range-based
  // ─────────────────────────────────────────────

  it("T-DEL-19: delegation is presence-based, not range-based (declared range is not compared to local version)", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      // Range that the local binary's version would NOT satisfy — delegation happens anyway.
      dependencies: { loopx: "^99.0.0" },
    });
    const markerPath = join(fixture.projectDir, "del-19-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    await fixture.runGlobal([]);

    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("local-ran");
  });

  // ─────────────────────────────────────────────
  // T-DEL-20: Workflow-level package.json does not trigger delegation
  // ─────────────────────────────────────────────

  it("T-DEL-20: workflow-level package.json + node_modules/.bin/loopx do not trigger delegation", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "loopx-del20-"));
    tempDirs.push(baseDir);

    const projectDir = join(baseDir, "project");
    const loopxDir = join(projectDir, ".loopx");
    const ralphDir = join(loopxDir, "ralph");
    await mkdir(ralphDir, { recursive: true });

    // Workflow-level package.json and local bin — these are NOT at project root.
    await writeFile(
      join(ralphDir, "package.json"),
      JSON.stringify({ name: "ralph", dependencies: { loopx: "*" } }),
      "utf-8",
    );
    await writeFile(
      join(ralphDir, "index.sh"),
      `#!/bin/bash\nprintf '{"stop":true}'\n`,
      "utf-8",
    );
    await chmod(join(ralphDir, "index.sh"), 0o755);

    const wfBinDir = join(ralphDir, "node_modules", ".bin");
    await mkdir(wfBinDir, { recursive: true });
    const markerPath = join(baseDir, "del-20-marker.txt");
    await createMarkerBinary(
      join(wfBinDir, "loopx"),
      markerPath,
      "workflow-bin-ran",
    );

    // Project root has NO package.json — no delegation should occur.
    const globalBinPath = join(baseDir, "global", "bin", "loopx");
    await createGlobalWrapper(globalBinPath);

    const result = await spawnBinary(globalBinPath, ["run", "-n", "1", "ralph"], {
      cwd: projectDir,
    });

    // Workflow-level bin must NOT have been invoked as delegation target.
    expect(existsSync(markerPath)).toBe(false);
    // Global runs normally.
    expect(result.exitCode).toBe(0);
  });

  // ─────────────────────────────────────────────
  // T-DEL-21 / T-DEL-22 / T-DEL-23 / T-DEL-26: Delegation on other commands
  // ─────────────────────────────────────────────

  it("T-DEL-21: delegation applies to `loopx install -h`", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });
    const markerPath = join(fixture.projectDir, "del-21-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    await fixture.runGlobal(["install", "-h"]);

    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("local-ran");
  });

  it("T-DEL-22: delegation applies to `loopx -h` (top-level help)", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });
    const markerPath = join(fixture.projectDir, "del-22-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    await fixture.runGlobal(["-h"]);

    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("local-ran");
  });

  it("T-DEL-23: delegation applies to bare `loopx` (no arguments)", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });
    const markerPath = join(fixture.projectDir, "del-23-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    await fixture.runGlobal([]);

    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("local-ran");
  });

  it("T-DEL-26: delegation applies to `loopx env list`", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });
    const markerPath = join(fixture.projectDir, "del-26-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    await fixture.runGlobal(["env", "list"]);

    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("local-ran");
  });

  // ─────────────────────────────────────────────
  // T-DEL-24 / T-DEL-25: Delegation × Version Checking
  // ─────────────────────────────────────────────

  it("T-DEL-24: runtime delegation × version checking — workflow range is checked against the delegated local version", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "loopx-del24-"));
    tempDirs.push(baseDir);

    const projectDir = join(baseDir, "project");
    await mkdir(projectDir, { recursive: true });

    await writeProjectPackageJson(projectDir, {
      name: "test",
      dependencies: { loopx: "*" },
    });

    // Local loopx reports version 2.0.0.
    await installFunctionalLocalLoopx(projectDir, "2.0.0");

    // Workflow declares loopx ^2.0.0 — should be satisfied by local 2.0.0.
    const ralphDir = join(projectDir, ".loopx", "ralph");
    await mkdir(ralphDir, { recursive: true });
    await writeFile(
      join(ralphDir, "package.json"),
      JSON.stringify({
        name: "ralph",
        dependencies: { loopx: "^2.0.0" },
      }),
      "utf-8",
    );
    await writeFile(
      join(ralphDir, "index.sh"),
      `#!/bin/bash\nprintf '{"stop":true}'\n`,
      "utf-8",
    );
    await chmod(join(ralphDir, "index.sh"), 0o755);

    const globalBinPath = join(baseDir, "global", "bin", "loopx");
    await createGlobalWrapper(globalBinPath);

    const result = await spawnBinary(globalBinPath, ["run", "-n", "1", "ralph"], {
      cwd: projectDir,
    });

    expect(result.exitCode).toBe(0);
    // No mismatch warning — the workflow's ^2.0.0 range is satisfied by the local binary's 2.0.0.
    expect(/version.*mismatch|does not satisfy|incompatib/i.test(result.stderr)).toBe(false);
  });

  it("T-DEL-25: install-time delegation × version checking — workflow range is checked against the delegated local version", async () => {
    let gitServer: GitServer | null = null;
    const baseDir = await mkdtemp(join(tmpdir(), "loopx-del25-"));
    tempDirs.push(baseDir);

    try {
      const projectDir = join(baseDir, "project");
      await mkdir(projectDir, { recursive: true });

      await writeProjectPackageJson(projectDir, {
        name: "test",
        dependencies: { loopx: "*" },
      });

      await installFunctionalLocalLoopx(projectDir, "2.0.0");

      // Source workflow declares loopx ^2.0.0.
      gitServer = await startLocalGitServer([
        {
          name: "ralph",
          files: {
            "index.sh": `#!/bin/bash\nprintf '{"stop":true}'\n`,
            "package.json": JSON.stringify({
              name: "ralph",
              dependencies: { loopx: "^2.0.0" },
            }),
          },
        },
      ]);

      const globalBinPath = join(baseDir, "global", "bin", "loopx");
      await createGlobalWrapper(globalBinPath);

      const result = await spawnBinary(
        globalBinPath,
        ["install", `${gitServer.url}/ralph.git`],
        { cwd: projectDir },
      );

      expect(result.exitCode).toBe(0);
      // Install succeeded without a version mismatch error.
      expect(/version.*mismatch|does not satisfy/i.test(result.stderr)).toBe(false);
      // Workflow was installed.
      expect(existsSync(join(projectDir, ".loopx", "ralph", "index.sh"))).toBe(
        true,
      );
    } finally {
      if (gitServer) {
        await gitServer.close();
      }
    }
  });

  // ─────────────────────────────────────────────
  // T-DEL-27: peerDependencies not treated as a delegation-checked field
  // ─────────────────────────────────────────────

  it("T-DEL-27: loopx declared only in peerDependencies → no delegation, no warning", async () => {
    fixture = await withDelegationSetup();
    await writeProjectPackageJson(fixture.projectDir, {
      name: "test",
      peerDependencies: { loopx: "*" },
    });
    const markerPath = join(fixture.projectDir, "del-27-marker.txt");
    await createMarkerBinary(fixture.localBinPath, markerPath, "local-ran");

    const result = await fixture.runGlobal(["version"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    // peerDependencies is the "not declared in any checked field" path, not the "declared but missing binary" path.
    expect(/warn/i.test(result.stderr)).toBe(false);
  });
});
