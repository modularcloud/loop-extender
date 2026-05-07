import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  createTempProject,
  createWorkflow,
  createWorkflowScript,
  createBashWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { createEnvFile } from "../helpers/env.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { runCLI, runCLIWithSignal } from "../helpers/cli.js";
import { forEachRuntime, isRuntimeAvailable } from "../helpers/runtime.js";

// ADR-0004 execution context additions:
// - scripts run with the project root as cwd
// - LOOPX_WORKFLOW_DIR exposes the current workflow directory
// - LOOPX_TMPDIR exposes run-scoped scratch space and is cleaned up on exit

describe("TEST-SPEC §4.7 LOOPX_WORKFLOW_DIR", () => {
  let project: TempProject | null = null;
  const extraCleanups: Array<() => Promise<void>> = [];

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
    it("T-WFDIR-01/T-WFDIR-02/T-WFDIR-09/T-WFDIR-09a: LOOPX_WORKFLOW_DIR equals dirname \"$0\" byte-for-byte for Bash", async () => {
      project = await createTempProject();
      const wfdirMarker = join(project.dir, "wfdir.txt");
      const dirnameMarker = join(project.dir, "dirname.txt");
      const argv0Marker = join(project.dir, "argv0.txt");

      const scriptPath = await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
dirname "$0" | tr -d '\\n' > "${dirnameMarker}"
printf '%s' "$0" > "${argv0Marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(wfdirMarker, "utf-8")).toBe(
        join(project.loopxDir, "ralph"),
      );
      expect(readFileSync(dirnameMarker, "utf-8")).toBe(
        readFileSync(wfdirMarker, "utf-8"),
      );
      expect(readFileSync(argv0Marker, "utf-8")).toBe(scriptPath);
    });

    it("T-WFDIR-03: LOOPX_WORKFLOW_DIR is refreshed on intra-workflow goto", async () => {
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

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const expected = join(project.loopxDir, "ralph");
      expect(readFileSync(indexMarker, "utf-8")).toBe(expected);
      expect(readFileSync(checkMarker, "utf-8")).toBe(expected);
    });

    it("T-WFDIR-04: LOOPX_WORKFLOW_DIR changes on cross-workflow goto while cwd remains project root", async () => {
      project = await createTempProject();
      const alphaMarker = join(project.dir, "alpha-wfdir.txt");
      const betaMarker = join(project.dir, "beta-wfdir.txt");
      const betaCwdMarker = join(project.dir, "beta-cwd.txt");

      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${alphaMarker}"
printf '{"goto":"beta:step"}'
`,
      );
      await createWorkflowScript(
        project,
        "beta",
        "step",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${betaMarker}"
/bin/pwd -P | tr -d '\\n' > "${betaCwdMarker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "2", "alpha"], {
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
      expect(readFileSync(betaCwdMarker, "utf-8")).toBe(project.dir);
    });

    it("T-WFDIR-04a: LOOPX_WORKFLOW_DIR follows a deeper cross-workflow chain", async () => {
      project = await createTempProject();
      const alphaMarker = join(project.dir, "alpha-chain-wfdir.txt");
      const betaMarker = join(project.dir, "beta-chain-wfdir.txt");
      const gammaMarker = join(project.dir, "gamma-chain-wfdir.txt");

      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${alphaMarker}"
printf '{"goto":"beta:step"}'
`,
      );
      await createWorkflowScript(
        project,
        "beta",
        "step",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${betaMarker}"
printf '{"goto":"gamma:finish"}'
`,
      );
      await createWorkflowScript(
        project,
        "gamma",
        "finish",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${gammaMarker}"
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

    it("T-WFDIR-05: LOOPX_WORKFLOW_DIR resets with the loop starting target", async () => {
      project = await createTempProject();
      const alphaLog = join(project.dir, "alpha-wfdir.log");
      const betaLog = join(project.dir, "beta-wfdir.log");

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

    it("T-WFDIR-06: LOOPX_WORKFLOW_DIR silently overrides inherited env", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "wfdir-inherited.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { LOOPX_WORKFLOW_DIR: "/tmp/fake-dir" },
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe(join(project.loopxDir, "ralph"));
      expect(result.stderr).not.toMatch(/LOOPX_WORKFLOW_DIR.*overrid/i);
    });

    it("T-WFDIR-07: LOOPX_WORKFLOW_DIR silently overrides local env-file values", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "wfdir-envfile.txt");
      const envFile = join(project.dir, "local.env");
      await createEnvFile(envFile, { LOOPX_WORKFLOW_DIR: "/tmp/fake-dir" });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-e", "local.env", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe(join(project.loopxDir, "ralph"));
      expect(result.stderr).not.toMatch(/LOOPX_WORKFLOW_DIR.*overrid/i);
    });
  });

  it("T-WFDIR-08: LOOPX_WORKFLOW_DIR overrides RunOptions.env values", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "wfdir-api.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.LOOPX_WORKFLOW_DIR ?? "");
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { LOOPX_WORKFLOW_DIR: "/tmp/fake-dir" },
});
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(join(project.loopxDir, "ralph"));
  });

  it("T-SYM-01/T-SYM-05/T-WFDIR-10/T-WFDIR-11/T-WFDIR-12: discovery-time symlink spelling is preserved", async () => {
    project = await createTempProject({ withLoopxDir: false });
    const realRoot = await mkdtemp(join(tmpdir(), "loopx-real-loopx-"));
    extraCleanups.push(() => rm(realRoot, { recursive: true, force: true }));
    await mkdir(join(realRoot, "ralph"), { recursive: true });
    const marker = join(project.dir, "wfdir-symlink.txt");
    await writeFile(
      join(realRoot, "ralph", "index.sh"),
      `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${marker}"
printf '{"stop":true}'
`,
      "utf-8",
    );
    await chmod(join(realRoot, "ralph", "index.sh"), 0o755);
    symlinkSync(realRoot, project.loopxDir, "dir");

    const result = await runCLI(["run", "ralph"], {
      cwd: project.dir,
      runtime: "node",
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(join(project.dir, ".loopx", "ralph"));
    expect(readFileSync(marker, "utf-8")).not.toBe(join(realRoot, "ralph"));
  });

  it("T-SYM-02a/T-WFDIR-09b: Bash $0 preserves symlinked workflow directory spelling", async () => {
    project = await createTempProject();
    const realWorkflowDir = await mkdtemp(join(tmpdir(), "loopx-real-workflow-"));
    extraCleanups.push(() => rm(realWorkflowDir, { recursive: true, force: true }));
    const workflowLink = join(project.loopxDir, "ralph");
    const argv0Marker = join(project.dir, "argv0-workflow-link.txt");
    const dirnameMarker = join(project.dir, "dirname-workflow-link.txt");

    await writeFile(
      join(realWorkflowDir, "index.sh"),
      `#!/bin/bash
printf '%s' "$0" > "${argv0Marker}"
dirname "$0" | tr -d '\\n' > "${dirnameMarker}"
printf '{"stop":true}'
`,
      "utf-8",
    );
    await chmod(join(realWorkflowDir, "index.sh"), 0o755);
    symlinkSync(realWorkflowDir, workflowLink, "dir");

    const result = await runCLI(["run", "ralph"], {
      cwd: project.dir,
      runtime: "node",
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(argv0Marker, "utf-8")).toBe(join(workflowLink, "index.sh"));
    expect(readFileSync(dirnameMarker, "utf-8")).toBe(workflowLink);
  });

  it("T-SYM-02b/T-WFDIR-09c: Bash $0 preserves symlinked entry script spelling", async () => {
    project = await createTempProject();
    const realScriptDir = await mkdtemp(join(tmpdir(), "loopx-real-script-"));
    extraCleanups.push(() => rm(realScriptDir, { recursive: true, force: true }));
    const workflowDir = await createWorkflow(project, "ralph");
    const entryLink = join(workflowDir, "index.sh");
    const realScript = join(realScriptDir, "real-index.sh");
    const argv0Marker = join(project.dir, "argv0-script-link.txt");

    await writeFile(
      realScript,
      `#!/bin/bash
printf '%s' "$0" > "${argv0Marker}"
printf '{"stop":true}'
`,
      "utf-8",
    );
    await chmod(realScript, 0o755);
    symlinkSync(realScript, entryLink, "file");

    const result = await runCLI(["run", "ralph"], {
      cwd: project.dir,
      runtime: "node",
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(argv0Marker, "utf-8")).toBe(entryLink);
  });

  it("T-WFDIR-09d: Bash $0 and LOOPX_WORKFLOW_DIR preserve symlinked .loopx spelling", async () => {
    project = await createTempProject({ withLoopxDir: false });
    const realLoopxDir = await mkdtemp(join(tmpdir(), "loopx-real-loopx-root-"));
    extraCleanups.push(() => rm(realLoopxDir, { recursive: true, force: true }));
    await mkdir(join(realLoopxDir, "ralph"), { recursive: true });
    const argv0Marker = join(project.dir, "argv0-loopx-link.txt");
    const dirnameMarker = join(project.dir, "dirname-loopx-link.txt");
    const wfdirMarker = join(project.dir, "wfdir-loopx-link.txt");

    await writeFile(
      join(realLoopxDir, "ralph", "index.sh"),
      `#!/bin/bash
printf '%s' "$0" > "${argv0Marker}"
dirname "$0" | tr -d '\\n' > "${dirnameMarker}"
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
printf '{"stop":true}'
`,
      "utf-8",
    );
    await chmod(join(realLoopxDir, "ralph", "index.sh"), 0o755);
    symlinkSync(realLoopxDir, project.loopxDir, "dir");

    const result = await runCLI(["run", "ralph"], {
      cwd: project.dir,
      runtime: "node",
    });

    expect(result.exitCode).toBe(0);
    const expectedWorkflowDir = join(project.dir, ".loopx", "ralph");
    expect(readFileSync(argv0Marker, "utf-8")).toBe(
      join(expectedWorkflowDir, "index.sh"),
    );
    expect(readFileSync(dirnameMarker, "utf-8")).toBe(expectedWorkflowDir);
    expect(readFileSync(wfdirMarker, "utf-8")).toBe(expectedWorkflowDir);
  });

  it("T-WFDIR-13: Bash top-level script and sourced helper observe the same LOOPX_WORKFLOW_DIR", async () => {
    project = await createTempProject();
    const workflowDir = await createWorkflow(project, "ralph");
    const indexMarker = join(project.dir, "bash-index-wfdir.txt");
    const helperMarker = join(project.dir, "bash-helper-wfdir.txt");

    await writeFile(
      join(workflowDir, "helper.sh"),
      `printf '%s' "$LOOPX_WORKFLOW_DIR" > "${helperMarker}"\n`,
      "utf-8",
    );
    await writeFile(
      join(workflowDir, "index.sh"),
      `#!/bin/bash
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${indexMarker}"
. "$LOOPX_WORKFLOW_DIR/helper.sh"
printf '{"stop":true}'
`,
      "utf-8",
    );
    await chmod(join(workflowDir, "index.sh"), 0o755);

    const result = await runCLI(["run", "ralph"], {
      cwd: project.dir,
      runtime: "node",
    });

    expect(result.exitCode).toBe(0);
    const expectedWorkflowDir = join(project.loopxDir, "ralph");
    expect(readFileSync(indexMarker, "utf-8")).toBe(expectedWorkflowDir);
    expect(readFileSync(helperMarker, "utf-8")).toBe(expectedWorkflowDir);
  });

  it("T-WFDIR-13a: TypeScript top-level script and imported helper observe the same LOOPX_WORKFLOW_DIR", async () => {
    project = await createTempProject();
    const workflowDir = await createWorkflow(project, "ralph");
    const helperDir = join(workflowDir, "lib");
    const indexMarker = join(project.dir, "ts-index-wfdir.txt");
    const helperMarker = join(project.dir, "ts-helper-wfdir.txt");
    await mkdir(helperDir, { recursive: true });

    await writeFile(
      join(helperDir, "helper.ts"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(helperMarker)}, process.env.LOOPX_WORKFLOW_DIR ?? "");
`,
      "utf-8",
    );
    await writeFile(
      join(workflowDir, "index.ts"),
      `import { writeFileSync } from "node:fs";
import "./lib/helper.ts";
writeFileSync(${JSON.stringify(indexMarker)}, process.env.LOOPX_WORKFLOW_DIR ?? "");
process.stdout.write(JSON.stringify({ stop: true }));
`,
      "utf-8",
    );

    const result = await runCLI(["run", "ralph"], {
      cwd: project.dir,
      runtime: "node",
    });

    expect(result.exitCode).toBe(0);
    const expectedWorkflowDir = join(project.loopxDir, "ralph");
    expect(readFileSync(indexMarker, "utf-8")).toBe(expectedWorkflowDir);
    expect(readFileSync(helperMarker, "utf-8")).toBe(expectedWorkflowDir);
  });

  it("T-WFDIR-14: cross-workflow rendezvous through LOOPX_WORKFLOW_DIR stays workflow-local", async () => {
    project = await createTempProject();
    const betaResultMarker = join(project.dir, "beta-shared-result.txt");

    await createWorkflowScript(
      project,
      "alpha",
      "index",
      ".sh",
      `#!/bin/bash
printf 'alpha' > "$LOOPX_WORKFLOW_DIR/shared.tmp"
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
  printf 'found' > "${betaResultMarker}"
else
  printf 'missing' > "${betaResultMarker}"
fi
printf '{"stop":true}'
`,
    );

    const result = await runCLI(["run", "-n", "2", "alpha"], {
      cwd: project.dir,
      runtime: "node",
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(betaResultMarker, "utf-8")).toBe("missing");
    expect(readFileSync(join(project.loopxDir, "alpha", "shared.tmp"), "utf-8")).toBe(
      "alpha",
    );
    expect(existsSync(join(project.loopxDir, "beta", "shared.tmp"))).toBe(false);
  });
});

describe("TEST-SPEC §4.7 symlink spelling and identity", () => {
  let cleanupDir: string | null = null;

  afterEach(async () => {
    if (cleanupDir) {
      await rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
      cleanupDir = null;
    }
  });

  async function createLinkedProject(): Promise<{
    realProject: string;
    linkProject: string;
    project: TempProject;
  }> {
    cleanupDir = await mkdtemp(join(tmpdir(), "loopx-sym-"));
    const realProject = join(cleanupDir, "real-project");
    const linkProject = join(cleanupDir, "link-project");
    await mkdir(join(realProject, ".loopx"), { recursive: true });
    symlinkSync(realProject, linkProject, "dir");
    return {
      realProject,
      linkProject,
      project: {
        dir: realProject,
        loopxDir: join(realProject, ".loopx"),
        cleanup: async () => {},
      },
    };
  }

  forEachRuntime((runtime) => {
    it("T-SYM-02/T-SYM-02c/T-SYM-02d: CLI symlinked cwd tracks runtime process.cwd() spelling and cwd identity", async () => {
      const { realProject, linkProject, project } = await createLinkedProject();
      const marker = join(realProject, "cli-symlink-cwd.txt");

      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s\\n%s\\n%s\\n%s' "$LOOPX_PROJECT_ROOT" "$LOOPX_WORKFLOW_DIR" "$0" "$(pwd -P)" > "${marker}"
printf '{"stop":true}'`,
      );

      const expected = await runAPIDriver(
        runtime,
        "process.stdout.write(process.cwd());",
        { cwd: linkProject },
      );
      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: linkProject,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const [root, workflowDir, argv0] = readFileSync(marker, "utf-8").split("\n");
      expect(root).toBe(expected.stdout);
      expect(workflowDir).toBe(join(expected.stdout, ".loopx", "ralph"));
      expect(dirname(argv0)).toBe(workflowDir);
      expect(statSync(linkProject).dev).toBe(statSync(realProject).dev);
      expect(statSync(linkProject).ino).toBe(statSync(realProject).ino);
    });
  });

  it("T-SYM-03/T-SYM-04/T-SYM-04d/T-SYM-06/T-SYM-06a: RunOptions.cwd preserves symlinked project spelling through workflow dir and Bash $0", async () => {
    const { linkProject, project } = await createLinkedProject();
    const marker = join(project.dir, "api-symlink-cwd.txt");

    await createBashWorkflowScript(
      project,
      "ralph",
      "index",
      `printf '%s\\n%s\\n%s\\n%s' "$LOOPX_PROJECT_ROOT" "$LOOPX_WORKFLOW_DIR" "$0" "$(pwd -P)" > "${marker}"
printf '{"stop":true}'`,
    );

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", { cwd: ${JSON.stringify(linkProject)}, maxIterations: 1 });
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    const [root, workflowDir, argv0] = readFileSync(marker, "utf-8").split("\n");
    expect(root).toBe(linkProject);
    expect(workflowDir).toBe(join(linkProject, ".loopx", "ralph"));
    expect(argv0).toBe(join(linkProject, ".loopx", "ralph", "index.sh"));
    expect(dirname(argv0)).toBe(workflowDir);
    expect(statSync(root).dev).toBe(statSync(project.dir).dev);
    expect(statSync(root).ino).toBe(statSync(project.dir).ino);
  });

  it("T-SYM-04a/T-SYM-04b/T-SYM-04c: absolute RunOptions.cwd spellings are not normalized before injection", async () => {
    cleanupDir = await mkdtemp(join(tmpdir(), "loopx-sym-absolute-"));
    const realProject = join(cleanupDir, "real-project");
    const adjacent = join(cleanupDir, "adjacent");
    await mkdir(join(realProject, ".loopx"), { recursive: true });
    await mkdir(adjacent, { recursive: true });
    const project: TempProject = {
      dir: realProject,
      loopxDir: join(realProject, ".loopx"),
      cleanup: async () => {},
    };
    const marker = join(realProject, "absolute-cwd-spellings.log");

    await createBashWorkflowScript(
      project,
      "ralph",
      "index",
      `printf '%s\\n%s\\n%s\\n---\\n' "$LOOPX_PROJECT_ROOT" "$LOOPX_WORKFLOW_DIR" "$0" >> "${marker}"
printf '{"stop":true}'`,
    );

    const trailing = `${realProject}/`;
    const lexical = join(adjacent, "..", "real-project");
    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", { cwd: ${JSON.stringify(trailing)}, maxIterations: 1 });
await runPromise("ralph", { cwd: ${JSON.stringify(lexical)}, maxIterations: 1 });
`;
    const result = await runAPIDriver("node", driverCode, { cwd: realProject });

    expect(result.exitCode).toBe(0);
    const records = readFileSync(marker, "utf-8")
      .trim()
      .split("\n---\n")
      .map((entry) => entry.split("\n"));
    expect(records[0][0]).toBe(trailing);
    expect(records[1][0]).toBe(lexical);
    for (const [, workflowDir, argv0] of records) {
      expect(dirname(argv0)).toBe(workflowDir);
      expect(statSync(argv0).ino).toBe(
        statSync(join(realProject, ".loopx", "ralph", "index.sh")).ino,
      );
    }
  });

  forEachRuntime((runtime) => {
    it.skipIf(runtime === "bun" && !isRuntimeAvailable("bun"))(
      `T-SYM-07/T-SYM-07b: import.meta.url directory equals LOOPX_WORKFLOW_DIR for symlink-free JS/TS entries [${runtime}]`,
      async () => {
        const project = await createTempProject();
        cleanupDir = project.dir;
        const marker = join(project.dir, "import-meta-symlink-free.json");
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".ts",
          `import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { output } from "loopx";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  workflowDir: process.env.LOOPX_WORKFLOW_DIR,
  importMetaDir: dirname(fileURLToPath(import.meta.url)),
}));
output({ stop: true });
`,
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const observed = JSON.parse(readFileSync(marker, "utf-8"));
        expect(observed.importMetaDir).toBe(observed.workflowDir);
      },
    );
  });

  it("T-SYM-07a: Node symlinked JS/TS entry keeps LOOPX_WORKFLOW_DIR authoritative without warnings", async () => {
    const project = await createTempProject();
    cleanupDir = project.dir;
    const workflowDir = await createWorkflow(project, "ralph");
    const realEntryDir = await mkdtemp(join(tmpdir(), "loopx-sym-entry-"));
    const marker = join(project.dir, "import-meta-symlinked.json");

    try {
      await writeFile(
        join(realEntryDir, "index.ts"),
        `import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { output } from "loopx";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  workflowDir: process.env.LOOPX_WORKFLOW_DIR,
  importMetaDir: dirname(fileURLToPath(import.meta.url)),
}));
output({ stop: true });
`,
        "utf-8",
      );
      symlinkSync(join(realEntryDir, "index.ts"), join(workflowDir, "index.ts"));

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime: "node",
      });

      expect(result.exitCode).toBe(0);
      const observed = JSON.parse(readFileSync(marker, "utf-8"));
      expect(observed.workflowDir).toBe(workflowDir);
      expect(result.stderr).not.toMatch(/symlink|canonical|workflow-local/i);
    } finally {
      await rm(realEntryDir, { recursive: true, force: true });
    }
  });

  it("T-SYM-08: Node child runtime is not passed symlink-preservation flags", async () => {
    const project = await createTempProject();
    cleanupDir = project.dir;
    const marker = join(project.dir, "node-flags.json");
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
import { output } from "loopx";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  execArgv: process.execArgv,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
}));
output({ stop: true });
`,
    );

    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env,
    });

    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(readFileSync(marker, "utf-8"));
    expect(observed.execArgv).not.toContain("--preserve-symlinks");
    expect(observed.execArgv).not.toContain("--preserve-symlinks-main");
    expect(observed.nodeOptions ?? "").not.toContain("--preserve-symlinks");
    expect(observed.nodeOptions ?? "").not.toContain("--preserve-symlinks-main");
  });

  it("T-SYM-09: omitted RunOptions.cwd captures symlinked driver cwd for runPromise and run", async () => {
    const { linkProject, project } = await createLinkedProject();
    const marker = join(project.dir, "omitted-cwd.log");

    await createBashWorkflowScript(
      project,
      "ralph",
      "index",
      `printf '%s\\n%s\\n%s\\n---\\n' "$LOOPX_PROJECT_ROOT" "$LOOPX_WORKFLOW_DIR" "$(pwd -P)" >> "${marker}"
printf '{"stop":true}'`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
process.chdir(${JSON.stringify(linkProject)});
const expectedRoot = process.cwd();
await runPromise("ralph", { maxIterations: 1 });
for await (const _ of run("ralph", { maxIterations: 1 })) {}
process.stdout.write(expectedRoot);
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    const records = readFileSync(marker, "utf-8")
      .trim()
      .split("\n---\n")
      .map((entry) => entry.split("\n"));
    expect(records).toHaveLength(2);
    for (const [root, workflowDir] of records) {
      expect(root).toBe(result.stdout);
      expect(workflowDir).toBe(join(result.stdout, ".loopx", "ralph"));
    }
    expect(statSync(linkProject).ino).toBe(statSync(project.dir).ino);
  });
});

describe("TEST-SPEC §4.7 LOOPX_TMPDIR", () => {
  let project: TempProject | null = null;
  let tmpParent: string | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
    if (tmpParent) {
      await rm(tmpParent, { recursive: true, force: true }).catch(() => {});
      tmpParent = null;
    }
  });

  async function createTmpParent(): Promise<string> {
    tmpParent = await mkdtemp(join(tmpdir(), "loopx-test-parent-"));
    return tmpParent;
  }

  function listLoopxTmpEntries(parent: string): string[] {
    return readdirSync(parent)
      .filter((entry) => entry.startsWith("loopx-"))
      .sort();
  }

  forEachRuntime((runtime) => {
    it("T-TMP-01/T-TMP-02/T-TMP-02a: LOOPX_TMPDIR is one absolute loopx-* dir per run and is cleaned up", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const pathLog = join(project.dir, "tmpdir-paths.log");
      const statLog = join(project.dir, "tmpdir-stats.log");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s\\n' "$LOOPX_TMPDIR" >> "${pathLog}"
if [ -d "$LOOPX_TMPDIR" ]; then
  printf 'dir\\n' >> "${statLog}"
else
  printf 'missing\\n' >> "${statLog}"
fi
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent },
      });

      expect(result.exitCode).toBe(0);
      const paths = readFileSync(pathLog, "utf-8").trim().split("\n");
      expect(paths).toHaveLength(2);
      expect(paths[0]).toBe(paths[1]);
      expect(resolve(paths[0])).toBe(paths[0]);
      expect(paths[0].startsWith(`${parent}/`)).toBe(true);
      expect(basename(paths[0]).startsWith("loopx-")).toBe(true);
      expect(readFileSync(statLog, "utf-8").trim().split("\n")).toEqual([
        "dir",
        "dir",
      ]);
      expect(existsSync(paths[0])).toBe(false);
    });

    it("T-TMP-03: files written inside LOOPX_TMPDIR persist across iterations within a run", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const marker = join(project.dir, "tmpdir-rendezvous.txt");
      const counter = join(project.dir, "counter.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '1' >> "${counter}"
COUNT=$(wc -c < "${counter}" | tr -d ' ')
if [ "$COUNT" = "1" ]; then
  printf 'handoff' > "$LOOPX_TMPDIR/value.txt"
else
  cat "$LOOPX_TMPDIR/value.txt" > "${marker}"
fi
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent },
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("handoff");
    });

    it("T-TMP-04/T-TMP-05/T-TMP-06: LOOPX_TMPDIR is shared across goto, cross-workflow goto, and reset", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const log = join(project.dir, "tmpdir-transitions.log");

      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".sh",
        `#!/bin/bash
printf 'alpha:%s\\n' "$LOOPX_TMPDIR" >> "${log}"
COUNT=$(grep -c '^alpha:' "${log}" 2>/dev/null || true)
if [ "$COUNT" = "1" ]; then
  printf '{"goto":"alpha:check"}'
else
  printf '{"stop":true}'
fi
`,
      );
      await createWorkflowScript(
        project,
        "alpha",
        "check",
        ".sh",
        `#!/bin/bash
printf 'check:%s\\n' "$LOOPX_TMPDIR" >> "${log}"
printf '{"goto":"beta:step"}'
`,
      );
      await createWorkflowScript(
        project,
        "beta",
        "step",
        ".sh",
        `#!/bin/bash
printf 'beta:%s\\n' "$LOOPX_TMPDIR" >> "${log}"
`,
      );

      const result = await runCLI(["run", "-n", "4", "alpha"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent },
      });

      expect(result.exitCode).toBe(0);
      const observed = readFileSync(log, "utf-8")
        .trim()
        .split("\n")
        .map((line) => line.split(":")[1]);
      expect(new Set(observed).size).toBe(1);
      expect(observed[0].startsWith(`${parent}/loopx-`)).toBe(true);
    });

    it("T-TMP-07: data written to LOOPX_TMPDIR is readable after a goto", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf 'hello' > "$LOOPX_TMPDIR/state.txt"
printf '{"goto":"check"}'
`,
      );
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".sh",
        `#!/bin/bash
VALUE=$(cat "$LOOPX_TMPDIR/state.txt")
printf '{"result":"%s","stop":true}' "$VALUE"
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  maxIterations: 2,
  env: { TMPDIR: ${JSON.stringify(parent)} },
});
process.stdout.write(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs[1].result).toBe("hello");
    });

    it("T-TMP-08/T-TMP-08a/T-TMP-08b/T-TMP-08c: concurrent runs receive distinct LOOPX_TMPDIR directories", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const release = join(project.dir, "release.tmp");
      const marker1 = join(project.dir, "tmpdir-run-1.txt");
      const marker2 = join(project.dir, "tmpdir-run-2.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
while [ ! -f "$RELEASE_SENTINEL" ]; do sleep 0.05; done
printf '{"stop":true}'
`,
      );

      const first = runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: {
          TMPDIR: parent,
          OBSERVED_TMPDIR_MARKER: marker1,
          RELEASE_SENTINEL: release,
        },
      });
      const second = runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: {
          TMPDIR: parent,
          OBSERVED_TMPDIR_MARKER: marker2,
          RELEASE_SENTINEL: release,
        },
      });

      for (let attempts = 0; attempts < 100; attempts += 1) {
        if (existsSync(marker1) && existsSync(marker2)) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(existsSync(marker1)).toBe(true);
      expect(existsSync(marker2)).toBe(true);
      await writeFile(release, "", "utf-8");
      const [result1, result2] = await Promise.all([first, second]);

      expect(result1.exitCode).toBe(0);
      expect(result2.exitCode).toBe(0);
      const tmp1 = readFileSync(marker1, "utf-8");
      const tmp2 = readFileSync(marker2, "utf-8");
      expect(tmp1).not.toBe(tmp2);
      expect(dirname(tmp1)).toBe(parent);
      expect(dirname(tmp2)).toBe(parent);
      expect(existsSync(tmp1)).toBe(false);
      expect(existsSync(tmp2)).toBe(false);
    });

    it("T-TMP-09: LOOPX_TMPDIR is created with 0700 mode while the run is active", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const release = join(project.dir, "release-mode.tmp");
      const marker = join(project.dir, "tmpdir-mode-path.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
while [ ! -f "${release}" ]; do sleep 0.05; done
printf '{"stop":true}'
`,
      );

      const pending = runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent },
      });
      for (let attempts = 0; attempts < 100; attempts += 1) {
        if (existsSync(marker)) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      const tmpdirPath = readFileSync(marker, "utf-8");
      expect(statSync(tmpdirPath).mode & 0o777).toBe(0o700);
      await writeFile(release, "", "utf-8");
      const result = await pending;
      expect(result.exitCode).toBe(0);
      expect(existsSync(tmpdirPath)).toBe(false);
    });

    it("T-TMP-10/T-TMP-11/T-TMP-11a/T-TMP-11b: zero-iteration and undriven run() paths do not create LOOPX_TMPDIR", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const marker = join(project.dir, "zero-iteration-ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf 'ran' > "${marker}"
printf '{"stop":true}'
`,
      );

      const before = readdirSync(parent).filter((entry) => entry.startsWith("loopx-"));
      const cli = await runCLI(["run", "-n", "0", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent },
      });
      expect(cli.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(false);

      const driverCode = `
import { readdirSync, existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const parent = ${JSON.stringify(parent)};
const before = readdirSync(parent).filter((entry) => entry.startsWith("loopx-"));
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0, env: { TMPDIR: parent } });
const genZero = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0, env: { TMPDIR: parent } });
const zero = await genZero.next();
const genUndriven = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, env: { TMPDIR: parent } });
const between = readdirSync(parent).filter((entry) => entry.startsWith("loopx-"));
await genUndriven.return(undefined);
const after = readdirSync(parent).filter((entry) => entry.startsWith("loopx-"));
process.stdout.write(JSON.stringify({ before, zeroDone: zero.done, between, after, markerExists: existsSync(${JSON.stringify(marker)}) }));
`;
      const api = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      const observed = JSON.parse(api.stdout);

      expect(api.exitCode).toBe(0);
      expect(observed.zeroDone).toBe(true);
      expect(observed.markerExists).toBe(false);
      expect(readdirSync(parent).filter((entry) => entry.startsWith("loopx-"))).toEqual(before);
      expect(observed.before).toEqual(before);
      expect(observed.between).toEqual(before);
      expect(observed.after).toEqual(before);
    });

    it("T-TMP-12/T-TMP-12-cli/T-TMP-12-env/T-TMP-12-global/T-TMP-12-invalid/T-TMP-12-missing/T-TMP-12-options/T-TMP-12-programmatic/T-TMP-12-target/T-TMP-12-throwing: pre-iteration validation failures do not create LOOPX_TMPDIR", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const noLoopxDir = join(project.dir, "no-loopx");
      await mkdir(noLoopxDir, { recursive: true });
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '{"stop":true}'
`,
      );

      const cliCases: Array<{ args: string[]; cwd?: string }> = [
        { args: ["run", "-e", "missing.env", "ralph"] },
        { args: ["run", "missing"] },
        { args: ["run", "ralph:missing"] },
        { args: ["run", ":script"] },
        { args: ["run", "bad.name"] },
        { args: ["run", "-n", "-1", "ralph"] },
        { args: ["run", "ralph"], cwd: noLoopxDir },
      ];
      const beforeCli = listLoopxTmpEntries(parent);
      const cliResults = await Promise.all(
        cliCases.map((cliCase) =>
          runCLI(cliCase.args, {
            cwd: cliCase.cwd ?? project!.dir,
            runtime,
            env: { TMPDIR: parent },
          }),
        ),
      );
      expect(cliResults.every((result) => result.exitCode !== 0)).toBe(true);
      expect(listLoopxTmpEntries(parent)).toEqual(beforeCli);

      const driverCode = `
import { readdirSync } from "node:fs";
import { run, runPromise } from "loopx";
const parent = ${JSON.stringify(parent)};
process.env.TMPDIR = parent;
function entries() {
  return readdirSync(parent).filter((entry) => entry.startsWith("loopx-")).sort();
}
async function exhaust(iterator) {
  for await (const _ of iterator) {}
}
function throwingOptions(prop) {
  return Object.defineProperty({}, prop, {
    enumerable: true,
    get() {
      throw new Error("getter boom " + prop);
    },
  });
}
function throwingEnvValue() {
  return {
    cwd: ${JSON.stringify(project.dir)},
    env: Object.defineProperty({}, "BROKEN", {
      enumerable: true,
      get() {
        throw new Error("env getter boom");
      },
    }),
  };
}
const cases = [
  ["runPromise-missing-env-file", () => runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, envFile: "missing.env", maxIterations: 1 })],
  ["runPromise-missing-workflow", () => runPromise("missing", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })],
  ["runPromise-missing-script", () => runPromise("ralph:missing", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })],
  ["runPromise-missing-loopx", () => runPromise("ralph", { cwd: ${JSON.stringify(noLoopxDir)}, maxIterations: 1 })],
  ["runPromise-target-syntax", () => runPromise(":script", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })],
  ["runPromise-target-type", () => runPromise(undefined, { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })],
  ["runPromise-workflow-name", () => runPromise("bad.name", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })],
  ["runPromise-options-shape", () => runPromise("ralph", null)],
  ["runPromise-cwd-type", () => runPromise("ralph", { cwd: 42, maxIterations: 1 })],
  ["runPromise-env-file-type", () => runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, envFile: 42, maxIterations: 1 })],
  ["runPromise-env-shape", () => runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, env: null, maxIterations: 1 })],
  ["runPromise-env-value", () => runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, env: { BROKEN: 42 }, maxIterations: 1 })],
  ["runPromise-signal-type", () => runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, signal: "broken", maxIterations: 1 })],
  ["runPromise-throw-cwd", () => runPromise("ralph", throwingOptions("cwd"))],
  ["runPromise-throw-env", () => runPromise("ralph", throwingOptions("env"))],
  ["runPromise-throw-signal", () => runPromise("ralph", throwingOptions("signal"))],
  ["runPromise-throw-env-value", () => runPromise("ralph", throwingEnvValue())],
  ["run-missing-env-file", () => exhaust(run("ralph", { cwd: ${JSON.stringify(project.dir)}, envFile: "missing.env", maxIterations: 1 }))],
  ["run-missing-workflow", () => exhaust(run("missing", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 }))],
  ["run-missing-script", () => exhaust(run("ralph:missing", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 }))],
  ["run-options-shape", () => exhaust(run("ralph", null))],
  ["run-env-shape", () => exhaust(run("ralph", { cwd: ${JSON.stringify(project.dir)}, env: null, maxIterations: 1 }))],
  ["run-throw-signal", () => exhaust(run("ralph", throwingOptions("signal")))],
];
const before = entries();
const results = [];
for (const [name, invoke] of cases) {
  const caseBefore = entries();
  let rejected = false;
  try {
    await invoke();
  } catch (error) {
    rejected = true;
  }
  results.push({ name, rejected, caseBefore, caseAfter: entries() });
}
process.stdout.write(JSON.stringify({ before, after: entries(), results }));
`;
      const api = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(api.exitCode).toBe(0);
      const observed = JSON.parse(api.stdout);
      expect(observed.after).toEqual(observed.before);
      for (const result of observed.results) {
        expect(result.rejected, result.name).toBe(true);
        expect(result.caseAfter, result.name).toEqual(result.caseBefore);
      }
      expect(listLoopxTmpEntries(parent)).toEqual(beforeCli);
    });

    it("T-TMP-12a/T-TMP-12b/T-TMP-12c: tmpdir creation failures surface on CLI, runPromise, and run", async () => {
      project = await createTempProject();
      const missingParent = join(project.dir, "missing-tmp-parent");
      const marker = join(project.dir, "tmpdir-create-failure-ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf 'ran' > "${marker}"
printf '{"stop":true}'
`,
      );

      const cli = await runCLI(["run", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: missingParent },
      });
      expect(cli.exitCode).not.toBe(0);
      expect(existsSync(marker)).toBe(false);

      const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
process.env.TMPDIR = ${JSON.stringify(missingParent)};
const cwd = ${JSON.stringify(project.dir)};
const results = {};
try {
  await runPromise("ralph", { cwd, maxIterations: 1 });
  results.runPromiseRejected = false;
} catch {
  results.runPromiseRejected = true;
}
try {
  for await (const _ of run("ralph", { cwd, maxIterations: 1 })) {}
  results.runRejected = false;
} catch {
  results.runRejected = true;
}
results.markerExists = existsSync(${JSON.stringify(marker)});
process.stdout.write(JSON.stringify(results));
`;
      const api = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(api.exitCode).toBe(0);
      const observed = JSON.parse(api.stdout);
      expect(observed.runPromiseRejected).toBe(true);
      expect(observed.runRejected).toBe(true);
      expect(observed.markerExists).toBe(false);
    });

    it("T-TMP-12d/T-TMP-12d2/T-TMP-12e/T-TMP-12e2/T-TMP-12e3: tmpdir setup and cleanup seam failures surface before script execution", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const marker = join(project.dir, "tmpdir-seam-failure-ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf 'ran' > "${marker}"
printf '{"stop":true}'
`,
      );

      const cases = [
        { name: "identity-capture-fail", env: { LOOPX_TEST_TMPDIR_FAULT: "identity-capture-fail" } },
        { name: "identity-capture-fail-rmdir-fail", env: { LOOPX_TEST_TMPDIR_FAULT: "identity-capture-fail-rmdir-fail" } },
        { name: "mode-secure-fail", env: { LOOPX_TEST_TMPDIR_FAULT: "mode-secure-fail" } },
        { name: "mode-secure-fail-recursive-remove-fail", env: { LOOPX_TEST_TMPDIR_FAULT: "mode-secure-fail", LOOPX_TEST_CLEANUP_FAULT: "recursive-remove-fail" } },
        { name: "mode-secure-fail-lstat-fail", env: { LOOPX_TEST_TMPDIR_FAULT: "mode-secure-fail", LOOPX_TEST_CLEANUP_FAULT: "lstat-fail" } },
      ];

      for (const testCase of cases) {
        const before = listLoopxTmpEntries(parent);
        const result = await runCLI(["run", "ralph"], {
          cwd: project.dir,
          runtime,
          env: { TMPDIR: parent, NODE_ENV: "test", ...testCase.env },
        });
        expect(result.exitCode, testCase.name).not.toBe(0);
        expect(existsSync(marker), testCase.name).toBe(false);
        const after = listLoopxTmpEntries(parent);
        if (testCase.name.includes("rmdir-fail") || testCase.name.includes("remove-fail") || testCase.name.includes("lstat-fail")) {
          expect(after.length, testCase.name).toBeGreaterThanOrEqual(before.length);
        } else {
          expect(after, testCase.name).toEqual(before);
        }
      }
    });

    it("T-TMP-12f/T-TMP-12f2/T-TMP-12f3/T-TMP-12f4/T-TMP-12f5/T-TMP-12g/T-TMP-12h: package warnings are emitted before tmpdir creation failures", async () => {
      project = await createTempProject();
      const baseProjectDir = project.dir;
      const variants: Array<{ name: string; packageEntry: string; packageText?: string }> = [
        {
          name: "unsatisfied-range",
          packageEntry: "package.json",
          packageText: JSON.stringify({ loopx: { version: ">=999.0.0" } }),
        },
        { name: "invalid-json", packageEntry: "package.json", packageText: "{" },
        {
          name: "invalid-semver",
          packageEntry: "package.json",
          packageText: JSON.stringify({ loopx: { version: "not semver" } }),
        },
        { name: "non-regular-package-json", packageEntry: "package.json" },
      ];

      for (const variant of variants) {
        const variantProject = join(baseProjectDir, `package-warning-${variant.name}`);
        await mkdir(join(variantProject, ".loopx", "ralph"), { recursive: true });
        if (variant.packageText === undefined) {
          await mkdir(join(variantProject, variant.packageEntry), { recursive: true });
        } else {
          await writeFile(
            join(variantProject, variant.packageEntry),
            variant.packageText,
            "utf-8",
          );
        }
        await writeFile(
          join(variantProject, ".loopx", "ralph", "index.sh"),
          `#!/bin/bash
printf '{"stop":true}'
`,
          "utf-8",
        );
        await chmod(join(variantProject, ".loopx", "ralph", "index.sh"), 0o755);
      }

      const missingParent = join(baseProjectDir, "missing-warning-tmp-parent");
      for (const variant of variants) {
        const variantProject = join(baseProjectDir, `package-warning-${variant.name}`);
        const cli = await runCLI(["run", "ralph"], {
          cwd: variantProject,
          runtime,
          env: { TMPDIR: missingParent },
        });
        expect(cli.exitCode, `${variant.name}:cli`).not.toBe(0);
        expect(cli.stderr, `${variant.name}:cli`).toMatch(/package|version|semver|json/i);
      }

      const driverCode = `
import { run, runPromise } from "loopx";
process.env.TMPDIR = ${JSON.stringify(missingParent)};
const projects = ${JSON.stringify(
        variants.map((variant) => ({
          name: variant.name,
          cwd: join(baseProjectDir, `package-warning-${variant.name}`),
        })),
      )};
const results = [];
for (const project of projects) {
  for (const surface of ["runPromise", "run"]) {
    let rejected = false;
    try {
      if (surface === "runPromise") {
        await runPromise("ralph", { cwd: project.cwd, maxIterations: 1 });
      } else {
        for await (const _ of run("ralph", { cwd: project.cwd, maxIterations: 1 })) {}
      }
    } catch {
      rejected = true;
    }
    results.push({ name: project.name, surface, rejected });
  }
}
process.stdout.write(JSON.stringify(results));
`;
      const api = await runAPIDriver(runtime, driverCode, { cwd: baseProjectDir });
      expect(api.exitCode).toBe(0);
      const observed = JSON.parse(api.stdout);
      for (const result of observed) {
        expect(result.rejected, `${result.name}:${result.surface}`).toBe(true);
      }
    });

    it("T-TMP-13/T-TMP-13a/T-TMP-13b/T-TMP-14/T-TMP-14a: normal settlements clean up LOOPX_TMPDIR", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const cliStopMarker = join(project.dir, "tmp-cli-stop.txt");
      const cliLimitMarker = join(project.dir, "tmp-cli-limit.txt");
      const apiStopPromiseMarker = join(project.dir, "tmp-api-stop-promise.txt");
      const apiStopRunMarker = join(project.dir, "tmp-api-stop-run.txt");
      const apiLimitMarker = join(project.dir, "tmp-api-limit.txt");

      await createWorkflowScript(
        project,
        "stop",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
printf 'payload' > "$LOOPX_TMPDIR/file.txt"
printf '{"stop":true}'
`,
      );
      await createWorkflowScript(
        project,
        "limit",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
printf 'payload' > "$LOOPX_TMPDIR/file.txt"
printf '{"result":"tick"}'
`,
      );

      const cliStop = await runCLI(["run", "-n", "5", "stop"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent, OBSERVED_TMPDIR_MARKER: cliStopMarker },
      });
      expect(cliStop.exitCode).toBe(0);
      const cliStopTmpdir = readFileSync(cliStopMarker, "utf-8");
      expect(existsSync(cliStopTmpdir)).toBe(false);

      const cliLimit = await runCLI(["run", "-n", "1", "limit"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent, OBSERVED_TMPDIR_MARKER: cliLimitMarker },
      });
      expect(cliLimit.exitCode).toBe(0);
      const cliLimitTmpdir = readFileSync(cliLimitMarker, "utf-8");
      expect(existsSync(cliLimitTmpdir)).toBe(false);

      const driverCode = `
import { existsSync, readFileSync } from "node:fs";
import { run, runPromise } from "loopx";
const cwd = ${JSON.stringify(project.dir)};
await runPromise("stop", {
  cwd,
  maxIterations: 5,
  env: { OBSERVED_TMPDIR_MARKER: ${JSON.stringify(apiStopPromiseMarker)} },
});
for await (const _ of run("stop", {
  cwd,
  maxIterations: 5,
  env: { OBSERVED_TMPDIR_MARKER: ${JSON.stringify(apiStopRunMarker)} },
})) {}
await runPromise("limit", {
  cwd,
  maxIterations: 1,
  env: { OBSERVED_TMPDIR_MARKER: ${JSON.stringify(apiLimitMarker)} },
});
const paths = {
  stopPromise: readFileSync(${JSON.stringify(apiStopPromiseMarker)}, "utf-8"),
  stopRun: readFileSync(${JSON.stringify(apiStopRunMarker)}, "utf-8"),
  limitPromise: readFileSync(${JSON.stringify(apiLimitMarker)}, "utf-8"),
};
process.stdout.write(JSON.stringify({
  paths,
  exists: Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, existsSync(value)])),
}));
`;
      const api = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: { TMPDIR: parent },
      });
      expect(api.exitCode).toBe(0);
      const observed = JSON.parse(api.stdout);
      expect(observed.exists).toEqual({
        stopPromise: false,
        stopRun: false,
        limitPromise: false,
      });
      for (const value of Object.values<string>(observed.paths)) {
        expect(value.startsWith(`${parent}/loopx-`)).toBe(true);
      }
    });

    it("T-TMP-15/T-TMP-15a/T-TMP-15b: non-zero script exits clean up LOOPX_TMPDIR before surfacing failure", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const cliMarker = join(project.dir, "tmp-cli-fail.txt");
      const promiseMarker = join(project.dir, "tmp-promise-fail.txt");
      const runMarker = join(project.dir, "tmp-run-fail.txt");
      await createWorkflowScript(
        project,
        "fail",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
printf 'payload' > "$LOOPX_TMPDIR/file.txt"
exit 1
`,
      );

      const cli = await runCLI(["run", "-n", "1", "fail"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent, OBSERVED_TMPDIR_MARKER: cliMarker },
      });
      expect(cli.exitCode).toBe(1);
      const cliTmpdir = readFileSync(cliMarker, "utf-8");
      expect(existsSync(cliTmpdir)).toBe(false);

      const driverCode = `
import { existsSync, readFileSync } from "node:fs";
import { run, runPromise } from "loopx";
const cwd = ${JSON.stringify(project.dir)};
const results = {};
try {
  await runPromise("fail", {
    cwd,
    maxIterations: 1,
    env: { OBSERVED_TMPDIR_MARKER: ${JSON.stringify(promiseMarker)} },
  });
  results.promiseRejected = false;
} catch {
  results.promiseRejected = true;
}
try {
  for await (const _ of run("fail", {
    cwd,
    maxIterations: 1,
    env: { OBSERVED_TMPDIR_MARKER: ${JSON.stringify(runMarker)} },
  })) {}
  results.runRejected = false;
} catch {
  results.runRejected = true;
}
const paths = {
  promise: readFileSync(${JSON.stringify(promiseMarker)}, "utf-8"),
  run: readFileSync(${JSON.stringify(runMarker)}, "utf-8"),
};
process.stdout.write(JSON.stringify({
  ...results,
  paths,
  exists: Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, existsSync(value)])),
}));
`;
      const api = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: { TMPDIR: parent },
      });
      expect(api.exitCode).toBe(0);
      const observed = JSON.parse(api.stdout);
      expect(observed.promiseRejected).toBe(true);
      expect(observed.runRejected).toBe(true);
      expect(observed.exists).toEqual({ promise: false, run: false });
    });

    it("T-TMP-16/T-TMP-16a/T-TMP-16b/T-TMP-16c/T-TMP-16d/T-TMP-16e/T-TMP-16f/T-TMP-16g/T-TMP-16h/T-TMP-16i/T-TMP-16j: invalid goto resolution cleans up LOOPX_TMPDIR", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const cases = [
        { workflow: "missingWorkflow", goto: "ghost:script" },
        { workflow: "missingQualifiedScript", goto: "other:missing" },
        { workflow: "missingBareScript", goto: "missing" },
        { workflow: "malformedDelimiter", goto: "a:b:c" },
        { workflow: "malformedName", goto: "-bad" },
      ];
      for (const testCase of cases) {
        await createWorkflowScript(
          project,
          testCase.workflow,
          "index",
          ".sh",
          `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
printf '{"goto":${JSON.stringify(testCase.goto)}}'
`,
        );
      }
      await createWorkflowScript(
        project,
        "other",
        "index",
        ".sh",
        `#!/bin/bash
printf '{"stop":true}'
`,
      );

      for (const testCase of cases) {
        const marker = join(project.dir, `tmp-cli-goto-${testCase.workflow}.txt`);
        const cli = await runCLI(["run", "-n", "2", testCase.workflow], {
          cwd: project.dir,
          runtime,
          env: { TMPDIR: parent, OBSERVED_TMPDIR_MARKER: marker },
        });
        expect(cli.exitCode, `${testCase.workflow}:cli`).toBe(1);
        const tmpdirPath = readFileSync(marker, "utf-8");
        expect(existsSync(tmpdirPath), `${testCase.workflow}:cli`).toBe(false);
      }

      const driverCode = `
import { existsSync, readFileSync } from "node:fs";
import { run, runPromise } from "loopx";
const cwd = ${JSON.stringify(project.dir)};
const cases = ${JSON.stringify(cases)};
const results = [];
for (const testCase of cases) {
  for (const surface of ["runPromise", "run"]) {
    const marker = ${JSON.stringify(project.dir)} + "/tmp-api-goto-" + surface + "-" + testCase.workflow + ".txt";
    let rejected = false;
    try {
      if (surface === "runPromise") {
        await runPromise(testCase.workflow, {
          cwd,
          maxIterations: 2,
          env: { OBSERVED_TMPDIR_MARKER: marker },
        });
      } else {
        for await (const _ of run(testCase.workflow, {
          cwd,
          maxIterations: 2,
          env: { OBSERVED_TMPDIR_MARKER: marker },
        })) {}
      }
    } catch {
      rejected = true;
    }
    const tmpdirPath = readFileSync(marker, "utf-8");
    results.push({ workflow: testCase.workflow, surface, rejected, exists: existsSync(tmpdirPath) });
  }
}
process.stdout.write(JSON.stringify(results));
`;
      const api = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: { TMPDIR: parent },
      });
      expect(api.exitCode).toBe(0);
      const observed = JSON.parse(api.stdout);
      for (const result of observed) {
        expect(result.rejected, `${result.workflow}:${result.surface}`).toBe(true);
        expect(result.exists, `${result.workflow}:${result.surface}`).toBe(false);
      }
    });

    it("T-TMP-17/T-TMP-18/T-TMP-18a/T-TMP-18b: CLI signal exits clean up LOOPX_TMPDIR after child termination", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const cases: Array<{
        name: string;
        signal: NodeJS.Signals;
        exitCode: number;
        trap: string;
      }> = [
        { name: "sigint", signal: "SIGINT", exitCode: 130, trap: "INT" },
        { name: "sigterm", signal: "SIGTERM", exitCode: 143, trap: "TERM" },
      ];

      for (const testCase of cases) {
        const marker = join(project.dir, `tmp-signal-${testCase.name}.txt`);
        const pidMarker = join(project.dir, `tmp-signal-${testCase.name}.pid`);
        await createWorkflowScript(
          project,
          testCase.name,
          "index",
          ".sh",
          `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '%s' "$$" > "${pidMarker}"
trap '' ${testCase.trap}
printf 'ready-${testCase.name}\\n' >&2
while true; do sleep 1; done
`,
        );

        const running = runCLIWithSignal(["run", "-n", "1", testCase.name], {
          cwd: project.dir,
          runtime,
          env: { TMPDIR: parent },
          timeout: 12_000,
        });
        await running.waitForStderr(`ready-${testCase.name}`, { timeoutMs: 5_000 });
        const tmpdirPath = readFileSync(marker, "utf-8");
        const childPid = Number(readFileSync(pidMarker, "utf-8"));
        const start = Date.now();
        running.sendSignal(testCase.signal);
        const result = await running.result;
        const elapsed = Date.now() - start;

        expect(result.exitCode, testCase.name).toBe(testCase.exitCode);
        expect(elapsed, testCase.name).toBeGreaterThanOrEqual(3_500);
        expect(existsSync(tmpdirPath), testCase.name).toBe(false);
        try {
          process.kill(childPid, 0);
          throw new Error(`child ${childPid} still alive`);
        } catch (error) {
          expect((error as NodeJS.ErrnoException).code, testCase.name).toBe("ESRCH");
        }
      }
    });

    it("T-TMP-19/T-TMP-20/T-TMP-21/T-TMP-21h/T-TMP-22/T-TMP-22a/T-TMP-22b/T-TMP-22c/T-TMP-22d/T-TMP-22e/T-TMP-22f: programmatic abort and generator cancellation clean up LOOPX_TMPDIR", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      await createWorkflowScript(
        project,
        "block",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
printf 'ready\\n' >&2
while true; do sleep 1; done
`,
      );
      await createWorkflowScript(
        project,
        "yield",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
printf '{"result":"first"}'
`,
      );

      const driverCode = `
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "loopx";
const cwd = ${JSON.stringify(project.dir)};
async function waitForFile(path) {
  for (let attempts = 0; attempts < 120; attempts += 1) {
    if (existsSync(path)) return;
    await delay(25);
  }
  throw new Error("timed out waiting for " + path);
}
async function cancellationCase(kind) {
  const marker = ${JSON.stringify(project.dir)} + "/tmp-programmatic-" + kind + ".txt";
  let rejected = false;
  if (kind === "abort") {
    const controller = new AbortController();
    const gen = run("block", { cwd, signal: controller.signal, env: { OBSERVED_TMPDIR_MARKER: marker } });
    const pending = gen.next();
    await waitForFile(marker);
    controller.abort();
    try {
      await pending;
      await gen.next();
    } catch {
      rejected = true;
    }
  } else if (kind === "return-pending") {
    const gen = run("block", { cwd, env: { OBSERVED_TMPDIR_MARKER: marker } });
    const pending = gen.next().catch(() => undefined);
    await waitForFile(marker);
    await gen.return(undefined);
    await pending;
  } else if (kind === "throw-pending") {
    const gen = run("block", { cwd, env: { OBSERVED_TMPDIR_MARKER: marker } });
    const pending = gen.next().catch(() => undefined);
    await waitForFile(marker);
    try {
      await gen.throw(new Error("consumer throw"));
    } catch {
      rejected = true;
    }
    await pending;
  } else if (kind === "break-after-yield") {
    for await (const _ of run("yield", { cwd, env: { OBSERVED_TMPDIR_MARKER: marker } })) {
      break;
    }
  } else if (kind === "return-after-yield") {
    const gen = run("yield", { cwd, env: { OBSERVED_TMPDIR_MARKER: marker } });
    await gen.next();
    await gen.return(undefined);
  } else if (kind === "throw-after-yield") {
    const gen = run("yield", { cwd, env: { OBSERVED_TMPDIR_MARKER: marker } });
    await gen.next();
    try {
      await gen.throw(new Error("consumer throw"));
    } catch {
      rejected = true;
    }
  }
  const tmpdirPath = readFileSync(marker, "utf-8");
  return { kind, rejected, exists: existsSync(tmpdirPath), tmpdirPath };
}
const results = [];
for (const kind of ["abort", "return-pending", "throw-pending", "break-after-yield", "return-after-yield", "throw-after-yield"]) {
  results.push(await cancellationCase(kind));
}
process.stdout.write(JSON.stringify(results));
`;
      const api = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: { TMPDIR: parent },
        timeout: 20_000,
      });
      expect(api.exitCode).toBe(0);
      const observed = JSON.parse(api.stdout);
      for (const result of observed) {
        expect(result.exists, result.kind).toBe(false);
        expect(result.tmpdirPath.startsWith(`${parent}/loopx-`), result.kind).toBe(true);
      }
      expect(
        observed.find((result: { kind: string }) => result.kind === "abort").rejected,
      ).toBe(true);
    });

    it("T-TMP-23/T-TMP-24/T-TMP-24a/T-TMP-24b/T-TMP-24c/T-TMP-24d/T-TMP-24e/T-TMP-24f/T-TMP-24g: final-yield settlement and hard kill define cleanup boundaries", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      await createWorkflowScript(
        project,
        "yield",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
printf '{"result":"final"}'
`,
      );
      await createWorkflowScript(
        project,
        "stop",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
printf '{"stop":true}'
`,
      );
      const killMarker = join(project.dir, "tmp-sigkill-path.txt");
      const killPidMarker = join(project.dir, "tmp-sigkill-pid.txt");
      await createWorkflowScript(
        project,
        "killable",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${killMarker}"
printf '%s' "$$" > "${killPidMarker}"
printf 'ready-kill\\n' >&2
while true; do sleep 1; done
`,
      );

      const driverCode = `
import { existsSync, readFileSync } from "node:fs";
import { run } from "loopx";
const cwd = ${JSON.stringify(project.dir)};
async function finalYieldCase(workflow, interaction) {
  const marker = ${JSON.stringify(project.dir)} + "/tmp-final-" + workflow + "-" + interaction + ".txt";
  const controller = new AbortController();
  const gen = run(workflow, {
    cwd,
    signal: controller.signal,
    maxIterations: workflow === "stop" ? 5 : 1,
    env: { OBSERVED_TMPDIR_MARKER: marker },
  });
  const first = await gen.next();
  const tmpdirPath = readFileSync(marker, "utf-8");
  let rejected = false;
  if (interaction === "settle-next") {
    const second = await gen.next();
    return { workflow, interaction, firstDone: first.done, secondDone: second.done, rejected, exists: existsSync(tmpdirPath), tmpdirPath };
  }
  controller.abort();
  try {
    if (interaction === "abort-next") {
      await gen.next();
    } else if (interaction === "abort-return") {
      await gen.return(undefined);
    } else {
      await gen.throw(new Error("consumer error"));
    }
  } catch {
    rejected = true;
  }
  return { workflow, interaction, firstDone: first.done, rejected, exists: existsSync(tmpdirPath), tmpdirPath };
}
const results = [];
results.push(await finalYieldCase("yield", "settle-next"));
results.push(await finalYieldCase("yield", "abort-next"));
results.push(await finalYieldCase("yield", "abort-return"));
results.push(await finalYieldCase("yield", "abort-throw"));
results.push(await finalYieldCase("stop", "abort-next"));
results.push(await finalYieldCase("stop", "abort-return"));
results.push(await finalYieldCase("stop", "abort-throw"));
for await (const _ of run("yield", {
  cwd,
  maxIterations: 1,
  env: { OBSERVED_TMPDIR_MARKER: ${JSON.stringify(join(project.dir, "tmp-final-for-await.txt"))} },
})) {}
const forAwaitPath = readFileSync(${JSON.stringify(join(project.dir, "tmp-final-for-await.txt"))}, "utf-8");
results.push({ workflow: "yield", interaction: "for-await", rejected: false, exists: existsSync(forAwaitPath), tmpdirPath: forAwaitPath });
process.stdout.write(JSON.stringify(results));
`;
      const api = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: { TMPDIR: parent },
        timeout: 20_000,
      });
      expect(api.exitCode).toBe(0);
      const observed = JSON.parse(api.stdout);
      for (const result of observed) {
        if (result.interaction === "abort-throw") {
          continue;
        }
        expect(result.exists, `${result.workflow}:${result.interaction}`).toBe(false);
        expect(result.tmpdirPath.startsWith(`${parent}/loopx-`)).toBe(true);
      }
      for (const result of observed.filter((entry: { interaction: string }) =>
        entry.interaction.startsWith("abort-"),
      )) {
        expect(result.rejected, `${result.workflow}:${result.interaction}`).toBe(true);
      }

      const running = runCLIWithSignal(["run", "-n", "1", "killable"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent },
        timeout: 8_000,
      });
      await running.waitForStderr("ready-kill", { timeoutMs: 5_000 });
      const killTmpdir = readFileSync(killMarker, "utf-8");
      const childPid = Number(readFileSync(killPidMarker, "utf-8"));
      running.sendSignal("SIGKILL");
      const killed = await running.result;
      expect(killed.signal).toBe("SIGKILL");
      expect(existsSync(killTmpdir)).toBe(true);
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
      await rm(killTmpdir, { recursive: true, force: true }).catch(() => {});
    });

    it("T-TMP-25/T-TMP-25a/T-TMP-25b/T-TMP-26/T-TMP-26-temp/T-TMP-26-tmp/T-TMP-27/T-TMP-27-temp/T-TMP-27-tmp/T-TMP-27a/T-TMP-28/T-TMP-28a/T-TMP-28b/T-TMP-28c/T-TMP-28d/T-TMP-28e/T-TMP-28f/T-TMP-28g/T-TMP-28h/T-TMP-29/T-TMP-29a/T-TMP-29b/T-TMP-29c/T-TMP-29d/T-TMP-29e/T-TMP-29f/T-TMP-29g/T-TMP-29h/T-TMP-29i/T-TMP-29j/T-TMP-29k: tmpdir parent comes from loopx process env, not injected child env tiers", async () => {
      project = await createTempProject();
      const parentA = await mkdtemp(join(tmpdir(), "loopx-parent-a-"));
      const parentB = await mkdtemp(join(tmpdir(), "loopx-parent-b-"));
      tmpParent = await mkdtemp(join(tmpdir(), "loopx-parent-cleanup-"));
      await createWorkflowScript(
        project,
        "observe",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s\\n%s\\n%s\\n%s' "$LOOPX_TMPDIR" "\${TMPDIR-}" "\${TEMP-}" "\${TMP-}" > "$OBSERVED_TMPDIR_MARKER"
printf '{"stop":true}'
`,
      );

      const cliMarker = join(project.dir, "tmp-parent-cli.txt");
      const localEnvFile = join(project.dir, "local-tmp.env");
      await createEnvFile(localEnvFile, { TMPDIR: parentB, TEMP: parentB, TMP: parentB });
      const cli = await runCLI(["run", "-e", "local-tmp.env", "-n", "1", "observe"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parentA, OBSERVED_TMPDIR_MARKER: cliMarker },
      });
      expect(cli.exitCode).toBe(0);
      const [cliTmpdir, cliChildTmpdir] = readFileSync(cliMarker, "utf-8").split("\n");
      expect(dirname(cliTmpdir)).toBe(parentA);
      expect(cliChildTmpdir).toBe(parentB);
      expect(existsSync(cliTmpdir)).toBe(false);

      const driverCode = `
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { run, runPromise } from "loopx";
const cwd = ${JSON.stringify(project.dir)};
const parentA = ${JSON.stringify(parentA)};
const parentB = ${JSON.stringify(parentB)};
const localEnvFile = ${JSON.stringify(localEnvFile)};
async function collect(marker, invoke) {
  await invoke();
  const [tmpdirPath, childTmpdir, childTemp, childTmp] = readFileSync(marker, "utf-8").split("\\n");
  return { marker, tmpdirPath, parent: tmpdirPath.split("/").slice(0, -1).join("/"), childTmpdir, childTemp, childTmp, exists: existsSync(tmpdirPath) };
}
const before = readdirSync(parentA).filter((entry) => entry.startsWith("loopx-")).sort();
process.env.TMPDIR = parentA;
const promise = runPromise("observe", {
  cwd,
  maxIterations: 1,
  env: { OBSERVED_TMPDIR_MARKER: ${JSON.stringify(join(project.dir, "tmp-parent-promise-eager.txt"))} },
});
const betweenSync = readdirSync(parentA).filter((entry) => entry.startsWith("loopx-")).sort();
process.env.TMPDIR = parentB;
await promise;
const after = readdirSync(parentA).filter((entry) => entry.startsWith("loopx-")).sort();
const eager = (() => {
  const [tmpdirPath] = readFileSync(${JSON.stringify(join(project.dir, "tmp-parent-promise-eager.txt"))}, "utf-8").split("\\n");
  return { tmpdirPath, parent: tmpdirPath.split("/").slice(0, -1).join("/"), exists: existsSync(tmpdirPath) };
})();
process.env.TMPDIR = parentA;
const gen = run("observe", {
  cwd,
  maxIterations: 1,
  env: { OBSERVED_TMPDIR_MARKER: ${JSON.stringify(join(project.dir, "tmp-parent-run-lazy.txt"))} },
});
process.env.TMPDIR = parentB;
for await (const _ of gen) {}
const lazy = (() => {
  const [tmpdirPath] = readFileSync(${JSON.stringify(join(project.dir, "tmp-parent-run-lazy.txt"))}, "utf-8").split("\\n");
  return { tmpdirPath, parent: tmpdirPath.split("/").slice(0, -1).join("/"), exists: existsSync(tmpdirPath) };
})();
process.env.TMPDIR = parentA;
const runOptionsEnv = await collect(${JSON.stringify(join(project.dir, "tmp-parent-runoptions-env.txt"))}, () =>
  runPromise("observe", {
    cwd,
    maxIterations: 1,
    env: {
      TMPDIR: parentB,
      TEMP: parentB,
      TMP: parentB,
      OBSERVED_TMPDIR_MARKER: ${JSON.stringify(join(project.dir, "tmp-parent-runoptions-env.txt"))},
    },
  })
);
process.env.TMPDIR = parentA;
const envFilePromise = await collect(${JSON.stringify(join(project.dir, "tmp-parent-envfile-promise.txt"))}, () =>
  runPromise("observe", {
    cwd,
    maxIterations: 1,
    envFile: localEnvFile,
    env: { OBSERVED_TMPDIR_MARKER: ${JSON.stringify(join(project.dir, "tmp-parent-envfile-promise.txt"))} },
  })
);
process.env.TMPDIR = parentA;
const envFileRun = await collect(${JSON.stringify(join(project.dir, "tmp-parent-envfile-run.txt"))}, async () => {
  for await (const _ of run("observe", {
    cwd,
    maxIterations: 1,
    envFile: localEnvFile,
    env: { OBSERVED_TMPDIR_MARKER: ${JSON.stringify(join(project.dir, "tmp-parent-envfile-run.txt"))} },
  })) {}
});
process.stdout.write(JSON.stringify({ before, betweenSync, after, eager, lazy, runOptionsEnv, envFilePromise, envFileRun }));
`;
      const api = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: { TMPDIR: parentA },
      });
      expect(api.exitCode).toBe(0);
      const observed = JSON.parse(api.stdout);
      expect(observed.betweenSync).toEqual(observed.before);
      expect(observed.after).toEqual(observed.before);
      expect(observed.eager.parent).toBe(parentA);
      expect(observed.eager.exists).toBe(false);
      expect(observed.lazy.parent).toBe(parentB);
      expect(observed.lazy.exists).toBe(false);
      for (const key of ["runOptionsEnv", "envFilePromise", "envFileRun"]) {
        expect(observed[key].parent, key).toBe(parentA);
        expect(observed[key].exists, key).toBe(false);
        expect(observed[key].childTmpdir, key).toBe(parentB);
      }
      await rm(parentA, { recursive: true, force: true }).catch(() => {});
      await rm(parentB, { recursive: true, force: true }).catch(() => {});
    });

    it("T-TMP-32/T-TMP-32a/T-TMP-32b/T-TMP-32c: run setup and CLI startup do not reap stale loopx-* tmpdirs", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const stale = join(parent, "loopx-stale-entry");
      const staleMarker = join(stale, "marker.txt");
      await mkdir(stale, { recursive: true });
      await writeFile(staleMarker, "stale", "utf-8");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
printf '{"stop":true}'
`,
      );

      const cliMarker = join(project.dir, "tmp-stale-cli.txt");
      const cli = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent, OBSERVED_TMPDIR_MARKER: cliMarker },
      });
      expect(cli.exitCode).toBe(0);
      expect(readFileSync(staleMarker, "utf-8")).toBe("stale");
      expect(existsSync(readFileSync(cliMarker, "utf-8"))).toBe(false);

      const startup = await runCLI(["-h"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent },
      });
      expect(startup.exitCode).toBe(0);
      expect(readFileSync(staleMarker, "utf-8")).toBe("stale");

      const driverCode = `
import { existsSync, readFileSync } from "node:fs";
import { run, runPromise } from "loopx";
const cwd = ${JSON.stringify(project.dir)};
await runPromise("ralph", {
  cwd,
  maxIterations: 1,
  env: { OBSERVED_TMPDIR_MARKER: ${JSON.stringify(join(project.dir, "tmp-stale-promise.txt"))} },
});
for await (const _ of run("ralph", {
  cwd,
  maxIterations: 1,
  env: { OBSERVED_TMPDIR_MARKER: ${JSON.stringify(join(project.dir, "tmp-stale-run.txt"))} },
})) {}
process.stdout.write(JSON.stringify({
  staleExists: existsSync(${JSON.stringify(staleMarker)}),
  promiseTmpExists: existsSync(readFileSync(${JSON.stringify(join(project.dir, "tmp-stale-promise.txt"))}, "utf-8")),
  runTmpExists: existsSync(readFileSync(${JSON.stringify(join(project.dir, "tmp-stale-run.txt"))}, "utf-8")),
}));
`;
      const api = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: { TMPDIR: parent },
      });
      expect(api.exitCode).toBe(0);
      expect(JSON.parse(api.stdout)).toEqual({
        staleExists: true,
        promiseTmpExists: false,
        runTmpExists: false,
      });
      expect(readFileSync(staleMarker, "utf-8")).toBe("stale");
    });

    it("T-TMP-33/T-TMP-34/T-TMP-34a/T-TMP-34b/T-TMP-35/T-TMP-35a/T-TMP-35b/T-TMP-35d/T-TMP-35e/T-TMP-35f/T-TMP-35g/T-TMP-35h/T-TMP-36/T-TMP-36-style/T-TMP-36a/T-TMP-36b/T-TMP-37/T-TMP-37a/T-TMP-37b/T-TMP-37c/T-TMP-37d/T-TMP-37e: cleanup-safety dispatch handles renamed, symlink, file, FIFO, and mismatched-directory replacements", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const externalTarget = join(project.dir, "target-survives");
      await mkdir(externalTarget, { recursive: true });
      await writeFile(join(externalTarget, "target-marker"), "target", "utf-8");
      const scripts: Record<string, string> = {
        rename: `printf 'initialized' > "$LOOPX_TMPDIR/initialized"\nmv "$LOOPX_TMPDIR" "$LOOPX_TMPDIR-renamed"\nprintf '{"stop":true}'`,
        symlink: `rm -rf "$LOOPX_TMPDIR"\nln -s "${externalTarget}" "$LOOPX_TMPDIR"\nprintf '{"stop":true}'`,
        regular: `rm -rf "$LOOPX_TMPDIR"\nprintf 'regular-file-replacement' > "$LOOPX_TMPDIR"\nprintf '{"stop":true}'`,
        fifo: `rm -rf "$LOOPX_TMPDIR"\nmkfifo "$LOOPX_TMPDIR"\nprintf '{"stop":true}'`,
        mismatch: `ORIGINAL="$LOOPX_TMPDIR"\nrm -rf "$ORIGINAL"\nmkdir "$ORIGINAL-other"\nmv "$ORIGINAL-other" "$ORIGINAL"\nprintf 'mismatch-marker' > "$ORIGINAL/marker.txt"\nprintf '{"stop":true}'`,
      };
      for (const [workflow, body] of Object.entries(scripts)) {
        await createWorkflowScript(
          project,
          workflow,
          "index",
          ".sh",
          `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
${body}
`,
        );
      }

      const cliExpectations: Record<string, (tmpdirPath: string) => void> = {
        rename: (tmpdirPath) => {
          expect(existsSync(tmpdirPath)).toBe(false);
          expect(readFileSync(`${tmpdirPath}-renamed/initialized`, "utf-8")).toBe("initialized");
        },
        symlink: (tmpdirPath) => {
          expect(existsSync(tmpdirPath)).toBe(false);
          expect(readFileSync(join(externalTarget, "target-marker"), "utf-8")).toBe("target");
        },
        regular: (tmpdirPath) => {
          expect(readFileSync(tmpdirPath, "utf-8")).toBe("regular-file-replacement");
        },
        fifo: (tmpdirPath) => {
          expect(existsSync(tmpdirPath)).toBe(true);
        },
        mismatch: (tmpdirPath) => {
          expect(readFileSync(join(tmpdirPath, "marker.txt"), "utf-8")).toBe("mismatch-marker");
        },
      };

      for (const workflow of Object.keys(scripts)) {
        const marker = join(project.dir, `tmp-safety-cli-${workflow}.txt`);
        const result = await runCLI(["run", "-n", "1", workflow], {
          cwd: project.dir,
          runtime,
          env: { TMPDIR: parent, OBSERVED_TMPDIR_MARKER: marker },
        });
        expect(result.exitCode, workflow).toBe(0);
        const tmpdirPath = readFileSync(marker, "utf-8");
        cliExpectations[workflow]!(tmpdirPath);
      }

      const driverCode = `
import { existsSync, readFileSync } from "node:fs";
import { run, runPromise } from "loopx";
const cwd = ${JSON.stringify(project.dir)};
const workflows = ["symlink", "regular", "mismatch"];
const results = [];
for (const workflow of workflows) {
  for (const surface of ["runPromise", "run"]) {
    const marker = ${JSON.stringify(project.dir)} + "/tmp-safety-" + surface + "-" + workflow + ".txt";
    if (surface === "runPromise") {
      await runPromise(workflow, { cwd, maxIterations: 1, env: { OBSERVED_TMPDIR_MARKER: marker } });
    } else {
      for await (const _ of run(workflow, { cwd, maxIterations: 1, env: { OBSERVED_TMPDIR_MARKER: marker } })) {}
    }
    const tmpdirPath = readFileSync(marker, "utf-8");
    results.push({ workflow, surface, tmpdirPath, exists: existsSync(tmpdirPath) });
  }
}
process.stdout.write(JSON.stringify(results));
`;
      const api = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: { TMPDIR: parent },
      });
      expect(api.exitCode).toBe(0);
      for (const result of JSON.parse(api.stdout)) {
        if (result.workflow === "symlink") {
          expect(result.exists, `${result.surface}:symlink`).toBe(false);
        } else {
          expect(result.exists, `${result.surface}:${result.workflow}`).toBe(true);
        }
      }
    });

    it("T-TMP-38/T-TMP-38a/T-TMP-38a2/T-TMP-38b/T-TMP-38b2/T-TMP-38c/T-TMP-38c2/T-TMP-38d/T-TMP-38d2/T-TMP-38d3/T-TMP-38d4/T-TMP-38e/T-TMP-38f/T-TMP-39/T-TMP-40/T-TMP-41/T-TMP-42/T-TMP-42a/T-TMP-42b/T-TMP-42c: cleanup faults emit bounded warnings without changing the terminal outcome", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
printf 'payload' > "$LOOPX_TMPDIR/file.txt"
printf '{"stop":true}'
`,
      );
      const faultCases = [
        "lstat-fail",
        "recursive-remove-fail",
      ];
      for (const fault of faultCases) {
        const marker = join(project.dir, `tmp-cleanup-fault-${fault}.txt`);
        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: {
            TMPDIR: parent,
            NODE_ENV: "test",
            LOOPX_TEST_CLEANUP_FAULT: fault,
            OBSERVED_TMPDIR_MARKER: marker,
          },
        });
        expect(result.exitCode, fault).toBe(0);
        const tmpdirPath = readFileSync(marker, "utf-8");
        expect(existsSync(tmpdirPath), fault).toBe(true);
        const warningCount = (result.stderr.match(/LOOPX_TEST_CLEANUP_WARNING/g) ?? []).length;
        expect(warningCount, fault).toBeLessThanOrEqual(1);
      }
    });

    it("T-TMP-30: LOOPX_TMPDIR silently overrides inherited env values", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const marker = join(project.dir, "tmpdir-inherited.txt");
      const statMarker = join(project.dir, "tmpdir-inherited-stat.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
if [ -d "$LOOPX_TMPDIR" ]; then printf 'dir' > "${statMarker}"; fi
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent, LOOPX_TMPDIR: "/tmp/fake-loopx-tmp" },
      });

      expect(result.exitCode).toBe(0);
      const observed = readFileSync(marker, "utf-8");
      expect(observed).not.toBe("/tmp/fake-loopx-tmp");
      expect(observed.startsWith(`${parent}/loopx-`)).toBe(true);
      expect(readFileSync(statMarker, "utf-8")).toBe("dir");
      expect(result.stderr).not.toMatch(/LOOPX_TMPDIR.*overrid/i);
    });

    it("T-TMP-31: LOOPX_TMPDIR silently overrides local env-file values", async () => {
      project = await createTempProject();
      const parent = await createTmpParent();
      const marker = join(project.dir, "tmpdir-envfile.txt");
      await createEnvFile(join(project.dir, "local.env"), {
        LOOPX_TMPDIR: "/tmp/fake-loopx-tmp",
      });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-e", "local.env", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent },
      });

      expect(result.exitCode).toBe(0);
      const observed = readFileSync(marker, "utf-8");
      expect(observed).not.toBe("/tmp/fake-loopx-tmp");
      expect(observed.startsWith(`${parent}/loopx-`)).toBe(true);
      expect(result.stderr).not.toMatch(/LOOPX_TMPDIR.*overrid/i);
    });
  });
});
