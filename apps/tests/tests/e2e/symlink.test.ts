import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createTempProject,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { forEachRuntime } from "../helpers/runtime.js";

// ============================================================================
// TEST-SPEC §4.7 — Symlink / Project-Root Spelling
// Spec refs: 3.2, 5.1, 6.1, 6.2, 9.5
//
// SPEC 3.2 / 6.1 declare loopx preserves discovery-time and caller-supplied
// spellings rather than canonicalizing via realpath. These tests close the
// foundational coverage block (T-SYM-01..05) for symlinks at the project
// root, the .loopx/ directory, and the workflow-directory entry.
// ============================================================================

const extraCleanups: Array<() => Promise<void>> = [];

describe("TEST-SPEC §4.7 Symlink / Project-Root Spelling", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    for (const cleanup of extraCleanups.splice(0)) {
      await cleanup().catch(() => {});
    }
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // ----------------------------------------------------------------------
    // T-SYM-01: Symlinked .loopx directory works end-to-end.
    // Real workflows under a symlinked .loopx/ run normally; the script
    // executes and the loop completes with exit 0. Paired with T-WFDIR-11
    // which adds the LOOPX_WORKFLOW_DIR spelling assertion.
    // ----------------------------------------------------------------------
    it("T-SYM-01: symlinked .loopx directory works end-to-end", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const realLoopx = await mkdtemp(join(tmpdir(), "loopx-sym-real-loopx-1-"));
      extraCleanups.push(() => rm(realLoopx, { recursive: true, force: true }));

      const realRalphDir = join(realLoopx, "ralph");
      await mkdir(realRalphDir, { recursive: true });
      const ranMarker = join(project.dir, "ran.txt");
      const realScriptPath = join(realRalphDir, "index.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf 'ran' > "${ranMarker}"
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(realScriptPath, 0o755);

      symlinkSync(realLoopx, project.loopxDir, "dir");

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(ranMarker)).toBe(true);
      expect(readFileSync(ranMarker, "utf-8")).toBe("ran");
    });

    // ----------------------------------------------------------------------
    // T-SYM-02: CLI invocation from a symlinked project-root spelling —
    // LOOPX_PROJECT_ROOT matches loopx's own process.cwd() at invocation,
    // computed dynamically so the assertion holds whether the runtime
    // canonicalizes via getcwd(3) or preserves the symlinked spelling.
    // ----------------------------------------------------------------------
    it("T-SYM-02: CLI from symlinked project root — LOOPX_PROJECT_ROOT matches process.cwd()", async () => {
      const realProject = await mkdtemp(
        join(tmpdir(), "loopx-sym-real-project-2-"),
      );
      extraCleanups.push(() =>
        rm(realProject, { recursive: true, force: true }),
      );

      const linkProject = join(
        tmpdir(),
        `loopx-sym-link-project-2-${randomUUID()}`,
      );
      await symlink(realProject, linkProject);
      extraCleanups.push(() => rm(linkProject, { force: true }));

      // Defensive: confirm the symlink is intact and resolves to realProject.
      const realStat = statSync(realProject);
      const linkStat = statSync(linkProject);
      expect(linkStat.dev).toBe(realStat.dev);
      expect(linkStat.ino).toBe(realStat.ino);

      await mkdir(join(realProject, ".loopx", "ralph"), { recursive: true });
      const rootMarker = join(realProject, "root.txt");
      const realScriptPath = join(realProject, ".loopx", "ralph", "index.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf '%s' "$LOOPX_PROJECT_ROOT" > "${rootMarker}"
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(realScriptPath, 0o755);

      // Pre-spawn the same runtime loopx will use, with cwd at the symlink,
      // and capture process.cwd() — that is the byte-for-byte expected
      // LOOPX_PROJECT_ROOT under SPEC 3.2 / 6.1 ("CLI LOOPX_PROJECT_ROOT is
      // exactly the string returned by loopx's own process.cwd() at
      // invocation"). On POSIX systems where getcwd(3) canonicalizes this
      // is typically realProject; runtimes that preserve the symlinked
      // spelling would yield linkProject — both outcomes are SPEC-conforming
      // and the dynamic capture handles either.
      const probe = spawnSync(
        runtime,
        ["-e", "process.stdout.write(process.cwd())"],
        { cwd: linkProject, encoding: "utf-8" },
      );
      expect(probe.status).toBe(0);
      const expectedRoot = probe.stdout;

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: linkProject,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(rootMarker)).toBe(true);
      expect(readFileSync(rootMarker, "utf-8")).toBe(expectedRoot);
    });

    // ----------------------------------------------------------------------
    // T-SYM-03: Programmatic cwd preserves symlink spelling — no realpath.
    // RunOptions.cwd: "/tmp/link-project" (a symlink) must reach
    // LOOPX_PROJECT_ROOT byte-for-byte unchanged. SPEC 9.5: an absolute cwd
    // is used unchanged; SPEC 3.2: no realpath / canonicalization.
    // ----------------------------------------------------------------------
    it("T-SYM-03: programmatic cwd preserves symlink spelling (no realpath)", async () => {
      const realProject = await mkdtemp(
        join(tmpdir(), "loopx-sym-real-project-3-"),
      );
      extraCleanups.push(() =>
        rm(realProject, { recursive: true, force: true }),
      );

      const linkProject = join(
        tmpdir(),
        `loopx-sym-link-project-3-${randomUUID()}`,
      );
      await symlink(realProject, linkProject);
      extraCleanups.push(() => rm(linkProject, { force: true }));

      // Defensive: confirm symlink intact.
      const realStat = statSync(realProject);
      const linkStat = statSync(linkProject);
      expect(linkStat.dev).toBe(realStat.dev);
      expect(linkStat.ino).toBe(realStat.ino);

      await mkdir(join(realProject, ".loopx", "ralph"), { recursive: true });
      const rootMarker = join(realProject, "root.txt");
      const realScriptPath = join(realProject, ".loopx", "ralph", "index.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf '%s' "$LOOPX_PROJECT_ROOT" > "${rootMarker}"
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(realScriptPath, 0o755);

      const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", { cwd: ${JSON.stringify(linkProject)}, maxIterations: 1 });
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(existsSync(rootMarker)).toBe(true);
      // The symlinked spelling is preserved verbatim — not realpath-canonicalized.
      expect(readFileSync(rootMarker, "utf-8")).toBe(linkProject);
    });

    // ----------------------------------------------------------------------
    // T-SYM-04: Programmatic cwd under a symlinked ancestor is preserved
    // verbatim. Lexical resolution via path.resolve only — no realpath
    // along any prefix of the supplied cwd.
    // ----------------------------------------------------------------------
    it("T-SYM-04: programmatic cwd under symlinked ancestor preserved verbatim", async () => {
      const realOuter = await mkdtemp(
        join(tmpdir(), "loopx-sym-real-outer-4-"),
      );
      extraCleanups.push(() =>
        rm(realOuter, { recursive: true, force: true }),
      );

      const projDir = join(realOuter, "proj");
      await mkdir(join(projDir, ".loopx", "ralph"), { recursive: true });
      const rootMarker = join(projDir, "root.txt");
      const realScriptPath = join(projDir, ".loopx", "ralph", "index.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf '%s' "$LOOPX_PROJECT_ROOT" > "${rootMarker}"
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(realScriptPath, 0o755);

      const linkOuter = join(
        tmpdir(),
        `loopx-sym-link-outer-4-${randomUUID()}`,
      );
      await symlink(realOuter, linkOuter);
      extraCleanups.push(() => rm(linkOuter, { force: true }));

      // Defensive: confirm symlink intact.
      const realStat = statSync(realOuter);
      const linkStat = statSync(linkOuter);
      expect(linkStat.dev).toBe(realStat.dev);
      expect(linkStat.ino).toBe(realStat.ino);

      const expectedCwd = join(linkOuter, "proj");

      const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", { cwd: ${JSON.stringify(expectedCwd)}, maxIterations: 1 });
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(existsSync(rootMarker)).toBe(true);
      // The symlinked-ancestor spelling is preserved verbatim along the full
      // supplied prefix — no realpath on /tmp/link-outer either.
      expect(readFileSync(rootMarker, "utf-8")).toBe(expectedCwd);
    });

    // ----------------------------------------------------------------------
    // T-SYM-05: LOOPX_WORKFLOW_DIR uses cached discovery-time spelling, not
    // recomposition / realpath. With <project>/.loopx itself a symlink to
    // an external directory and ralph/ a plain dir under that, the
    // workflow-dir env var must reflect the symlink-preserving spelling
    // (<project>/.loopx/ralph) rather than the realpath-canonicalized form
    // (<realLoopx>/ralph).
    // ----------------------------------------------------------------------
    it("T-SYM-05: LOOPX_WORKFLOW_DIR uses cached discovery-time spelling, not recomposition", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const realLoopx = await mkdtemp(join(tmpdir(), "loopx-sym-real-loopx-5-"));
      extraCleanups.push(() => rm(realLoopx, { recursive: true, force: true }));

      const realRalphDir = join(realLoopx, "ralph");
      await mkdir(realRalphDir, { recursive: true });
      const wfdirMarker = join(project.dir, "wfdir.txt");
      const realScriptPath = join(realRalphDir, "index.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(realScriptPath, 0o755);

      symlinkSync(realLoopx, project.loopxDir, "dir");

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(wfdirMarker)).toBe(true);
      const wfdir = readFileSync(wfdirMarker, "utf-8");
      // Cached discovery-time spelling: <PROJECT_ROOT>/.loopx/ralph where
      // PROJECT_ROOT is the kernel-canonicalized form of project.dir
      // (loopx's own process.cwd() at CLI invocation, typically /private/tmp
      // on macOS / direct path on Linux). realpathSync(project.dir) yields
      // the same canonical form.
      expect(wfdir).toBe(join(realpathSync(project.dir), ".loopx", "ralph"));
      // Must NOT be the realpath-canonicalized form following the .loopx
      // symlink to its target.
      expect(wfdir).not.toBe(join(realpathSync(realLoopx), "ralph"));
    });
  });
});
