import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdir, chmod, rm, realpath, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { withDelegationSetup, type DelegationFixture } from "../helpers/delegation.js";
import type { CLIResult } from "../helpers/cli.js";

// ---------------------------------------------------------------------------
// Helpers local to delegation tests
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the real loopx bin.js entry point.
 * Falls back to node_modules/loopx/bin.js if the package isn't installed.
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
  options: { cwd?: string; env?: Record<string, string> } = {}
): Promise<CLIResult> {
  const { cwd = process.cwd(), env: extraEnv = {} } = options;

  const mergedEnv = {
    ...process.env,
    ...extraEnv,
  };

  return new Promise<CLIResult>((resolve, reject) => {
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
      reject(new Error("Binary timed out after 15000ms"));
    }, 15_000);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
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
 * Create a shell script that writes a marker value to a file.
 */
async function createMarkerBinary(
  path: string,
  markerPath: string,
  markerValue: string
): Promise<void> {
  const content = `#!/bin/bash
printf '%s' '${markerValue}' > "${markerPath}"
`;
  await writeFile(path, content, "utf-8");
  await chmod(path, 0o755);
}

/**
 * Create a shell script that writes an env var's value to a marker file.
 */
async function createEnvObserverBinary(
  path: string,
  varname: string,
  markerPath: string
): Promise<void> {
  const content = `#!/bin/bash
printf '%s' "\$${varname}" > "${markerPath}"
`;
  await writeFile(path, content, "utf-8");
  await chmod(path, 0o755);
}

// ---------------------------------------------------------------------------
// SPEC: 4.12 CLI Delegation (T-DEL-01 through T-DEL-08)
//
// These tests exercise the real loopx binary's delegation logic.
// Without loopx installed, the global binary wrapper fails (cannot find
// module), causing all tests to fail as expected for SPEC tests.
//
// When loopx is implemented:
// - The global binary (real loopx) starts up
// - It discovers node_modules/.bin/loopx in the project
// - It delegates to the local binary
// - Tests verify delegation occurred by checking marker files
// ---------------------------------------------------------------------------

describe("SPEC: CLI Delegation (T-DEL-01 through T-DEL-08)", () => {
  let fixture: DelegationFixture | null = null;
  let tempDirs: string[] = [];

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = null;
    }
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tempDirs = [];
  });

  // ─────────────────────────────────────────────
  // T-DEL-01: Global delegates to local node_modules/.bin/loopx
  // ─────────────────────────────────────────────

  it("T-DEL-01: global delegates to local node_modules/.bin/loopx", async () => {
    fixture = await withDelegationSetup();
    const markerPath = join(fixture.projectDir, "del-01-marker.txt");

    // Replace the local binary with one that writes a distinctive marker.
    // The global binary (real loopx) should delegate to this local binary.
    await createMarkerBinary(
      fixture.localBinPath,
      markerPath,
      "local-binary-invoked"
    );

    // Run the global binary (real loopx) from the project directory.
    // Loopx's delegation logic should find the local binary and exec it.
    const result = await fixture.runGlobal([]);

    // The marker file must exist, proving the local binary was invoked
    expect(existsSync(markerPath)).toBe(true);
    const content = readFileSync(markerPath, "utf-8");
    expect(content).toBe("local-binary-invoked");
  });

  // ─────────────────────────────────────────────
  // T-DEL-02: Ancestor directory delegation
  // ─────────────────────────────────────────────

  it("T-DEL-02: delegates to ancestor directory's node_modules/.bin/loopx", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "loopx-del02-"));
    tempDirs.push(baseDir);

    const parentDir = join(baseDir, "parent");
    const childDir = join(parentDir, "child");
    await mkdir(childDir, { recursive: true });
    await mkdir(join(childDir, ".loopx"), { recursive: true });

    // Create local loopx in parent's node_modules/.bin/
    const parentBinDir = join(parentDir, "node_modules", ".bin");
    await mkdir(parentBinDir, { recursive: true });
    const parentLocalBin = join(parentBinDir, "loopx");
    const markerPath = join(baseDir, "del-02-marker.txt");

    await createMarkerBinary(parentLocalBin, markerPath, "parent-local-invoked");

    // Create a global binary that runs the real loopx via node
    const loopxBinJs = resolveLoopxBinJs();
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

    // Run the global binary from the child directory (no local loopx in child).
    // Real loopx should walk up and find parent's node_modules/.bin/loopx.
    const result = await spawnBinary(globalBinPath, [], {
      cwd: childDir,
    });

    // The parent's local binary should have been found and executed
    expect(existsSync(markerPath)).toBe(true);
    const content = readFileSync(markerPath, "utf-8");
    expect(content).toBe("parent-local-invoked");
  });

  // ─────────────────────────────────────────────
  // T-DEL-03: Nearest ancestor wins
  // ─────────────────────────────────────────────

  it("T-DEL-03: nearest ancestor wins when both parent and child have local loopx", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "loopx-del03-"));
    tempDirs.push(baseDir);

    const parentDir = join(baseDir, "parent");
    const childDir = join(parentDir, "child");
    await mkdir(childDir, { recursive: true });
    await mkdir(join(childDir, ".loopx"), { recursive: true });

    const markerPath = join(baseDir, "del-03-marker.txt");

    // Create loopx in parent's node_modules/.bin/
    const parentBinDir = join(parentDir, "node_modules", ".bin");
    await mkdir(parentBinDir, { recursive: true });
    const parentLocalBin = join(parentBinDir, "loopx");
    await createMarkerBinary(parentLocalBin, markerPath, "parent-version");

    // Create loopx in child's node_modules/.bin/
    const childBinDir = join(childDir, "node_modules", ".bin");
    await mkdir(childBinDir, { recursive: true });
    const childLocalBin = join(childBinDir, "loopx");
    await createMarkerBinary(childLocalBin, markerPath, "child-version");

    // Create a global binary that runs real loopx
    const loopxBinJs = resolveLoopxBinJs();
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

    // Run from the child directory — nearest ancestor should win
    const result = await spawnBinary(globalBinPath, [], {
      cwd: childDir,
    });

    // The child's local binary should win (nearest ancestor)
    expect(existsSync(markerPath)).toBe(true);
    const content = readFileSync(markerPath, "utf-8");
    expect(content).toBe("child-version");
  });

  // ─────────────────────────────────────────────
  // T-DEL-04: LOOPX_DELEGATED=1 prevents delegation
  // ─────────────────────────────────────────────

  it("T-DEL-04: LOOPX_DELEGATED=1 prevents delegation", async () => {
    fixture = await withDelegationSetup();

    const localMarkerPath = join(fixture.projectDir, "del-04-local.txt");

    // Replace the local binary with one that writes a marker
    await createMarkerBinary(
      fixture.localBinPath,
      localMarkerPath,
      "local-ran"
    );

    // Run `loopx version` with LOOPX_DELEGATED=1 set.
    // Real loopx should skip delegation and handle the command itself.
    const result = await fixture.runGlobal(["version"], {
      env: { LOOPX_DELEGATED: "1" },
    });

    // Loopx should have handled "version" directly — exit 0 and output version
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    // The local binary should NOT have been invoked
    expect(existsSync(localMarkerPath)).toBe(false);
  });

  // ─────────────────────────────────────────────
  // T-DEL-05: LOOPX_BIN contains resolved realpath of local binary
  // ─────────────────────────────────────────────

  it("T-DEL-05: LOOPX_BIN contains resolved realpath of local binary", async () => {
    fixture = await withDelegationSetup();
    const markerPath = join(fixture.projectDir, "del-05-marker.txt");

    // Replace the local binary with one that writes $LOOPX_BIN to a marker file
    await createEnvObserverBinary(
      fixture.localBinPath,
      "LOOPX_BIN",
      markerPath
    );

    const result = await fixture.runGlobal([]);

    // The marker file should contain the resolved realpath of the local binary
    expect(existsSync(markerPath)).toBe(true);
    const recordedBin = readFileSync(markerPath, "utf-8");

    // Get the expected realpath of the local binary
    const expectedRealpath = await realpath(fixture.localBinPath);

    expect(recordedBin).toBe(expectedRealpath);
  });

  // ─────────────────────────────────────────────
  // T-DEL-06: import from "loopx" resolves to local version
  // ─────────────────────────────────────────────

  it("T-DEL-06: import from 'loopx' resolves to local version after delegation", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "loopx-del06-"));
    tempDirs.push(baseDir);

    const projectDir = join(baseDir, "project");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, ".loopx"), { recursive: true });

    const markerPath = join(baseDir, "del-06-marker.txt");

    // Create a local node_modules/loopx with a distinctive marker export
    const localLoopxDir = join(projectDir, "node_modules", "loopx");
    await mkdir(localLoopxDir, { recursive: true });
    await writeFile(
      join(localLoopxDir, "package.json"),
      JSON.stringify({
        name: "loopx",
        version: "99.0.0-local-test",
        type: "module",
        main: "index.js",
        exports: {
          ".": "./index.js",
        },
      }),
      "utf-8"
    );
    await writeFile(
      join(localLoopxDir, "index.js"),
      `export const __loopxVersion = "99.0.0-local-test";
export function output(data) {
  process.stdout.write(JSON.stringify(data));
}
export function input() {
  return Promise.resolve("");
}
`,
      "utf-8"
    );

    // Create a local node_modules/.bin/loopx binary that runs a script
    // which imports from "loopx" and checks the version marker
    const localBinDir = join(projectDir, "node_modules", ".bin");
    await mkdir(localBinDir, { recursive: true });
    const localBinPath = join(localBinDir, "loopx");

    // The local binary imports from "loopx" and writes the version to marker
    await writeFile(
      localBinPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

// Use dynamic import to load the "loopx" package
const loopxPkg = await import("loopx");
const version = loopxPkg.__loopxVersion ?? "unknown";
writeFileSync(${JSON.stringify(markerPath)}, version);
`,
      "utf-8"
    );
    await chmod(localBinPath, 0o755);

    // Create a global binary that runs the real loopx
    const loopxBinJs = resolveLoopxBinJs();
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

    const result = await spawnBinary(globalBinPath, [], {
      cwd: projectDir,
    });

    // The marker should contain the local version's distinctive marker
    expect(existsSync(markerPath)).toBe(true);
    const content = readFileSync(markerPath, "utf-8");
    expect(content).toBe("99.0.0-local-test");
  });

  // ─────────────────────────────────────────────
  // T-DEL-07: LOOPX_DELEGATED=1 set in delegated process
  // ─────────────────────────────────────────────

  it("T-DEL-07: LOOPX_DELEGATED=1 is set in the delegated process", async () => {
    fixture = await withDelegationSetup();
    const markerPath = join(fixture.projectDir, "del-07-marker.txt");

    // Replace the local binary with one that checks $LOOPX_DELEGATED
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
      "utf-8"
    );
    await chmod(fixture.localBinPath, 0o755);

    // Run the global binary (real loopx). It should set LOOPX_DELEGATED=1
    // when delegating to the local binary.
    const result = await fixture.runGlobal([]);

    // The marker should contain { present: true, value: "1" }
    expect(existsSync(markerPath)).toBe(true);
    const content = JSON.parse(readFileSync(markerPath, "utf-8"));
    expect(content).toEqual({ present: true, value: "1" });
  });

  // ─────────────────────────────────────────────
  // T-DEL-08: Delegation happens before command handling
  // ─────────────────────────────────────────────

  it("T-DEL-08: delegation happens before command handling", async () => {
    fixture = await withDelegationSetup();
    const markerPath = join(fixture.projectDir, "del-08-marker.txt");

    // Replace the local binary with one that writes a marker and outputs
    // its own version. If delegation works, this local binary handles
    // the "version" command, not the global binary.
    await writeFile(
      fixture.localBinPath,
      `#!/bin/bash
printf '%s' 'delegated' > "${markerPath}"
echo "99.0.0-local"
`,
      "utf-8"
    );
    await chmod(fixture.localBinPath, 0o755);

    // Run `loopx version` via the global binary.
    // Real loopx should delegate FIRST, then the local binary handles "version".
    const result = await fixture.runGlobal(["version"]);

    // The marker file must exist, proving the local binary was invoked
    // INSTEAD of the global binary handling "version" directly.
    expect(existsSync(markerPath)).toBe(true);
    const markerContent = readFileSync(markerPath, "utf-8");
    expect(markerContent).toBe("delegated");

    // The output should be the local binary's version, not the global's
    expect(result.stdout.trim()).toBe("99.0.0-local");
  });
});
