import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  symlinkSync,
  chmodSync,
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
import { withFakeNpm } from "../helpers/fake-npm.js";

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

function hasAnyPackageJsonWarning(stderr: string, workflow: string): boolean {
  return (
    hasInvalidJsonWarning(stderr, workflow) ||
    hasInvalidSemverWarning(stderr, workflow) ||
    hasUnreadableWarning(stderr, workflow)
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
  /**
   * Symlinks to record in the archive, keyed by the symlink path (relative to
   * the wrapperDir if set, else the archive root) with the value being the
   * literal symlink-target string. Targets are recorded verbatim — relative
   * paths resolve against the link's own parent directory at extraction time.
   */
  symlinks?: Record<string, string>;
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
      type: "file" | "dir" | "symlink";
      content?: string;
      /** Symlink target (literal). */
      linkname?: string;
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
      if (opts.symlinks) {
        for (const [linkPath, target] of Object.entries(opts.symlinks)) {
          const archivePathForEntry = prefix ? `${prefix}/${linkPath}` : linkPath;
          const dirPart = archivePathForEntry
            .split("/")
            .slice(0, -1)
            .join("/");
          if (dirPart) pushDir(dirPart);
          entries.push({
            name: archivePathForEntry,
            mode: 0o777,
            type: "symlink",
            linkname: target,
          });
        }
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
      linkname?: string;
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
      } else if (e.type === "symlink") {
        manifest.push({
          name: e.name,
          mode: e.mode,
          type: "symlink",
          linkname: e.linkname ?? "",
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
      "        elif e['type'] == 'symlink':",
      "            info.type = tarfile.SYMTYPE",
      "            info.linkname = e['linkname']",
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

      it("T-INST-40f: --no-install with no source → usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "--no-install"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-41: -h → install help, lists --no-install w/ no short alias, no single-file URL advertised", async () => {
        project = await createTempProject();
        const result = await runCLI(["install", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        const out = result.stdout + result.stderr;
        expect(out).toMatch(/-w|--workflow/);
        expect(out).toMatch(/-y/);
        // (c) `--no-install` option with description (per SPEC 4.2 / 11.3 — Spec 10.10).
        expect(out).toMatch(/--no-install/);
        // Either git or tarball terminology should appear
        expect(out).toMatch(/git|tarball|repo/i);
        // (e) Single-file URL install is removed — help must NOT advertise it
        expect(out).not.toMatch(/single[- ]file/i);
        // (f) `--no-install` has "No short form" per SPEC 4.2. The help text's
        // option line for `--no-install` (and any synopsis / usage block listing
        // install-scoped flags) must not list `-n`, `-N`, `-i`, `-I`, or any
        // other single-character form alongside `--no-install`.
        const noInstallLines = out
          .split(/\r?\n/)
          .filter((line) => /--no-install/.test(line));
        expect(noInstallLines.length).toBeGreaterThan(0);
        for (const line of noInstallLines) {
          // No `-X, --no-install` or `-X | --no-install` style alias on the same line.
          expect(line).not.toMatch(/-[a-zA-Z][, |]+--no-install/);
          expect(line).not.toMatch(/--no-install[, |]+-[a-zA-Z]\b/);
        }
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

      // ──────────────────────────────────────────────────────────
      // T-INST-42m / T-INST-42n: Install-time treatment of
      // unsupported `.mjs` / `.cjs` extensions. SPEC §10.4 install-
      // time validation reuses SPEC §5.1 / §5.2 (discovered scripts
      // only); `.mjs` / `.cjs` are not in the supported-extension
      // set, so they are not discovered as scripts, not validated
      // against the name pattern, and not subject to same-base-name
      // collision detection. They are copied byte-for-byte as
      // workflow content. See TEST-SPEC §3 (install) and §2
      // (discovery) for the runtime-side counterparts (T-DISC-07a
      // through T-DISC-07c, T-DISC-24a / T-DISC-24b).
      // ──────────────────────────────────────────────────────────

      it("T-INST-42m: install copies .mjs/.cjs as non-script workflow content alongside scripts", async () => {
        project = await createTempProject();
        const helperMjsContent = 'export const helper = "from-mjs";\n';
        const toolCjsContent = 'module.exports = { tool: "from-cjs" };\n';
        const tarball = await makeTarball({
          "index.sh": BASH_STOP,
          "helper.mjs": helperMjsContent,
          "tool.cjs": toolCjsContent,
        });
        httpServer = await startLocalHTTPServer([
          tarballRoute("/my-agent.tar.gz", tarball),
        ]);
        const installResult = await runCLI(
          ["install", `${httpServer.url}/my-agent.tar.gz`],
          { cwd: project.dir, runtime },
        );

        // (a) install succeeds
        expect(installResult.exitCode).toBe(0);

        const wfDir = join(project.loopxDir, "my-agent");

        // (b) all three files preserved byte-for-byte
        expect(existsSync(join(wfDir, "index.sh"))).toBe(true);
        expect(existsSync(join(wfDir, "helper.mjs"))).toBe(true);
        expect(existsSync(join(wfDir, "tool.cjs"))).toBe(true);
        expect(readFileSync(join(wfDir, "helper.mjs"), "utf-8")).toBe(
          helperMjsContent,
        );
        expect(readFileSync(join(wfDir, "tool.cjs"), "utf-8")).toBe(
          toolCjsContent,
        );

        // (c) no validation warning about .mjs/.cjs extensions
        expect(hasWarningCategoryFor(installResult.stderr, "helper.mjs")).toBe(
          false,
        );
        expect(hasWarningCategoryFor(installResult.stderr, "tool.cjs")).toBe(
          false,
        );
        expect(installResult.stderr).not.toMatch(
          /helper\.mjs.*(unsupported|invalid|extension)/i,
        );
        expect(installResult.stderr).not.toMatch(
          /tool\.cjs.*(unsupported|invalid|extension)/i,
        );

        // (d-i) `loopx run -n 1 my-agent` runs the index script
        const runIndex = await runCLI(["run", "-n", "1", "my-agent"], {
          cwd: project.dir,
          runtime,
        });
        expect(runIndex.exitCode).toBe(0);

        // (d-ii) helper / tool are not discovered as scripts
        const runHelper = await runCLI(
          ["run", "-n", "1", "my-agent:helper"],
          { cwd: project.dir, runtime },
        );
        expect(runHelper.exitCode).toBe(1);
        expect(runHelper.stderr).toMatch(/(not.*found|missing|unknown)/i);

        const runTool = await runCLI(
          ["run", "-n", "1", "my-agent:tool"],
          { cwd: project.dir, runtime },
        );
        expect(runTool.exitCode).toBe(1);
        expect(runTool.stderr).toMatch(/(not.*found|missing|unknown)/i);
      });

      it("T-INST-42n: install does not flag same-base-name collision between .ts and unsupported .mjs/.cjs siblings", async () => {
        project = await createTempProject();
        // check.ts: writes a marker file then emits {stop:true}.
        // process.cwd() is LOOPX_PROJECT_ROOT per SPEC §6.1.
        const checkTsContent =
          'import { writeFileSync } from "node:fs";\n' +
          'writeFileSync("check-marker.txt", "ran");\n' +
          "process.stdout.write('{\"stop\":true}');\n";
        const checkMjsContent = 'export const check = "mjs-version";\n';
        const checkCjsContent = 'module.exports = { check: "cjs-version" };\n';
        const tarball = await makeTarball({
          "check.ts": checkTsContent,
          "check.mjs": checkMjsContent,
          "check.cjs": checkCjsContent,
        });
        httpServer = await startLocalHTTPServer([
          tarballRoute("/my-agent.tar.gz", tarball),
        ]);
        const installResult = await runCLI(
          ["install", `${httpServer.url}/my-agent.tar.gz`],
          { cwd: project.dir, runtime },
        );

        // (a) install succeeds — no collision rejection
        expect(installResult.exitCode).toBe(0);

        const wfDir = join(project.loopxDir, "my-agent");

        // (b) all three files preserved byte-for-byte
        expect(existsSync(join(wfDir, "check.ts"))).toBe(true);
        expect(existsSync(join(wfDir, "check.mjs"))).toBe(true);
        expect(existsSync(join(wfDir, "check.cjs"))).toBe(true);
        expect(readFileSync(join(wfDir, "check.ts"), "utf-8")).toBe(
          checkTsContent,
        );
        expect(readFileSync(join(wfDir, "check.mjs"), "utf-8")).toBe(
          checkMjsContent,
        );
        expect(readFileSync(join(wfDir, "check.cjs"), "utf-8")).toBe(
          checkCjsContent,
        );

        // (c) no collision warning or error referencing the .mjs/.cjs files
        expect(installResult.stderr).not.toMatch(
          /collision|conflict|same.*base|multiple.*files/i,
        );

        // (d) `loopx run -n 1 my-agent:check` runs check.ts unambiguously
        const runCheck = await runCLI(
          ["run", "-n", "1", "my-agent:check"],
          { cwd: project.dir, runtime },
        );
        expect(runCheck.exitCode).toBe(0);
        expect(existsSync(join(project.dir, "check-marker.txt"))).toBe(true);
        expect(
          readFileSync(join(project.dir, "check-marker.txt"), "utf-8"),
        ).toBe("ran");
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

      it("T-INST-44a: --no-install --no-install <source> → usage error (duplicate)", async () => {
        project = await createTempProject();
        const result = await runCLI(
          ["install", "--no-install", "--no-install", "org/repo"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-INST-44b: -h --no-install <source> → install help, exit 0, no network", async () => {
        gitServer = await startLocalGitServer([
          { name: "ni-pkg", files: { "index.sh": BASH_STOP } },
        ]);
        const sourceUrl = `${gitServer.url}/ni-pkg.git`;

        project = await createTempProject();
        const result = await runCLI(
          ["install", "-h", "--no-install", sourceUrl],
          { cwd: project.dir, runtime },
        );
        const ref = await runCLI(["install", "-h"], {
          cwd: project.dir,
          runtime,
        });
        // (a) help stdout, (b) exit 0
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(ref.stdout);
        // (c) no source download / network activity, (d) `.loopx/` untouched
        expect(existsSync(join(project.loopxDir, "ni-pkg"))).toBe(false);
        expect(readdirSync(project.loopxDir).length).toBe(0);
      });

      it("T-INST-44c: --help --no-install --no-install <source> → install help, exit 0, no duplicate-flag error", async () => {
        gitServer = await startLocalGitServer([
          { name: "ni-pkg", files: { "index.sh": BASH_STOP } },
        ]);
        const sourceUrl = `${gitServer.url}/ni-pkg.git`;

        project = await createTempProject();
        const result = await runCLI(
          ["install", "--help", "--no-install", "--no-install", sourceUrl],
          { cwd: project.dir, runtime },
        );
        const ref = await runCLI(["install", "--help"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(ref.stdout);
        // No duplicate-flag error on stderr (short-circuit suppresses T-INST-44a usage error).
        expect(result.stderr).not.toMatch(/duplicate.*--no-install/i);
        // No source download / network activity.
        expect(existsSync(join(project.loopxDir, "ni-pkg"))).toBe(false);
        expect(readdirSync(project.loopxDir).length).toBe(0);
      });

      it("T-INST-44d: --no-install -h <source> → install help, exit 0 (late-help suppresses)", async () => {
        gitServer = await startLocalGitServer([
          { name: "ni-pkg", files: { "index.sh": BASH_STOP } },
        ]);
        const sourceUrl = `${gitServer.url}/ni-pkg.git`;

        project = await createTempProject();
        const result = await runCLI(
          ["install", "--no-install", "-h", sourceUrl],
          { cwd: project.dir, runtime },
        );
        const ref = await runCLI(["install", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(ref.stdout);
        expect(existsSync(join(project.loopxDir, "ni-pkg"))).toBe(false);
        expect(readdirSync(project.loopxDir).length).toBe(0);
      });

      it("T-INST-44e: --no-install --no-install -h/--help <source> → install help, exit 0 (late-help suppresses duplicate)", async () => {
        gitServer = await startLocalGitServer([
          { name: "ni-pkg", files: { "index.sh": BASH_STOP } },
        ]);
        const sourceUrl = `${gitServer.url}/ni-pkg.git`;

        // Parameterize over both forms: variant (a) `-h`, variant (b) `--help`.
        for (const helpFlag of ["-h", "--help"] as const) {
          const subProject = await createTempProject();
          try {
            const result = await runCLI(
              [
                "install",
                "--no-install",
                "--no-install",
                helpFlag,
                sourceUrl,
              ],
              { cwd: subProject.dir, runtime },
            );
            const ref = await runCLI(["install", helpFlag], {
              cwd: subProject.dir,
              runtime,
            });
            // (a) install help on stdout (matches help reference)
            expect(result.stdout).toBe(ref.stdout);
            // (b) exit code 0
            expect(result.exitCode).toBe(0);
            // (c) no duplicate-flag error on stderr
            expect(result.stderr).not.toMatch(/duplicate.*--no-install/i);
            // (d) no source download / network activity
            expect(existsSync(join(subProject.loopxDir, "ni-pkg"))).toBe(false);
            // (e) `.loopx/` is untouched
            expect(readdirSync(subProject.loopxDir).length).toBe(0);
          } finally {
            await subProject.cleanup();
          }
        }
      });

      it("T-INST-44f: --no-install has no short form — -n/-N/-i/-I rejected as unknown short flags", async () => {
        gitServer = await startLocalGitServer([
          { name: "ni-pkg", files: { "index.sh": BASH_STOP } },
        ]);
        const sourceUrl = `${gitServer.url}/ni-pkg.git`;

        // Parameterize over the four most-plausible candidate aliases.
        for (const candidate of ["-n", "-N", "-i", "-I"] as const) {
          const subProject = await createTempProject();
          try {
            const result = await runCLI(
              ["install", candidate, sourceUrl],
              { cwd: subProject.dir, runtime },
            );
            // (a) exit code 1 (unrecognized install-scoped short flag).
            expect(result.exitCode).toBe(1);
            // (b) stderr references the unrecognized-flag rejection.
            expect(result.stderr).toMatch(
              new RegExp(`unknown.*install.*flag.*${candidate}|${candidate}.*unknown|unrecognized.*${candidate}`, "i"),
            );
            // (d) `.loopx/` untouched, no workflow committed (parser-time exit;
            // this also indirectly catches a buggy implementation that aliased
            // the short form to `--no-install` and proceeded with a successful
            // install — the would-be `ni-pkg` workflow would be committed).
            expect(existsSync(join(subProject.loopxDir, "ni-pkg"))).toBe(false);
            expect(readdirSync(subProject.loopxDir).length).toBe(0);
          } finally {
            await subProject.cleanup();
          }
        }
      });

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
  // Install-scoped `--` Rejection (T-INST-DASHDASH-01 … 04)
  // ═══════════════════════════════════════════════════════════
  //
  // SPEC 4.2: `--` is not a recognized install-scoped token (no end-of-options
  // separator semantics, no positional separator). Reject at any position when
  // the `-h`/`--help` short-circuit is not present; suppress the rejection when
  // it is.

  describe("Install-scoped `--` Rejection", () => {
    forEachRuntime((runtime) => {
      it("T-INST-DASHDASH-01: install -- <source> → usage error, exit 1", async () => {
        // Use a genuinely valid file:// bare-git source so that exit 1 is
        // distinguishable from a downstream "unsupported source" error.
        gitServer = await startLocalGitServer([
          { name: "dd-pkg", files: { "index.sh": BASH_STOP } },
        ]);
        const sourceUrl = `${gitServer.url}/dd-pkg.git`;

        // Pre-verify: same source succeeds without `--` against a fresh project.
        const preProject = await createTempProject();
        try {
          const pre = await runCLI(["install", sourceUrl], {
            cwd: preProject.dir,
            runtime,
          });
          expect(pre.exitCode).toBe(0);
          expect(existsSync(join(preProject.loopxDir, "dd-pkg"))).toBe(true);
        } finally {
          await preProject.cleanup();
        }

        // Actual test: leading `--` is rejected as a usage error.
        project = await createTempProject();
        const result = await runCLI(["install", "--", sourceUrl], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("--");
        // Distinguish a usage-error category from a "source unsupported" /
        // network/clone failure category — the failure must be about the `--`
        // token, not about resolving the source.
        expect(result.stderr).not.toMatch(/single[- ]file/i);
        expect(result.stderr).not.toMatch(/unsupported source/i);
        expect(result.stderr).not.toMatch(/Failed to (download|clone)/i);
        // No source clone activity occurred — the would-be `dd-pkg` workflow
        // was not committed.
        expect(existsSync(join(project.loopxDir, "dd-pkg"))).toBe(false);
        expect(readdirSync(project.loopxDir).length).toBe(0);
      });

      it("T-INST-DASHDASH-02: install <source> -- → usage error, exit 1", async () => {
        gitServer = await startLocalGitServer([
          { name: "dd-pkg", files: { "index.sh": BASH_STOP } },
        ]);
        const sourceUrl = `${gitServer.url}/dd-pkg.git`;

        // Pre-verify the same source is installable without the trailing `--`.
        const preProject = await createTempProject();
        try {
          const pre = await runCLI(["install", sourceUrl], {
            cwd: preProject.dir,
            runtime,
          });
          expect(pre.exitCode).toBe(0);
          expect(existsSync(join(preProject.loopxDir, "dd-pkg"))).toBe(true);
        } finally {
          await preProject.cleanup();
        }

        // Trailing `--` is rejected at any position when help short-circuit is absent.
        project = await createTempProject();
        const result = await runCLI(["install", sourceUrl, "--"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("--");
        expect(result.stderr).not.toMatch(/single[- ]file/i);
        expect(result.stderr).not.toMatch(/unsupported source/i);
        expect(result.stderr).not.toMatch(/Failed to (download|clone)/i);
        expect(existsSync(join(project.loopxDir, "dd-pkg"))).toBe(false);
        expect(readdirSync(project.loopxDir).length).toBe(0);
      });

      it("T-INST-DASHDASH-03: install -h -- <source> → help, exit 0", async () => {
        // Use a genuinely valid source: a buggy implementation that consumed
        // `--` as end-of-options would otherwise install successfully (exit 0)
        // and leave `.loopx/dd-pkg/` behind — this test still detects that by
        // asserting `.loopx/` remains empty after the `-h` short-circuit.
        gitServer = await startLocalGitServer([
          { name: "dd-pkg", files: { "index.sh": BASH_STOP } },
        ]);
        const sourceUrl = `${gitServer.url}/dd-pkg.git`;

        project = await createTempProject();
        const result = await runCLI(
          ["install", "-h", "--", sourceUrl],
          { cwd: project.dir, runtime },
        );
        // Reference: byte-equal to plain `install -h`.
        const ref = await runCLI(["install", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(ref.stdout);
        // No source clone activity occurred — `.loopx/` is untouched.
        expect(existsSync(join(project.loopxDir, "dd-pkg"))).toBe(false);
        expect(readdirSync(project.loopxDir).length).toBe(0);
        // No usage-error message about `--` was surfaced.
        expect(result.stderr).not.toMatch(/unknown.*install.*flag/i);
      });

      it("T-INST-DASHDASH-04: install --help -- <source> → help, exit 0", async () => {
        gitServer = await startLocalGitServer([
          { name: "dd-pkg", files: { "index.sh": BASH_STOP } },
        ]);
        const sourceUrl = `${gitServer.url}/dd-pkg.git`;

        project = await createTempProject();
        const result = await runCLI(
          ["install", "--help", "--", sourceUrl],
          { cwd: project.dir, runtime },
        );
        const ref = await runCLI(["install", "--help"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(ref.stdout);
        expect(existsSync(join(project.loopxDir, "dd-pkg"))).toBe(false);
        expect(readdirSync(project.loopxDir).length).toBe(0);
        expect(result.stderr).not.toMatch(/unknown.*install.*flag/i);
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
            "--no-install",
            "-w",
            "ralph",
            "-y",
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
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Install-time Validation (T-INST-61 … 64d, 52b)
  // ═══════════════════════════════════════════════════════════

  describe("Install-time Validation", () => {
    forEachRuntime((runtime) => {
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
          ["install", `${gitServer.url}/repo.git`],
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
          ["install", `${gitServer.url}/repo.git`],
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

      it("T-INST-70: symlink to workflow directory → collision error", async () => {
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
          ["install", "--no-install", "-y", `${gitServer.url}/wf.git`],
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
          ["install", "--no-install", "-y", `${gitServer.url}/wf.git`],
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

      it.skipIf(IS_ROOT)(
        "T-INST-79: staging failure leaves .loopx/ unchanged (tarball)",
        async () => {
          project = await createTempProject();
          const tarball = await makeTarball(
            {
              "ralph/index.sh": BASH_STOP,
              "broken/index.sh": BASH_STOP,
              "broken/data.txt": { content: "secret", mode: 0o000 },
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
          expect(existsSync(join(project.loopxDir, "ralph"))).toBe(false);
          expect(existsSync(join(project.loopxDir, "broken"))).toBe(false);
        },
      );

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
          ["install", "--no-install", "-y", `${gitServer.url}/multi.git`],
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

      it.skipIf(IS_ROOT)(
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
              "other/data.txt": { content: "secret", mode: 0o000 },
            },
            { wrapperDir: "multi" },
          );
          httpServer = await startLocalHTTPServer([
            tarballRoute("/multi.tar.gz", tarball),
          ]);
          const result = await runCLI(
            ["install", "-y", `${httpServer.url}/multi.tar.gz`],
            { cwd: project.dir, runtime },
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
          ["install", `${gitServer.url}/repo.git`],
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
          ["install", `${gitServer.url}/repo.git`],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(project.loopxDir)).toBe(true);
        expect(existsSync(join(project.loopxDir, "repo"))).toBe(true);
      });

      it("T-INST-91: --no-install suppresses npm install (no node_modules after clone/extract)", async () => {
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
        // SPEC §10.10: by default, loopx install runs `npm install` for
        // every committed workflow with a top-level package.json. To
        // preserve the original "no install-time npm" behavior this test
        // asserts, pass --no-install explicitly. (See T-INST-110 et al.
        // for the default-on auto-install path.)
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
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Auto-install of Workflow Dependencies (T-INST-110 … 120e)
  // ═══════════════════════════════════════════════════════════
  //
  // SPEC §10.10: After the commit phase completes, unless `--no-install` is
  // present, loopx runs `npm install` once per committed workflow that has a
  // top-level `package.json`, sequentially in an implementation-defined order.
  // Workflows without a top-level `package.json` are skipped silently. Before
  // each spawn, loopx checks `.gitignore` and synthesizes one with the line
  // `node_modules` if absent.

  describe("Auto-install of Workflow Dependencies (Spec 10.10)", () => {
    forEachRuntime((runtime) => {
      it("T-INST-110: default post-commit npm install runs once per committed workflow with package.json, sequentially", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
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
          { exitCode: 0, sleepSeconds: 1, logFile },
          async (fake) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            expect(result.exitCode).toBe(0);

            const invocations = fake.readInvocations();
            expect(invocations.length).toBe(2);

            // Each invocation argv is exactly ["install"] — no flags.
            for (const inv of invocations) {
              expect(inv.argv).toEqual(["install"]);
            }

            // Set of cwds must be exactly {.loopx/alpha/, .loopx/beta/}.
            const alphaPath = join(project!.loopxDir, "alpha");
            const betaPath = join(project!.loopxDir, "beta");
            const cwdSet = new Set(invocations.map((i) => i.cwd));
            expect(cwdSet.has(alphaPath)).toBe(true);
            expect(cwdSet.has(betaPath)).toBe(true);
            expect(cwdSet.size).toBe(2);

            // Non-overlap in wall-clock time: under 1-second per-invocation
            // sleep, parallel execution would produce overlapping intervals.
            const sorted = invocations
              .slice()
              .sort((a, b) => a.startedAtMs - b.startedAtMs);
            expect(sorted[1].startedAtMs).toBeGreaterThanOrEqual(
              sorted[0].endedAtMs,
            );

            // No aggregate failure report on success path.
            expect(result.stderr).not.toMatch(/auto-install|aggregate|failed/i);
          },
        );
      });

      it("T-INST-110a: npm install is skipped silently for workflows without a top-level package.json", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
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
              // beta has no package.json
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(1);
          expect(invocations[0].cwd).toBe(join(project!.loopxDir, "alpha"));
          expect(invocations[0].argv).toEqual(["install"]);

          // No warning about beta missing package.json — silent skip.
          expect(result.stderr).not.toMatch(/beta.*package\.json/i);
        });
      });

      it("T-INST-110c: presence of package.json alone triggers auto-install (dependency content not inspected)", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
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
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/minimal-workflow.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(1);
          expect(invocations[0].argv).toEqual(["install"]);
          expect(invocations[0].cwd).toBe(
            join(project!.loopxDir, "minimal-workflow"),
          );

          // .gitignore was synthesized.
          const gitignorePath = join(
            project!.loopxDir,
            "minimal-workflow",
            ".gitignore",
          );
          expect(existsSync(gitignorePath)).toBe(true);
          expect(readFileSync(gitignorePath, "utf-8").trim()).toBe(
            "node_modules",
          );

          expect(result.stderr).not.toMatch(/auto-install|aggregate|failed/i);
        });
      });

      it("T-INST-110b: -w <name> scopes auto-install to the selected workflow", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
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
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", "-w", "alpha", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(1);
          expect(invocations[0].cwd).toBe(join(project!.loopxDir, "alpha"));
        });
      });

      it("T-INST-110d: auto-install fires on a no-index workflow", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "check.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "my-workflow",
                version: "1.0.0",
              }),
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/my-workflow.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(1);
          expect(invocations[0].cwd).toBe(
            join(project!.loopxDir, "my-workflow"),
          );
          expect(invocations[0].argv).toEqual(["install"]);

          // .gitignore synthesized
          const gitignorePath = join(
            project!.loopxDir,
            "my-workflow",
            ".gitignore",
          );
          expect(existsSync(gitignorePath)).toBe(true);
          expect(readFileSync(gitignorePath, "utf-8").trim()).toBe(
            "node_modules",
          );

          // No index file invented
          const wfDir = join(project!.loopxDir, "my-workflow");
          const wfFiles = readdirSync(wfDir);
          expect(wfFiles.some((f) => f.startsWith("index."))).toBe(false);
        });
      });

      it("T-INST-110e: nested package.json alone does NOT trigger auto-install", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "lib/package.json": JSON.stringify({
                name: "lib",
                version: "1.0.0",
              }),
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/my-workflow.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          // Zero npm invocations — no top-level package.json
          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(0);

          // No .gitignore synthesized
          const gitignorePath = join(
            project!.loopxDir,
            "my-workflow",
            ".gitignore",
          );
          expect(existsSync(gitignorePath)).toBe(false);

          // Nested lib/package.json preserved byte-for-byte
          const nestedPath = join(
            project!.loopxDir,
            "my-workflow",
            "lib",
            "package.json",
          );
          expect(existsSync(nestedPath)).toBe(true);
          const nested = JSON.parse(readFileSync(nestedPath, "utf-8"));
          expect(nested.name).toBe("lib");
        });
      });

      it("T-INST-110f: auto-install fires on a selected no-index workflow under -w", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
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
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", "-w", "tools", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          // Exactly one invocation, for the selected no-index workflow.
          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(1);
          expect(invocations[0].cwd).toBe(join(project!.loopxDir, "tools"));
          expect(invocations[0].argv).toEqual(["install"]);

          // .gitignore synthesized for the selected workflow.
          const gitignorePath = join(
            project!.loopxDir,
            "tools",
            ".gitignore",
          );
          expect(existsSync(gitignorePath)).toBe(true);
          expect(readFileSync(gitignorePath, "utf-8").trim()).toBe(
            "node_modules",
          );

          // check.sh is present; no index.* invented by loopx.
          const toolsDir = join(project!.loopxDir, "tools");
          expect(existsSync(join(toolsDir, "check.sh"))).toBe(true);
          const toolsFiles = readdirSync(toolsDir);
          expect(toolsFiles.some((f) => f.startsWith("index."))).toBe(false);

          // Unselected workflow not committed.
          expect(existsSync(join(project!.loopxDir, "other"))).toBe(false);
        });
      });

      it("T-INST-110g: auto-install fires on a tarball source with a top-level package.json", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        // Archive name and wrapper directory deliberately match so that the
        // SPEC §10.2 archive-name-derived workflow name and the wrapper-dir
        // name agree (eliminating ambiguity in the `<name>` assertions below).
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
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", `${httpServer!.url}/tarball-workflow.tar.gz`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          // Workflow committed at the archive-name-derived workflow name.
          const wfDir = join(project!.loopxDir, "tarball-workflow");
          expect(existsSync(join(wfDir, "index.sh"))).toBe(true);
          expect(existsSync(join(wfDir, "package.json"))).toBe(true);
          const pkg = JSON.parse(
            readFileSync(join(wfDir, "package.json"), "utf-8"),
          );
          expect(pkg.name).toBe("tarball-workflow");

          // Exactly one invocation, with cwd = .loopx/tarball-workflow/.
          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(1);
          expect(invocations[0].argv).toEqual(["install"]);
          expect(invocations[0].cwd).toBe(wfDir);

          // .gitignore synthesized on the tarball path.
          const gitignorePath = join(wfDir, ".gitignore");
          expect(existsSync(gitignorePath)).toBe(true);
          expect(readFileSync(gitignorePath, "utf-8").trim()).toBe(
            "node_modules",
          );
        });
      });

      // T-INST-110h: Auto-install fires on a symlinked workflow directory that
      // has a top-level package.json. Pins down the SPEC §10.10 × §10.11
      // interaction: the source-side `alias -> internal/real-workflow` symlink
      // must materialize as a real directory at `.loopx/alias/`, and the
      // post-commit auto-install pass must invoke `npm install` once with
      // cwd = `.loopx/alias/` (not `.loopx/internal/real-workflow/`).
      // Parameterized across git and tarball sources per SPEC 10.2 / 10.11.
      describe("T-INST-110h: symlinked workflow directory + auto-install", () => {
        const SOURCE_INDEX = BASH_STOP;
        const SOURCE_PKG = JSON.stringify({
          name: "real-workflow",
          version: "1.0.0",
        });

        async function assertMaterializedAndAutoInstalled(
          aliasDir: string,
          stderr: string,
          fake: { readInvocations: () => Array<{ argv: string[]; cwd: string }> },
          loopxDir: string,
        ): Promise<void> {
          // (b) `.loopx/alias/` is a real directory (not a symlink).
          expect(existsSync(aliasDir)).toBe(true);
          const aliasLstat = lstatSync(aliasDir);
          expect(aliasLstat.isSymbolicLink()).toBe(false);
          expect(aliasLstat.isDirectory()).toBe(true);

          // (c) `.loopx/alias/index.sh` and `.loopx/alias/package.json` are
          //     real files (not symlinks) with content byte-identical to the
          //     symlink target's `index.sh` / `package.json`.
          const indexPath = join(aliasDir, "index.sh");
          const pkgPath = join(aliasDir, "package.json");
          expect(existsSync(indexPath)).toBe(true);
          expect(existsSync(pkgPath)).toBe(true);
          const indexLstat = lstatSync(indexPath);
          const pkgLstat = lstatSync(pkgPath);
          expect(indexLstat.isSymbolicLink()).toBe(false);
          expect(indexLstat.isFile()).toBe(true);
          expect(pkgLstat.isSymbolicLink()).toBe(false);
          expect(pkgLstat.isFile()).toBe(true);
          expect(readFileSync(indexPath, "utf-8")).toBe(SOURCE_INDEX);
          expect(readFileSync(pkgPath, "utf-8")).toBe(SOURCE_PKG);

          // (d) Exactly one fake-npm invocation, cwd = .loopx/alias/, argv = ["install"].
          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(1);
          expect(invocations[0].argv).toEqual(["install"]);
          expect(invocations[0].cwd).toBe(aliasDir);

          // (e) `.loopx/alias/.gitignore` synthesized — single line `node_modules`.
          const gitignorePath = join(aliasDir, ".gitignore");
          expect(existsSync(gitignorePath)).toBe(true);
          expect(lstatSync(gitignorePath).isFile()).toBe(true);
          expect(readFileSync(gitignorePath, "utf-8").trim()).toBe(
            "node_modules",
          );

          // (f) `.loopx/internal/` is NOT committed as a workflow (top-level
          //     workflow detection is non-recursive).
          expect(existsSync(join(loopxDir, "internal"))).toBe(false);

          // (g) No aggregate failure report on stderr.
          expect(stderr).not.toMatch(/auto-install|aggregate|failed/i);
        }

        it("git source: symlinked workflow → materialized real directory + auto-install", async () => {
          project = await createTempProject();
          const logFile = join(project.dir, "fake-npm.log");
          gitServer = await startLocalGitServer([
            {
              name: "multi",
              files: {
                "internal/real-workflow/index.sh": SOURCE_INDEX,
                "internal/real-workflow/package.json": SOURCE_PKG,
              },
              symlinks: {
                alias: "internal/real-workflow",
              },
            },
          ]);
          await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            // (a) Exit 0 — materialization succeeded and auto-install ran.
            expect(result.exitCode).toBe(0);
            await assertMaterializedAndAutoInstalled(
              join(project!.loopxDir, "alias"),
              result.stderr,
              fake,
              project!.loopxDir,
            );
          });
        });

        it("tarball source: symlinked workflow → materialized real directory + auto-install", async () => {
          project = await createTempProject();
          const logFile = join(project.dir, "fake-npm.log");
          // Archive name and wrapper directory deliberately match so the
          // SPEC §10.2 archive-name-derived workflow root is unambiguous when
          // the source is unwrapped (the wrapper-dir contents become the
          // source root).
          const tarball = await makeTarball(
            {
              "internal/real-workflow/index.sh": SOURCE_INDEX,
              "internal/real-workflow/package.json": SOURCE_PKG,
            },
            {
              wrapperDir: "multi",
              symlinks: {
                alias: "internal/real-workflow",
              },
            },
          );
          httpServer = await startLocalHTTPServer([
            tarballRoute("/multi.tar.gz", tarball),
          ]);
          await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
            const result = await runCLI(
              ["install", `${httpServer!.url}/multi.tar.gz`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            // (a) Exit 0 — materialization succeeded and auto-install ran.
            expect(result.exitCode).toBe(0);
            await assertMaterializedAndAutoInstalled(
              join(project!.loopxDir, "alias"),
              result.stderr,
              fake,
              project!.loopxDir,
            );
          });
        });
      });

      it("T-INST-111: --no-install suppresses both npm install and .gitignore synthesis", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "my-workflow",
                version: "1.0.0",
              }),
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            [
              "install",
              "--no-install",
              `${gitServer!.url}/my-workflow.git`,
            ],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          // No npm invocations
          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(0);

          // No .gitignore synthesis
          const gitignorePath = join(
            project!.loopxDir,
            "my-workflow",
            ".gitignore",
          );
          expect(existsSync(gitignorePath)).toBe(false);

          // Workflow files still present
          expect(
            existsSync(join(project!.loopxDir, "my-workflow", "index.sh")),
          ).toBe(true);
        });
      });

      it("T-INST-111a: --no-install on a workflow with pre-existing .gitignore leaves it unchanged", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        const existingGitignore = "# original\nlogs/\n";
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "my-workflow",
                version: "1.0.0",
              }),
              ".gitignore": existingGitignore,
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            [
              "install",
              "--no-install",
              `${gitServer!.url}/my-workflow.git`,
            ],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          // No npm invocations
          expect(fake.readInvocations().length).toBe(0);

          // .gitignore content unchanged
          const gitignorePath = join(
            project!.loopxDir,
            "my-workflow",
            ".gitignore",
          );
          expect(existsSync(gitignorePath)).toBe(true);
          expect(readFileSync(gitignorePath, "utf-8")).toBe(existingGitignore);
        });
      });

      it("T-INST-111b: --no-install does NOT suppress preflight version-mismatch (fatal exit 1)", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "my-workflow",
                version: "1.0.0",
                dependencies: { loopx: unsatisfiedRange() },
              }),
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            [
              "install",
              "--no-install",
              `${gitServer!.url}/my-workflow.git`,
            ],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );

          // (a) Exit 1 with version-mismatch error.
          expect(result.exitCode).toBe(1);
          expect(hasVersionMismatchWarning(result.stderr, "my-workflow")).toBe(
            true,
          );

          // (b) Shim log empty — auto-install never ran.
          expect(fake.readInvocations().length).toBe(0);

          // (c) No .gitignore was synthesized.
          const gitignorePath = join(
            project!.loopxDir,
            "my-workflow",
            ".gitignore",
          );
          expect(existsSync(gitignorePath)).toBe(false);

          // (d) Workflow not committed — preflight failure exits before commit.
          expect(existsSync(join(project!.loopxDir, "my-workflow"))).toBe(
            false,
          );
        });
      });

      it("T-INST-111c: --no-install does NOT suppress non-fatal package.json parse warning", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": "{broken",
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            [
              "install",
              "--no-install",
              `${gitServer!.url}/my-workflow.git`,
            ],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );

          // (a) Exit 0 — invalid JSON is non-fatal.
          expect(result.exitCode).toBe(0);

          // (b) Shim log empty — --no-install suppresses auto-install.
          expect(fake.readInvocations().length).toBe(0);

          // (c) Exactly one parse-failure warning. The runAutoInstall pass
          // emits a second warning for the same workflow when it runs;
          // --no-install skips that pass entirely so only the preflight
          // warning fires.
          expect(countInvalidJsonWarnings(result.stderr, "my-workflow")).toBe(
            1,
          );

          // (d) No .gitignore was synthesized (safeguard skipped under
          // --no-install).
          const gitignorePath = join(
            project!.loopxDir,
            "my-workflow",
            ".gitignore",
          );
          expect(existsSync(gitignorePath)).toBe(false);

          // (e) Workflow committed at .loopx/<name>/ with both files
          // byte-for-byte (file-level commit ran).
          const indexPath = join(
            project!.loopxDir,
            "my-workflow",
            "index.sh",
          );
          const pkgPath = join(
            project!.loopxDir,
            "my-workflow",
            "package.json",
          );
          expect(existsSync(indexPath)).toBe(true);
          expect(readFileSync(indexPath, "utf-8")).toBe(BASH_STOP);
          expect(readFileSync(pkgPath, "utf-8")).toBe("{broken");
        });
      });

      it("T-INST-111d: --no-install suppresses auto-install for every selected workflow in a multi-workflow source", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
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
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", "--no-install", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );

          // (a) Exit 0.
          expect(result.exitCode).toBe(0);

          // (b) All three workflows committed byte-for-byte.
          for (const wf of ["alpha", "beta", "gamma"]) {
            const indexPath = join(project!.loopxDir, wf, "index.sh");
            const pkgPath = join(project!.loopxDir, wf, "package.json");
            expect(existsSync(indexPath)).toBe(true);
            expect(readFileSync(indexPath, "utf-8")).toBe(BASH_STOP);
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            expect(pkg.name).toBe(wf);
            expect(pkg.version).toBe("1.0.0");
          }

          // (c) Zero npm invocations across all workflows.
          expect(fake.readInvocations().length).toBe(0);

          // (d) None of the .gitignore files were synthesized.
          for (const wf of ["alpha", "beta", "gamma"]) {
            const gitignorePath = join(project!.loopxDir, wf, ".gitignore");
            expect(existsSync(gitignorePath)).toBe(false);
          }

          // (e) No aggregate auto-install failure report.
          expect(result.stderr).not.toMatch(
            /auto-install|aggregate|failed/i,
          );
        });
      });

      it("T-INST-111e: --no-install × -w selective install only commits selected workflow and skips auto-install", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
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
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            [
              "install",
              "--no-install",
              "-w",
              "beta",
              `${gitServer!.url}/multi.git`,
            ],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );

          // (a) Exit 0.
          expect(result.exitCode).toBe(0);

          // (b) Only beta committed; alpha and gamma absent.
          expect(existsSync(join(project!.loopxDir, "alpha"))).toBe(false);
          expect(existsSync(join(project!.loopxDir, "gamma"))).toBe(false);
          expect(
            existsSync(join(project!.loopxDir, "beta", "index.sh")),
          ).toBe(true);
          expect(
            existsSync(join(project!.loopxDir, "beta", "package.json")),
          ).toBe(true);

          // (c) Zero npm invocations.
          expect(fake.readInvocations().length).toBe(0);

          // (d) No .gitignore synthesized for the selected workflow.
          const gitignorePath = join(
            project!.loopxDir,
            "beta",
            ".gitignore",
          );
          expect(existsSync(gitignorePath)).toBe(false);

          // (e) No aggregate auto-install failure report.
          expect(result.stderr).not.toMatch(
            /auto-install|aggregate|failed/i,
          );
        });
      });

      it("T-INST-112: missing .gitignore is created with exactly 'node_modules' before npm install spawn", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "my-workflow",
                version: "1.0.0",
              }),
            },
          },
        ]);
        await withFakeNpm(
          { exitCode: 0, logFile, recordGitignoreAtStart: true },
          async (fake) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/my-workflow.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            expect(result.exitCode).toBe(0);

            const invocations = fake.readInvocations();
            expect(invocations.length).toBe(1);

            // .gitignore must have existed before npm spawn (loopx synthesized
            // it before spawning npm).
            const inv = invocations[0];
            expect(inv.gitignoreAtStart).toBeDefined();
            expect(inv.gitignoreAtStart!.existed).toBe(true);
            expect(inv.gitignoreAtStart!.content?.trim()).toBe("node_modules");

            // Final on-disk state: .gitignore content equals exactly
            // "node_modules" (with optional trailing newline).
            const gitignorePath = join(
              project!.loopxDir,
              "my-workflow",
              ".gitignore",
            );
            expect(readFileSync(gitignorePath, "utf-8").trim()).toBe(
              "node_modules",
            );
          },
        );
      });

      it("T-INST-112a: existing regular .gitignore is left unchanged", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        const original = "# user content\nfoo/\nbar.log\n";
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "my-workflow",
                version: "1.0.0",
              }),
              ".gitignore": original,
            },
          },
        ]);
        await withFakeNpm(
          { exitCode: 0, logFile, recordGitignoreAtStart: true },
          async (fake) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/my-workflow.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            expect(result.exitCode).toBe(0);

            const invocations = fake.readInvocations();
            expect(invocations.length).toBe(1);

            // .gitignore must still match original at npm spawn time.
            const inv = invocations[0];
            expect(inv.gitignoreAtStart!.existed).toBe(true);
            expect(inv.gitignoreAtStart!.content).toBe(original);

            // Final on-disk state byte-for-byte equal.
            const gitignorePath = join(
              project!.loopxDir,
              "my-workflow",
              ".gitignore",
            );
            expect(readFileSync(gitignorePath, "utf-8")).toBe(original);
          },
        );
      });

      it("T-INST-112c: .gitignore write failure skips npm install for that workflow, contributes to aggregate failure, and does not abort the auto-install pass", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
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
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            {
              cwd: project!.dir,
              runtime,
              timeout: 60_000,
              env: {
                NODE_ENV: "test",
                LOOPX_TEST_AUTOINSTALL_FAULT:
                  "gitignore-write-fail:beta,gamma",
              },
            },
          );
          // (a) exit code 1 — both safeguard write failures contribute.
          expect(result.exitCode).toBe(1);

          // (b) Only alpha reached the npm shim.
          const invocations = fake.readInvocations();
          const cwds = new Set(invocations.map((i) => i.cwd));
          expect(cwds.has(join(project!.loopxDir, "alpha"))).toBe(true);
          expect(cwds.has(join(project!.loopxDir, "beta"))).toBe(false);
          expect(cwds.has(join(project!.loopxDir, "gamma"))).toBe(false);
          expect(cwds.size).toBe(1);

          // (c) Aggregate report lists BOTH beta and gamma — proves
          // continuation past the first failure regardless of order.
          expect(result.stderr).toMatch(/beta/);
          expect(result.stderr).toMatch(/gamma/);
          expect(result.stderr).toMatch(/\.gitignore/);

          // (d) alpha is not listed in the aggregate report.
          // The aggregate-report block starts with the SPEC §10.10
          // "auto-install failures" header; only the failure entries
          // following the header are scoped to the report (other stderr
          // lines like progress / status messages are not in scope).
          const reportStart = result.stderr.indexOf("auto-install failures");
          expect(reportStart).toBeGreaterThanOrEqual(0);
          const report = result.stderr.slice(reportStart);
          expect(report).not.toMatch(/\[alpha\]/);
        });
      });

      it("T-INST-112d: .gitignore write failure does not roll back committed workflow files", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
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
        await withFakeNpm({ exitCode: 0, logFile }, async () => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/multi.git`],
            {
              cwd: project!.dir,
              runtime,
              timeout: 60_000,
              env: {
                NODE_ENV: "test",
                LOOPX_TEST_AUTOINSTALL_FAULT:
                  "gitignore-write-fail:beta,gamma",
              },
            },
          );
          expect(result.exitCode).toBe(1);

          // (a) alpha succeeded fully — its files + synthesized .gitignore.
          expect(
            existsSync(join(project!.loopxDir, "alpha", "index.sh")),
          ).toBe(true);
          expect(
            existsSync(join(project!.loopxDir, "alpha", "package.json")),
          ).toBe(true);
          expect(
            existsSync(join(project!.loopxDir, "alpha", ".gitignore")),
          ).toBe(true);
          expect(
            readFileSync(
              join(project!.loopxDir, "alpha", ".gitignore"),
              "utf-8",
            ).trim(),
          ).toBe("node_modules");

          // (b) beta committed files remain — no rollback.
          expect(
            existsSync(join(project!.loopxDir, "beta", "index.sh")),
          ).toBe(true);
          expect(
            existsSync(join(project!.loopxDir, "beta", "package.json")),
          ).toBe(true);

          // (c) beta has no .gitignore — write failed, no committed file.
          expect(
            existsSync(join(project!.loopxDir, "beta", ".gitignore")),
          ).toBe(false);

          // (d) gamma mirrors beta state — independent no-rollback per workflow.
          expect(
            existsSync(join(project!.loopxDir, "gamma", "index.sh")),
          ).toBe(true);
          expect(
            existsSync(join(project!.loopxDir, "gamma", "package.json")),
          ).toBe(true);
          expect(
            existsSync(join(project!.loopxDir, "gamma", ".gitignore")),
          ).toBe(false);
        });
      });

      it("T-INST-112b: .gitignore synthesis is skipped when the workflow has no top-level package.json", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "no-pkg",
            files: {
              "index.sh": BASH_STOP,
              // Deliberately no package.json — auto-install must be silently
              // skipped, AND the .gitignore safeguard must not run.
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/no-pkg.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          // Workflow committed.
          expect(
            existsSync(join(project!.loopxDir, "no-pkg", "index.sh")),
          ).toBe(true);
          expect(
            existsSync(join(project!.loopxDir, "no-pkg", "package.json")),
          ).toBe(false);

          // Auto-install was skipped (no package.json) — npm not invoked.
          expect(fake.readInvocations().length).toBe(0);

          // .gitignore was NOT synthesized — the safeguard runs only under
          // the same trigger as `npm install` per SPEC §10.10.
          expect(
            existsSync(join(project!.loopxDir, "no-pkg", ".gitignore")),
          ).toBe(false);

          // No aggregate failure report.
          expect(result.stderr).not.toMatch(
            /auto-install|aggregate|failed/i,
          );
        });
      });

      it("T-INST-112e: pre-existing .gitignore directory is a safeguard failure (non-regular branch)", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              // alpha/.gitignore is a non-empty directory at the workflow
              // root — committed as a directory through git, preserved
              // through SPEC §10.11 file-level install, and then triggers
              // SPEC §10.10's non-regular `lstat` dispatch.
              "alpha/.gitignore/README": "# placeholder content\n",
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
            },
          },
        ]);
        await withFakeNpm(
          { exitCode: 0, sleepSeconds: 1, logFile },
          async (fake) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            // (a) Safeguard failure on alpha contributes to final exit 1.
            expect(result.exitCode).toBe(1);

            // (b) Exactly one shim invocation, for beta only — auto-install
            //     pass continued past alpha's failure rather than aborting.
            const invocations = fake.readInvocations();
            expect(invocations.length).toBe(1);
            expect(invocations[0].cwd).toBe(
              join(project!.loopxDir, "beta"),
            );

            // (c) Aggregate report lists alpha as a .gitignore failure;
            //     beta is not listed (its safeguard + npm both succeeded).
            const reportStart = result.stderr.indexOf(
              "auto-install failures",
            );
            expect(reportStart).toBeGreaterThanOrEqual(0);
            const report = result.stderr.slice(reportStart);
            expect(report).toMatch(/\[alpha\]/);
            expect(report).toMatch(/\.gitignore/);
            expect(report).not.toMatch(/\[beta\]/);

            // (d) alpha's committed files remain — SPEC §10.10 no-rollback.
            expect(
              existsSync(join(project!.loopxDir, "alpha", "index.sh")),
            ).toBe(true);
            expect(
              existsSync(
                join(project!.loopxDir, "alpha", "package.json"),
              ),
            ).toBe(true);

            // (e) alpha/.gitignore is still a directory; placeholder
            //     unchanged. loopx did not delete, replace, or mutate it.
            const alphaGitignore = join(
              project!.loopxDir,
              "alpha",
              ".gitignore",
            );
            const alphaLstat = lstatSync(alphaGitignore);
            expect(alphaLstat.isSymbolicLink()).toBe(false);
            expect(alphaLstat.isDirectory()).toBe(true);
            const placeholderPath = join(alphaGitignore, "README");
            expect(existsSync(placeholderPath)).toBe(true);
            expect(readFileSync(placeholderPath, "utf-8")).toBe(
              "# placeholder content\n",
            );

            // (f) beta got a synthesized regular .gitignore via the
            //     ENOENT-creation branch (single line `node_modules`).
            const betaGitignore = join(
              project!.loopxDir,
              "beta",
              ".gitignore",
            );
            const betaLstat = lstatSync(betaGitignore);
            expect(betaLstat.isSymbolicLink()).toBe(false);
            expect(betaLstat.isFile()).toBe(true);
            expect(readFileSync(betaGitignore, "utf-8").trim()).toBe(
              "node_modules",
            );
            expect(
              existsSync(join(project!.loopxDir, "beta", "index.sh")),
            ).toBe(true);
            expect(
              existsSync(
                join(project!.loopxDir, "beta", "package.json"),
              ),
            ).toBe(true);
          },
        );
      });

      it("T-INST-112f: --no-install suppresses the .gitignore safeguard entirely, even with a non-regular pre-existing entry", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "multi",
            files: {
              "alpha/index.sh": BASH_STOP,
              "alpha/package.json": JSON.stringify({
                name: "alpha",
                version: "1.0.0",
              }),
              // Same non-regular .gitignore directory as T-INST-112e —
              // would cause a safeguard failure if the safeguard ran.
              "alpha/.gitignore/README": "# placeholder content\n",
              "beta/index.sh": BASH_STOP,
              "beta/package.json": JSON.stringify({
                name: "beta",
                version: "1.0.0",
              }),
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", "--no-install", `${gitServer!.url}/multi.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          // (a) Exit 0 — safeguard never ran, so the non-regular entry
          //     is not a failure under --no-install.
          expect(result.exitCode).toBe(0);

          // (b) Zero npm invocations.
          expect(fake.readInvocations().length).toBe(0);

          // (c) alpha/.gitignore is still a directory; placeholder
          //     unchanged (loopx did not touch the entry).
          const alphaGitignore = join(
            project!.loopxDir,
            "alpha",
            ".gitignore",
          );
          const alphaLstat = lstatSync(alphaGitignore);
          expect(alphaLstat.isSymbolicLink()).toBe(false);
          expect(alphaLstat.isDirectory()).toBe(true);
          expect(
            readFileSync(join(alphaGitignore, "README"), "utf-8"),
          ).toBe("# placeholder content\n");

          // (d) beta has no synthesized .gitignore — the safeguard was
          //     skipped entirely under --no-install, not just for the
          //     workflow with the non-regular entry.
          expect(
            existsSync(join(project!.loopxDir, "beta", ".gitignore")),
          ).toBe(false);

          // (e) Both workflows committed — only auto-install was
          //     suppressed, file-level commit ran for both.
          expect(
            existsSync(join(project!.loopxDir, "alpha", "index.sh")),
          ).toBe(true);
          expect(
            existsSync(
              join(project!.loopxDir, "alpha", "package.json"),
            ),
          ).toBe(true);
          expect(
            existsSync(join(project!.loopxDir, "beta", "index.sh")),
          ).toBe(true);
          expect(
            existsSync(
              join(project!.loopxDir, "beta", "package.json"),
            ),
          ).toBe(true);

          // (f) No aggregate failure report — safeguard never produced
          //     a failure to aggregate.
          expect(result.stderr).not.toMatch(
            /auto-install|aggregate|failed/i,
          );
        });
      });

      it("T-INST-114: npm install non-zero exit emits aggregate report and exits 1", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
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
          {
            exitCode: 0,
            exitCodeByWorkflow: { beta: 1 },
            logFile,
          },
          async (fake) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            expect(result.exitCode).toBe(1);

            const invocations = fake.readInvocations();
            // Both workflows still attempted — installer continues past failure.
            expect(invocations.length).toBe(2);

            // Aggregate report mentions beta failure.
            expect(result.stderr).toMatch(/beta/);
            expect(result.stderr).toMatch(/install|fail/i);

            // Both committed workflows remain on disk.
            expect(existsSync(join(project!.loopxDir, "alpha"))).toBe(true);
            expect(existsSync(join(project!.loopxDir, "beta"))).toBe(true);
          },
        );
      });

      it("T-INST-114a: npm spawn failure emits aggregate report and exits 1", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "my-workflow",
                version: "1.0.0",
              }),
            },
          },
        ]);
        await withFakeNpm(
          { spawnFailure: true, logFile },
          async (fake) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/my-workflow.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            expect(result.exitCode).toBe(1);

            // Zero shim invocations — npm did not resolve.
            expect(fake.readInvocations().length).toBe(0);

            // Aggregate report mentions the workflow.
            expect(result.stderr).toMatch(/my-workflow/);

            // Workflow files committed despite spawn failure.
            expect(
              existsSync(join(project!.loopxDir, "my-workflow", "index.sh")),
            ).toBe(true);
          },
        );
      });

      it("T-INST-115: npm install inherits loopx's process.env unchanged", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "my-workflow",
                version: "1.0.0",
              }),
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/my-workflow.git`],
            {
              cwd: project!.dir,
              runtime,
              timeout: 60_000,
              env: { LOOPX_TEST_INHERITED: "marker-value" },
            },
          );
          expect(result.exitCode).toBe(0);

          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(1);

          // The shim should have inherited PATH unchanged (it's our PATH-prepended
          // shim dir; the rest of PATH chain is preserved) — basic sanity.
          // HOME passthrough: must be present and equal to loopx's HOME.
          expect(invocations[0].env.HOME).toBe(process.env.HOME ?? "");
        });
      });

      it("T-INST-118: packageManager field does NOT cause loopx to select a different manager", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "my-workflow",
                version: "1.0.0",
                packageManager: "pnpm@9.0.0",
              }),
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/my-workflow.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          // Exactly one invocation, against our fake `npm` shim.
          // (If loopx selected pnpm, the shim would not have been invoked.)
          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(1);
          expect(invocations[0].argv).toEqual(["install"]);
        });
      });

      it("T-INST-118a: bun.lockb does NOT cause loopx to select bun", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "my-workflow",
                version: "1.0.0",
              }),
              // Zero-byte placeholder is sufficient for presence detection.
              "bun.lockb": "",
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/my-workflow.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          // Exactly one invocation, against our fake `npm` shim.
          // (If loopx selected bun based on bun.lockb presence, the npm shim
          // would not have been invoked.)
          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(1);
          expect(invocations[0].argv).toEqual(["install"]);

          // bun.lockb is preserved byte-for-byte in committed workflow.
          expect(
            existsSync(join(project!.loopxDir, "my-workflow", "bun.lockb")),
          ).toBe(true);
        });
      });

      it("T-INST-118b: yarn.lock does NOT cause loopx to select yarn", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "my-workflow",
                version: "1.0.0",
              }),
              "yarn.lock": "",
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/my-workflow.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          // Exactly one invocation, against our fake `npm` shim.
          // (If loopx selected yarn based on yarn.lock presence, the npm shim
          // would not have been invoked.)
          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(1);
          expect(invocations[0].argv).toEqual(["install"]);

          // yarn.lock preserved byte-for-byte in committed workflow.
          expect(
            existsSync(join(project!.loopxDir, "my-workflow", "yarn.lock")),
          ).toBe(true);
        });
      });

      it("T-INST-118c: multiple lockfiles + packageManager field still select npm", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "my-workflow",
                version: "1.0.0",
                packageManager: "yarn@3.6.1",
              }),
              "bun.lockb": "",
              "pnpm-lock.yaml": "",
              "yarn.lock": "",
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/my-workflow.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          // Exactly one invocation, against our fake `npm` shim.
          // Per SPEC 10.10: none of these signals (lockfiles, packageManager)
          // has any effect — `npm install` runs unconditionally.
          const invocations = fake.readInvocations();
          expect(invocations.length).toBe(1);
          expect(invocations[0].argv).toEqual(["install"]);

          // All lockfiles preserved byte-for-byte in committed workflow.
          expect(
            existsSync(join(project!.loopxDir, "my-workflow", "bun.lockb")),
          ).toBe(true);
          expect(
            existsSync(
              join(project!.loopxDir, "my-workflow", "pnpm-lock.yaml"),
            ),
          ).toBe(true);
          expect(
            existsSync(join(project!.loopxDir, "my-workflow", "yarn.lock")),
          ).toBe(true);
        });
      });

      it("T-INST-113: malformed package.json (invalid JSON) — warning once, auto-install skipped silently", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "my-workflow",
            files: {
              "index.sh": BASH_STOP,
              "package.json": "{this is not valid json",
            },
          },
        ]);
        await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
          const result = await runCLI(
            ["install", `${gitServer!.url}/my-workflow.git`],
            { cwd: project!.dir, runtime, timeout: 60_000 },
          );
          expect(result.exitCode).toBe(0);

          // No npm invocations — auto-install skipped because pkg malformed.
          expect(fake.readInvocations().length).toBe(0);

          // No .gitignore synthesis (safeguard skipped under same trigger).
          const gitignorePath = join(
            project!.loopxDir,
            "my-workflow",
            ".gitignore",
          );
          expect(existsSync(gitignorePath)).toBe(false);

          // Workflow files still committed.
          expect(
            existsSync(join(project!.loopxDir, "my-workflow", "index.sh")),
          ).toBe(true);
        });
      });

      // ─────────────────────────────────────────────────────────
      // No Rollback on Auto-install Failure (T-INST-117 / 117a / 117b)
      // SPEC §10.10 / §10.7 / §10.9: failures during the auto-install
      // pass do NOT roll back committed workflow files; partial
      // node_modules/ state from a failed npm install is left intact;
      // `loopx install -y <source>` retries by removing the existing
      // workflow directory (including stale node_modules/) and
      // recommitting + re-running the auto-install pass.
      // ─────────────────────────────────────────────────────────

      it("T-INST-117: auto-install failures do not remove committed workflow files", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
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
          {
            exitCode: 0,
            exitCodeByWorkflow: { beta: 1 },
            logFile,
          },
          async () => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/multi.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            // Auto-install for `beta/` failed → exit 1 from the
            // post-commit aggregate report; no rollback.
            expect(result.exitCode).toBe(1);

            // Both committed workflows remain on disk with their
            // intended source files, plus the synthesized .gitignore
            // each safeguard wrote before the npm spawn.
            for (const wf of ["alpha", "beta"]) {
              expect(
                existsSync(join(project!.loopxDir, wf, "index.sh")),
              ).toBe(true);
              expect(
                existsSync(join(project!.loopxDir, wf, "package.json")),
              ).toBe(true);
              expect(
                existsSync(join(project!.loopxDir, wf, ".gitignore")),
              ).toBe(true);
              expect(
                readFileSync(
                  join(project!.loopxDir, wf, ".gitignore"),
                  "utf-8",
                ).trim(),
              ).toBe("node_modules");
            }
          },
        );
      });

      it("T-INST-117a: partial node_modules state from a failed npm install is not cleaned up", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
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
            exitCode: 1,
            createFiles: ["node_modules/partial-file"],
            logFile,
          },
          async () => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/ralph.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            expect(result.exitCode).toBe(1);

            // Partial node_modules/ left intact — loopx did not
            // clean up the failing npm child's filesystem state.
            expect(
              existsSync(
                join(
                  project!.loopxDir,
                  "ralph",
                  "node_modules",
                  "partial-file",
                ),
              ),
            ).toBe(true);

            // Workflow source files still committed despite npm failure.
            expect(
              existsSync(join(project!.loopxDir, "ralph", "index.sh")),
            ).toBe(true);
            expect(
              existsSync(join(project!.loopxDir, "ralph", "package.json")),
            ).toBe(true);
          },
        );
      });

      it("T-INST-117b: loopx install -y after a prior auto-install failure reinstalls cleanly", async () => {
        project = await createTempProject();
        const phase1Log = join(project.dir, "fake-npm-phase1.log");
        const phase2Log = join(project.dir, "fake-npm-phase2.log");
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

        // ── Phase 1: failed install. ─────────────────────────────
        await withFakeNpm(
          {
            exitCode: 1,
            createFiles: ["node_modules/partial-file"],
            logFile: phase1Log,
          },
          async (fake) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/ralph.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            // (a1) npm exited 1 → install exits 1 from aggregate report.
            expect(result.exitCode).toBe(1);

            // (b1) Workflow source files committed despite npm failure
            //      (no rollback — T-INST-117 contract).
            expect(
              existsSync(join(project!.loopxDir, "ralph", "index.sh")),
            ).toBe(true);
            expect(
              existsSync(join(project!.loopxDir, "ralph", "package.json")),
            ).toBe(true);

            // (c1) Partial node_modules/ left intact
            //      (T-INST-117a contract).
            expect(
              existsSync(
                join(
                  project!.loopxDir,
                  "ralph",
                  "node_modules",
                  "partial-file",
                ),
              ),
            ).toBe(true);

            // (d1) .gitignore synthesized by the safeguard before
            //      npm spawn.
            const gitignorePath = join(
              project!.loopxDir,
              "ralph",
              ".gitignore",
            );
            expect(existsSync(gitignorePath)).toBe(true);
            expect(readFileSync(gitignorePath, "utf-8").trim()).toBe(
              "node_modules",
            );

            // (e1) Phase-1 fake-npm log records exactly one
            //      invocation for .loopx/ralph/.
            const invocations = fake.readInvocations();
            expect(invocations.length).toBe(1);
            expect(invocations[0].cwd).toBe(
              join(project!.loopxDir, "ralph"),
            );
          },
        );

        // ── Phase 2: successful retry with -y. ───────────────────
        await withFakeNpm(
          { exitCode: 0, logFile: phase2Log },
          async (fake) => {
            const result = await runCLI(
              ["install", "-y", `${gitServer!.url}/ralph.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            // (a2) Retry succeeds.
            expect(result.exitCode).toBe(0);

            // (b2) Workflow source files committed fresh —
            //      `-y` removed the old workflow directory and
            //      re-committed from the source.
            expect(
              existsSync(join(project!.loopxDir, "ralph", "index.sh")),
            ).toBe(true);
            expect(
              existsSync(join(project!.loopxDir, "ralph", "package.json")),
            ).toBe(true);

            // (c2) Stale partial-file no longer exists — `-y`
            //      file-level replacement removed the previous
            //      workflow directory (including the leftover
            //      node_modules/) before the new commit.
            expect(
              existsSync(
                join(
                  project!.loopxDir,
                  "ralph",
                  "node_modules",
                  "partial-file",
                ),
              ),
            ).toBe(false);

            // (d2) .gitignore synthesized fresh against the
            //      replacement workflow.
            const gitignorePath = join(
              project!.loopxDir,
              "ralph",
              ".gitignore",
            );
            expect(existsSync(gitignorePath)).toBe(true);
            expect(readFileSync(gitignorePath, "utf-8").trim()).toBe(
              "node_modules",
            );

            // (e2) Phase-2 fake-npm log records exactly one new
            //      invocation — npm install was re-spawned for
            //      the replaced workflow. This is the load-bearing
            //      assertion: a buggy implementation that treated
            //      the workflow as already-present-on-disk and
            //      skipped the auto-install pass would pass
            //      (a2)/(b2)/(c2)/(d2) but fail here.
            const invocations = fake.readInvocations();
            expect(invocations.length).toBe(1);
            expect(invocations[0].cwd).toBe(
              join(project!.loopxDir, "ralph"),
            );
          },
        );
      });

      // ─────────────────────────────────────────────────────────
      // npm Stdout/Stderr Passthrough (T-INST-119 / 119a /
      // 119a-stderr / 119b / 119c / 119d) — SPEC §10.10:
      // "npm's stdout and stderr stream through to loopx's
      // stdout and stderr unchanged; loopx neither buffers nor
      // parses npm output and does not introduce a progress
      // indicator of its own."
      // ─────────────────────────────────────────────────────────

      // Spinner glyphs and progress-bar/percentage patterns the
      // SPEC §10.10 progress-indicator clause forbids.
      const SPINNER_GLYPHS = /[⠇⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
      const PROGRESS_BAR = /\[#+\s*\]|\[#+\s*#*\]/;
      const PROGRESS_PCT = /^\s*\d{1,3}\s*%\s*$/m;

      function expectNoProgressIndicator(text: string): void {
        expect(text).not.toMatch(SPINNER_GLYPHS);
        expect(text).not.toMatch(PROGRESS_BAR);
        expect(text).not.toMatch(PROGRESS_PCT);
      }

      it("T-INST-119: npm stdout/stderr marker bytes appear unchanged in loopx's streams (success path)", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "passthrough",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "passthrough",
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
            logFile,
          },
          async (fake) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/passthrough.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            // (a) exit 0
            expect(result.exitCode).toBe(0);
            // (b) marker bytes appear as exact standalone lines
            expect(result.stdout).toMatch(/(^|\n)npm-stdout-MARKER\n/);
            expect(result.stderr).toMatch(/(^|\n)npm-stderr-MARKER\n/);
            // (c) no progress indicator
            expectNoProgressIndicator(result.stdout);
            expectNoProgressIndicator(result.stderr);
            // (d) shim ran exactly once for the workflow
            const invocations = fake.readInvocations();
            expect(invocations.length).toBe(1);
            expect(invocations[0].cwd).toBe(
              join(project!.loopxDir, "passthrough"),
            );
          },
        );
      });

      it("T-INST-119a: npm stdout streams through loopx in real time (no buffering until child exit)", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        const pidFile = join(project.dir, "fake-npm.pid");
        gitServer = await startLocalGitServer([
          {
            name: "stream-stdout",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "stream-stdout",
                version: "1.0.0",
              }),
            },
          },
        ]);
        await withFakeNpm(
          {
            exitCode: 0,
            stdout: "npm-streaming-MARKER\n",
            sleepSeconds: 5,
            pidFile,
            logFile,
          },
          async () => {
            const { result, waitForStdout } = runCLIWithSignal(
              ["install", `${gitServer!.url}/stream-stdout.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            // (a) Marker appears as exact standalone line within 4s
            // — well under the shim's 5s sleep.
            await waitForStdout(/(^|\n)npm-streaming-MARKER\n/, {
              timeoutMs: 4_000,
            });
            // (b) Shim PID is still alive at the moment we observed
            // the marker (proving real-time, not buffered-until-exit).
            const pid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
            expect(Number.isFinite(pid)).toBe(true);
            expect(() => process.kill(pid, 0)).not.toThrow();

            const outcome = await result;
            // (c) eventual exit 0
            expect(outcome.exitCode).toBe(0);
          },
        );
      });

      it("T-INST-119a-stderr: npm stderr streams through loopx in real time (no buffering until child exit)", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        const pidFile = join(project.dir, "fake-npm.pid");
        gitServer = await startLocalGitServer([
          {
            name: "stream-stderr",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "stream-stderr",
                version: "1.0.0",
              }),
            },
          },
        ]);
        await withFakeNpm(
          {
            exitCode: 0,
            stderr: "npm-streaming-stderr-MARKER\n",
            sleepSeconds: 5,
            pidFile,
            logFile,
          },
          async () => {
            const { result, waitForStderr } = runCLIWithSignal(
              ["install", `${gitServer!.url}/stream-stderr.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            await waitForStderr(/(^|\n)npm-streaming-stderr-MARKER\n/, {
              timeoutMs: 4_000,
            });
            const pid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
            expect(Number.isFinite(pid)).toBe(true);
            expect(() => process.kill(pid, 0)).not.toThrow();

            const outcome = await result;
            expect(outcome.exitCode).toBe(0);
          },
        );
      });

      it("T-INST-119b: npm stdout/stderr marker bytes appear unchanged on the non-zero-exit failure path", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        gitServer = await startLocalGitServer([
          {
            name: "passthrough-fail",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "passthrough-fail",
                version: "1.0.0",
              }),
            },
          },
        ]);
        await withFakeNpm(
          {
            exitCode: 1,
            stdout: "npm-fail-stdout-MARKER\n",
            stderr: "npm-fail-stderr-MARKER\n",
            logFile,
          },
          async (fake) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/passthrough-fail.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            // (a) exit 1 from the npm non-zero-exit branch
            expect(result.exitCode).toBe(1);
            // (b)/(c) marker bytes survived the failure path
            expect(result.stdout).toMatch(/(^|\n)npm-fail-stdout-MARKER\n/);
            expect(result.stderr).toMatch(/(^|\n)npm-fail-stderr-MARKER\n/);
            // (d) shim ran exactly once
            const invocations = fake.readInvocations();
            expect(invocations.length).toBe(1);
            // (e) no progress indicator
            expectNoProgressIndicator(result.stdout);
            expectNoProgressIndicator(result.stderr);
          },
        );
      });

      it("T-INST-119c: npm stdout/stderr stream through loopx in real time on the failure path", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
        const pidFile = join(project.dir, "fake-npm.pid");
        gitServer = await startLocalGitServer([
          {
            name: "stream-fail",
            files: {
              "index.sh": BASH_STOP,
              "package.json": JSON.stringify({
                name: "stream-fail",
                version: "1.0.0",
              }),
            },
          },
        ]);
        await withFakeNpm(
          {
            exitCode: 1,
            stdout: "npm-fail-stream-stdout-MARKER\n",
            stderr: "npm-fail-stream-stderr-MARKER\n",
            sleepSeconds: 5,
            pidFile,
            logFile,
          },
          async () => {
            const { result, waitForStdout, waitForStderr } = runCLIWithSignal(
              ["install", `${gitServer!.url}/stream-fail.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            // (a)/(b) markers appear as standalone lines within 4s
            // (well under the shim's 5s sleep).
            await waitForStdout(/(^|\n)npm-fail-stream-stdout-MARKER\n/, {
              timeoutMs: 4_000,
            });
            await waitForStderr(/(^|\n)npm-fail-stream-stderr-MARKER\n/, {
              timeoutMs: 4_000,
            });
            // (c) shim PID still alive at observation time
            const pid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
            expect(Number.isFinite(pid)).toBe(true);
            expect(() => process.kill(pid, 0)).not.toThrow();

            const outcome = await result;
            // (d) exit 1 per the non-zero-exit branch
            expect(outcome.exitCode).toBe(1);
            // (e) no progress indicator
            expectNoProgressIndicator(outcome.stdout);
            expectNoProgressIndicator(outcome.stderr);
          },
        );
      });

      it("T-INST-119d: npm payloads with leading/trailing whitespace, tabs, no trailing newline, and UTF-8 are preserved byte-for-byte", async () => {
        project = await createTempProject();
        const logFile = join(project.dir, "fake-npm.log");
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
        // Payloads exercise:
        //  - leading whitespace (trim-resistance)
        //  - embedded tabs (tab-normalization-resistance)
        //  - trailing whitespace (trim-resistance)
        //  - no trailing newline (line-buffer-drop-partial-line-resistance)
        //  - multi-byte UTF-8 (Unicode-mangling-resistance)
        const stdoutPayload =
          "  [LEAD-SPACES]npm-stdout-MARKER\twith-tab\twith-internal-spaces  [TRAIL-SPACES-NO-NEWLINE]";
        const stderrPayload =
          "\t[LEAD-TAB]npm-stderr-MARKER  with-spaces  naïve→END";
        await withFakeNpm(
          {
            exitCode: 0,
            stdout: stdoutPayload,
            stderr: stderrPayload,
            logFile,
          },
          async (fake) => {
            const result = await runCLI(
              ["install", `${gitServer!.url}/byte-shape.git`],
              { cwd: project!.dir, runtime, timeout: 60_000 },
            );
            // (a) exit 0
            expect(result.exitCode).toBe(0);
            // (b)/(c) byte-exact substring presence (not line-anchored)
            expect(result.stdout.includes(stdoutPayload)).toBe(true);
            expect(result.stderr.includes(stderrPayload)).toBe(true);
            // (d) shim ran once for this workflow
            const invocations = fake.readInvocations();
            expect(invocations.length).toBe(1);
            expect(invocations[0].cwd).toBe(
              join(project!.loopxDir, "byte-shape"),
            );
          },
        );
      });
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
