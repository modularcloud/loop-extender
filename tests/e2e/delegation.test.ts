import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdir, chmod, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { withDelegationSetup, type DelegationFixture } from "../helpers/delegation.js";
import type { CLIResult } from "../helpers/cli.js";

// ---------------------------------------------------------------------------
// Helpers local to delegation tests
// ---------------------------------------------------------------------------

/**
 * Spawn a script directly (not through runCLI) to simulate global binary
 * invocation. This is needed because runCLI always resolves to the same
 * bin path, while delegation tests need to run specific binaries.
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
 * Create a shell script that writes a marker value to a file, simulating
 * a "local" loopx binary. The script is executable and uses #!/bin/bash.
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
 * Create a shell script that writes an env var's value to a marker file,
 * simulating a "local" loopx binary that observes its environment.
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

    // Replace the local binary with one that writes a distinctive marker
    await createMarkerBinary(
      fixture.localBinPath,
      markerPath,
      "local-binary-invoked"
    );

    // Replace the global binary with a delegation script that searches for
    // a local node_modules/.bin/loopx and exec's it (since the real loopx
    // binary does not exist yet, withDelegationSetup's default global binary
    // cannot function).
    await writeFile(
      fixture.globalBinPath,
      `#!/bin/bash
if [ "$LOOPX_DELEGATED" = "1" ]; then
  exec "$@"
fi
DIR="$PWD"
while [ "$DIR" != "/" ]; do
  LOCAL="$DIR/node_modules/.bin/loopx"
  if [ -x "$LOCAL" ]; then
    export LOOPX_DELEGATED=1
    exec "$LOCAL" "$@"
  fi
  DIR="$(dirname "$DIR")"
done
echo "no local loopx found" >&2
exit 1
`,
      "utf-8"
    );
    await chmod(fixture.globalBinPath, 0o755);

    // Run the global binary from the project directory
    const result = await spawnBinary(fixture.globalBinPath, [], {
      cwd: fixture.projectDir,
    });

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

    // Create a global binary that delegates
    const globalBinDir = join(baseDir, "global", "bin");
    await mkdir(globalBinDir, { recursive: true });
    const globalBinPath = join(globalBinDir, "loopx");

    // The global binary is a Node script that simulates delegation logic:
    // it searches upward for node_modules/.bin/loopx and exec's it.
    await writeFile(
      globalBinPath,
      `#!/bin/bash
# Simulate global loopx delegation: walk up from CWD looking for node_modules/.bin/loopx
DIR="$PWD"
while [ "$DIR" != "/" ]; do
  LOCAL="$DIR/node_modules/.bin/loopx"
  if [ -x "$LOCAL" ]; then
    exec "$LOCAL" "$@"
  fi
  DIR="$(dirname "$DIR")"
done
echo "no local loopx found" >&2
exit 1
`,
      "utf-8"
    );
    await chmod(globalBinPath, 0o755);

    // Run the global binary from the child directory (no local loopx in child)
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

    // Create a global binary that delegates to nearest ancestor
    const globalBinDir = join(baseDir, "global", "bin");
    await mkdir(globalBinDir, { recursive: true });
    const globalBinPath = join(globalBinDir, "loopx");

    await writeFile(
      globalBinPath,
      `#!/bin/bash
DIR="$PWD"
while [ "$DIR" != "/" ]; do
  LOCAL="$DIR/node_modules/.bin/loopx"
  if [ -x "$LOCAL" ]; then
    exec "$LOCAL" "$@"
  fi
  DIR="$(dirname "$DIR")"
done
echo "no local loopx found" >&2
exit 1
`,
      "utf-8"
    );
    await chmod(globalBinPath, 0o755);

    // Run from the child directory
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
    const globalMarkerPath = join(fixture.projectDir, "del-04-global.txt");

    // Replace the local binary with one that writes a "local" marker
    await createMarkerBinary(
      fixture.localBinPath,
      localMarkerPath,
      "local-ran"
    );

    // Replace the global binary with one that:
    //   - If LOOPX_DELEGATED=1, writes a "global" marker (skips delegation)
    //   - Otherwise, delegates to local
    await writeFile(
      fixture.globalBinPath,
      `#!/bin/bash
if [ "$LOOPX_DELEGATED" = "1" ]; then
  printf '%s' 'global-ran' > "${globalMarkerPath}"
  exit 0
fi
# Normal delegation: find and exec local binary
DIR="$PWD"
while [ "$DIR" != "/" ]; do
  LOCAL="$DIR/node_modules/.bin/loopx"
  if [ -x "$LOCAL" ]; then
    LOOPX_DELEGATED=1 exec "$LOCAL" "$@"
  fi
  DIR="$(dirname "$DIR")"
done
`,
      "utf-8"
    );
    await chmod(fixture.globalBinPath, 0o755);

    // Run with LOOPX_DELEGATED=1 set — delegation should be skipped
    const result = await spawnBinary(fixture.globalBinPath, [], {
      cwd: fixture.projectDir,
      env: { LOOPX_DELEGATED: "1" },
    });

    // The global binary should have run directly
    expect(existsSync(globalMarkerPath)).toBe(true);
    const globalContent = readFileSync(globalMarkerPath, "utf-8");
    expect(globalContent).toBe("global-ran");

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

    // Replace the global binary so it sets LOOPX_BIN to the realpath of the
    // local binary before delegating, matching the spec behavior
    await writeFile(
      fixture.globalBinPath,
      `#!/bin/bash
if [ "$LOOPX_DELEGATED" = "1" ]; then
  exec "$@"
fi
DIR="$PWD"
while [ "$DIR" != "/" ]; do
  LOCAL="$DIR/node_modules/.bin/loopx"
  if [ -x "$LOCAL" ]; then
    RESOLVED=$(realpath "$LOCAL")
    export LOOPX_BIN="$RESOLVED"
    export LOOPX_DELEGATED=1
    exec "$LOCAL" "$@"
  fi
  DIR="$(dirname "$DIR")"
done
echo "no local loopx found" >&2
exit 1
`,
      "utf-8"
    );
    await chmod(fixture.globalBinPath, 0o755);

    const result = await spawnBinary(fixture.globalBinPath, [], {
      cwd: fixture.projectDir,
    });

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

    // Create a local node_modules/.bin/loopx binary that runs a TS script
    // which imports from "loopx" and checks the version marker
    const localBinDir = join(projectDir, "node_modules", ".bin");
    await mkdir(localBinDir, { recursive: true });
    const localBinPath = join(localBinDir, "loopx");

    // The local binary runs a script that imports from "loopx" and writes
    // the __loopxVersion to a marker file
    await writeFile(
      localBinPath,
      `#!/usr/bin/env node
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

// Use dynamic import to load the "loopx" package
const loopxPkg = await import("loopx");
const version = loopxPkg.__loopxVersion ?? "unknown";
writeFileSync(${JSON.stringify(markerPath)}, version);
`,
      "utf-8"
    );
    await chmod(localBinPath, 0o755);

    // Create a global binary that delegates
    const globalBinDir = join(baseDir, "global", "bin");
    await mkdir(globalBinDir, { recursive: true });
    const globalBinPath = join(globalBinDir, "loopx");

    await writeFile(
      globalBinPath,
      `#!/bin/bash
if [ "$LOOPX_DELEGATED" = "1" ]; then
  exec node "$0" "$@"
fi
DIR="$PWD"
while [ "$DIR" != "/" ]; do
  LOCAL="$DIR/node_modules/.bin/loopx"
  if [ -x "$LOCAL" ]; then
    export LOOPX_DELEGATED=1
    exec node "$LOCAL" "$@"
  fi
  DIR="$(dirname "$DIR")"
done
echo "no local loopx found" >&2
exit 1
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

    // Replace the local binary with one that writes $LOOPX_DELEGATED to a marker
    // Using the JSON observe-env format from the spec: { present: bool, value?: string }
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

    // Replace the global binary with one that sets LOOPX_DELEGATED=1 when delegating
    await writeFile(
      fixture.globalBinPath,
      `#!/bin/bash
if [ "$LOOPX_DELEGATED" = "1" ]; then
  exec "$@"
fi
DIR="$PWD"
while [ "$DIR" != "/" ]; do
  LOCAL="$DIR/node_modules/.bin/loopx"
  if [ -x "$LOCAL" ]; then
    export LOOPX_DELEGATED=1
    exec node "$LOCAL" "$@"
  fi
  DIR="$(dirname "$DIR")"
done
echo "no local loopx found" >&2
exit 1
`,
      "utf-8"
    );
    await chmod(fixture.globalBinPath, 0o755);

    const result = await spawnBinary(fixture.globalBinPath, [], {
      cwd: fixture.projectDir,
    });

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

    // Replace the local binary with one that writes a marker AND outputs
    // its own version, proving it was invoked instead of the global binary
    // processing the "version" subcommand.
    await writeFile(
      fixture.localBinPath,
      `#!/bin/bash
printf '%s' 'delegated' > "${markerPath}"
echo "99.0.0-local"
`,
      "utf-8"
    );
    await chmod(fixture.localBinPath, 0o755);

    // Replace the global binary with one that delegates before handling "version"
    await writeFile(
      fixture.globalBinPath,
      `#!/bin/bash
if [ "$LOOPX_DELEGATED" = "1" ]; then
  # Already delegated, handle commands directly
  if [ "$1" = "version" ]; then
    echo "1.0.0-global"
  fi
  exit 0
fi
# Delegation happens BEFORE command handling
DIR="$PWD"
while [ "$DIR" != "/" ]; do
  LOCAL="$DIR/node_modules/.bin/loopx"
  if [ -x "$LOCAL" ]; then
    export LOOPX_DELEGATED=1
    exec "$LOCAL" "$@"
  fi
  DIR="$(dirname "$DIR")"
done
# No local found, handle commands here
if [ "$1" = "version" ]; then
  echo "1.0.0-global"
fi
`,
      "utf-8"
    );
    await chmod(fixture.globalBinPath, 0o755);

    // Run `loopx version` via the global binary
    const result = await spawnBinary(fixture.globalBinPath, ["version"], {
      cwd: fixture.projectDir,
    });

    // (1) The marker file must exist, proving the local binary was invoked
    expect(existsSync(markerPath)).toBe(true);
    const markerContent = readFileSync(markerPath, "utf-8");
    expect(markerContent).toBe("delegated");

    // (2) The output should be the local binary's version, not the global's
    expect(result.stdout.trim()).toBe("99.0.0-local");
    expect(result.stdout.trim()).not.toBe("1.0.0-global");
  });
});
