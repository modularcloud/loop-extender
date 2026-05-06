import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  createBashWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { createEnvFile } from "../helpers/env.js";
import {
  emitResult,
  writeCwdToFile,
  writeEnvToFile,
  writeStderr,
} from "../helpers/fixture-scripts.js";
import { runCLI } from "../helpers/cli.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { forEachRuntime, isRuntimeAvailable } from "../helpers/runtime.js";

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function bashJsonString(value: string): string {
  return JSON.stringify(value);
}

function observeEnvJsonBash(varname: string, markerPath: string): string {
  return `if [[ -v ${varname} ]]; then
  node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ present: true, value: process.env[process.argv[2]] }))' ${bashJsonString(markerPath)} ${bashJsonString(varname)}
else
  printf '{"present":false}' > ${bashJsonString(markerPath)}
fi`;
}

// ============================================================================
// TEST-SPEC §4.4 — Script Execution (ADR-0003 workflow model)
// Spec refs: 6.1–6.5, 8.3, 2.1, 2.2
//
// Under the workflow model, all scripts live in workflow subdirectories of
// .loopx/ (e.g. .loopx/ralph/index.sh). Scripts execute with the project root
// as cwd. LOOPX_PROJECT_ROOT points to that same directory; LOOPX_WORKFLOW and
// LOOPX_WORKFLOW_DIR are refreshed on every cross-workflow transition
// (including loop reset).
// ============================================================================

// ----------------------------------------------------------------------------
// Working Directory (T-EXEC-01..03, 03a) + Environment (T-EXEC-04..04c)
// ----------------------------------------------------------------------------

describe("TEST-SPEC §4.4 Working Directory", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    it("T-EXEC-01: script in ralph workflow runs with cwd = project root", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "cwd-marker.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeCwdToFile(markerPath),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const recordedCwd = readFileSync(markerPath, "utf-8");
      const workflowDir = join(project.loopxDir, "ralph");
      expect(recordedCwd).toBe(project.dir);
      expect(recordedCwd).not.toBe(workflowDir);
    });

    it("T-EXEC-02: script in other workflow also runs with cwd = project root", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "cwd-other.txt");

      await createWorkflowScript(
        project,
        "other",
        "index",
        ".sh",
        writeCwdToFile(markerPath),
      );

      const result = await runCLI(["run", "-n", "1", "other"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const recordedCwd = readFileSync(markerPath, "utf-8");
      const otherDir = join(project.loopxDir, "other");
      expect(recordedCwd).toBe(project.dir);
      expect(recordedCwd).not.toBe(otherDir);
    });

    it("T-EXEC-03: $LOOPX_PROJECT_ROOT equals invocation directory, not workflow directory", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "projroot-marker.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeEnvToFile("LOOPX_PROJECT_ROOT", markerPath),
      );

      await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(existsSync(markerPath)).toBe(true);
      const recordedRoot = readFileSync(markerPath, "utf-8");
      expect(recordedRoot).toBe(project.dir);
      expect(recordedRoot).not.toBe(join(project.loopxDir, "ralph"));
    });

    it("T-EXEC-03a: $LOOPX_PROJECT_ROOT is preserved across cross-workflow goto", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "projroot-after-goto.txt");

      // ralph:index transitions to other:check via qualified goto
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"goto":"other:check"}'`,
      );
      // other:check records LOOPX_PROJECT_ROOT then stops to end the chain
      await createWorkflowScript(
        project,
        "other",
        "check",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_PROJECT_ROOT" > "${markerPath}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const recordedRoot = readFileSync(markerPath, "utf-8");
      // Even after crossing into the 'other' workflow, LOOPX_PROJECT_ROOT still
      // points at the project root (invocation cwd), not the target workflow dir.
      expect(recordedRoot).toBe(project.dir);
      expect(recordedRoot).not.toBe(join(project.loopxDir, "other"));
    });

    it("T-EXEC-03b: child cd does not leak across intra-workflow goto", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "cwd-after-cd-goto.txt");
      const outsideDir = tmpdir();

      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `cd ${JSON.stringify(outsideDir)}
printf '{"goto":"check"}'`,
      );
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".sh",
        `${writeCwdToFile(markerPath)}
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const recordedCwd = readFileSync(markerPath, "utf-8");
      expect(recordedCwd).toBe(project.dir);
      expect(recordedCwd).not.toBe(outsideDir);
      expect(recordedCwd).not.toBe(join(project.loopxDir, "ralph"));
    });

    it("T-EXEC-04: $LOOPX_WORKFLOW is injected and equals the workflow name", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "workflow-marker.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeEnvToFile("LOOPX_WORKFLOW", markerPath),
      );

      await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf-8")).toBe("ralph");
    });

    it("T-EXEC-04a: $LOOPX_WORKFLOW overrides inherited env value", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "workflow-override.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeEnvToFile("LOOPX_WORKFLOW", markerPath),
      );

      // Set LOOPX_WORKFLOW=fake in the loopx process's environment. The
      // injected value must win over this inherited value.
      await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { LOOPX_WORKFLOW: "fake" },
      });

      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf-8")).toBe("ralph");
    });

    it("T-EXEC-04b: cross-workflow goto updates $LOOPX_WORKFLOW to the target workflow", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "cross-workflow-marker.txt");

      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"goto":"other:check"}'`,
      );
      await createWorkflowScript(
        project,
        "other",
        "check",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW" > "${markerPath}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf-8")).toBe("other");
    });

    it("T-EXEC-04c: $LOOPX_WORKFLOW is re-injected correctly after a cross-workflow loop reset", async () => {
      project = await createTempProject();
      const alphaMarker = join(project.dir, "alpha-marker.txt");
      const betaMarker = join(project.dir, "beta-marker.txt");

      // alpha:index appends its workflow name to alphaMarker then emits a
      // cross-workflow goto into beta.
      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW" >> "${alphaMarker}"
printf '{"goto":"beta:step"}'
`,
      );
      // beta:step writes its workflow name to betaMarker, emits no goto (chain
      // ends, loop resets to starting target alpha:index).
      await createWorkflowScript(
        project,
        "beta",
        "step",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW" > "${betaMarker}"
`,
      );

      const result = await runCLI(["run", "-n", "3", "alpha"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(alphaMarker)).toBe(true);
      expect(existsSync(betaMarker)).toBe(true);
      // beta-marker: single write of "beta" during iteration 2.
      expect(readFileSync(betaMarker, "utf-8")).toBe("beta");
      // alpha-marker: writes on iteration 1 and iteration 3 (post-reset).
      expect(readFileSync(alphaMarker, "utf-8")).toBe("alphaalpha");
    });

    it("T-EXEC-03c: child cd does not leak across loop reset", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "cwd-after-cd-reset.txt");
      const outsideDir = tmpdir();

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
ITER_FILE="${project.dir}/iter-bash-reset"
if [[ -f "$ITER_FILE" ]]; then
  ITER=$(cat "$ITER_FILE")
else
  ITER=0
fi
ITER=$((ITER + 1))
printf '%s' "$ITER" > "$ITER_FILE"

if [[ "$ITER" == "1" ]]; then
  cd ${JSON.stringify(outsideDir)}
  exit 0
fi

/bin/pwd -P | tr -d '\\n' > "${markerPath}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const recordedCwd = readFileSync(markerPath, "utf-8");
      expect(recordedCwd).toBe(project.dir);
      expect(recordedCwd).not.toBe(outsideDir);
      expect(recordedCwd).not.toBe(join(project.loopxDir, "ralph"));
    });
  });
});

// ----------------------------------------------------------------------------
// LOOPX_WORKFLOW_DIR (T-WFDIR-01..14)
// ----------------------------------------------------------------------------

describe("TEST-SPEC §4.4 LOOPX_WORKFLOW_DIR", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    it("T-WFDIR-01: injected value equals discovery-time workflow dir and dirname $0", async () => {
      project = await createTempProject();
      const envMarker = join(project.dir, "wfdir-env.json");
      const dirnameMarker = join(project.dir, "wfdir-dirname.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
${observeEnvJsonBash("LOOPX_WORKFLOW_DIR", envMarker)}
printf '%s' "$(dirname "$0")" > ${bashJsonString(dirnameMarker)}
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const observed = readJsonFile<{ present: boolean; value?: string }>(
        envMarker,
      );
      const expected = join(project.loopxDir, "ralph");
      expect(observed).toEqual({ present: true, value: expected });
      expect(readFileSync(dirnameMarker, "utf-8")).toBe(expected);
    });

    it("T-WFDIR-02: value equals project root plus .loopx workflow path", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "wfdir-project-root.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s\n%s' "$LOOPX_WORKFLOW_DIR" "$LOOPX_PROJECT_ROOT" > ${bashJsonString(markerPath)}
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const [wfdir, root] = readFileSync(markerPath, "utf-8").split("\n");
      expect(root).toBe(project.dir);
      expect(wfdir).toBe(join(root, ".loopx", "ralph"));
    });

    it("T-WFDIR-03: value is refreshed on intra-workflow goto", async () => {
      project = await createTempProject();
      const indexMarker = join(project.dir, "wfdir-index.txt");
      const checkMarker = join(project.dir, "wfdir-check.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(indexMarker)}
printf '{"goto":"check"}'
`,
      );
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(checkMarker)}
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      const expected = join(project.loopxDir, "ralph");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(indexMarker, "utf-8")).toBe(expected);
      expect(readFileSync(checkMarker, "utf-8")).toBe(expected);
    });

    it("T-WFDIR-04: value changes on cross-workflow goto", async () => {
      project = await createTempProject();
      const ralphMarker = join(project.dir, "wfdir-ralph.txt");
      const otherMarker = join(project.dir, "wfdir-other.txt");
      const workflowMarker = join(project.dir, "workflow-other.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(ralphMarker)}
printf '{"goto":"other:check"}'
`,
      );
      await createWorkflowScript(
        project,
        "other",
        "check",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(otherMarker)}
printf '%s' "$LOOPX_WORKFLOW" > ${bashJsonString(workflowMarker)}
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(ralphMarker, "utf-8")).toBe(
        join(project.loopxDir, "ralph"),
      );
      expect(readFileSync(otherMarker, "utf-8")).toBe(
        join(project.loopxDir, "other"),
      );
      expect(readFileSync(workflowMarker, "utf-8")).toBe("other");
    });

    it("T-WFDIR-04a: deeper cross-workflow chain observes each workflow dir", async () => {
      project = await createTempProject();
      const alphaMarker = join(project.dir, "wfdir-alpha.txt");
      const betaMarker = join(project.dir, "wfdir-beta.txt");
      const gammaMarker = join(project.dir, "wfdir-gamma.txt");

      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(alphaMarker)}
printf '{"goto":"beta:step"}'
`,
      );
      await createWorkflowScript(
        project,
        "beta",
        "step",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(betaMarker)}
printf '{"goto":"gamma:step"}'
`,
      );
      await createWorkflowScript(
        project,
        "gamma",
        "step",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(gammaMarker)}
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "3", "alpha"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(alphaMarker, "utf-8")).toBe(
        join(project.loopxDir, "alpha"),
      );
      expect(readFileSync(betaMarker, "utf-8")).toBe(
        join(project.loopxDir, "beta"),
      );
      expect(readFileSync(gammaMarker, "utf-8")).toBe(
        join(project.loopxDir, "gamma"),
      );
    });

    it("T-WFDIR-05: value resets to starting workflow after loop reset", async () => {
      project = await createTempProject();
      const alphaLog = join(project.dir, "wfdir-alpha.log");
      const betaLog = join(project.dir, "wfdir-beta.log");

      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s\n' "$LOOPX_WORKFLOW_DIR" >> ${bashJsonString(alphaLog)}
printf '{"goto":"beta:step"}'
`,
      );
      await createWorkflowScript(
        project,
        "beta",
        "step",
        ".sh",
        `#!/bin/bash
printf '%s\n' "$LOOPX_WORKFLOW_DIR" >> ${bashJsonString(betaLog)}
`,
      );

      const result = await runCLI(["run", "-n", "3", "alpha"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(alphaLog, "utf-8").trim().split("\n")).toEqual([
        join(project.loopxDir, "alpha"),
        join(project.loopxDir, "alpha"),
      ]);
      expect(readFileSync(betaLog, "utf-8").trim()).toBe(
        join(project.loopxDir, "beta"),
      );
    });

    it("T-WFDIR-06: value silently overrides inherited env", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "wfdir-inherited.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `${writeEnvToFile("LOOPX_WORKFLOW_DIR", markerPath)}
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { LOOPX_WORKFLOW_DIR: "/tmp/fake-dir" },
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(markerPath, "utf-8")).toBe(
        join(project.loopxDir, "ralph"),
      );
      expect(result.stderr).not.toContain("LOOPX_WORKFLOW_DIR");
    });

    it("T-WFDIR-07: value silently overrides local env file", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "wfdir-local-env.txt");
      const envFilePath = join(project.dir, "local.env");
      await createEnvFile(envFilePath, { LOOPX_WORKFLOW_DIR: "/tmp/fake-dir" });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `${writeEnvToFile("LOOPX_WORKFLOW_DIR", markerPath)}
printf '{"stop":true}'
`,
      );

      const result = await runCLI(
        ["run", "-e", "local.env", "-n", "1", "ralph"],
        {
          cwd: project.dir,
          runtime,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(readFileSync(markerPath, "utf-8")).toBe(
        join(project.loopxDir, "ralph"),
      );
      expect(result.stderr).not.toContain("LOOPX_WORKFLOW_DIR");
    });

    it("T-WFDIR-08: value overrides RunOptions.env", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "wfdir-api-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `${writeEnvToFile("LOOPX_WORKFLOW_DIR", markerPath)}
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  maxIterations: 1,
  env: { LOOPX_WORKFLOW_DIR: "/tmp/fake-dir" }
});
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(markerPath, "utf-8")).toBe(
        join(project.loopxDir, "ralph"),
      );
    });

    it("T-WFDIR-09: dirname $0 equals LOOPX_WORKFLOW_DIR", async () => {
      project = await createTempProject();
      const wfdirMarker = join(project.dir, "wfdir-09.txt");
      const dirnameMarker = join(project.dir, "dirname-09.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(wfdirMarker)}
printf '%s' "$(dirname "$0")" > ${bashJsonString(dirnameMarker)}
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(dirnameMarker, "utf-8")).toBe(
        readFileSync(wfdirMarker, "utf-8"),
      );
    });

    it("T-WFDIR-09a: bash $0 equals absolute discovery-time script path", async () => {
      project = await createTempProject();
      const zeroMarker = join(project.dir, "zero-09a.txt");
      const expectedMarker = join(project.dir, "expected-09a.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$0" > ${bashJsonString(zeroMarker)}
printf '%s/index.sh' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(expectedMarker)}
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(zeroMarker, "utf-8")).toBe(
        readFileSync(expectedMarker, "utf-8"),
      );
    });

    it("T-WFDIR-09b/T-WFDIR-10: symlinked workflow dir preserves symlink spelling", async () => {
      project = await createTempProject();
      const realWorkflowDir = join(project.dir, "real-workflows", "ralph");
      await mkdir(realWorkflowDir, { recursive: true });
      const zeroMarker = join(project.dir, "zero-09b.txt");
      const wfdirMarker = join(project.dir, "wfdir-10.txt");
      const scriptPath = join(realWorkflowDir, "index.sh");
      await writeFile(
        scriptPath,
        `#!/bin/bash
printf '%s' "$0" > ${bashJsonString(zeroMarker)}
printf '%s' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(wfdirMarker)}
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(scriptPath, 0o755);
      await symlink(realWorkflowDir, join(project.loopxDir, "ralph"));

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      const expectedWfdir = join(project.loopxDir, "ralph");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(zeroMarker, "utf-8")).toBe(
        join(expectedWfdir, "index.sh"),
      );
      expect(readFileSync(zeroMarker, "utf-8")).not.toBe(scriptPath);
      expect(readFileSync(wfdirMarker, "utf-8")).toBe(expectedWfdir);
      expect(readFileSync(wfdirMarker, "utf-8")).not.toBe(realWorkflowDir);
    });

    it("T-WFDIR-09c/T-WFDIR-12: symlinked entry script preserves script-path spelling", async () => {
      project = await createTempProject();
      const workflowDir = join(project.loopxDir, "ralph");
      await mkdir(workflowDir, { recursive: true });
      const realScript = join(project.dir, "real-script.sh");
      const zeroMarker = join(project.dir, "zero-09c.txt");
      const dirnameMarker = join(project.dir, "dirname-12.txt");
      const wfdirMarker = join(project.dir, "wfdir-12.txt");
      await writeFile(
        realScript,
        `#!/bin/bash
printf '%s' "$0" > ${bashJsonString(zeroMarker)}
printf '%s' "$(dirname "$0")" > ${bashJsonString(dirnameMarker)}
printf '%s' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(wfdirMarker)}
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(realScript, 0o755);
      await symlink(realScript, join(workflowDir, "index.sh"));

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(zeroMarker, "utf-8")).toBe(
        join(workflowDir, "index.sh"),
      );
      expect(readFileSync(zeroMarker, "utf-8")).not.toBe(realScript);
      expect(readFileSync(dirnameMarker, "utf-8")).toBe(
        readFileSync(wfdirMarker, "utf-8"),
      );
      expect(readFileSync(wfdirMarker, "utf-8")).toBe(workflowDir);
    });

    it("T-WFDIR-09d/T-WFDIR-11: symlinked .loopx dir preserves symlink spelling", async () => {
      project = await createTempProject({ withLoopxDir: false });
      const realLoopxDir = join(project.dir, "real-loopx");
      const realWorkflowDir = join(realLoopxDir, "ralph");
      await mkdir(realWorkflowDir, { recursive: true });
      const zeroMarker = join(project.dir, "zero-09d.txt");
      const dirnameMarker = join(project.dir, "dirname-09d.txt");
      const wfdirMarker = join(project.dir, "wfdir-11.txt");
      const scriptPath = join(realWorkflowDir, "index.sh");
      await writeFile(
        scriptPath,
        `#!/bin/bash
printf '%s' "$0" > ${bashJsonString(zeroMarker)}
printf '%s' "$(dirname "$0")" > ${bashJsonString(dirnameMarker)}
printf '%s' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(wfdirMarker)}
printf '{"stop":true}'
`,
        "utf-8",
      );
      await chmod(scriptPath, 0o755);
      await symlink(realLoopxDir, project.loopxDir);

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      const expectedWfdir = join(project.loopxDir, "ralph");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(zeroMarker, "utf-8")).toBe(
        join(expectedWfdir, "index.sh"),
      );
      expect(readFileSync(zeroMarker, "utf-8")).not.toBe(scriptPath);
      expect(readFileSync(dirnameMarker, "utf-8")).toBe(expectedWfdir);
      expect(readFileSync(wfdirMarker, "utf-8")).toBe(expectedWfdir);
      expect(readFileSync(wfdirMarker, "utf-8")).not.toBe(realWorkflowDir);
    });

    it("T-WFDIR-13: sourced bash helper observes same value as top-level script", async () => {
      project = await createTempProject();
      const workflowDir = join(project.loopxDir, "ralph");
      const libDir = join(workflowDir, "lib");
      await mkdir(libDir, { recursive: true });
      const topMarker = join(project.dir, "wfdir-top-bash.txt");
      const helperMarker = join(project.dir, "wfdir-helper-bash.txt");
      await writeFile(
        join(libDir, "helper.sh"),
        `printf '%s' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(helperMarker)}
`,
        "utf-8",
      );
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > ${bashJsonString(topMarker)}
source "$LOOPX_WORKFLOW_DIR/lib/helper.sh"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(helperMarker, "utf-8")).toBe(
        readFileSync(topMarker, "utf-8"),
      );
    });

    it("T-WFDIR-13a: imported TS helper observes same value as top-level script", async () => {
      project = await createTempProject();
      const workflowDir = join(project.loopxDir, "ralph");
      const libDir = join(workflowDir, "lib");
      await mkdir(libDir, { recursive: true });
      const topMarker = join(project.dir, "wfdir-top-ts.txt");
      const helperMarker = join(project.dir, "wfdir-helper-ts.txt");
      await writeFile(
        join(libDir, "helper.ts"),
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(helperMarker)}, process.env.LOOPX_WORKFLOW_DIR ?? "");
`,
        "utf-8",
      );
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
import { output } from "loopx";
import "./lib/helper.ts";
writeFileSync(${JSON.stringify(topMarker)}, process.env.LOOPX_WORKFLOW_DIR ?? "");
output({ stop: true });
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(helperMarker, "utf-8")).toBe(
        readFileSync(topMarker, "utf-8"),
      );
    });

    it("T-WFDIR-14: cross-workflow rendezvous through workflow dirs does not work", async () => {
      project = await createTempProject();

      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".sh",
        `#!/bin/bash
printf 'alpha-state' > "$LOOPX_WORKFLOW_DIR/shared.tmp"
printf '{"goto":"beta:index"}'
`,
      );
      await createWorkflowScript(
        project,
        "beta",
        "index",
        ".sh",
        `#!/bin/bash
if [[ -f "$LOOPX_WORKFLOW_DIR/shared.tmp" ]]; then
  VALUE=$(cat "$LOOPX_WORKFLOW_DIR/shared.tmp")
  printf '{"result":"%s","stop":true}' "$VALUE"
else
  printf '{"result":"missing","stop":true}'
fi
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("alpha", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
process.stdout.write(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs.at(-1)?.result).toBe("missing");
    });
  });
});

// ----------------------------------------------------------------------------
// Bash Scripts (T-EXEC-05..07)
// ----------------------------------------------------------------------------

describe("TEST-SPEC §4.4 Bash Scripts", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    it("T-EXEC-05: bash stdout is captured as structured output (observed via runPromise)", async () => {
      project = await createTempProject();

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        emitResult("bash-output-captured"),
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { maxIterations: 1, cwd: ${JSON.stringify(project.dir)} });
process.stdout.write(JSON.stringify(outputs));
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("bash-output-captured");
    });

    it("T-EXEC-06: bash script stderr passes through to the CLI's stderr", async () => {
      project = await createTempProject();

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeStderr("STDERR_SENTINEL_MSG"),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.stderr).toContain("STDERR_SENTINEL_MSG");
    });

    it("T-EXEC-07: a .sh script without a shebang still runs (invoked via /bin/bash)", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "no-shebang-marker.txt");

      // No #!/bin/bash — just raw bash commands. loopx must invoke /bin/bash
      // explicitly, so the shebang is unnecessary.
      const scriptContent =
        `printf '%s' 'no-shebang-ran' > "${markerPath}"\nprintf '{"result":"ok"}'\n`;

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        scriptContent,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf-8")).toBe("no-shebang-ran");
    });
  });
});

// ----------------------------------------------------------------------------
// JS/TS Scripts (T-EXEC-08..14, 13a/13b)
// ----------------------------------------------------------------------------

describe("TEST-SPEC §4.4 JS/TS Scripts", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    it("T-EXEC-08: .ts script runs and produces structured output", async () => {
      project = await createTempProject();

      const tsContent = `process.stdout.write(JSON.stringify({ result: "ts-output-ok" }));\n`;
      await createWorkflowScript(project, "ralph", "index", ".ts", tsContent);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { maxIterations: 1, cwd: ${JSON.stringify(project.dir)} });
process.stdout.write(JSON.stringify(outputs));
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("ts-output-ok");
    });

    it("T-EXEC-09: .js script runs and produces structured output", async () => {
      project = await createTempProject();

      const jsContent = `process.stdout.write(JSON.stringify({ result: "js-output-ok" }));\n`;
      await createWorkflowScript(project, "ralph", "index", ".js", jsContent);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { maxIterations: 1, cwd: ${JSON.stringify(project.dir)} });
process.stdout.write(JSON.stringify(outputs));
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("js-output-ok");
    });

    it("T-EXEC-10: .tsx script with real TSX syntax produces structured output", async () => {
      project = await createTempProject();

      // Real TSX: type-annotated arg + JSX element literal. Uses a local
      // createElement shim to avoid requiring a real React dependency.
      const tsxContent = `const React = { createElement: (tag: string) => tag };
const el = <div/>;
process.stdout.write(JSON.stringify({ result: String(el) }));
`;
      await createWorkflowScript(project, "ralph", "index", ".tsx", tsxContent);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { maxIterations: 1, cwd: ${JSON.stringify(project.dir)} });
process.stdout.write(JSON.stringify(outputs));
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      // React.createElement("div") returns "div" via the shim.
      expect(outputs[0].result).toBe("div");
    });

    it("T-EXEC-11: .jsx script with real JSX syntax produces structured output", async () => {
      project = await createTempProject();

      const jsxContent = `const React = { createElement: (tag) => tag };
const el = <span/>;
process.stdout.write(JSON.stringify({ result: String(el) }));
`;
      await createWorkflowScript(project, "ralph", "index", ".jsx", jsxContent);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { maxIterations: 1, cwd: ${JSON.stringify(project.dir)} });
process.stdout.write(JSON.stringify(outputs));
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("span");
    });

    it("T-EXEC-12: JS/TS script stderr passes through to the CLI's stderr", async () => {
      project = await createTempProject();

      const tsContent = `process.stderr.write("TS_STDERR_SENTINEL\\n");
process.stdout.write(JSON.stringify({ result: "ok" }));
`;
      await createWorkflowScript(project, "ralph", "index", ".ts", tsContent);

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.stderr).toContain("TS_STDERR_SENTINEL");
    });

    it("T-EXEC-13a: a .js script that uses require() (CJS) fails with an error", async () => {
      project = await createTempProject();

      const cjsContent = `const fs = require("fs");
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`;
      await createWorkflowScript(project, "ralph", "index", ".js", cjsContent);

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      // CJS is not supported. loopx must exit non-zero.
      expect(result.exitCode).not.toBe(0);
    });
  });

  // T-EXEC-13: Node-specific (verifies tsx handles TS syntax under Node.js)
  it("T-EXEC-13: TypeScript annotations work under Node.js (via tsx) [Node]", async () => {
    project = await createTempProject();

    const tsContent = `interface Greeting {
  message: string;
  count: number;
}

function greet(name: string, times: number): Greeting {
  return { message: \`hello \${name}\`, count: times };
}

const r: Greeting = greet("world", 42);
process.stdout.write(JSON.stringify({ result: r.message }));
`;
    await createWorkflowScript(project, "ralph", "index", ".ts", tsContent);

    const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { maxIterations: 1, cwd: ${JSON.stringify(project.dir)} });
process.stdout.write(JSON.stringify(outputs));
`;

    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
    });

    expect(result.exitCode).toBe(0);
    const outputs = JSON.parse(result.stdout);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].result).toBe("hello world");
  });

  // T-EXEC-13b: Bun-specific (TS annotations under Bun's native runtime)
  it.skipIf(!isRuntimeAvailable("bun"))(
    "T-EXEC-13b: TypeScript annotations work under Bun (native TS support) [Bun]",
    async () => {
      project = await createTempProject();

      const tsContent = `interface Result {
  value: string;
  ok: boolean;
}

function compute(x: number): Result {
  return { value: String(x * 2), ok: true };
}

const r: Result = compute(21);
process.stdout.write(JSON.stringify({ result: r.value }));
`;
      await createWorkflowScript(project, "ralph", "index", ".ts", tsContent);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { maxIterations: 1, cwd: ${JSON.stringify(project.dir)} });
process.stdout.write(JSON.stringify(outputs));
`;

      const result = await runAPIDriver("bun", driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("42");
    },
  );

  // T-EXEC-14: Bun-specific (confirm Bun's native runtime is used, not tsx)
  it.skipIf(!isRuntimeAvailable("bun"))(
    "T-EXEC-14: under Bun, TS scripts run via Bun's native runtime (not tsx) [Bun]",
    async () => {
      project = await createTempProject();

      const tsContent = `import { output } from "loopx";
output({ result: JSON.stringify({ bunVersion: process.versions.bun }) });
`;
      await createWorkflowScript(project, "ralph", "index", ".ts", tsContent);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { maxIterations: 1, cwd: ${JSON.stringify(project.dir)} });
console.log(JSON.stringify(outputs));
`;

      const result = await runAPIDriver("bun", driverCode, {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      // process.versions.bun is only defined when a script actually runs under
      // Bun's runtime. If loopx delegated to tsx-on-Node instead, this value
      // would be undefined, and JSON.parse would observe a different shape.
      const parsed = JSON.parse(outputs[0].result);
      expect(parsed.bunVersion).toBeTruthy();
      expect(typeof parsed.bunVersion).toBe("string");
    },
  );
});

// ----------------------------------------------------------------------------
// Workflow-Local Dependencies & cwd semantics (T-EXEC-15, 16, 16a, 16b)
// ----------------------------------------------------------------------------

describe("TEST-SPEC §4.4 Workflow-Local Dependencies", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    it("T-EXEC-15: workflow with its own node_modules can import local dependencies", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "import-marker.txt");

      await createWorkflowScript(
        project,
        "with-deps",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
import { greeting } from "my-local-lib";
writeFileSync(${JSON.stringify(markerPath)}, greeting);
process.stdout.write(JSON.stringify({ result: greeting }));
`,
      );

      // Install a local ESM dep in the workflow's node_modules. Node/tsx/bun
      // resolve bare specifiers from the importing script's file location.
      const depDir = join(
        project.loopxDir,
        "with-deps",
        "node_modules",
        "my-local-lib",
      );
      await mkdir(depDir, { recursive: true });
      await writeFile(
        join(depDir, "package.json"),
        JSON.stringify({
          name: "my-local-lib",
          type: "module",
          main: "index.js",
        }),
        "utf-8",
      );
      await writeFile(
        join(depDir, "index.js"),
        `export const greeting = "hello-from-local-dep";\n`,
        "utf-8",
      );

      const result = await runCLI(["run", "-n", "1", "with-deps"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf-8")).toBe("hello-from-local-dep");
    });

    it("T-EXEC-16: JS/TS script cwd equals the project root", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "ts-cwd-marker.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerPath)}, process.cwd());
process.stdout.write(JSON.stringify({ result: "ok" }));
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const workflowDir = join(project.loopxDir, "ralph");
      const recordedCwd = readFileSync(markerPath, "utf-8");
      expect(recordedCwd).toBe(project.dir);
      expect(recordedCwd).not.toBe(workflowDir);
    });

    it("T-EXEC-16a: workflow importing a package not present in its node_modules fails with exit 1", async () => {
      project = await createTempProject();

      await createWorkflowScript(
        project,
        "missing-dep",
        "index",
        ".ts",
        `import "nonexistent-pkg";
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`,
      );

      const result = await runCLI(["run", "-n", "1", "missing-dep"], {
        cwd: project.dir,
        runtime,
      });

      // A module-resolution error from the active runtime must bubble up as
      // exit code 1 — loopx does not silently swallow the failure.
      expect(result.exitCode).toBe(1);
    });

    it("T-EXEC-16b: cross-workflow goto preserves project-root cwd", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "cross-cwd-marker.txt");
      const workflowDirMarkerPath = join(project.dir, "cross-wfdir-marker.txt");

      // ralph:index transitions into other:check
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"goto":"other:check"}'`,
      );
      // other:check records cwd and workflow-dir, then stops so the chain ends.
      await createWorkflowScript(
        project,
        "other",
        "check",
        ".sh",
        `#!/bin/bash
/bin/pwd -P | tr -d '\\n' > "${markerPath}"
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${workflowDirMarkerPath}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      expect(existsSync(workflowDirMarkerPath)).toBe(true);
      const recordedCwd = readFileSync(markerPath, "utf-8");
      const otherDir = join(project.loopxDir, "other");
      const ralphDir = join(project.loopxDir, "ralph");
      expect(recordedCwd).toBe(project.dir);
      expect(recordedCwd).not.toBe(ralphDir);
      expect(recordedCwd).not.toBe(otherDir);
      expect(readFileSync(workflowDirMarkerPath, "utf-8")).toBe(otherDir);
    });

    it("T-EXEC-16c: JS/TS process.chdir() does not leak across intra-workflow goto", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "ts-cwd-after-chdir-goto.txt");
      const outsideDir = tmpdir();

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";
process.chdir(${JSON.stringify(outsideDir)});
output({ goto: "check" });
`,
      );
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".ts",
        `import { writeFileSync } from "node:fs";
import { output } from "loopx";
writeFileSync(${JSON.stringify(markerPath)}, process.cwd());
output({ stop: true });
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const recordedCwd = readFileSync(markerPath, "utf-8");
      expect(recordedCwd).toBe(project.dir);
      expect(recordedCwd).not.toBe(outsideDir);
      expect(recordedCwd).not.toBe(join(project.loopxDir, "ralph"));
    });

    it("T-EXEC-16d: JS/TS process.chdir() does not leak across loop reset", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "ts-cwd-after-chdir-reset.txt");
      const outsideDir = tmpdir();

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { output } from "loopx";

const iterFile = ${JSON.stringify(join(project.dir, "iter-ts-reset"))};
const iter = existsSync(iterFile) ? Number(readFileSync(iterFile, "utf-8")) + 1 : 1;
writeFileSync(iterFile, String(iter));

if (iter === 1) {
  process.chdir(${JSON.stringify(outsideDir)});
} else {
  writeFileSync(${JSON.stringify(markerPath)}, process.cwd());
  output({ stop: true });
}
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const recordedCwd = readFileSync(markerPath, "utf-8");
      expect(recordedCwd).toBe(project.dir);
      expect(recordedCwd).not.toBe(outsideDir);
      expect(recordedCwd).not.toBe(join(project.loopxDir, "ralph"));
    });
  });
});
