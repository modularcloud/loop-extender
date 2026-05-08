import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { forEachRuntime } from "../helpers/runtime.js";

function assertUsageError(result: { exitCode: number; stderr: string }): void {
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toLowerCase()).toMatch(
    /usage|invalid|unrecognized|unexpected|too many|extra|target|argument/,
  );
}

function assertRunHelp(result: { exitCode: number; stdout: string }): void {
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toLowerCase()).toContain("usage");
  expect(result.stdout).toMatch(/\brun\b/i);
}

describe("TEST-SPEC ADR-0004 CLI grammar", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    it("T-CLI-RUN-DASHDASH- T-CLI-TOP-DASHDASH-01: top-level `loopx --` is rejected", async () => {
      project = await createTempProject();
      const result = await runCLI(["--"], { cwd: project.dir, runtime });

      assertUsageError(result);
      expect(result.stdout).not.toMatch(/^\d+\.\d+\.\d+\s*$/);
    });

    it("T-CLI-40b: run help usage does not advertise `--` or a name=value tail", async () => {
      project = await createTempProject();
      const result = await runCLI(["run", "-h"], {
        cwd: project.dir,
        runtime,
      });

      assertRunHelp(result);
      const usageBlock = result.stdout.split(/\n\s*\n/)[0] ?? result.stdout;
      expect(usageBlock).not.toMatch(/\[?--(?:\s|\]|\.\.\.)/);
      expect(usageBlock).not.toMatch(/\[[^\]]*=\s*[^\]]*\]/);
      expect(usageBlock).not.toMatch(/\b[A-Z_]*=[A-Z_]*\b/);
    });

    it("T-CLI-RUN-DASHDASH-01: `loopx run -- ralph` rejects `--` and does not run", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "--", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      assertUsageError(result);
      expect(existsSync(marker)).toBe(false);
    });

    it("T-CLI-RUN-DASHDASH-02: `loopx run -n 1 -- ralph` rejects `--` after valid options", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "--", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      assertUsageError(result);
      expect(existsSync(marker)).toBe(false);
    });

    it("T-CLI-RUN-DASHDASH-03: `loopx run -- name=value` rejects `--` before target validation", async () => {
      project = await createTempProject();
      const result = await runCLI(["run", "--", "adr=0003"], {
        cwd: project.dir,
        runtime,
      });

      assertUsageError(result);
      expect(result.stderr).toMatch(/--|usage|unrecognized|unexpected/i);
    });

    it("T-CLI-RUN-DASHDASH-04: `loopx run -h -- ralph` prints run help", async () => {
      project = await createTempProject();
      const result = await runCLI(["run", "-h", "--", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      assertRunHelp(result);
      expect(result.stderr).toBe("");
    });

    it("T-CLI-RUN-DASHDASH-05: `loopx run -- ralph -h` prints run help", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "--", "ralph", "-h"], {
        cwd: project.dir,
        runtime,
      });

      assertRunHelp(result);
      expect(existsSync(marker)).toBe(false);
    });

    it("T-CLI-RUN-DASHDASH-06: `loopx run --` is a usage error", async () => {
      project = await createTempProject();
      const result = await runCLI(["run", "--"], {
        cwd: project.dir,
        runtime,
      });

      assertUsageError(result);
    });

    it("T-CLI-RUN-DASHDASH-07: `loopx run ralph --` rejects trailing `--` and does not run", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "ralph", "--"], {
        cwd: project.dir,
        runtime,
      });

      assertUsageError(result);
      expect(existsSync(marker)).toBe(false);
    });

    it("T-CLI-RUN-DASHDASH-10: `loopx run -e -- ralph` rejects before loading an env file named `--`", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "ran.txt");
      await writeFile(
        join(project.dir, "--"),
        "MARKER=should-not-be-loaded\n1BAD=warning-if-loaded\n",
        "utf-8",
      );
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-e", "--", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      assertUsageError(result);
      expect(existsSync(marker)).toBe(false);
      expect(result.stderr).not.toContain("1BAD");
      expect(result.stderr).not.toContain("warning-if-loaded");
    });

    it("T-CLI-RUN-DASHDASH-08/T-CLI-RUN-DASHDASH-09: help short-circuit wins when `--` precedes help", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "dashdash-help-ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
      );

      for (const args of [
        ["run", "--", "-h"],
        ["run", "--", "--help"],
      ]) {
        const result = await runCLI(args, { cwd: project.dir, runtime });
        assertRunHelp(result);
      }
      expect(existsSync(marker)).toBe(false);
    });

    it("T-CLI-RUN-DASHDASH-11: `loopx run ralph -e --` rejects before loading an env file named `--`", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "ran.txt");
      await writeFile(
        join(project.dir, "--"),
        "MARKER=should-not-be-loaded\n1BAD=warning-if-loaded\n",
        "utf-8",
      );
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "ralph", "-e", "--"], {
        cwd: project.dir,
        runtime,
      });

      assertUsageError(result);
      expect(existsSync(marker)).toBe(false);
      expect(result.stderr).not.toContain("1BAD");
      expect(result.stderr).not.toContain("warning-if-loaded");
    });

    it("T-CLI-RUN-DASHDASH-12/T-CLI-RUN-DASHDASH-13: `--` in the -n operand slot is rejected as `--`, not as a numeric operand", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "dashdash-n-ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
      );

      for (const args of [
        ["run", "-n", "--", "ralph"],
        ["run", "ralph", "-n", "--"],
      ]) {
        const result = await runCLI(args, { cwd: project.dir, runtime });
        assertUsageError(result);
        expect(result.stderr).toContain("--");
        expect(result.stderr).not.toMatch(/\b(integer|numeric|number|operand|value for -n|requires.*-n)\b/i);
      }
      expect(existsSync(marker)).toBe(false);
    });

    it("T-CLI-RUN-NAMEVAL- T-CLI-RUN-NAMEVAL-01: sole `name=value` positional is parsed as an invalid target", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "adr=0003"], {
        cwd: project.dir,
        runtime,
      });

      assertUsageError(result);
      expect(result.stderr).toContain("=");
    });

    it("T-CLI-RUN-NAMEVAL-02: `name=value` is not loaded as an env var by the run parser", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "nameval-env.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$adr" > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "adr=0003"], {
        cwd: project.dir,
        runtime,
      });

      assertUsageError(result);
      expect(existsSync(marker)).toBe(false);
    });

    it("T-CLI-RUN-NAMEVAL-03: `name=value` after target is an extra-positional usage error", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "ralph", "adr=0003"], {
        cwd: project.dir,
        runtime,
      });

      assertUsageError(result);
      expect(existsSync(marker)).toBe(false);
    });

    it("T-CLI-RUN-NAMEVAL-04: `name=value` before run help is ignored by the help short-circuit", async () => {
      project = await createTempProject();
      const result = await runCLI(["run", "adr=0003", "-h"], {
        cwd: project.dir,
        runtime,
      });

      assertRunHelp(result);
      expect(result.stderr).not.toMatch(/adr=0003/);
    });

    it("T-CLI-RUN-NAMEVAL-05: `name=value` before --help is ignored by the help short-circuit", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "ralph", "adr=0003", "--help"], {
        cwd: project.dir,
        runtime,
      });

      assertRunHelp(result);
      expect(result.stderr).not.toMatch(/adr=0003/);
      expect(existsSync(marker)).toBe(false);
    });

    it("T-CLI-RUN-NAMEVAL-06: `name=value` before target is an extra-positional usage error", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "adr=0003", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      assertUsageError(result);
      expect(existsSync(marker)).toBe(false);
      expect(result.stderr).not.toMatch(/version/i);
    });

    it("T-CLI-RUN-NAMEVAL-07: option then `name=value` then target is an extra-positional usage error", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "adr=0003", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      assertUsageError(result);
      expect(existsSync(marker)).toBe(false);
    });

    it("T-CLI-69a/T-CLI-70a/T-CLI-123/T-CLI-123a/T-CLI-124/T-CLI-124a/T-CLI-125/T-CLI-126: run help short-circuits would-be operands and extra tokens", async () => {
      project = await createTempProject();
      const variants = [
        ["run", "--help", "--", "ralph"],
        ["run", "--help", "ralph", "adr=0003"],
        ["run", "-n", "-h"],
        ["run", "ralph", "-n", "-h"],
        ["run", "-e", "-h"],
        ["run", "ralph", "-e", "-h"],
        ["run", "-n", "--help"],
        ["run", "-e", "--help"],
      ];

      for (const args of variants) {
        const result = await runCLI(args, { cwd: project.dir, runtime });
        assertRunHelp(result);
      }
    });

    it("T-CLI-71a/T-CLI-71b: unknown top-level flags are usage errors even when help appears later", async () => {
      project = await createTempProject();
      for (const args of [
        ["--unknown", "-h"],
        ["--unknown", "--help"],
      ]) {
        const result = await runCLI(args, { cwd: project.dir, runtime });
        assertUsageError(result);
        expect(result.exitCode).toBe(1);
      }
    });

    it("T-CLI-19b: missing .loopx error includes creation guidance", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const result = await runCLI(["run", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      assertUsageError(result);
      expect(result.stderr).toMatch(/\.loopx/i);
      expect(result.stderr).toMatch(/create|initiali[sz]e|mkdir|install|add|set up|get started/i);
    });

    it("T-CLI-23a: CLI stdout stays empty for raw successful script output", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "raw-output-ran.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf ran > "${marker}"
printf 'hello raw\\n'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(existsSync(marker)).toBe(true);
    });

    it("T-CLI-RUN-ORDER-01/T-CLI-RUN-ORDER-02: env-file errors beat target-resolution errors", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '{"stop":true}'
`,
      );

      for (const target of ["nonexistent", ":script"]) {
        const result = await runCLI(["run", "-e", "missing.env", target], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("missing.env");
        expect(result.stderr).not.toContain(target);
      }
    });

    it("T-CLI-RUN-ORDER-03: discovery validation beats env-file loading", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '{"stop":true}'
`,
      );
      await createWorkflowScript(
        project,
        "broken",
        "check",
        ".sh",
        `#!/bin/bash
printf '{"stop":true}'
`,
      );
      await createWorkflowScript(
        project,
        "broken",
        "check",
        ".ts",
        `process.stdout.write('{"stop":true}');`,
      );

      const result = await runCLI(["run", "-e", "missing.env", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/broken|check/i);
      expect(result.stderr).not.toContain("missing.env");
    });

    it("T-CLI-RUN-ORDER-04: missing .loopx beats env-file loading", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const result = await runCLI(["run", "-e", "missing.env", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/\.loopx/i);
      expect(result.stderr).not.toContain("missing.env");
    });

    it("T-CLI-RUN-ORDER-05: env-file errors prevent workflow package warnings", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '{"stop":true}'
`,
      );
      await writeFile(join(project.loopxDir, "ralph", "package.json"), "{{{INVALID", "utf-8");

      const result = await runCLI(["run", "-e", "missing.env", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("missing.env");
      expect(result.stderr).not.toMatch(/package\.json|json|version|semver/i);
    });

    it("T-CLI-RUN-INHERIT-01: shell-style env prefix reaches scripts through inherited env", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "inherited-env.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$ADR" > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { ADR: "0004" },
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("0004");
    });
  });

  it("T-CLI-01a/T-CLI-01b: version subcommand rejects extra args and help flags", async () => {
    project = await createTempProject({ withLoopxDir: false });
    const expectedVersion = JSON.parse(
      readFileSync(resolve(process.cwd(), "node_modules/loopx/package.json"), "utf-8"),
    ).version;

    const extra = await runCLI(["version", "extra"], {
      cwd: project.dir,
      runtime: "node",
    });
    const help = await runCLI(["version", "--help"], {
      cwd: project.dir,
      runtime: "node",
    });

    assertUsageError(extra);
    assertUsageError(help);
    expect(extra.stdout).not.toBe(`${expectedVersion}\n`);
    expect(help.stdout).not.toBe(`${expectedVersion}\n`);
  });
});
