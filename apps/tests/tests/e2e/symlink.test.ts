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
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createTempProject,
  createWorkflowScript,
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

    // ----------------------------------------------------------------------
    // T-SYM-02c: CLI invocation from a symlinked project-root spelling —
    // LOOPX_WORKFLOW_DIR and Bash dirname "$0" track the same
    // process.cwd()-based root that LOOPX_PROJECT_ROOT does. Pins the
    // LOOPX_WORKFLOW_DIR derivation (path.join(projectRoot, ".loopx", entry)
    // at discovery + execution.ts injection) and the SPEC §6.2 normative
    // Bash equality dirname "$0" === LOOPX_WORKFLOW_DIR, all anchored on
    // loopx's own process.cwd() at invocation.
    // ----------------------------------------------------------------------
    it("T-SYM-02c: CLI from symlinked project root — LOOPX_WORKFLOW_DIR + dirname \"$0\" track process.cwd()", async () => {
      const realProject = await mkdtemp(
        join(tmpdir(), "loopx-sym-real-project-2c-"),
      );
      extraCleanups.push(() =>
        rm(realProject, { recursive: true, force: true }),
      );

      const linkProject = join(
        tmpdir(),
        `loopx-sym-link-project-2c-${randomUUID()}`,
      );
      await symlink(realProject, linkProject);
      extraCleanups.push(() => rm(linkProject, { force: true }));

      await mkdir(join(realProject, ".loopx", "ralph"), { recursive: true });
      const rootMarker = join(realProject, "root.txt");
      const wfdirMarker = join(realProject, "wfdir.txt");
      const dirname0Marker = join(realProject, "dirname0.txt");
      const realScriptPath = join(realProject, ".loopx", "ralph", "index.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf '%s' "$LOOPX_PROJECT_ROOT" > "${rootMarker}"
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
printf '%s' "$(dirname "$0")" > "${dirname0Marker}"
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(realScriptPath, 0o755);

      // Capture loopx's own process.cwd() at invocation under linkProject.
      // Same dynamic-probe pattern as T-SYM-02 — handles both runtimes that
      // canonicalize via getcwd(3) and runtimes that preserve the symlink
      // spelling.
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
      expect(readFileSync(rootMarker, "utf-8")).toBe(expectedRoot);
      // LOOPX_WORKFLOW_DIR is path.join(expectedRoot, ".loopx", "ralph") —
      // tracks the same process.cwd()-anchored root.
      expect(readFileSync(wfdirMarker, "utf-8")).toBe(
        join(expectedRoot, ".loopx", "ralph"),
      );
      // SPEC §6.2 normative Bash equality: dirname "$0" === LOOPX_WORKFLOW_DIR
      // byte-for-byte. Bash does not canonicalize $0; loopx invokes scripts
      // by their absolute discovery-time path so they agree.
      expect(readFileSync(dirname0Marker, "utf-8")).toBe(
        join(expectedRoot, ".loopx", "ralph"),
      );
    });

    // ----------------------------------------------------------------------
    // T-SYM-02d: CLI invocation from a symlinked project-root spelling —
    // effective-cwd directory identity matches LOOPX_PROJECT_ROOT. Even if
    // LOOPX_PROJECT_ROOT's string spelling is the runtime-canonicalized
    // form, the script's own cwd device/inode must match the symlinked
    // path the user invoked under (and equally, the canonical real path).
    // Completes the {string-spelling, identity} × {CLI, programmatic}
    // matrix initiated by T-SYM-02 / T-SYM-04d.
    // ----------------------------------------------------------------------
    it("T-SYM-02d: CLI from symlinked project root — effective cwd device/inode matches LOOPX_PROJECT_ROOT", async () => {
      const realProject = await mkdtemp(
        join(tmpdir(), "loopx-sym-real-project-2d-"),
      );
      extraCleanups.push(() =>
        rm(realProject, { recursive: true, force: true }),
      );

      const linkProject = join(
        tmpdir(),
        `loopx-sym-link-project-2d-${randomUUID()}`,
      );
      await symlink(realProject, linkProject);
      extraCleanups.push(() => rm(linkProject, { force: true }));

      // Confirm the symlink resolves to realProject.
      const realStat = statSync(realProject);
      const linkStat = statSync(linkProject);
      expect(linkStat.dev).toBe(realStat.dev);
      expect(linkStat.ino).toBe(realStat.ino);

      await mkdir(join(realProject, ".loopx", "ralph"), { recursive: true });
      const rootMarker = join(realProject, "root.txt");
      const cwdStatMarker = join(realProject, "cwd-stat.txt");
      const rootStatMarker = join(realProject, "root-stat.txt");
      const realScriptPath = join(realProject, ".loopx", "ralph", "index.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf '%s' "$LOOPX_PROJECT_ROOT" > "${rootMarker}"
{ stat -c '%d %i' . 2>/dev/null || stat -f '%d %i' .; } > "${cwdStatMarker}"
{ stat -c '%d %i' "$LOOPX_PROJECT_ROOT" 2>/dev/null || stat -f '%d %i' "$LOOPX_PROJECT_ROOT"; } > "${rootStatMarker}"
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(realScriptPath, 0o755);

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: linkProject,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const cwdStat = readFileSync(cwdStatMarker, "utf-8").trim();
      const rootStat = readFileSync(rootStatMarker, "utf-8").trim();
      // (b) device/inode of `.` == device/inode of $LOOPX_PROJECT_ROOT —
      // the spawned script's effective cwd matches whatever string spelling
      // is in LOOPX_PROJECT_ROOT.
      expect(cwdStat).toBe(rootStat);
      // (c) both equal harness-captured device/inode of /tmp/link-project
      // (which equals /tmp/real-project's, since the symlink resolves there).
      expect(cwdStat).toBe(`${linkStat.dev} ${linkStat.ino}`);
    });

    // ----------------------------------------------------------------------
    // T-SYM-04a: Absolute RunOptions.cwd with trailing slash preserved
    // verbatim in LOOPX_PROJECT_ROOT. SPEC §9.5: "Absolute cwd is used
    // unchanged" — path.resolve would strip the trailing slash; the impl
    // must NOT apply that normalization.
    // ----------------------------------------------------------------------
    it("T-SYM-04a: absolute RunOptions.cwd with trailing slash preserved verbatim", async () => {
      const realProject = await mkdtemp(
        join(tmpdir(), "loopx-sym-real-project-4a-"),
      );
      extraCleanups.push(() =>
        rm(realProject, { recursive: true, force: true }),
      );

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

      const cwdWithSlash = `${realProject}/`;

      const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", { cwd: ${JSON.stringify(cwdWithSlash)}, maxIterations: 1 });
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      // Trailing slash preserved byte-for-byte in LOOPX_PROJECT_ROOT —
      // path.resolve() would have stripped it.
      expect(readFileSync(rootMarker, "utf-8")).toBe(cwdWithSlash);
    });

    // ----------------------------------------------------------------------
    // T-SYM-04b: Absolute RunOptions.cwd with lexical `..` components
    // preserved verbatim in LOOPX_PROJECT_ROOT. SPEC §9.5: "Absolute cwd
    // is used unchanged"; SPEC §3.2: no realpath/canonicalization. The
    // /<adjacent>/.. component must traverse a real directory at chdir
    // time, but the env-var content is the raw caller-supplied spelling.
    // ----------------------------------------------------------------------
    it("T-SYM-04b: absolute RunOptions.cwd with lexical .. preserved verbatim", async () => {
      const realProject = await mkdtemp(
        join(tmpdir(), "loopx-sym-real-project-4b-"),
      );
      extraCleanups.push(() =>
        rm(realProject, { recursive: true, force: true }),
      );

      // Create a sibling directory under the same tmpdir parent so the
      // lexical `..` resolves to realProject's actual location at chdir().
      const adjacentDir = await mkdtemp(
        join(tmpdir(), "loopx-sym-adjacent-4b-"),
      );
      extraCleanups.push(() =>
        rm(adjacentDir, { recursive: true, force: true }),
      );

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

      const lexicalCwd = `${adjacentDir}/../${basename(realProject)}`;

      const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", { cwd: ${JSON.stringify(lexicalCwd)}, maxIterations: 1 });
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      // Lexical `..` preserved byte-for-byte in LOOPX_PROJECT_ROOT —
      // path.resolve() would have collapsed it to the canonical form.
      expect(readFileSync(rootMarker, "utf-8")).toBe(lexicalCwd);
    });

    // ----------------------------------------------------------------------
    // T-SYM-04c: Workflow-dir consistency under absolute RunOptions.cwd
    // trailing-slash and lexical-`..` spellings. Pins the SPEC §6.2
    // normative Bash equality dirname "$0" === LOOPX_WORKFLOW_DIR
    // byte-for-byte across cwd-spelling edges, plus same-file identity via
    // stat. Does NOT over-pin implementation-defined lexical normalization
    // of LOOPX_WORKFLOW_DIR's own string spelling.
    // ----------------------------------------------------------------------
    for (const variant of [
      { label: "trailing-slash", makeCwd: (p: string) => `${p}/` },
      {
        label: "lexical-dotdot",
        makeCwd: (p: string, adj: string) => `${adj}/../${basename(p)}`,
      },
    ]) {
      it(`T-SYM-04c [${variant.label}]: dirname "$0" equals LOOPX_WORKFLOW_DIR byte-for-byte under absolute cwd`, async () => {
        const realProject = await mkdtemp(
          join(tmpdir(), `loopx-sym-real-project-4c-${variant.label}-`),
        );
        extraCleanups.push(() =>
          rm(realProject, { recursive: true, force: true }),
        );

        let cwd: string;
        if (variant.label === "lexical-dotdot") {
          const adjacentDir = await mkdtemp(
            join(tmpdir(), `loopx-sym-adjacent-4c-${variant.label}-`),
          );
          extraCleanups.push(() =>
            rm(adjacentDir, { recursive: true, force: true }),
          );
          cwd = variant.makeCwd(realProject, adjacentDir);
        } else {
          cwd = variant.makeCwd(realProject, "");
        }

        await mkdir(join(realProject, ".loopx", "ralph"), { recursive: true });
        const wfdirMarker = join(realProject, "wfdir.txt");
        const dirname0Marker = join(realProject, "dirname0.txt");
        const wfdirStatMarker = join(realProject, "wfdir-stat.txt");
        const dirname0StatMarker = join(realProject, "dirname0-stat.txt");
        const realScriptPath = join(realProject, ".loopx", "ralph", "index.sh");
        await writeFile(
          realScriptPath,
          `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
printf '%s' "$(dirname "$0")" > "${dirname0Marker}"
{ stat -c '%d %i' "$LOOPX_WORKFLOW_DIR" 2>/dev/null || stat -f '%d %i' "$LOOPX_WORKFLOW_DIR"; } > "${wfdirStatMarker}"
{ stat -c '%d %i' "$(dirname "$0")" 2>/dev/null || stat -f '%d %i' "$(dirname "$0")"; } > "${dirname0StatMarker}"
printf '{"stop":true}'
`,
          "utf-8",
        );
        await chmod(realScriptPath, 0o755);

        const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", { cwd: ${JSON.stringify(cwd)}, maxIterations: 1 });
console.log("done");
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);

        const wfdir = readFileSync(wfdirMarker, "utf-8");
        const dirname0 = readFileSync(dirname0Marker, "utf-8");
        // SPEC §6.2 normative Bash equality (byte-for-byte).
        expect(dirname0).toBe(wfdir);
        // Same-file identity: both stat the same physical workflow dir.
        expect(readFileSync(wfdirStatMarker, "utf-8").trim()).toBe(
          readFileSync(dirname0StatMarker, "utf-8").trim(),
        );
      });
    }

    // ----------------------------------------------------------------------
    // T-SYM-04d: Effective-cwd directory identity under symlinked
    // RunOptions.cwd. The script's own cwd device/inode must match the
    // symlinked path the caller supplied (and equally, the canonical real
    // path it resolves to). Anchors SPEC §6.1's "directory identity vs.
    // string spelling" rule on the programmatic-API surface.
    // ----------------------------------------------------------------------
    it("T-SYM-04d: effective cwd device/inode matches symlinked RunOptions.cwd", async () => {
      const realProject = await mkdtemp(
        join(tmpdir(), "loopx-sym-real-project-4d-"),
      );
      extraCleanups.push(() =>
        rm(realProject, { recursive: true, force: true }),
      );

      const linkProject = join(
        tmpdir(),
        `loopx-sym-link-project-4d-${randomUUID()}`,
      );
      await symlink(realProject, linkProject);
      extraCleanups.push(() => rm(linkProject, { force: true }));

      // Confirm symlink intact.
      const realStat = statSync(realProject);
      const linkStat = statSync(linkProject);
      expect(linkStat.dev).toBe(realStat.dev);
      expect(linkStat.ino).toBe(realStat.ino);

      await mkdir(join(realProject, ".loopx", "ralph"), { recursive: true });
      const rootMarker = join(realProject, "root.txt");
      const cwdStatMarker = join(realProject, "cwd-stat.txt");
      const realScriptPath = join(realProject, ".loopx", "ralph", "index.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf '%s' "$LOOPX_PROJECT_ROOT" > "${rootMarker}"
{ stat -c '%d %i' . 2>/dev/null || stat -f '%d %i' .; } > "${cwdStatMarker}"
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
      // (a) String spelling preserved (covered by T-SYM-03; sanity here).
      expect(readFileSync(rootMarker, "utf-8")).toBe(linkProject);
      // (b) Effective cwd dev/ino matches /tmp/link-project (via the
      // symlink resolution, which equals /tmp/real-project's dev/ino).
      expect(readFileSync(cwdStatMarker, "utf-8").trim()).toBe(
        `${linkStat.dev} ${linkStat.ino}`,
      );
    });

    // ----------------------------------------------------------------------
    // T-SYM-06: LOOPX_WORKFLOW_DIR preserves the symlink spelling coming
    // from RunOptions.cwd in its project-root prefix. With cwd =
    // "/tmp/link-project" (a symlink), LOOPX_WORKFLOW_DIR must be
    // "/tmp/link-project/.loopx/ralph" — NOT the realpath-canonicalized
    // form. Pins SPEC §3.2 / §6.1 / §9.5 across the workflow-dir env var.
    // ----------------------------------------------------------------------
    it("T-SYM-06: LOOPX_WORKFLOW_DIR preserves symlink spelling from RunOptions.cwd", async () => {
      const realProject = await mkdtemp(
        join(tmpdir(), "loopx-sym-real-project-6-"),
      );
      extraCleanups.push(() =>
        rm(realProject, { recursive: true, force: true }),
      );

      const linkProject = join(
        tmpdir(),
        `loopx-sym-link-project-6-${randomUUID()}`,
      );
      await symlink(realProject, linkProject);
      extraCleanups.push(() => rm(linkProject, { force: true }));

      await mkdir(join(realProject, ".loopx", "ralph"), { recursive: true });
      const wfdirMarker = join(realProject, "wfdir.txt");
      const realScriptPath = join(realProject, ".loopx", "ralph", "index.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
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
      // Symlinked-cwd spelling preserved through to LOOPX_WORKFLOW_DIR —
      // not the realpath-canonicalized form.
      expect(readFileSync(wfdirMarker, "utf-8")).toBe(
        join(linkProject, ".loopx", "ralph"),
      );
    });

    // ----------------------------------------------------------------------
    // T-SYM-06a: Bash $0 preserves the symlink spelling coming from
    // RunOptions.cwd. Pins SPEC §6.2's normative dirname "$0" ===
    // LOOPX_WORKFLOW_DIR equality across the symlinked-cwd path. Bash
    // does not canonicalize $0; loopx invokes Bash with the symlink-
    // preserving absolute path so the equality holds.
    // ----------------------------------------------------------------------
    it("T-SYM-06a: Bash $0 preserves symlink spelling from RunOptions.cwd", async () => {
      const realProject = await mkdtemp(
        join(tmpdir(), "loopx-sym-real-project-6a-"),
      );
      extraCleanups.push(() =>
        rm(realProject, { recursive: true, force: true }),
      );

      const linkProject = join(
        tmpdir(),
        `loopx-sym-link-project-6a-${randomUUID()}`,
      );
      await symlink(realProject, linkProject);
      extraCleanups.push(() => rm(linkProject, { force: true }));

      await mkdir(join(realProject, ".loopx", "ralph"), { recursive: true });
      const dollar0Marker = join(realProject, "dollar0.txt");
      const wfdirMarker = join(realProject, "wfdir.txt");
      const dirname0Marker = join(realProject, "dirname0.txt");
      const realScriptPath = join(realProject, ".loopx", "ralph", "index.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf '%s' "$0" > "${dollar0Marker}"
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
printf '%s' "$(dirname "$0")" > "${dirname0Marker}"
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
      // (a) $0 is the symlink-preserving absolute path.
      expect(readFileSync(dollar0Marker, "utf-8")).toBe(
        join(linkProject, ".loopx", "ralph", "index.sh"),
      );
      // (b) LOOPX_WORKFLOW_DIR is the symlink-preserving spelling.
      expect(readFileSync(wfdirMarker, "utf-8")).toBe(
        join(linkProject, ".loopx", "ralph"),
      );
      // (c) SPEC §6.2 byte-for-byte equality.
      expect(readFileSync(dirname0Marker, "utf-8")).toBe(
        join(linkProject, ".loopx", "ralph"),
      );
    });

    // ----------------------------------------------------------------------
    // T-SYM-07: [Node] import.meta.url vs. LOOPX_WORKFLOW_DIR — symlink-
    // free entry path equality. With no symlinks anywhere along the
    // workflow path, dirname(fileURLToPath(import.meta.url)) and
    // LOOPX_WORKFLOW_DIR agree byte-for-byte.
    // ----------------------------------------------------------------------
    it.skipIf(runtime !== "node")(
      "T-SYM-07: [Node] import.meta.url == LOOPX_WORKFLOW_DIR (symlink-free entry)",
      async () => {
        project = await createTempProject({});
        const wfdirMarker = join(project.dir, "wfdir.txt");
        const importMetaMarker = join(project.dir, "import-meta.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".ts",
          `
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
const importMetaDir = dirname(fileURLToPath(import.meta.url));
writeFileSync(${JSON.stringify(wfdirMarker)}, process.env.LOOPX_WORKFLOW_DIR ?? "");
writeFileSync(${JSON.stringify(importMetaMarker)}, importMetaDir);
console.log('{"stop":true}');
`,
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);

        const wfdir = readFileSync(wfdirMarker, "utf-8");
        const importMetaDir = readFileSync(importMetaMarker, "utf-8");
        // Symlink-free case: byte-for-byte equality. SPEC §6.1 / §6.3.
        expect(importMetaDir).toBe(wfdir);
      },
    );

    // ----------------------------------------------------------------------
    // T-SYM-07a: [Node] import.meta.url vs. LOOPX_WORKFLOW_DIR —
    // symlinked entry path under Node, observational outcome envelope.
    // With the entry script itself symlinked, LOOPX_WORKFLOW_DIR is still
    // the discovery-time spelling and no warning is emitted on stderr.
    // Does NOT pin importMetaDir vs. workflowDir equality — SPEC §6.3
    // admits either equality (preserve-symlinks loader) or divergence
    // (default Node behavior, which canonicalizes via the loader chain).
    // ----------------------------------------------------------------------
    it.skipIf(runtime !== "node")(
      "T-SYM-07a: [Node] symlinked entry — LOOPX_WORKFLOW_DIR is discovery-time spelling, no stderr warning",
      async () => {
        project = await createTempProject({});

        // External target the entry script symlinks to.
        const externalDir = await mkdtemp(
          join(tmpdir(), "loopx-sym-7a-external-"),
        );
        extraCleanups.push(() =>
          rm(externalDir, { recursive: true, force: true }),
        );

        const wfdirMarker = join(project.dir, "wfdir.txt");
        const importMetaMarker = join(project.dir, "import-meta.txt");

        const externalTarget = join(externalDir, "real-index.ts");
        await writeFile(
          externalTarget,
          `
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
const importMetaDir = dirname(fileURLToPath(import.meta.url));
writeFileSync(${JSON.stringify(wfdirMarker)}, process.env.LOOPX_WORKFLOW_DIR ?? "");
writeFileSync(${JSON.stringify(importMetaMarker)}, importMetaDir);
console.log('{"stop":true}');
`,
          "utf-8",
        );

        // Workflow's index.ts is a symlink pointing to the external file.
        await mkdir(join(project.loopxDir, "ralph"), { recursive: true });
        const entryPath = join(project.loopxDir, "ralph", "index.ts");
        symlinkSync(externalTarget, entryPath, "file");

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);

        // (a) LOOPX_WORKFLOW_DIR is the discovery-time spelling — the
        // workflow path under the project's own .loopx/, not the external
        // target's directory.
        expect(readFileSync(wfdirMarker, "utf-8")).toBe(
          join(project.dir, ".loopx", "ralph"),
        );
        // (b) No warning on stderr about the symlinked entry.
        expect(result.stderr).not.toMatch(/symlink/i);
        expect(result.stderr).not.toMatch(/preserve/i);
        expect(result.stderr).not.toMatch(/canonical/i);
        // Diagnostic only — does not over-pin SPEC §6.3's
        // implementation-defined envelope.
        readFileSync(importMetaMarker, "utf-8");
      },
    );

    // ----------------------------------------------------------------------
    // T-SYM-07b: [Bun] import.meta.url vs. LOOPX_WORKFLOW_DIR —
    // symlink-free entry path equality under Bun. Bun counterpart to
    // T-SYM-07; conditional on Bun availability.
    // ----------------------------------------------------------------------
    it.skipIf(runtime !== "bun")(
      "T-SYM-07b: [Bun] import.meta.url == LOOPX_WORKFLOW_DIR (symlink-free entry)",
      async () => {
        project = await createTempProject({});
        const wfdirMarker = join(project.dir, "wfdir.txt");
        const importMetaMarker = join(project.dir, "import-meta.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".ts",
          `
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
const importMetaDir = dirname(fileURLToPath(import.meta.url));
writeFileSync(${JSON.stringify(wfdirMarker)}, process.env.LOOPX_WORKFLOW_DIR ?? "");
writeFileSync(${JSON.stringify(importMetaMarker)}, importMetaDir);
console.log('{"stop":true}');
`,
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);

        const wfdir = readFileSync(wfdirMarker, "utf-8");
        const importMetaDir = readFileSync(importMetaMarker, "utf-8");
        // Symlink-free case under Bun: byte-for-byte equality.
        expect(importMetaDir).toBe(wfdir);
      },
    );

    // ----------------------------------------------------------------------
    // T-SYM-08: [Node] loopx does not pass runtime-specific symlink-
    // preservation flags (--preserve-symlinks, --preserve-symlinks-main)
    // to the JS/TS child runtime — neither via process.execArgv nor via
    // NODE_OPTIONS. SPEC §6.3.
    // ----------------------------------------------------------------------
    it.skipIf(runtime !== "node")(
      "T-SYM-08: [Node] no --preserve-symlinks(-main) injection in execArgv or NODE_OPTIONS",
      async () => {
        project = await createTempProject({});
        const execArgvMarker = join(project.dir, "execArgv.txt");
        const nodeOptionsMarker = join(project.dir, "node-options.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".ts",
          `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(execArgvMarker)}, JSON.stringify(process.execArgv));
writeFileSync(${JSON.stringify(nodeOptionsMarker)}, process.env.NODE_OPTIONS ?? "");
console.log('{"stop":true}');
`,
        );

        // Scrub NODE_OPTIONS from inherited env so the marker reflects only
        // what loopx itself injects (or doesn't).
        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: { NODE_OPTIONS: "" },
        });
        expect(result.exitCode).toBe(0);

        const execArgv: string[] = JSON.parse(
          readFileSync(execArgvMarker, "utf-8"),
        );
        const nodeOptions = readFileSync(nodeOptionsMarker, "utf-8");

        expect(
          execArgv.some((a) => a.includes("preserve-symlinks")),
        ).toBe(false);
        expect(nodeOptions).not.toMatch(/--preserve-symlinks/);
      },
    );

    // ----------------------------------------------------------------------
    // T-SYM-09: Programmatic invocation with omitted RunOptions.cwd from a
    // symlinked process cwd. Parameterized over runPromise() and run().
    // Pins SPEC §9.1 / §9.2 / §9.5: when cwd is omitted, loopx defaults to
    // process.cwd() at call time (whatever string the runtime's getcwd(3)
    // returns). Anchors the {explicit-cwd, omitted-cwd} × {runPromise,
    // run} corner of the symlink-spelling matrix.
    // ----------------------------------------------------------------------
    for (const apiKind of ["runPromise", "run"] as const) {
      it(`T-SYM-09 [${apiKind}]: omitted cwd uses process.cwd() at call time when invoked from a symlinked process cwd`, async () => {
        const realProject = await mkdtemp(
          join(tmpdir(), `loopx-sym-real-project-9-${apiKind}-`),
        );
        extraCleanups.push(() =>
          rm(realProject, { recursive: true, force: true }),
        );

        const linkProject = join(
          tmpdir(),
          `loopx-sym-link-project-9-${apiKind}-${randomUUID()}`,
        );
        await symlink(realProject, linkProject);
        extraCleanups.push(() => rm(linkProject, { force: true }));

        // Confirm symlink intact.
        const realStat = statSync(realProject);
        const linkStat = statSync(linkProject);
        expect(linkStat.dev).toBe(realStat.dev);
        expect(linkStat.ino).toBe(realStat.ino);

        await mkdir(join(realProject, ".loopx", "ralph"), { recursive: true });
        const rootMarker = join(realProject, "root.txt");
        const wfdirMarker = join(realProject, "wfdir.txt");
        const cwdStatMarker = join(realProject, "cwd-stat.txt");
        const realScriptPath = join(realProject, ".loopx", "ralph", "index.sh");
        await writeFile(
          realScriptPath,
          `#!/bin/bash
printf '%s' "$LOOPX_PROJECT_ROOT" > "${rootMarker}"
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
{ stat -c '%d %i' . 2>/dev/null || stat -f '%d %i' .; } > "${cwdStatMarker}"
printf '{"stop":true}'
`,
          "utf-8",
        );
        await chmod(realScriptPath, 0o755);

        // Driver: chdir into the symlink path BEFORE the API call, capture
        // process.cwd() right then (that's the byte-for-byte expected
        // LOOPX_PROJECT_ROOT under SPEC §9.5's "defaults to process.cwd()
        // at call time"), and emit it on stdout for the harness to read.
        const apiInvocation =
          apiKind === "runPromise"
            ? `await runPromise("ralph", { maxIterations: 1 });`
            : `for await (const _ of run("ralph", { maxIterations: 1 })) {}`;
        const apiImport =
          apiKind === "runPromise"
            ? `import { runPromise } from "loopx";`
            : `import { run } from "loopx";`;
        const driverCode = `
${apiImport}
process.chdir(${JSON.stringify(linkProject)});
const expectedRoot = process.cwd();
process.stdout.write("EXPECTED_ROOT=" + expectedRoot + "\\n");
${apiInvocation}
console.log("done");
`;

        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);

        const match = result.stdout.match(/EXPECTED_ROOT=(.+?)\n/);
        expect(match).toBeTruthy();
        const expectedRoot = match![1]!;

        // (a) LOOPX_PROJECT_ROOT equals process.cwd() captured at call time.
        expect(readFileSync(rootMarker, "utf-8")).toBe(expectedRoot);
        // (b) LOOPX_WORKFLOW_DIR is anchored on the same root.
        expect(readFileSync(wfdirMarker, "utf-8")).toBe(
          join(expectedRoot, ".loopx", "ralph"),
        );
        // (c) Effective cwd dev/ino matches /tmp/link-project (and equally
        // /tmp/real-project) — directory identity vs. string spelling per
        // SPEC §6.1.
        expect(readFileSync(cwdStatMarker, "utf-8").trim()).toBe(
          `${linkStat.dev} ${linkStat.ino}`,
        );
      });
    }
  });
});
