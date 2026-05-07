import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { get } from "node:http";
import { execSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createTempProject,
  createWorkflowScript,
  createWorkflowPackageJson,
  createBashWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { createEnvFile } from "../helpers/env.js";
import { startLocalHTTPServer } from "../helpers/servers.js";
import { startLocalGitServer } from "../helpers/servers.js";
import { forEachRuntime, getDetectedRuntimes } from "../helpers/runtime.js";
import { withGlobalEnv } from "../helpers/env.js";

describe("HARNESS: Phase 0 — Test Infrastructure Validation", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  // H-01: Temp project creation and cleanup
  it("H-01: createTempProject creates dir, cleanup removes it", async () => {
    project = await createTempProject();

    expect(existsSync(project.dir)).toBe(true);
    expect(existsSync(project.loopxDir)).toBe(true);

    const dir = project.dir;
    await project.cleanup();
    project = null;

    expect(existsSync(dir)).toBe(false);
  });

  // H-02: Workflow script fixture creation
  it("H-02: createWorkflowScript writes file to .loopx/<workflow>/ with correct content", async () => {
    project = await createTempProject();
    const content = '#!/bin/bash\necho "hello"\n';
    const filePath = await createWorkflowScript(
      project,
      "myscript",
      "index",
      ".sh",
      content,
    );

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe(content);
    expect(filePath).toBe(join(project.loopxDir, "myscript", "index.sh"));
  });

  // H-03: Workflow package.json fixture creation
  it("H-03: createWorkflowPackageJson + createWorkflowScript build expected workflow structure", async () => {
    project = await createTempProject();
    const workflowDir = join(project.loopxDir, "mypipe");
    await createWorkflowPackageJson(project, "mypipe", { type: "module" });
    await createWorkflowScript(
      project,
      "mypipe",
      "index",
      ".ts",
      'console.log("hello");\n',
    );

    expect(existsSync(workflowDir)).toBe(true);
    expect(existsSync(join(workflowDir, "package.json"))).toBe(true);
    expect(existsSync(join(workflowDir, "index.ts"))).toBe(true);

    const pkg = JSON.parse(
      readFileSync(join(workflowDir, "package.json"), "utf-8"),
    );
    expect(pkg.type).toBe("module");

    const indexContent = readFileSync(join(workflowDir, "index.ts"), "utf-8");
    expect(indexContent).toBe('console.log("hello");\n');
  });

  // H-04: Bash workflow script is executable
  it("H-04: created .sh has execute permission bit", async () => {
    project = await createTempProject();
    const filePath = await createBashWorkflowScript(
      project,
      "test-exec",
      "index",
      'echo "hi"',
    );

    const stats = statSync(filePath);
    // Check that the file has execute permission (owner execute bit)
    expect(stats.mode & 0o111).not.toBe(0);
  });

  // H-05: Env file creation
  it("H-05: createEnvFile writes readable file with expected content", async () => {
    project = await createTempProject();
    const envPath = join(project.dir, ".env");
    await createEnvFile(envPath, { FOO: "bar", BAZ: "qux" });

    expect(existsSync(envPath)).toBe(true);
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("FOO=bar");
    expect(content).toContain("BAZ=qux");
  });

  // H-06: Process spawning captures exit code
  it("H-06: spawn captures exit code", async () => {
    const result = await spawnAndCapture("node", ["-e", "process.exit(42)"]);
    expect(result.exitCode).toBe(42);
  });

  // H-07: Process spawning captures stdout
  it("H-07: spawn captures stdout", async () => {
    const result = await spawnAndCapture("echo", ["hello"]);
    expect(result.stdout).toBe("hello\n");
  });

  // H-08: Process spawning captures stderr
  it("H-08: spawn captures stderr", async () => {
    const result = await spawnAndCapture("node", [
      "-e",
      'console.error("err")',
    ]);
    expect(result.stderr).toContain("err");
  });

  // H-09: Process spawning respects cwd
  it("H-09: spawn respects cwd", async () => {
    project = await createTempProject();
    const result = await spawnAndCapture("pwd", [], { cwd: project.dir });
    // realpath handles symlinks (e.g., /tmp on macOS → /private/tmp)
    const actual = result.stdout.trim();
    const expected = execSync(`realpath "${project.dir}"`).toString().trim();
    expect(actual).toBe(expected);
  });

  // H-10: Process spawning respects env
  it("H-10: spawn respects env", async () => {
    const result = await spawnAndCapture(
      "node",
      ["-e", "process.stdout.write(process.env.MY_VAR || '')"],
      { env: { ...process.env, MY_VAR: "hello" } }
    );
    expect(result.stdout).toBe("hello");
  });

  // H-11: Signal delivery works
  it("H-11: signal delivery terminates sleeping process", async () => {
    const child = spawn("sleep", ["999"], { stdio: "pipe" });

    const exitPromise = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        child.on("close", (code, signal) => {
          resolve({ code, signal });
        });
      }
    );

    // Give the process a moment to start
    await new Promise((r) => setTimeout(r, 100));

    child.kill("SIGTERM");

    const result = await exitPromise;
    expect(result.signal).toBe("SIGTERM");
  });

  // H-12: Local HTTP server starts and serves content
  it("H-12: local HTTP server starts and serves content", async () => {
    const server = await startLocalHTTPServer([
      { path: "/test.txt", body: "hello world", contentType: "text/plain" },
    ]);

    try {
      const body = await httpGet(`${server.url}/test.txt`);
      expect(body).toBe("hello world");
    } finally {
      await server.close();
    }
  });

  // H-13: Local git repo is cloneable
  it("H-13: local git repo is cloneable and contains files", async () => {
    const gitServer = await startLocalGitServer([
      {
        name: "test-repo",
        files: {
          "package.json": '{"main": "index.ts"}',
          "index.ts": 'console.log("hello");',
        },
      },
    ]);

    try {
      const cloneDir = await mkdtemp(join(tmpdir(), "loopx-clone-test-"));
      execSync(
        `git clone "${gitServer.url}/test-repo.git" "${cloneDir}/repo"`,
        { stdio: "pipe" }
      );

      expect(existsSync(join(cloneDir, "repo", "package.json"))).toBe(true);
      expect(existsSync(join(cloneDir, "repo", "index.ts"))).toBe(true);

      const content = readFileSync(
        join(cloneDir, "repo", "index.ts"),
        "utf-8"
      );
      expect(content).toBe('console.log("hello");');

      // Cleanup
      execSync(`rm -rf "${cloneDir}"`, { stdio: "pipe" });
    } finally {
      await gitServer.close();
    }
  });

  // H-14: Runtime detection
  it("H-14 T-RUNTIME-MATRIX: forEachRuntime correctly detects available runtimes", () => {
    const runtimes = getDetectedRuntimes();

    // At minimum, Node.js should be available since we're running in it
    expect(runtimes.length).toBeGreaterThanOrEqual(1);
    expect(runtimes.some((r) => r.runtime === "node")).toBe(true);

    // Verify version strings are non-empty
    for (const r of runtimes) {
      expect(r.version.length).toBeGreaterThan(0);
    }
  });

  // H-15: Global env isolation
  it("H-15: withGlobalEnv uses temp dir, doesn't touch real ~/.config", async () => {
    const originalXdg = process.env.XDG_CONFIG_HOME;

    await withGlobalEnv({ TEST_VAR: "test_value" }, async () => {
      // XDG_CONFIG_HOME should be set to a temp dir
      expect(process.env.XDG_CONFIG_HOME).toBeDefined();
      expect(process.env.XDG_CONFIG_HOME).not.toBe(originalXdg);

      // The temp dir should contain loopx/env
      const envPath = join(
        process.env.XDG_CONFIG_HOME!,
        "loopx",
        "env"
      );
      expect(existsSync(envPath)).toBe(true);
      const content = readFileSync(envPath, "utf-8");
      expect(content).toContain("TEST_VAR=test_value");
    });

    // After cleanup, XDG_CONFIG_HOME should be restored
    expect(process.env.XDG_CONFIG_HOME).toBe(originalXdg);
  });
});

// --- Helper for process spawning tests ---

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function spawnAndCapture(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
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
      reject(new Error("Process timed out"));
    }, 10_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}
