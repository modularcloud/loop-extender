import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { createEnvFile, withGlobalEnv } from "../helpers/env.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { runCLI } from "../helpers/cli.js";
import { forEachRuntime } from "../helpers/runtime.js";

describe("TEST-SPEC §4.7 PWD non-protocol behavior (T-PWD- T-PWD-05 non-normative reminder)", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    it("T-PWD-01/T-PWD-03: inherited PWD propagates unchanged to TS scripts", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "pwd-inherited.json");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
const value = process.env.PWD;
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(value === undefined ? { present: false } : { present: true, value }));
process.stdout.write(JSON.stringify({ stop: true }));
`,
      );

      const result = await runCLI(["run", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { PWD: "/inherited-pwd-value" },
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
        present: true,
        value: "/inherited-pwd-value",
      });
    });

    it("T-PWD-06: CLI project root ignores inherited PWD", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "pwd-project-root.json");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  projectRoot: process.env.LOOPX_PROJECT_ROOT,
  cwd: process.cwd(),
  pwd: process.env.PWD,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
      );

      const result = await runCLI(["run", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { PWD: "/bogus-value-that-does-not-exist" },
      });

      expect(result.exitCode).toBe(0);
      const observed = JSON.parse(readFileSync(marker, "utf-8"));
      expect(observed.projectRoot).toBe(project.dir);
      expect(observed.cwd).toBe(project.dir);
      expect(observed.pwd).toBe("/bogus-value-that-does-not-exist");
    });

    it("T-PWD-07: PWD supplied by global env file reaches scripts", async () => {
      await withGlobalEnv({ PWD: "/value-from-global-env-file" }, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "pwd-global.json");

        await createWorkflowScript(
          project!,
          "ralph",
          "index",
          ".ts",
          `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ present: process.env.PWD !== undefined, value: process.env.PWD }));
process.stdout.write(JSON.stringify({ stop: true }));
`,
        );

        const result = await runCLI(["run", "ralph"], {
          cwd: project!.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
          present: true,
          value: "/value-from-global-env-file",
        });
      });
    });

    it("T-PWD-08: PWD supplied by local env file reaches scripts", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "pwd-local.json");
      await createEnvFile(join(project.dir, "local.env"), {
        PWD: "/value-from-local-env-file",
      });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ present: process.env.PWD !== undefined, value: process.env.PWD }));
process.stdout.write(JSON.stringify({ stop: true }));
`,
      );

      const result = await runCLI(["run", "-e", "local.env", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
        present: true,
        value: "/value-from-local-env-file",
      });
    });
  });

  it("T-PWD-02: RunOptions.env.PWD reaches spawned scripts", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "pwd-api.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ present: process.env.PWD !== undefined, value: process.env.PWD }));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { PWD: "/value-from-run-options" },
});
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
      present: true,
      value: "/value-from-run-options",
    });
  });

  it("T-PWD-04: loopx does not synthesize PWD when absent from its environment", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "pwd-not-synthesized.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  keys: Object.keys(process.env).filter((key) => key === "PWD" || key.startsWith("LOOPX_")).sort(),
  pwd: process.env.PWD,
}));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const result = await runCLI(["run", "ralph"], {
      cwd: project.dir,
      runtime: "node",
      env: { PWD: undefined as unknown as string },
    });

    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(readFileSync(marker, "utf-8"));
    expect(observed.keys).toEqual(
      expect.arrayContaining([
        "LOOPX_BIN",
        "LOOPX_PROJECT_ROOT",
        "LOOPX_WORKFLOW",
        "LOOPX_WORKFLOW_DIR",
        "LOOPX_TMPDIR",
      ]),
    );
    expect(observed.keys).not.toContain("PWD");
    expect(observed.pwd).toBeUndefined();
    expect(existsSync(marker)).toBe(true);
  });
});
