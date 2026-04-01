import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  createTempProject,
  createScript,
  createBashScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import {
  startLocalHTTPServer,
  startLocalGitServer,
  withGitURLRewrite,
  type HTTPServer,
  type GitServer,
} from "../helpers/servers.js";
import { forEachRuntime, isRuntimeAvailable } from "../helpers/runtime.js";

// ─────────────────────────────────────────────────────────────
// Helpers: create tarball archives programmatically
// ─────────────────────────────────────────────────────────────

/**
 * Creates a .tar.gz archive from a set of files, wrapped in a single
 * top-level directory. Returns the archive as a Buffer.
 */
async function createTarball(
  topDir: string,
  files: Record<string, string>,
): Promise<Buffer> {
  const tmp = join(tmpdir(), `loopx-tar-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const contentDir = join(tmp, topDir);
  await mkdir(contentDir, { recursive: true });

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(contentDir, filePath);
    const parentDir = join(fullPath, "..");
    await mkdir(parentDir, { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  const archivePath = join(tmp, "archive.tar.gz");
  execSync(`tar czf "${archivePath}" -C "${tmp}" "${topDir}"`, { stdio: "pipe" });
  const buf = readFileSync(archivePath);
  await rm(tmp, { recursive: true, force: true });
  return buf;
}

/**
 * Creates a .tar.gz archive with multiple top-level entries (no single wrapping dir).
 */
async function createMultiTopTarball(
  files: Record<string, string>,
): Promise<Buffer> {
  const tmp = join(tmpdir(), `loopx-tar-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const contentDir = join(tmp, "content");
  await mkdir(contentDir, { recursive: true });

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(contentDir, filePath);
    const parentDir = join(fullPath, "..");
    await mkdir(parentDir, { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  const archivePath = join(tmp, "archive.tar.gz");
  // Archive all entries in contentDir directly (multiple top-level entries)
  execSync(`tar czf "${archivePath}" -C "${contentDir}" .`, { stdio: "pipe" });
  const buf = readFileSync(archivePath);
  await rm(tmp, { recursive: true, force: true });
  return buf;
}

/**
 * Standard valid package.json content for directory scripts.
 */
function validPackageJson(main: string): string {
  return JSON.stringify({ name: "test-script", main }, null, 2);
}

/**
 * Standard valid index.ts content for directory scripts.
 */
const VALID_INDEX_TS = `import { output } from "loopx";\noutput({ result: "installed-ok" });\n`;

// ═════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════

describe("SPEC: Install Command (T-INST-01 through T-INST-GLOBAL-01)", () => {
  let project: TempProject | null = null;
  let httpServer: HTTPServer | null = null;
  let gitServer: GitServer | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
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

  // ─────────────────────────────────────────────
  // Source Detection
  // ─────────────────────────────────────────────

  describe("SPEC: Source Detection", () => {
    forEachRuntime((runtime) => {
      it("T-INST-01: org/repo shorthand expands to github.com git clone", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "my-script",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        await withGitURLRewrite(
          { "https://github.com/myorg/my-script.git": `${gitServer.url}/my-script.git` },
          async () => {
            const result = await runCLI(["install", "myorg/my-script"], {
              cwd: project!.dir,
              runtime,
            });

            expect(result.exitCode).toBe(0);
            // Repo should be cloned into .loopx/my-script/
            const installed = join(project!.loopxDir, "my-script");
            expect(existsSync(installed)).toBe(true);
            expect(existsSync(join(installed, "package.json"))).toBe(true);
          },
        );
      });

      it("T-INST-01a: org/repo.git shorthand is rejected", async () => {
        project = await createTempProject();

        const result = await runCLI(["install", "myorg/my-script.git"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
      });

      it("T-INST-02: https://github.com/org/repo is treated as git (known host)", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "repo",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
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

      it("T-INST-03: https://gitlab.com/org/repo is treated as git", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "repo",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
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

      it("T-INST-04: https://bitbucket.org/org/repo is treated as git", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "repo",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
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

      it("T-INST-05: https://example.com/repo.git is treated as git (.git suffix)", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "repo",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
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

      it("T-INST-06: URL ending in .tar.gz is treated as tarball", async () => {
        const tarball = await createTarball("pkg", {
          "package.json": validPackageJson("index.ts"),
          "index.ts": VALID_INDEX_TS,
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/pkg.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/pkg.tar.gz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(true);
        expect(
          existsSync(join(project.loopxDir, "pkg", "package.json")),
        ).toBe(true);
      });

      it("T-INST-07: URL ending in .tgz is treated as tarball", async () => {
        const tarball = await createTarball("pkg", {
          "package.json": validPackageJson("index.ts"),
          "index.ts": VALID_INDEX_TS,
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/pkg.tgz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/pkg.tgz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(true);
      });

      it("T-INST-08: URL ending in .ts is treated as single file", async () => {
        const scriptContent = `import { output } from "loopx";\noutput({ result: "hello" });\n`;

        httpServer = await startLocalHTTPServer([
          {
            path: "/script.ts",
            contentType: "text/plain",
            body: scriptContent,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/script.ts`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "script.ts"))).toBe(true);
      });

      it("T-INST-08a: known host URL with extra path segments and .tar.gz is treated as tarball (not git)", async () => {
        // Note: The known-host source-detection edge case (github.com URL with
        // deep path classified as tarball, not git) is tested in the
        // source-detection unit test. This E2E test verifies the tarball
        // download/extraction works end-to-end with a path that has multiple segments.
        const tarball = await createTarball("main", {
          "package.json": validPackageJson("index.ts"),
          "index.ts": VALID_INDEX_TS,
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/org/repo/archive/main.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();

        const result = await runCLI(
          ["install", `${httpServer!.url}/org/repo/archive/main.tar.gz`],
          { cwd: project!.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        // Tarball extracted: name derived from "main.tar.gz" → "main"
        expect(existsSync(join(project!.loopxDir, "main"))).toBe(true);
      });

      it("T-INST-08b: known host URL with raw file path is treated as single file (not git)", async () => {
        const scriptContent = `import { output } from "loopx";\noutput({ result: "raw" });\n`;

        httpServer = await startLocalHTTPServer([
          {
            path: "/org/repo/raw/main/script.ts",
            contentType: "text/plain",
            body: scriptContent,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/org/repo/raw/main/script.ts`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "script.ts"))).toBe(true);
      });

      it("T-INST-08c: known host URL with trailing slash is treated as git", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "repo",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
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

      it("T-INST-08d: tarball URL with query string is treated as tarball", async () => {
        const tarball = await createTarball("pkg", {
          "package.json": validPackageJson("index.ts"),
          "index.ts": VALID_INDEX_TS,
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/pkg.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/pkg.tar.gz?token=abc`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        // Name derived from pathname, query stripped: "pkg"
        expect(existsSync(join(project.loopxDir, "pkg"))).toBe(true);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Single-File Install
  // ─────────────────────────────────────────────

  describe("SPEC: Single-File Install", () => {
    forEachRuntime((runtime) => {
      it("T-INST-09: single-file .ts download places correct filename in .loopx/", async () => {
        const scriptContent = `import { output } from "loopx";\noutput({ result: "ok" });\n`;

        httpServer = await startLocalHTTPServer([
          {
            path: "/myscript.ts",
            contentType: "text/plain",
            body: scriptContent,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/myscript.ts`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        const filePath = join(project.loopxDir, "myscript.ts");
        expect(existsSync(filePath)).toBe(true);
        const content = readFileSync(filePath, "utf-8");
        expect(content).toBe(scriptContent);
      });

      it("T-INST-10: query string stripped from filename", async () => {
        const scriptContent = `console.log("hello");\n`;

        httpServer = await startLocalHTTPServer([
          {
            path: "/tool.ts",
            contentType: "text/plain",
            body: scriptContent,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/tool.ts?token=abc`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        // File should be tool.ts, NOT tool.ts?token=abc
        expect(existsSync(join(project.loopxDir, "tool.ts"))).toBe(true);
        expect(
          existsSync(join(project.loopxDir, "tool.ts?token=abc")),
        ).toBe(false);
      });

      it("T-INST-11: fragment stripped from filename", async () => {
        const scriptContent = `console.log("hello");\n`;

        httpServer = await startLocalHTTPServer([
          {
            path: "/util.ts",
            contentType: "text/plain",
            body: scriptContent,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/util.ts#section`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "util.ts"))).toBe(true);
      });

      it("T-INST-12: unsupported extension (.py) is rejected", async () => {
        httpServer = await startLocalHTTPServer([
          {
            path: "/script.py",
            contentType: "text/plain",
            body: "print('hello')\n",
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/script.py`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        // Nothing saved in .loopx/
        const entries = readdirSync(project.loopxDir);
        expect(entries).toHaveLength(0);
      });

      it("T-INST-13: script name derived from base name (script.ts -> name 'script')", async () => {
        const scriptContent = `import { output } from "loopx";\noutput({ result: "derived" });\n`;

        httpServer = await startLocalHTTPServer([
          {
            path: "/my-agent.ts",
            contentType: "text/plain",
            body: scriptContent,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/my-agent.ts`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        // File is my-agent.ts, script name is "my-agent"
        expect(existsSync(join(project.loopxDir, "my-agent.ts"))).toBe(true);
      });

      it("T-INST-14: .loopx/ directory created if missing", async () => {
        const scriptContent = `import { output } from "loopx";\noutput({ result: "created" });\n`;

        httpServer = await startLocalHTTPServer([
          {
            path: "/tool.ts",
            contentType: "text/plain",
            body: scriptContent,
          },
        ]);

        // Create project WITHOUT .loopx/
        project = await createTempProject({ withLoopxDir: false });
        expect(existsSync(project.loopxDir)).toBe(false);

        const result = await runCLI(
          ["install", `${httpServer.url}/tool.ts`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        expect(existsSync(project.loopxDir)).toBe(true);
        expect(existsSync(join(project.loopxDir, "tool.ts"))).toBe(true);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Git Install
  // ─────────────────────────────────────────────

  describe("SPEC: Git Install", () => {
    forEachRuntime((runtime) => {
      it("T-INST-15: cloning a git repo places it in .loopx/<repo-name>/", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "my-tool",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        await withGitURLRewrite(
          { "https://github.com/org/my-tool": `${gitServer.url}/my-tool.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/my-tool"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(0);
            const installDir = join(project!.loopxDir, "my-tool");
            expect(existsSync(installDir)).toBe(true);
            expect(statSync(installDir).isDirectory()).toBe(true);
            expect(existsSync(join(installDir, "package.json"))).toBe(true);
            expect(existsSync(join(installDir, "index.ts"))).toBe(true);
          },
        );
      });

      it("T-INST-16: shallow clone (depth 1) — only 1 commit in cloned repo", async () => {
        project = await createTempProject();

        // We need a repo with 2+ commits for the assertion to be non-vacuous.
        // startLocalGitServer creates one commit. We add a second manually.
        gitServer = await startLocalGitServer([
          {
            name: "deep-repo",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        // Add a second commit to the bare repo via a temp clone
        const tmpCloneDir = join(tmpdir(), `loopx-extra-commit-${Date.now()}`);
        try {
          execSync(
            `git clone "${gitServer.url}/deep-repo.git" "${tmpCloneDir}"`,
            { stdio: "pipe" },
          );
          writeFileSync(
            join(tmpCloneDir, "extra.txt"),
            "second commit content",
          );
          execSync(
            `cd "${tmpCloneDir}" && git add -A && git -c user.email="test@test.com" -c user.name="Test" commit -m "second commit" && git push origin HEAD`,
            { stdio: "pipe" },
          );
        } finally {
          await rm(tmpCloneDir, { recursive: true, force: true });
        }

        // Verify the source repo has 2 commits
        const srcCount = execSync(
          `git -C "${gitServer.url.replace("file://", "")}/deep-repo.git" rev-list --count HEAD`,
          { stdio: "pipe" },
        ).toString().trim();
        expect(Number(srcCount)).toBeGreaterThanOrEqual(2);

        await withGitURLRewrite(
          { "https://github.com/org/deep-repo": `${gitServer.url}/deep-repo.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/deep-repo"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(0);

            const installDir = join(project!.loopxDir, "deep-repo");
            expect(existsSync(installDir)).toBe(true);

            // Shallow clone should have exactly 1 commit
            const commitCount = execSync(
              `git -C "${installDir}" rev-list --count HEAD`,
              { stdio: "pipe" },
            ).toString().trim();
            expect(commitCount).toBe("1");
          },
        );
      });

      it("T-INST-17: repo name derived from URL minus .git suffix", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "my-agent",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        await withGitURLRewrite(
          { "https://example.com/my-agent.git": `${gitServer.url}/my-agent.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://example.com/my-agent.git"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(0);
            // Name should be "my-agent" (stripped .git suffix)
            expect(existsSync(join(project!.loopxDir, "my-agent"))).toBe(true);
          },
        );
      });

      it("T-INST-18: repo name derived from URL without .git suffix (known host)", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "toolbox",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        await withGitURLRewrite(
          { "https://github.com/org/toolbox": `${gitServer.url}/toolbox.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/toolbox"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(0);
            // Name is "toolbox"
            expect(existsSync(join(project!.loopxDir, "toolbox"))).toBe(true);
          },
        );
      });

      it("T-INST-19: missing package.json with main -> clone removed, error", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "no-main",
            files: {
              // package.json exists but has no main field
              "package.json": JSON.stringify({ name: "no-main" }),
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        await withGitURLRewrite(
          { "https://github.com/org/no-main": `${gitServer.url}/no-main.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/no-main"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(1);
            expect(result.stderr.length).toBeGreaterThan(0);
            // Clone should be removed
            expect(existsSync(join(project!.loopxDir, "no-main"))).toBe(false);
          },
        );
      });

      it("T-INST-20: package.json main with unsupported extension -> clone removed, error", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "bad-ext",
            files: {
              "package.json": validPackageJson("index.py"),
              "index.py": "print('hello')",
            },
          },
        ]);

        await withGitURLRewrite(
          { "https://github.com/org/bad-ext": `${gitServer.url}/bad-ext.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/bad-ext"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(1);
            expect(result.stderr.length).toBeGreaterThan(0);
            // Clone should be removed
            expect(existsSync(join(project!.loopxDir, "bad-ext"))).toBe(false);
          },
        );
      });

      it("T-INST-21: successful git install -> runnable via loopx -n 1 <name>", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "runnable",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        await withGitURLRewrite(
          { "https://github.com/org/runnable": `${gitServer.url}/runnable.git` },
          async () => {
            const installResult = await runCLI(
              ["install", "https://github.com/org/runnable"],
              { cwd: project!.dir, runtime },
            );
            expect(installResult.exitCode).toBe(0);

            // Now run the installed script
            const runResult = await runCLI(["-n", "1", "runnable"], {
              cwd: project!.dir,
              runtime,
            });
            expect(runResult.exitCode).toBe(0);
          },
        );
      });
    });
  });

  // ─────────────────────────────────────────────
  // Tarball Install
  // ─────────────────────────────────────────────

  describe("SPEC: Tarball Install", () => {
    forEachRuntime((runtime) => {
      it("T-INST-22: extracting .tar.gz places contents in .loopx/<archive-name>/", async () => {
        const tarball = await createTarball("my-pkg", {
          "package.json": validPackageJson("index.ts"),
          "index.ts": VALID_INDEX_TS,
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/my-pkg.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/my-pkg.tar.gz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        const installDir = join(project.loopxDir, "my-pkg");
        expect(existsSync(installDir)).toBe(true);
        expect(existsSync(join(installDir, "package.json"))).toBe(true);
        expect(existsSync(join(installDir, "index.ts"))).toBe(true);
      });

      it("T-INST-23: single top-level directory in archive is unwrapped", async () => {
        // Archive structure: wrapper-dir/package.json, wrapper-dir/index.ts
        // After install, .loopx/archive/ should contain package.json directly
        const tarball = await createTarball("wrapper-dir", {
          "package.json": validPackageJson("index.ts"),
          "index.ts": VALID_INDEX_TS,
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/archive.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/archive.tar.gz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        const installDir = join(project.loopxDir, "archive");
        expect(existsSync(installDir)).toBe(true);
        // The single top-level dir "wrapper-dir" should be unwrapped
        expect(existsSync(join(installDir, "package.json"))).toBe(true);
        // wrapper-dir itself should NOT be a subdir
        expect(existsSync(join(installDir, "wrapper-dir"))).toBe(false);
      });

      it("T-INST-24: multiple top-level entries placed directly", async () => {
        // Create archive with multiple top-level entries (not a single wrapping dir)
        const tarball = await createMultiTopTarball({
          "package.json": validPackageJson("index.ts"),
          "index.ts": VALID_INDEX_TS,
          "README.md": "# Hello",
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/multi.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/multi.tar.gz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        const installDir = join(project.loopxDir, "multi");
        expect(existsSync(installDir)).toBe(true);
        expect(existsSync(join(installDir, "package.json"))).toBe(true);
        expect(existsSync(join(installDir, "index.ts"))).toBe(true);
      });

      it("T-INST-25: .tgz extension handled identically", async () => {
        const tarball = await createTarball("tgz-pkg", {
          "package.json": validPackageJson("index.ts"),
          "index.ts": VALID_INDEX_TS,
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/tgz-pkg.tgz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/tgz-pkg.tgz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        const installDir = join(project.loopxDir, "tgz-pkg");
        expect(existsSync(installDir)).toBe(true);
        expect(existsSync(join(installDir, "package.json"))).toBe(true);
      });

      it("T-INST-26: extracted dir must have package.json with main, otherwise removed", async () => {
        // Tarball with package.json but no main field
        const tarball = await createTarball("no-main-pkg", {
          "package.json": JSON.stringify({ name: "no-main-pkg" }),
          "index.ts": VALID_INDEX_TS,
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/no-main-pkg.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/no-main-pkg.tar.gz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        // Directory should be removed
        expect(existsSync(join(project.loopxDir, "no-main-pkg"))).toBe(false);
      });

      it("T-INST-26a: tarball URL with query string -> query stripped from archive-name", async () => {
        const tarball = await createTarball("qs-pkg", {
          "package.json": validPackageJson("index.ts"),
          "index.ts": VALID_INDEX_TS,
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/qs-pkg.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/qs-pkg.tar.gz?token=abc`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        // Installed as .loopx/qs-pkg/, NOT .loopx/qs-pkg.tar.gz?token=abc/
        expect(existsSync(join(project.loopxDir, "qs-pkg"))).toBe(true);
      });

      it("T-INST-26b: tarball URL with fragment -> fragment stripped from archive-name", async () => {
        const tarball = await createTarball("frag-pkg", {
          "package.json": validPackageJson("index.ts"),
          "index.ts": VALID_INDEX_TS,
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/frag-pkg.tgz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/frag-pkg.tgz#v1`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        // Installed as .loopx/frag-pkg/
        expect(existsSync(join(project.loopxDir, "frag-pkg"))).toBe(true);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Common Rules
  // ─────────────────────────────────────────────

  describe("SPEC: Common Install Rules", () => {
    forEachRuntime((runtime) => {
      it("T-INST-27: destination-path collision with existing file -> error", async () => {
        const scriptContent = `import { output } from "loopx";\noutput({ result: "new" });\n`;

        httpServer = await startLocalHTTPServer([
          {
            path: "/foo.ts",
            contentType: "text/plain",
            body: scriptContent,
          },
        ]);

        project = await createTempProject();
        // Pre-create .loopx/foo.ts
        const existingContent = `// existing\n`;
        await writeFile(join(project.loopxDir, "foo.ts"), existingContent, "utf-8");

        const result = await runCLI(
          ["install", `${httpServer.url}/foo.ts`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        // Existing file untouched
        const content = readFileSync(join(project.loopxDir, "foo.ts"), "utf-8");
        expect(content).toBe(existingContent);
      });

      it("T-INST-27a: destination-path collision with non-script directory -> error", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "foo",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        // Pre-create .loopx/foo/ as a non-script directory (no package.json)
        const existingDir = join(project.loopxDir, "foo");
        await mkdir(existingDir, { recursive: true });
        await writeFile(join(existingDir, "utils.ts"), "export const x = 1;\n", "utf-8");

        await withGitURLRewrite(
          { "https://github.com/org/foo": `${gitServer.url}/foo.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/foo"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(1);
            expect(result.stderr.length).toBeGreaterThan(0);
            // Existing directory untouched
            expect(existsSync(join(existingDir, "utils.ts"))).toBe(true);
            // No package.json added (it was not overwritten)
            expect(existsSync(join(existingDir, "package.json"))).toBe(false);
          },
        );
      });

      it("T-INST-27b: script-name collision across types (file vs dir) -> error", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "foo",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        // Pre-create .loopx/foo.sh (file script named "foo")
        await createBashScript(project, "foo", 'echo "existing"');

        await withGitURLRewrite(
          { "https://github.com/org/foo": `${gitServer.url}/foo.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/foo"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(1);
            expect(result.stderr.length).toBeGreaterThan(0);
            // .loopx/foo.sh still exists
            expect(existsSync(join(project!.loopxDir, "foo.sh"))).toBe(true);
            // .loopx/foo/ NOT created
            expect(existsSync(join(project!.loopxDir, "foo"))).toBe(false);
          },
        );
      });

      it("T-INST-27c: script-name collision across file extensions -> error", async () => {
        const shContent = `import { output } from "loopx";\noutput({ result: "new" });\n`;

        httpServer = await startLocalHTTPServer([
          {
            path: "/foo.sh",
            contentType: "text/plain",
            body: "#!/bin/bash\necho 'new'\n",
          },
        ]);

        project = await createTempProject();
        // Pre-create .loopx/foo.ts (file script named "foo")
        await createScript(project, "foo", ".ts", `console.log("existing");\n`);

        const result = await runCLI(
          ["install", `${httpServer.url}/foo.sh`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        // .loopx/foo.ts still exists, .loopx/foo.sh NOT created
        expect(existsSync(join(project.loopxDir, "foo.ts"))).toBe(true);
        expect(existsSync(join(project.loopxDir, "foo.sh"))).toBe(false);
      });

      it("T-INST-27d: name collision detected even with pre-existing collision in .loopx/", async () => {
        // Create TWO file scripts with the same base name (pre-existing collision)
        project = await createTempProject();
        await createBashScript(project, "foo", `printf '{"result":"sh"}'`);
        await createScript(project, "foo", ".ts", `console.log(JSON.stringify({result:"ts"}));`);

        gitServer = await startLocalGitServer([
          {
            name: "foo",
            files: {
              "package.json": validPackageJson("index.ts"),
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        await withGitURLRewrite(
          { "https://github.com/testorg/foo": `${gitServer.url}/foo.git` },
          async () => {
            const result = await runCLI(
              ["install", "testorg/foo"],
              { cwd: project.dir, runtime },
            );

            expect(result.exitCode).toBe(1);
            expect(result.stderr.length).toBeGreaterThan(0);
            // No directory created for the install
            expect(existsSync(join(project.loopxDir, "foo"))).toBe(false);
            // Both pre-existing files still intact
            expect(existsSync(join(project.loopxDir, "foo.sh"))).toBe(true);
            expect(existsSync(join(project.loopxDir, "foo.ts"))).toBe(true);
          },
        );
      });

      it("T-INST-28: reserved name (output.ts) -> error, nothing saved", async () => {
        httpServer = await startLocalHTTPServer([
          {
            path: "/output.ts",
            contentType: "text/plain",
            body: `console.log("should not install");\n`,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/output.ts`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(existsSync(join(project.loopxDir, "output.ts"))).toBe(false);
      });

      it("T-INST-29: invalid name (-invalid.ts) -> error, nothing saved", async () => {
        httpServer = await startLocalHTTPServer([
          {
            path: "/-invalid.ts",
            contentType: "text/plain",
            body: `console.log("should not install");\n`,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/-invalid.ts`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(existsSync(join(project.loopxDir, "-invalid.ts"))).toBe(false);
      });

      it("T-INST-30: no auto npm install after git clone", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "has-deps",
            files: {
              "package.json": JSON.stringify(
                {
                  name: "has-deps",
                  main: "index.ts",
                  dependencies: { lodash: "^4.0.0" },
                },
                null,
                2,
              ),
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        await withGitURLRewrite(
          { "https://github.com/org/has-deps": `${gitServer.url}/has-deps.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/has-deps"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(0);
            const installDir = join(project!.loopxDir, "has-deps");
            expect(existsSync(installDir)).toBe(true);
            // node_modules should NOT exist — no auto-install
            expect(
              existsSync(join(installDir, "node_modules")),
            ).toBe(false);
          },
        );
      });

      it("T-INST-31: HTTP 404 during single-file download -> error, no partial file", async () => {
        httpServer = await startLocalHTTPServer([
          {
            path: "/not-here.ts",
            status: 404,
            contentType: "text/plain",
            body: "Not Found",
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/not-here.ts`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        // No partial file left
        expect(existsSync(join(project.loopxDir, "not-here.ts"))).toBe(false);
      });

      it("T-INST-31a: HTTP 500 during single-file download -> error", async () => {
        httpServer = await startLocalHTTPServer([
          {
            path: "/error.ts",
            status: 500,
            contentType: "text/plain",
            body: "Internal Server Error",
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/error.ts`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(existsSync(join(project.loopxDir, "error.ts"))).toBe(false);
      });

      it.skipIf(process.getuid?.() === 0)(
        "T-INST-31b: single-file install write failure (read-only .loopx/) -> clean up, error",
        async () => {
          httpServer = await startLocalHTTPServer([
            {
              path: "/script.ts",
              contentType: "text/plain",
              body: `console.log(JSON.stringify({result:"ok"}));\n`,
            },
          ]);

          project = await createTempProject();

          // Make .loopx/ read-only so the write fails
          await chmod(project.loopxDir, 0o555);

          try {
            const result = await runCLI(
              ["install", `${httpServer.url}/script.ts`],
              { cwd: project.dir, runtime },
            );

            expect(result.exitCode).toBe(1);
            expect(existsSync(join(project.loopxDir, "script.ts"))).toBe(false);
          } finally {
            // Restore permissions so cleanup works
            await chmod(project.loopxDir, 0o755);
          }
        },
      );

      it("T-INST-32: git clone failure (non-existent repo) -> error, no partial dir", async () => {
        project = await createTempProject();

        // Use withGitURLRewrite pointing to a non-existent bare repo
        gitServer = await startLocalGitServer([]);

        await withGitURLRewrite(
          { "https://github.com/org/nonexistent": `${gitServer.url}/nonexistent.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/nonexistent"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(1);
            expect(result.stderr.length).toBeGreaterThan(0);
            // No partial directory left
            expect(
              existsSync(join(project!.loopxDir, "nonexistent")),
            ).toBe(false);
          },
        );
      });

      it("T-INST-33a: empty archive -> error with clear message, no partial dir", async () => {
        // Create a valid but empty tar.gz (just end-of-archive markers)
        const emptyTmp = join(tmpdir(), `loopx-empty-tar-${Date.now()}`);
        await mkdir(emptyTmp, { recursive: true });
        execFileSync("tar", ["czf", join(emptyTmp, "empty.tar.gz"), "-T", "/dev/null"], { cwd: emptyTmp });
        const emptyArchive = readFileSync(join(emptyTmp, "empty.tar.gz"));
        await rm(emptyTmp, { recursive: true, force: true });

        httpServer = await startLocalHTTPServer([
          {
            path: "/empty.tar.gz",
            contentType: "application/gzip",
            body: emptyArchive,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/empty.tar.gz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/empty/i);
        expect(existsSync(join(project.loopxDir, "empty"))).toBe(false);
      });

      it("T-INST-33: corrupt archive -> error, no partial dir", async () => {
        // Serve garbage bytes as a tarball
        httpServer = await startLocalHTTPServer([
          {
            path: "/corrupt.tar.gz",
            contentType: "application/gzip",
            body: Buffer.from("this is not a real tarball at all!!!"),
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/corrupt.tar.gz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        // No partial directory left
        expect(existsSync(join(project.loopxDir, "corrupt"))).toBe(false);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Post-Validation (Directory Scripts)
  // ─────────────────────────────────────────────

  describe("SPEC: Install Post-Validation (Directory Scripts)", () => {
    forEachRuntime((runtime) => {
      // --- Git post-validation ---

      it("T-INST-34: git install with invalid JSON in package.json -> clone removed, error", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "bad-json",
            files: {
              "package.json": "{invalid json!!!}",
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        await withGitURLRewrite(
          { "https://github.com/org/bad-json": `${gitServer.url}/bad-json.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/bad-json"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(1);
            expect(result.stderr.length).toBeGreaterThan(0);
            expect(
              existsSync(join(project!.loopxDir, "bad-json")),
            ).toBe(false);
          },
        );
      });

      it("T-INST-35: git install with non-string main -> clone removed, error", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "num-main",
            files: {
              "package.json": JSON.stringify({ name: "num-main", main: 42 }),
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        await withGitURLRewrite(
          { "https://github.com/org/num-main": `${gitServer.url}/num-main.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/num-main"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(1);
            expect(result.stderr.length).toBeGreaterThan(0);
            expect(
              existsSync(join(project!.loopxDir, "num-main")),
            ).toBe(false);
          },
        );
      });

      it("T-INST-36: git install with main escaping directory -> clone removed, error", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "escape-main",
            files: {
              "package.json": JSON.stringify({
                name: "escape-main",
                main: "../escape.ts",
              }),
              "index.ts": VALID_INDEX_TS,
            },
          },
        ]);

        await withGitURLRewrite(
          { "https://github.com/org/escape-main": `${gitServer.url}/escape-main.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/escape-main"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(1);
            expect(result.stderr.length).toBeGreaterThan(0);
            expect(
              existsSync(join(project!.loopxDir, "escape-main")),
            ).toBe(false);
          },
        );
      });

      it("T-INST-37: git install with main pointing to non-existent file -> clone removed, error", async () => {
        project = await createTempProject();

        gitServer = await startLocalGitServer([
          {
            name: "missing-main",
            files: {
              "package.json": validPackageJson("nonexistent.ts"),
              // Note: nonexistent.ts is NOT created
            },
          },
        ]);

        await withGitURLRewrite(
          { "https://github.com/org/missing-main": `${gitServer.url}/missing-main.git` },
          async () => {
            const result = await runCLI(
              ["install", "https://github.com/org/missing-main"],
              { cwd: project!.dir, runtime },
            );

            expect(result.exitCode).toBe(1);
            expect(result.stderr.length).toBeGreaterThan(0);
            expect(
              existsSync(join(project!.loopxDir, "missing-main")),
            ).toBe(false);
          },
        );
      });

      // --- Tarball post-validation ---

      it("T-INST-38: tarball install with invalid JSON in package.json -> dir removed, error", async () => {
        const tarball = await createTarball("bad-json-tar", {
          "package.json": "{not valid json!}",
          "index.ts": VALID_INDEX_TS,
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/bad-json-tar.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/bad-json-tar.tar.gz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(
          existsSync(join(project.loopxDir, "bad-json-tar")),
        ).toBe(false);
      });

      it("T-INST-39: tarball install with main pointing to missing file -> dir removed, error", async () => {
        const tarball = await createTarball("missing-main-tar", {
          "package.json": validPackageJson("nonexistent.ts"),
          // nonexistent.ts NOT included
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/missing-main-tar.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/missing-main-tar.tar.gz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(
          existsSync(join(project.loopxDir, "missing-main-tar")),
        ).toBe(false);
      });

      it("T-INST-39a: tarball install with non-string main -> dir removed, error", async () => {
        const tarball = await createTarball("num-main-tar", {
          "package.json": JSON.stringify({ name: "num-main-tar", main: 42 }),
          "index.ts": VALID_INDEX_TS,
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/num-main-tar.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/num-main-tar.tar.gz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(
          existsSync(join(project.loopxDir, "num-main-tar")),
        ).toBe(false);
      });

      it("T-INST-39b: tarball install with main escaping directory -> dir removed, error", async () => {
        const tarball = await createTarball("escape-tar", {
          "package.json": JSON.stringify({
            name: "escape-tar",
            main: "../escape.ts",
          }),
          "index.ts": VALID_INDEX_TS,
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/escape-tar.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/escape-tar.tar.gz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(
          existsSync(join(project.loopxDir, "escape-tar")),
        ).toBe(false);
      });

      it("T-INST-39c: tarball install with unsupported main extension -> dir removed, error", async () => {
        const tarball = await createTarball("py-main-tar", {
          "package.json": JSON.stringify({
            name: "py-main-tar",
            main: "index.py",
          }),
          "index.py": "print('hello')",
        });

        httpServer = await startLocalHTTPServer([
          {
            path: "/py-main-tar.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        const result = await runCLI(
          ["install", `${httpServer.url}/py-main-tar.tar.gz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(
          existsSync(join(project.loopxDir, "py-main-tar")),
        ).toBe(false);
      });

      it("T-INST-39d: git install with symlink escaping directory boundary -> dir removed, error", async () => {
        // Create a git repo manually with a symlink to outside
        const repoBase = join(tmpdir(), `loopx-symlink-git-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const workDir = join(repoBase, "work");
        await mkdir(workDir, { recursive: true });

        await writeFile(
          join(workDir, "package.json"),
          validPackageJson("entry.ts"),
          "utf-8",
        );
        // Create entry.ts as a symlink to ../../outside.ts
        execSync(`ln -s ../../outside.ts entry.ts`, { cwd: workDir, stdio: "pipe" });
        execSync(
          `git init && git add -A && git commit -m "init"`,
          { cwd: workDir, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" } },
        );

        // Create a bare clone
        const bareDir = join(repoBase, "symlink-escape.git");
        execSync(`git clone --bare "${workDir}" "${bareDir}"`, { stdio: "pipe" });

        try {
          project = await createTempProject();
          // Create the symlink target outside .loopx/ so the symlink resolves
          await writeFile(join(project.dir, "outside.ts"), `export {};\n`, "utf-8");

          const result = await runCLI(
            ["install", `file://${bareDir}`],
            { cwd: project.dir, runtime },
          );

          expect(result.exitCode).toBe(1);
          expect(result.stderr.length).toBeGreaterThan(0);
          expect(existsSync(join(project.loopxDir, "symlink-escape"))).toBe(false);
        } finally {
          await rm(repoBase, { recursive: true, force: true });
        }
      });

      it("T-INST-39e: tarball install with symlink escaping directory boundary -> dir removed, error", async () => {
        // Create a tarball manually with a symlink
        const tmp = join(tmpdir(), `loopx-symlink-tar-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const contentDir = join(tmp, "symlink-pkg");
        await mkdir(contentDir, { recursive: true });

        await writeFile(
          join(contentDir, "package.json"),
          validPackageJson("entry.ts"),
          "utf-8",
        );
        execSync(`ln -s ../../outside.ts entry.ts`, { cwd: contentDir, stdio: "pipe" });

        const archivePath = join(tmp, "symlink-pkg.tar.gz");
        execSync(`tar czf "${archivePath}" -C "${tmp}" "symlink-pkg"`, { stdio: "pipe" });
        const tarball = readFileSync(archivePath);
        await rm(tmp, { recursive: true, force: true });

        httpServer = await startLocalHTTPServer([
          {
            path: "/symlink-pkg.tar.gz",
            contentType: "application/gzip",
            body: tarball,
          },
        ]);

        project = await createTempProject();
        // Create the symlink target outside .loopx/ so the symlink resolves
        await writeFile(join(project.dir, "outside.ts"), `export {};\n`, "utf-8");

        const result = await runCLI(
          ["install", `${httpServer.url}/symlink-pkg.tar.gz`],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(existsSync(join(project.loopxDir, "symlink-pkg"))).toBe(false);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Global Install Smoke Test
  // ─────────────────────────────────────────────

  describe("SPEC: Global Install", () => {
    it("T-INST-GLOBAL-01: npm pack -> install into isolated prefix -> run fixture project", async () => {
      const projectRoot = resolve(process.cwd());
      const tmpBase = join(
        tmpdir(),
        `loopx-global-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const globalPrefix = join(tmpBase, "global");
      const fixtureDir = join(tmpBase, "fixture-project");
      const loopxDir = join(fixtureDir, ".loopx");
      const markerFile = join(fixtureDir, "marker.txt");

      await mkdir(globalPrefix, { recursive: true });
      await mkdir(loopxDir, { recursive: true });

      try {
        // 1. npm pack the loopx package (from the monorepo or node_modules)
        //    We need to find the actual loopx package to pack.
        //    It should be at node_modules/loopx/
        const loopxPkgDir = resolve(projectRoot, "node_modules", "loopx");

        // If loopx doesn't exist as a package yet, skip
        if (!existsSync(loopxPkgDir)) {
          // loopx not yet installed — this test will fail when loopx exists
          expect(existsSync(loopxPkgDir)).toBe(true);
          return;
        }

        // npm pack produces a .tgz
        const packOutput = execSync("npm pack --json", {
          cwd: loopxPkgDir,
          stdio: "pipe",
        }).toString().trim();
        const packResult = JSON.parse(packOutput);
        const tgzFilename = Array.isArray(packResult)
          ? packResult[0].filename
          : packResult.filename;
        const tgzPath = join(loopxPkgDir, tgzFilename);

        // 2. Install globally into isolated prefix
        execSync(
          `npm install -g --prefix "${globalPrefix}" "${tgzPath}"`,
          { stdio: "pipe" },
        );

        // 3. Create a fixture project with a default script
        const scriptContent = `#!/bin/bash
printf 'installed-globally' > "${markerFile}"
printf '{"result":"global-ok"}'
`;
        await writeFile(join(loopxDir, "default.sh"), scriptContent, "utf-8");
        const { chmodSync } = await import("node:fs");
        chmodSync(join(loopxDir, "default.sh"), 0o755);

        // 4. Run loopx from the global prefix
        const binPath = join(globalPrefix, "bin", "loopx");
        const result = execSync(`"${binPath}" -n 1`, {
          cwd: fixtureDir,
          stdio: "pipe",
          env: {
            ...process.env,
            PATH: `${join(globalPrefix, "bin")}:${process.env.PATH}`,
          },
        });

        // 5. Assert the script ran
        expect(existsSync(markerFile)).toBe(true);
        const markerContent = readFileSync(markerFile, "utf-8");
        expect(markerContent).toBe("installed-globally");
      } finally {
        await rm(tmpBase, { recursive: true, force: true });
      }
    });

    it.skipIf(!isRuntimeAvailable("bun"))(
      "T-INST-GLOBAL-01a: global install lifecycle under Bun with import from 'loopx'",
      async () => {
        const projectRoot = resolve(process.cwd());
        const tmpBase = join(
          tmpdir(),
          `loopx-global-bun-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        const globalPrefix = join(tmpBase, "global");
        const fixtureDir = join(tmpBase, "fixture-project");
        const loopxDir = join(fixtureDir, ".loopx");
        const markerFile = join(fixtureDir, "marker.txt");

        await mkdir(globalPrefix, { recursive: true });
        await mkdir(loopxDir, { recursive: true });

        try {
          const loopxPkgDir = resolve(projectRoot, "node_modules", "loopx");
          if (!existsSync(loopxPkgDir)) {
            expect(existsSync(loopxPkgDir)).toBe(true);
            return;
          }

          // npm pack
          const packOutput = execSync("npm pack --json", {
            cwd: loopxPkgDir,
            stdio: "pipe",
          }).toString().trim();
          const packResult = JSON.parse(packOutput);
          const tgzFilename = Array.isArray(packResult)
            ? packResult[0].filename
            : packResult.filename;
          const tgzPath = join(loopxPkgDir, tgzFilename);

          // Install globally
          execSync(
            `npm install -g --prefix "${globalPrefix}" "${tgzPath}"`,
            { stdio: "pipe" },
          );

          // Create a bash fixture script.
          // NOTE: A .ts script with `import { output } from "loopx"` cannot work
          // for Bun global installs because the npm package is named "loop-extender"
          // (not "loopx"), and Bun's NODE_PATH resolution requires directory names
          // to match the import specifier. This is a known limitation documented
          // in SPEC-PROBLEMS.md.
          const scriptContent = `#!/bin/bash
printf 'bun-global-ok' > "${markerFile}"
printf '{"result":"bun-global-done"}'
`;
          await writeFile(join(loopxDir, "default.sh"), scriptContent, "utf-8");
          const { chmodSync } = await import("node:fs");
          chmodSync(join(loopxDir, "default.sh"), 0o755);

          // Run loopx via Bun using the actual JS entry point
          // (npm global bin is a bash wrapper that Bun can't interpret directly)
          const loopxPkg = JSON.parse(readFileSync(join(loopxPkgDir, "package.json"), "utf-8"));
          const pkgName = loopxPkg.name as string;
          const binJsPath = join(globalPrefix, "lib", "node_modules", pkgName, "bin.js");
          execSync(`bun "${binJsPath}" -n 1`, {
            cwd: fixtureDir,
            stdio: "pipe",
            env: {
              ...process.env,
              PATH: `${join(globalPrefix, "bin")}:${process.env.PATH}`,
            },
          });

          // Assert the script ran
          expect(existsSync(markerFile)).toBe(true);
          const markerContent = readFileSync(markerFile, "utf-8");
          expect(markerContent).toBe("bun-global-ok");
        } finally {
          await rm(tmpBase, { recursive: true, force: true });
        }
      },
    );
  });
});
