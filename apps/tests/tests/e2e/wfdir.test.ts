import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createTempProject,
  createWorkflow,
  createWorkflowScript,
  createBashWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { createEnvFile } from "../helpers/env.js";
import { writeEnvToFile, observeEnv } from "../helpers/fixture-scripts.js";
import { forEachRuntime } from "../helpers/runtime.js";

// ============================================================================
// TEST-SPEC §4.7 — LOOPX_WORKFLOW_DIR (script-protocol-protected variable)
// Spec refs: 6.1, 6.2, 8.3, 13 (and ADR-0004 §4)
//
// LOOPX_WORKFLOW_DIR is the absolute path of the workflow directory containing
// the currently-spawned script. It is derived from the cached discovery-time
// script path, refreshed per-spawn alongside LOOPX_WORKFLOW, and joins
// LOOPX_BIN / LOOPX_PROJECT_ROOT / LOOPX_WORKFLOW / LOOPX_TMPDIR in the top
// precedence tier — silently overriding any user-supplied value at every
// lower tier (inherited env, env files, RunOptions.env).
// ============================================================================

const extraCleanups: Array<() => Promise<void>> = [];

describe("TEST-SPEC §4.7 LOOPX_WORKFLOW_DIR", () => {
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
    // T-WFDIR-01: Injected on every spawn; spelling matches the
    // discovery-time workflow path byte-for-byte (also asserts SPEC 6.2's
    // normative Bash equality dirname "$0" == LOOPX_WORKFLOW_DIR).
    // ----------------------------------------------------------------------
    it("T-WFDIR-01: LOOPX_WORKFLOW_DIR is injected and equals dirname \"$0\" byte-for-byte", async () => {
      project = await createTempProject();
      const wfdirMarker = join(project.dir, "wfdir.txt");
      const dirnameMarker = join(project.dir, "dirname.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
printf '%s' "$(dirname "$0")" > "${dirnameMarker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(wfdirMarker)).toBe(true);
      expect(existsSync(dirnameMarker)).toBe(true);

      const wfdir = readFileSync(wfdirMarker, "utf-8");
      const dn = readFileSync(dirnameMarker, "utf-8");
      // SPEC 6.2 normatively states Bash dirname "$0" == LOOPX_WORKFLOW_DIR
      // byte-for-byte. No trailing-slash drift permitted.
      expect(wfdir).toBe(dn);
      // The injected value must be an absolute path.
      expect(wfdir.startsWith("/")).toBe(true);
      // Names the workflow directory (allowing /tmp → /private/tmp on macOS).
      expect(wfdir.endsWith("/.loopx/ralph")).toBe(true);
    });

    function expectedWorkflowDir(p: TempProject, workflow: string): string {
      // SPEC 6.1 / 8.3: LOOPX_WORKFLOW_DIR equals
      //   <LOOPX_PROJECT_ROOT>/.loopx/<workflow>
      // and LOOPX_PROJECT_ROOT is loopx's process.cwd() at invocation.
      // When the CLI is spawned with `cwd: project.dir`, the kernel canonicalizes
      // via getcwd(3), which on macOS resolves /tmp → /private/tmp. Mirror that
      // canonicalization here so assertions hold on both Linux and macOS.
      return join(realpathSync(p.dir), ".loopx", workflow);
    }

    // ----------------------------------------------------------------------
    // T-WFDIR-02: equals path.join(LOOPX_PROJECT_ROOT, ".loopx", "ralph")
    // ----------------------------------------------------------------------
    it("T-WFDIR-02: LOOPX_WORKFLOW_DIR equals join(LOOPX_PROJECT_ROOT, .loopx, ralph)", async () => {
      project = await createTempProject();
      const wfdirMarker = join(project.dir, "wfdir.txt");
      const rootMarker = join(project.dir, "root.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
printf '%s' "$LOOPX_PROJECT_ROOT" > "${rootMarker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const wfdir = readFileSync(wfdirMarker, "utf-8");
      const root = readFileSync(rootMarker, "utf-8");
      expect(wfdir).toBe(join(root, ".loopx", "ralph"));
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-03: per-spawn refresh on intra-workflow goto.
    // ----------------------------------------------------------------------
    it("T-WFDIR-03: LOOPX_WORKFLOW_DIR is refreshed per-spawn on intra-workflow goto", async () => {
      project = await createTempProject();
      const indexMarker = join(project.dir, "index-wfdir.txt");
      const checkMarker = join(project.dir, "check-wfdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${indexMarker}"
printf '{"goto":"check"}'
`,
      );
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${checkMarker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "3", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const expected = expectedWorkflowDir(project, "ralph");
      const indexVal = readFileSync(indexMarker, "utf-8");
      const checkVal = readFileSync(checkMarker, "utf-8");
      // Intra-workflow goto preserves the workflow dir for both spawns.
      expect(indexVal).toBe(expected);
      expect(checkVal).toBe(expected);
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-04: cross-workflow goto refreshes LOOPX_WORKFLOW_DIR.
    // ----------------------------------------------------------------------
    it("T-WFDIR-04: LOOPX_WORKFLOW_DIR is refreshed across cross-workflow goto", async () => {
      project = await createTempProject();
      const indexWfdirMarker = join(project.dir, "ralph-wfdir.txt");
      const indexWfMarker = join(project.dir, "ralph-wf.txt");
      const checkWfdirMarker = join(project.dir, "other-wfdir.txt");
      const checkWfMarker = join(project.dir, "other-wf.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${indexWfdirMarker}"
printf '%s' "$LOOPX_WORKFLOW" > "${indexWfMarker}"
printf '{"goto":"other:check"}'
`,
      );
      await createWorkflowScript(
        project,
        "other",
        "check",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${checkWfdirMarker}"
printf '%s' "$LOOPX_WORKFLOW" > "${checkWfMarker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "3", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const ralphDir = expectedWorkflowDir(project, "ralph");
      const otherDir = expectedWorkflowDir(project, "other");
      expect(readFileSync(indexWfdirMarker, "utf-8")).toBe(ralphDir);
      expect(readFileSync(indexWfMarker, "utf-8")).toBe("ralph");
      expect(readFileSync(checkWfdirMarker, "utf-8")).toBe(otherDir);
      expect(readFileSync(checkWfMarker, "utf-8")).toBe("other");
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-04a: deeper chain A → B → C.
    // ----------------------------------------------------------------------
    it("T-WFDIR-04a: deeper cross-workflow chain (A → B → C) observes each workflow's own dir", async () => {
      project = await createTempProject();
      const alphaMarker = join(project.dir, "alpha-wfdir.txt");
      const betaMarker = join(project.dir, "beta-wfdir.txt");
      const gammaMarker = join(project.dir, "gamma-wfdir.txt");

      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${alphaMarker}"
printf '{"goto":"beta:index"}'
`,
      );
      await createWorkflowScript(
        project,
        "beta",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${betaMarker}"
printf '{"goto":"gamma:index"}'
`,
      );
      await createWorkflowScript(
        project,
        "gamma",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${gammaMarker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "5", "alpha"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(alphaMarker, "utf-8")).toBe(
        expectedWorkflowDir(project, "alpha"),
      );
      expect(readFileSync(betaMarker, "utf-8")).toBe(
        expectedWorkflowDir(project, "beta"),
      );
      expect(readFileSync(gammaMarker, "utf-8")).toBe(
        expectedWorkflowDir(project, "gamma"),
      );
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-05: loop reset returns LOOPX_WORKFLOW_DIR to the starting
    // workflow's directory. alpha:index → beta:step → (no goto, reset to
    // alpha:index). Append per-iteration markers, run -n 3.
    // ----------------------------------------------------------------------
    it("T-WFDIR-05: LOOPX_WORKFLOW_DIR resets correctly when loop returns to starting target", async () => {
      project = await createTempProject();
      const alphaLog = join(project.dir, "alpha-log.txt");
      const betaLog = join(project.dir, "beta-log.txt");

      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s\\n' "$LOOPX_WORKFLOW_DIR" >> "${alphaLog}"
printf '{"goto":"beta:step"}'
`,
      );
      await createWorkflowScript(
        project,
        "beta",
        "step",
        ".sh",
        `#!/bin/bash
printf '%s\\n' "$LOOPX_WORKFLOW_DIR" >> "${betaLog}"
printf '{}'
`,
      );

      const result = await runCLI(["run", "-n", "3", "alpha"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const alphaDir = expectedWorkflowDir(project, "alpha");
      const betaDir = expectedWorkflowDir(project, "beta");
      // Iterations: 1 (alpha→beta), 2 (beta, then loop reset; reset spawns
      // alpha:index again), 3 (alpha→beta). The exact count of executions
      // per script depends on whether reset counts as a separate iteration
      // boundary, but the values seen by alpha must always be alphaDir and
      // by beta must always be betaDir.
      const alphaSeen = readFileSync(alphaLog, "utf-8")
        .split("\n")
        .filter(Boolean);
      const betaSeen = readFileSync(betaLog, "utf-8")
        .split("\n")
        .filter(Boolean);
      expect(alphaSeen.length).toBeGreaterThanOrEqual(1);
      expect(betaSeen.length).toBeGreaterThanOrEqual(1);
      for (const v of alphaSeen) expect(v).toBe(alphaDir);
      for (const v of betaSeen) expect(v).toBe(betaDir);
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-06: LOOPX_WORKFLOW_DIR overrides inherited system env value.
    // Asserts also that no override warning appears on stderr (silent
    // override per SPEC §13 / §8.3).
    // ----------------------------------------------------------------------
    it("T-WFDIR-06: LOOPX_WORKFLOW_DIR overrides inherited system-env value (silent)", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "wfdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeEnvToFile("LOOPX_WORKFLOW_DIR", markerPath),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { LOOPX_WORKFLOW_DIR: "/tmp/fake-dir" },
      });

      expect(result.exitCode).toBe(0);
      const observed = readFileSync(markerPath, "utf-8");
      expect(observed).not.toBe("/tmp/fake-dir");
      expect(observed).toBe(expectedWorkflowDir(project, "ralph"));
      // Silent override: stderr must not announce the override.
      expect(result.stderr.toLowerCase()).not.toMatch(
        /loopx_workflow_dir.*(override|overrid|ignored|warning|notice)/i,
      );
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-07: LOOPX_WORKFLOW_DIR overrides local env file (-e) value.
    // ----------------------------------------------------------------------
    it("T-WFDIR-07: LOOPX_WORKFLOW_DIR overrides local env file (-e) value (silent)", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "wfdir.txt");
      const envPath = join(project.dir, "local.env");
      await createEnvFile(envPath, { LOOPX_WORKFLOW_DIR: "/tmp/fake-dir" });
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeEnvToFile("LOOPX_WORKFLOW_DIR", markerPath),
      );

      const result = await runCLI(
        ["run", "-e", "local.env", "-n", "1", "ralph"],
        { cwd: project.dir, runtime },
      );

      expect(result.exitCode).toBe(0);
      const observed = readFileSync(markerPath, "utf-8");
      expect(observed).not.toBe("/tmp/fake-dir");
      expect(observed).toBe(expectedWorkflowDir(project, "ralph"));
      expect(result.stderr.toLowerCase()).not.toMatch(
        /loopx_workflow_dir.*(override|overrid|ignored|warning|notice)/i,
      );
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-08: LOOPX_WORKFLOW_DIR overrides RunOptions.env value
    // (programmatic). Tier 1 protocol injection wins over tier 2.
    // ----------------------------------------------------------------------
    it("T-WFDIR-08: LOOPX_WORKFLOW_DIR overrides RunOptions.env value (silent)", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "wfdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeEnvToFile("LOOPX_WORKFLOW_DIR", markerPath),
      );

      const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { LOOPX_WORKFLOW_DIR: "/tmp/fake-dir" },
  maxIterations: 1,
})) {}
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const observed = readFileSync(markerPath, "utf-8");
      expect(observed).not.toBe("/tmp/fake-dir");
      expect(observed).toBe(expectedWorkflowDir(project, "ralph"));
      expect(result.stderr.toLowerCase()).not.toMatch(
        /loopx_workflow_dir.*(override|overrid|ignored|warning|notice)/i,
      );
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-09: Bash dirname "$0" == LOOPX_WORKFLOW_DIR byte-for-byte.
    // ----------------------------------------------------------------------
    it("T-WFDIR-09: Bash dirname \"$0\" equals LOOPX_WORKFLOW_DIR byte-for-byte", async () => {
      project = await createTempProject();
      const wfdirMarker = join(project.dir, "wfdir.txt");
      const dirnameMarker = join(project.dir, "dirname.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
printf '%s' "$(dirname "$0")" > "${dirnameMarker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const wfdir = readFileSync(wfdirMarker, "utf-8");
      const dn = readFileSync(dirnameMarker, "utf-8");
      expect(wfdir).toBe(dn);
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-09a: Bash $0 equals the absolute discovery-time entry path
    // (non-symlinked case).
    // ----------------------------------------------------------------------
    it("T-WFDIR-09a: Bash $0 equals the absolute discovery-time entry path", async () => {
      project = await createTempProject();
      const dollarZeroMarker = join(project.dir, "dollar-zero.txt");
      const expectedMarker = join(project.dir, "expected-path.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$0" > "${dollarZeroMarker}"
printf '%s' "$LOOPX_WORKFLOW_DIR/index.sh" > "${expectedMarker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const dollarZero = readFileSync(dollarZeroMarker, "utf-8");
      const expected = readFileSync(expectedMarker, "utf-8");
      expect(dollarZero).toBe(expected);
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-09b: $0 under a symlinked workflow directory preserves the
    // symlink spelling.
    // ----------------------------------------------------------------------
    it("T-WFDIR-09b: Bash $0 under a symlinked workflow directory preserves the symlink spelling", async () => {
      project = await createTempProject();

      // Create a real workflow tree outside `.loopx/`.
      const realRoot = await mkdtemp(join(tmpdir(), "loopx-wfdir-real-"));
      extraCleanups.push(() => rm(realRoot, { recursive: true, force: true }));
      const realRalphDir = join(realRoot, "ralph");
      await mkdir(realRalphDir, { recursive: true });
      const dollarZeroMarker = join(project.dir, "dollar-zero.txt");
      const realScriptPath = join(realRalphDir, "index.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf '%s' "$0" > "${dollarZeroMarker}"
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(realScriptPath, 0o755);

      // Symlink <project>/.loopx/ralph -> /tmp/.../ralph
      const symlinkPath = join(project.loopxDir, "ralph");
      symlinkSync(realRalphDir, symlinkPath, "dir");

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const dollarZero = readFileSync(dollarZeroMarker, "utf-8");
      // Symlink-preserving spelling, not realpath-canonicalized. The path
      // loopx invokes the script with starts from the canonical project
      // root (loopx's own getcwd(3)) but does NOT canonicalize the .loopx/
      // child component.
      expect(dollarZero).toBe(
        join(expectedWorkflowDir(project, "ralph"), "index.sh"),
      );
      expect(dollarZero).not.toBe(realScriptPath);
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-09c: $0 under a symlinked entry script preserves the symlink
    // spelling.
    // ----------------------------------------------------------------------
    it("T-WFDIR-09c: Bash $0 under a symlinked entry script preserves the symlink spelling", async () => {
      project = await createTempProject();

      // Create a real script outside `.loopx/`.
      const realDir = await mkdtemp(join(tmpdir(), "loopx-wfdir-realscript-"));
      extraCleanups.push(() => rm(realDir, { recursive: true, force: true }));
      const dollarZeroMarker = join(project.dir, "dollar-zero.txt");
      const realScriptPath = join(realDir, "real-script.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf '%s' "$0" > "${dollarZeroMarker}"
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(realScriptPath, 0o755);

      // Create the workflow dir, symlink the script.
      await createWorkflow(project, "ralph");
      const scriptSymlinkPath = join(project.loopxDir, "ralph", "index.sh");
      symlinkSync(realScriptPath, scriptSymlinkPath, "file");

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const dollarZero = readFileSync(dollarZeroMarker, "utf-8");
      // Loopx invokes the script with its discovery-time path; the script
      // file itself is a symlink, but loopx does not realpath it. The
      // workflow-dir component is canonicalized only because loopx's project
      // root is canonical (kernel getcwd(3)).
      expect(dollarZero).toBe(
        join(expectedWorkflowDir(project, "ralph"), "index.sh"),
      );
      expect(dollarZero).not.toBe(realScriptPath);
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-09d: $0 under a symlinked .loopx directory preserves the
    // symlink spelling, AND $(dirname "$0") == LOOPX_WORKFLOW_DIR holds.
    // ----------------------------------------------------------------------
    it("T-WFDIR-09d: Bash $0 under a symlinked .loopx directory preserves the symlink spelling", async () => {
      project = await createTempProject({ withLoopxDir: false });

      // Create real workflows outside the project.
      const realRoot = await mkdtemp(join(tmpdir(), "loopx-wfdir-realloopx-"));
      extraCleanups.push(() => rm(realRoot, { recursive: true, force: true }));
      const realRalphDir = join(realRoot, "ralph");
      await mkdir(realRalphDir, { recursive: true });
      const dollarZeroMarker = join(project.dir, "dollar-zero.txt");
      const wfdirMarker = join(project.dir, "wfdir.txt");
      const realScriptPath = join(realRalphDir, "index.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf '%s' "$0" > "${dollarZeroMarker}"
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(realScriptPath, 0o755);

      // Symlink <project>/.loopx -> realRoot.
      symlinkSync(realRoot, project.loopxDir, "dir");

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const dollarZero = readFileSync(dollarZeroMarker, "utf-8");
      const wfdir = readFileSync(wfdirMarker, "utf-8");
      // Symlink-preserving spelling: <project>/.loopx/ralph/index.sh, where
      // <project> is canonicalized to the same form loopx's process.cwd()
      // returns at invocation, but the .loopx symlink itself is preserved
      // (not realpath'd to the symlink's target).
      expect(dollarZero).toBe(
        join(expectedWorkflowDir(project, "ralph"), "index.sh"),
      );
      expect(dollarZero).not.toBe(realScriptPath);
      // Bash equality: dirname "$0" == LOOPX_WORKFLOW_DIR.
      expect(dirname(dollarZero)).toBe(wfdir);
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-10: Symlinked workflow directory — LOOPX_WORKFLOW_DIR uses
    // the symlinked spelling.
    // ----------------------------------------------------------------------
    it("T-WFDIR-10: symlinked workflow directory — LOOPX_WORKFLOW_DIR preserves discovery-time spelling", async () => {
      project = await createTempProject();

      const realRoot = await mkdtemp(join(tmpdir(), "loopx-wfdir-real10-"));
      extraCleanups.push(() => rm(realRoot, { recursive: true, force: true }));
      const realRalphDir = join(realRoot, "ralph");
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

      const symlinkPath = join(project.loopxDir, "ralph");
      symlinkSync(realRalphDir, symlinkPath, "dir");

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const wfdir = readFileSync(wfdirMarker, "utf-8");
      // Symlink-preserving spelling, not realpath.
      expect(wfdir).toBe(expectedWorkflowDir(project, "ralph"));
      expect(wfdir).not.toBe(realRalphDir);
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-11: Symlinked .loopx directory — LOOPX_WORKFLOW_DIR uses the
    // symlinked spelling.
    // ----------------------------------------------------------------------
    it("T-WFDIR-11: symlinked .loopx directory — LOOPX_WORKFLOW_DIR preserves discovery-time spelling", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const realRoot = await mkdtemp(join(tmpdir(), "loopx-wfdir-real11-"));
      extraCleanups.push(() => rm(realRoot, { recursive: true, force: true }));
      const realRalphDir = join(realRoot, "ralph");
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

      symlinkSync(realRoot, project.loopxDir, "dir");

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const wfdir = readFileSync(wfdirMarker, "utf-8");
      expect(wfdir).toBe(expectedWorkflowDir(project, "ralph"));
      expect(wfdir).not.toBe(realRalphDir);
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-12: Symlinked entry script — LOOPX_WORKFLOW_DIR is the
    // symlinked workflow directory; dirname "$0" matches.
    // ----------------------------------------------------------------------
    it("T-WFDIR-12: symlinked entry script — LOOPX_WORKFLOW_DIR uses workflow-dir spelling, dirname matches", async () => {
      project = await createTempProject();

      const realDir = await mkdtemp(join(tmpdir(), "loopx-wfdir-real12-"));
      extraCleanups.push(() => rm(realDir, { recursive: true, force: true }));
      const wfdirMarker = join(project.dir, "wfdir.txt");
      const dollarZeroMarker = join(project.dir, "dollar-zero.txt");
      const realScriptPath = join(realDir, "real-script.sh");
      await writeFile(
        realScriptPath,
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
printf '%s' "$0" > "${dollarZeroMarker}"
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(realScriptPath, 0o755);

      await createWorkflow(project, "ralph");
      const scriptSymlinkPath = join(project.loopxDir, "ralph", "index.sh");
      symlinkSync(realScriptPath, scriptSymlinkPath, "file");

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const wfdir = readFileSync(wfdirMarker, "utf-8");
      const dollarZero = readFileSync(dollarZeroMarker, "utf-8");
      // Workflow dir is the (symlinked-script's) workflow directory, not the
      // realpath of the symlink target.
      expect(wfdir).toBe(expectedWorkflowDir(project, "ralph"));
      // dirname "$0" == LOOPX_WORKFLOW_DIR per SPEC 6.2.
      expect(dirname(dollarZero)).toBe(wfdir);
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-13: Top-level Bash script and a sourced helper observe the
    // same LOOPX_WORKFLOW_DIR value.
    // ----------------------------------------------------------------------
    it("T-WFDIR-13: top-level Bash and a sourced helper observe the same LOOPX_WORKFLOW_DIR", async () => {
      project = await createTempProject();
      const topMarker = join(project.dir, "top-wfdir.txt");
      const helperMarker = join(project.dir, "helper-wfdir.txt");

      const workflowDir = await createWorkflow(project, "ralph");
      const libDir = join(workflowDir, "lib");
      await mkdir(libDir, { recursive: true });
      const helperPath = join(libDir, "helper.sh");
      await writeFile(
        helperPath,
        `printf '%s' "$LOOPX_WORKFLOW_DIR" > "${helperMarker}"\n`,
        "utf-8",
      );

      const indexPath = join(workflowDir, "index.sh");
      await writeFile(
        indexPath,
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${topMarker}"
source "$LOOPX_WORKFLOW_DIR/lib/helper.sh"
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(indexPath, 0o755);

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const top = readFileSync(topMarker, "utf-8");
      const helper = readFileSync(helperMarker, "utf-8");
      expect(top).toBe(helper);
      expect(top).toBe(expectedWorkflowDir(project, "ralph"));
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-13a: Top-level TS and an imported helper observe the same
    // LOOPX_WORKFLOW_DIR value.
    // ----------------------------------------------------------------------
    it("T-WFDIR-13a: top-level TS and an imported helper observe the same LOOPX_WORKFLOW_DIR", async () => {
      project = await createTempProject();
      const topMarker = join(project.dir, "top-wfdir.txt");
      const helperMarker = join(project.dir, "helper-wfdir.txt");

      const workflowDir = await createWorkflow(project, "ralph");
      const libDir = join(workflowDir, "lib");
      await mkdir(libDir, { recursive: true });
      const helperPath = join(libDir, "helper.ts");
      await writeFile(
        helperPath,
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(helperMarker)}, process.env.LOOPX_WORKFLOW_DIR ?? "");
`,
        "utf-8",
      );

      const indexPath = join(workflowDir, "index.ts");
      await writeFile(
        indexPath,
        `import { writeFileSync } from "node:fs";
import { output } from "loopx";
writeFileSync(${JSON.stringify(topMarker)}, process.env.LOOPX_WORKFLOW_DIR ?? "");
await import("./lib/helper.ts");
output({ stop: true });
`,
        "utf-8",
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const top = readFileSync(topMarker, "utf-8");
      const helper = readFileSync(helperMarker, "utf-8");
      expect(top).toBe(helper);
      expect(top).toBe(expectedWorkflowDir(project, "ralph"));
    });

    // ----------------------------------------------------------------------
    // T-WFDIR-14: cross-workflow rendezvous anti-pattern check.
    // alpha:index writes a file under its own LOOPX_WORKFLOW_DIR, then gotos
    // beta:index. beta:index reads from its own LOOPX_WORKFLOW_DIR/shared.tmp
    // and reports file-not-found — proving LOOPX_WORKFLOW_DIR is not a
    // rendezvous point.
    // ----------------------------------------------------------------------
    it("T-WFDIR-14: LOOPX_WORKFLOW_DIR is not a cross-workflow rendezvous point", async () => {
      project = await createTempProject();
      const reportMarker = join(project.dir, "rendezvous-report.txt");

      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".sh",
        `#!/bin/bash
printf 'shared-from-alpha' > "$LOOPX_WORKFLOW_DIR/shared.tmp"
printf '{"goto":"beta:index"}'
`,
      );
      await createWorkflowScript(
        project,
        "beta",
        "index",
        ".sh",
        `#!/bin/bash
if [ -f "$LOOPX_WORKFLOW_DIR/shared.tmp" ]; then
  printf 'present' > "${reportMarker}"
else
  printf 'missing' > "${reportMarker}"
fi
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "3", "alpha"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const report = readFileSync(reportMarker, "utf-8");
      expect(report).toBe("missing");
      // Sanity: alpha did write the file under its own workflow dir.
      const alphaShared = join(
        expectedWorkflowDir(project, "alpha"),
        "shared.tmp",
      );
      expect(existsSync(alphaShared)).toBe(true);
      expect(readFileSync(alphaShared, "utf-8")).toBe("shared-from-alpha");
    });
  });
});
