import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  readFileSync,
  symlinkSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTempProject,
  createWorkflow,
  createWorkflowScript,
  createBashWorkflowScript,
  createWorkflowPackageJson,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { startLocalGitServer, type GitServer } from "../helpers/servers.js";
import {
  writeValueToFile,
  writeEnvToFile,
  emitResult,
  emitGoto,
  emitStop,
} from "../helpers/fixture-scripts.js";

// TS fixture: write a marker file with a literal value.
function tsMarker(markerPath: string, value: string): string {
  return `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(value)});\n`;
}

// Structural migration-warning check: return true iff any stderr line looks like
// a distinct warning/notice/advisory/migration/deprecation output category AND
// names the given subject. Prose-free — does not blacklist specific wording.
function hasWarningCategoryFor(stderr: string, subject: string): boolean {
  return stderr.split("\n").some((line) => {
    return (
      /^\s*(warning|notice|advisory|deprecat|migration)/i.test(line) &&
      line.includes(subject)
    );
  });
}

describe("SPEC: Workflow & Script Discovery (ADR-0003)", () => {
  let project: TempProject | null = null;
  let gitServer: GitServer | null = null;
  const extraCleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of extraCleanups.splice(0)) {
      await cleanup().catch(() => {});
    }
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
    if (gitServer) {
      await gitServer.close().catch(() => {});
      gitServer = null;
    }
  });

  // =========================================================================
  // Workflow Discovery (T-DISC-01 through T-DISC-11, T-DISC-10a–10g)
  // =========================================================================
  describe("SPEC: Workflow Discovery", () => {
    it("T-DISC-01: .loopx/ralph/index.sh is a valid workflow, loopx run -n 1 ralph runs it", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-01.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeValueToFile("disc01", marker),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc01");
    });

    it("T-DISC-02: .loopx/ralph/index.ts is a valid workflow, runs via loopx run -n 1 ralph", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-02.txt");
      await createWorkflowScript(project, "ralph", "index", ".ts", tsMarker(marker, "disc02"));

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc02");
    });

    it("T-DISC-03: .loopx/ralph/index.js is a valid workflow", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-03.txt");
      await createWorkflowScript(project, "ralph", "index", ".js", tsMarker(marker, "disc03"));

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc03");
    });

    it("T-DISC-04: .loopx/ralph/index.jsx is a valid workflow", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-04.txt");
      await createWorkflowScript(project, "ralph", "index", ".jsx", tsMarker(marker, "disc04"));

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc04");
    });

    it("T-DISC-05: .loopx/ralph/index.tsx is a valid workflow", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-05.txt");
      await createWorkflowScript(project, "ralph", "index", ".tsx", tsMarker(marker, "disc05"));

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc05");
    });

    it("T-DISC-06: .loopx/ralph/ containing only index.mjs is not a workflow (.mjs unsupported)", async () => {
      project = await createTempProject();
      await createWorkflowScript(project, "ralph", "index", ".mjs", `console.log("hello");\n`);

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/not found|no.*workflow|unknown/i);
    });

    it("T-DISC-07: .loopx/ralph/ containing only index.cjs is not a workflow (.cjs unsupported)", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".cjs",
        `console.log("hello");\n`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-07b: .cjs sibling of valid script is silently ignored (workflow runs, .cjs not discovered as script)", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-07b.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeValueToFile("disc07b", marker),
      );
      // .cjs sibling — unsupported extension, must be silently ignored during discovery.
      const wf = join(project.loopxDir, "ralph");
      writeFileSync(join(wf, "helper.cjs"), `console.log("helper");\n`);

      // (a) ralph:index runs successfully
      const idxRes = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });
      expect(idxRes.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc07b");

      // (b) no warning about helper.cjs being unsupported (silent exclusion, not a warning)
      expect(hasWarningCategoryFor(idxRes.stderr, "helper.cjs")).toBe(false);
      expect(idxRes.stderr).not.toMatch(/helper\.cjs/);

      // (c) ralph:helper fails — .cjs was not discovered as a `helper` script
      const helperRes = await runCLI(["run", "-n", "1", "ralph:helper"], { cwd: project.dir });
      expect(helperRes.exitCode).toBe(1);
      expect(helperRes.stderr).toMatch(/not found/i);
    });

    it("T-DISC-08: subdir with only non-script files (readme.txt, config.json) is not a workflow, no warning", async () => {
      project = await createTempProject();
      const wf = await createWorkflow(project, "ralph");
      writeFileSync(join(wf, "readme.txt"), "readme\n");
      writeFileSync(join(wf, "config.json"), `{"name":"ralph"}\n`);

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
      expect(hasWarningCategoryFor(result.stderr, "ralph")).toBe(false);
    });

    it("T-DISC-09: empty .loopx/ralph/ is not a workflow, no warning", async () => {
      project = await createTempProject();
      await createWorkflow(project, "ralph");

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
      expect(hasWarningCategoryFor(result.stderr, "ralph")).toBe(false);
    });

    it("T-DISC-09a: top-level entry shaped as <name>.<ext> but typed as a directory does not count as a script (workflow detection requires real files)", async () => {
      project = await createTempProject();
      // ralph/ contains only a directory entry "index.sh/" — must NOT be discovered as a workflow.
      const ralphDir = join(project.loopxDir, "ralph");
      mkdirSync(join(ralphDir, "index.sh"), { recursive: true });
      // Sibling workflow (real) so .loopx/ has at least one valid workflow.
      const otherMarker = join(project.dir, "marker-09a-other.txt");
      await createWorkflowScript(
        project,
        "other",
        "index",
        ".sh",
        writeValueToFile("disc09a-other", otherMarker),
      );

      // (a) ralph is not a discovered workflow
      const ralphRes = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });
      expect(ralphRes.exitCode).toBe(1);
      // (b) error category is missing-workflow (NOT missing-default-entry-point, NOT script-execution)
      expect(ralphRes.stderr).toMatch(/not found in \.loopx\//);
      expect(ralphRes.stderr).not.toMatch(/has no default entry point/);
      // (c) directory-shaped index.sh/ is silently ignored — no validation warning
      expect(hasWarningCategoryFor(ralphRes.stderr, "index.sh")).toBe(false);

      // (d) sibling workflow is still discoverable
      const otherRes = await runCLI(["run", "-n", "1", "other"], { cwd: project.dir });
      expect(otherRes.exitCode).toBe(0);
      expect(existsSync(otherMarker)).toBe(true);
      expect(readFileSync(otherMarker, "utf-8")).toBe("disc09a-other");
    });

    it("T-DISC-09b: top-level directory shaped as <name>.<ext> alongside a real script is silently ignored during script discovery", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-09b.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeValueToFile("disc09b", marker),
      );
      // Top-level directory whose name shapes as check.ts/ — not a real .ts file.
      const checkDir = join(project.loopxDir, "ralph", "check.ts");
      mkdirSync(checkDir, { recursive: true });
      writeFileSync(join(checkDir, "notes.md"), "internal notes\n");

      // (a) ralph:index runs successfully
      const idxRes = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });
      expect(idxRes.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc09b");

      // (b) ralph:check fails — the directory check.ts/ was not discovered as a script
      const checkRes = await runCLI(["run", "-n", "1", "ralph:check"], { cwd: project.dir });
      expect(checkRes.exitCode).toBe(1);
      expect(checkRes.stderr).toMatch(/not found/i);

      // (c-e) loopx run -h: ralph listed with index, "check" NOT in script list, no warning
      const helpRes = await runCLI(["run", "-h"], { cwd: project.dir });
      expect(helpRes.exitCode).toBe(0);
      expect(helpRes.stdout).toMatch(/ralph/);
      // Within the help body, "check" must not appear as a script line. Script lines
      // begin with at least 4 spaces of indent then the script name. "    check (.ts)"
      // would be the buggy output we're guarding against.
      expect(helpRes.stdout).not.toMatch(/^\s{4,}check\b/m);
      // No warning about check.ts being a directory — silent ignore, like nested subdirs (T-DISC-14).
      expect(hasWarningCategoryFor(helpRes.stderr, "check.ts")).toBe(false);
    });

    it("T-DISC-10: files directly in .loopx/ are never discovered (loose-script.sh alongside ralph)", async () => {
      project = await createTempProject();
      // Loose file directly under .loopx/
      const loosePath = join(project.loopxDir, "loose-script.sh");
      writeFileSync(loosePath, `#!/bin/bash\necho loose\n`);
      chmodSync(loosePath, 0o755);
      // Valid workflow
      const ralphMarker = join(project.dir, "marker-10-ralph.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeValueToFile("ralph-ran", ralphMarker),
      );

      const looseResult = await runCLI(["run", "-n", "1", "loose-script"], { cwd: project.dir });
      expect(looseResult.exitCode).toBe(1);

      const ralphResult = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });
      expect(ralphResult.exitCode).toBe(0);
      expect(existsSync(ralphMarker)).toBe(true);
      expect(readFileSync(ralphMarker, "utf-8")).toBe("ralph-ran");
    });

    it("T-DISC-11: .loopx/loose-script.ts directly in .loopx/ is not discovered (supported ext irrelevant)", async () => {
      project = await createTempProject();
      const loosePath = join(project.loopxDir, "loose-script.ts");
      writeFileSync(loosePath, `console.log("loose");\n`);

      const result = await runCLI(["run", "-n", "1", "loose-script"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-10a: flat loose-script.sh — no separate migration/deprecation warning category in stderr", async () => {
      project = await createTempProject();
      const loosePath = join(project.loopxDir, "loose-script.sh");
      // Fixture script emits {stop:true} so that if pre-ADR-0003 impl incidentally discovers
      // it as a flat script, the run still terminates quickly (test still expects exit 1
      // once the workflow model is implemented; this shortcut just avoids 30s hangs today).
      writeFileSync(loosePath, `#!/bin/bash\nprintf '{"stop":true}'\n`);
      chmodSync(loosePath, 0o755);
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"stop":true}'\n`,
      );

      const result = await runCLI(["run", "loose-script"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
      // Structural: no warning/notice/advisory/migration/deprecation category that names the
      // loose file path. The routine target-not-found error for "loose-script" is permitted.
      expect(hasWarningCategoryFor(result.stderr, ".loopx/loose-script.sh")).toBe(false);
      expect(hasWarningCategoryFor(result.stderr, "loose-script.sh")).toBe(false);
    });

    it("T-DISC-10b: invalid loose file name (.loopx/-bad-name.sh) is ignored entirely — never validated", async () => {
      project = await createTempProject();
      const loosePath = join(project.loopxDir, "-bad-name.sh");
      writeFileSync(loosePath, `#!/bin/bash\necho loose\n`);
      chmodSync(loosePath, 0o755);
      const marker = join(project.dir, "marker-10b.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeValueToFile("disc10b", marker),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc10b");
      // The invalid-named loose file must not surface any error or warning.
      expect(result.stderr).not.toMatch(/-bad-name/);
    });

    it("T-DISC-10c: non-workflow subdir with invalid name (only README.md, no scripts) ignored — not validated", async () => {
      project = await createTempProject();
      const badDir = join(project.loopxDir, "-bad-dir");
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, "README.md"), "# no scripts\n");
      const marker = join(project.dir, "marker-10c.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeValueToFile("disc10c", marker),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc10c");
      expect(result.stderr).not.toMatch(/-bad-dir/);
    });

    it("T-DISC-10d: under loopx run -h, non-workflow -bad-dir/ (README.md only) is neither listed nor warned", async () => {
      project = await createTempProject();
      const badDir = join(project.loopxDir, "-bad-dir");
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, "README.md"), "# no scripts\n");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).not.toMatch(/-bad-dir/);
      expect(result.stdout).toMatch(/ralph/);
    });

    it("T-DISC-10e: under loopx run -h, invalid-named loose root file .loopx/-bad-root-file.sh is ignored (not listed, not warned)", async () => {
      project = await createTempProject();
      const loosePath = join(project.loopxDir, "-bad-root-file.sh");
      writeFileSync(loosePath, `#!/bin/bash\necho loose\n`);
      chmodSync(loosePath, 0o755);
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).not.toMatch(/-bad-root-file/);
      expect(result.stdout).toMatch(/ralph/);
    });

    it("T-DISC-10f: .loopx/foo.sh (loose) and .loopx/foo/index.sh coexist; loopx run foo runs foo:index", async () => {
      project = await createTempProject();
      // Loose root file with same basename as the workflow
      const loosePath = join(project.loopxDir, "foo.sh");
      writeFileSync(loosePath, `#!/bin/bash\nprintf 'loose-ran' > ${JSON.stringify(join(project.dir, "loose-marker.txt"))}\n`);
      chmodSync(loosePath, 0o755);
      // Workflow foo/index.sh
      const marker = join(project.dir, "marker-10f.txt");
      await createWorkflowScript(
        project,
        "foo",
        "index",
        ".sh",
        writeValueToFile("foo-index-ran", marker),
      );

      const result = await runCLI(["run", "-n", "1", "foo"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("foo-index-ran");
      // Loose file was never invoked.
      expect(existsSync(join(project.dir, "loose-marker.txt"))).toBe(false);
    });

    it("T-DISC-10g: under loopx run -h, foo.sh (loose) and foo/ workflow coexist without collision warning", async () => {
      project = await createTempProject();
      const loosePath = join(project.loopxDir, "foo.sh");
      writeFileSync(loosePath, `#!/bin/bash\necho loose\n`);
      chmodSync(loosePath, 0o755);
      await createWorkflowScript(
        project,
        "foo",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      // foo is listed
      expect(result.stdout).toMatch(/foo/);
      // The loose file path must not appear anywhere
      expect(result.stdout + result.stderr).not.toMatch(/\.loopx\/foo\.sh/);
      // No collision warning mentioning foo.sh + foo/
      expect(hasWarningCategoryFor(result.stderr, "foo.sh")).toBe(false);
      expect(result.stderr).not.toMatch(/collision|conflict|duplicate/i);
    });
  });

  // =========================================================================
  // Script Discovery Within Workflows (T-DISC-12, 13, 14, 14a, 14b, 15, 15a, 15b, 16)
  // =========================================================================
  describe("SPEC: Script Discovery Within Workflows", () => {
    it("T-DISC-12: all top-level supported-extension files in a workflow are discovered", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"idx"}'\n`,
      );
      const checkMarker = join(project.dir, "marker-12-check.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "check-ready",
        ".sh",
        writeValueToFile("check-ready-ran", checkMarker),
      );
      const setupMarker = join(project.dir, "marker-12-setup.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "setup",
        ".ts",
        tsMarker(setupMarker, "setup-ran"),
      );

      const checkRes = await runCLI(["run", "-n", "1", "ralph:check-ready"], { cwd: project.dir });
      expect(checkRes.exitCode).toBe(0);
      expect(readFileSync(checkMarker, "utf-8")).toBe("check-ready-ran");

      const setupRes = await runCLI(["run", "-n", "1", "ralph:setup"], { cwd: project.dir });
      expect(setupRes.exitCode).toBe(0);
      expect(readFileSync(setupMarker, "utf-8")).toBe("setup-ran");
    });

    it("T-DISC-13: script base name (without extension) is the addressable script name", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"idx"}'\n`,
      );
      const marker = join(project.dir, "marker-13.txt");
      await createWorkflowScript(project, "ralph", "my-check", ".ts", tsMarker(marker, "disc13"));

      const result = await runCLI(["run", "-n", "1", "ralph:my-check"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc13");
    });

    it("T-DISC-14: files in workflow subdirectories (lib/) are NOT discovered as scripts", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"idx"}'\n`,
      );
      const wf = join(project.loopxDir, "ralph");
      mkdirSync(join(wf, "lib"), { recursive: true });
      writeFileSync(
        join(wf, "lib", "helpers.ts"),
        `console.log("helpers");\n`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph:helpers"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-14a: invalid names / collisions nested in workflow subdirectories do not trigger fatal validation", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-14a.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeValueToFile("disc14a", marker),
      );
      const libDir = join(project.loopxDir, "ralph", "lib");
      mkdirSync(libDir, { recursive: true });
      // invalid script name and same-base-name collision within the subdirectory
      writeFileSync(join(libDir, "-bad.ts"), `console.log("bad");\n`);
      writeFileSync(join(libDir, "check.sh"), `#!/bin/bash\necho check\n`);
      chmodSync(join(libDir, "check.sh"), 0o755);
      writeFileSync(join(libDir, "check.ts"), `console.log("check");\n`);

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc14a");
    });

    it("T-DISC-14b: subdirectory files (lib/) are usable internally by workflow scripts but not discovered as scripts", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-14b.txt");
      // helpers.ts exports greet()
      const libDir = join(project.loopxDir, "ralph", "lib");
      mkdirSync(libDir, { recursive: true });
      writeFileSync(
        join(libDir, "helpers.ts"),
        `export function greet(): string { return "hello from helpers"; }\n`,
      );
      // index.ts imports from ./lib/helpers.ts and writes to marker
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        [
          `import { writeFileSync } from "node:fs";`,
          `import { greet } from "./lib/helpers.ts";`,
          `writeFileSync(${JSON.stringify(marker)}, greet());`,
          ``,
        ].join("\n"),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("hello from helpers");

      // ralph:helpers must not be a discovered script.
      const negative = await runCLI(["run", "-n", "1", "ralph:helpers"], { cwd: project.dir });
      expect(negative.exitCode).toBe(1);
    });

    it("T-DISC-15: non-script files (schema.json, README.md) are allowed and ignored without warnings", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-15.txt");
      await createWorkflowScript(project, "ralph", "index", ".ts", tsMarker(marker, "disc15"));
      const wf = join(project.loopxDir, "ralph");
      writeFileSync(join(wf, "schema.json"), `{"schema":"x"}\n`);
      writeFileSync(join(wf, "README.md"), "# ralph\n");

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc15");
      expect(hasWarningCategoryFor(result.stderr, "schema.json")).toBe(false);
      expect(hasWarningCategoryFor(result.stderr, "README.md")).toBe(false);
    });

    it("T-DISC-15a: config-style file with supported ext (eslint.config.js) is discovered as script; dot in name fails validation", async () => {
      project = await createTempProject();
      await createWorkflowScript(project, "ralph", "index", ".ts", `console.log("idx");\n`);
      // eslint.config.js at workflow top level → discovered as script "eslint.config" which has a dot
      const wf = join(project.loopxDir, "ralph");
      writeFileSync(join(wf, "eslint.config.js"), `console.log("cfg");\n`);

      const result = await runCLI(["run", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-15b: under loopx run -h, eslint.config.js invalid script name surfaces as non-fatal warning", async () => {
      project = await createTempProject();
      await createWorkflowScript(project, "ralph", "index", ".ts", `console.log("idx");\n`);
      const wf = join(project.loopxDir, "ralph");
      writeFileSync(join(wf, "eslint.config.js"), `console.log("cfg");\n`);

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/eslint\.config/);
    });

    it("T-DISC-15c: uppercase script extensions (.SH/.TS/.JS) are not supported — case-sensitive matching, single-file workflow not discovered", async () => {
      project = await createTempProject();
      // .loopx/ralph/ contains a single file index.SH (uppercase only — no lowercase counterpart).
      // Per SPEC 5.1, the supported extension set (.sh/.ts/.js/.jsx/.tsx) is case-sensitive,
      // so this directory has zero supported-extension files and is NOT a workflow.
      const ralphDir = join(project.loopxDir, "ralph");
      mkdirSync(ralphDir, { recursive: true });
      const upperMarker = join(project.dir, "marker-15c-uppercase.txt");
      const upperPath = join(ralphDir, "index.SH");
      writeFileSync(
        upperPath,
        `#!/bin/bash\nprintf 'should-not-run' > ${JSON.stringify(upperMarker)}\n`,
      );
      chmodSync(upperPath, 0o755);

      // Sibling workflow with a real lowercase ext so .loopx/ itself discovers something.
      const otherMarker = join(project.dir, "marker-15c-other.txt");
      await createWorkflowScript(
        project,
        "other",
        "index",
        ".sh",
        writeValueToFile("disc15c-other", otherMarker),
      );

      // (a) ralph is not a discovered workflow — error category is missing-workflow,
      //     NOT missing-default-entry-point, NOT a spawn-time "is-a-directory" / exec error.
      const ralphRes = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });
      expect(ralphRes.exitCode).toBe(1);
      expect(ralphRes.stderr).toMatch(/not found in \.loopx\//);
      expect(ralphRes.stderr).not.toMatch(/has no default entry point/);

      // (b) the .SH file did not run — marker absent
      expect(existsSync(upperMarker)).toBe(false);

      // (c) sibling workflow still runs
      const otherRes = await runCLI(["run", "-n", "1", "other"], { cwd: project.dir });
      expect(otherRes.exitCode).toBe(0);
      expect(readFileSync(otherMarker, "utf-8")).toBe("disc15c-other");
    });

    it("T-DISC-15c (companion): when index.SH and index.sh coexist on a case-sensitive filesystem, only index.sh is discovered", async () => {
      // Probe whether the filesystem is case-sensitive. On case-insensitive FS the two
      // filenames cannot coexist as distinct files, so the companion case is unrunnable.
      const probeDir = await mkdtemp(join(tmpdir(), "loopx-15c-probe-"));
      let caseSensitive = true;
      try {
        const lower = join(probeDir, "probe.txt");
        const upper = join(probeDir, "PROBE.TXT");
        writeFileSync(lower, "lower");
        try {
          writeFileSync(upper, "upper");
          // Distinct content survives only on a case-sensitive filesystem.
          caseSensitive = readFileSync(lower, "utf-8") === "lower" &&
            readFileSync(upper, "utf-8") === "upper";
        } catch {
          caseSensitive = false;
        }
      } finally {
        await rm(probeDir, { recursive: true, force: true });
      }
      if (!caseSensitive) {
        // Skip silently — the fixture cannot be constructed.
        return;
      }

      project = await createTempProject();
      const ralphDir = join(project.loopxDir, "ralph");
      mkdirSync(ralphDir, { recursive: true });
      const lowerMarker = join(project.dir, "marker-15c-companion-lower.txt");
      const upperMarker = join(project.dir, "marker-15c-companion-upper.txt");
      const lowerPath = join(ralphDir, "index.sh");
      const upperPath = join(ralphDir, "index.SH");
      writeFileSync(lowerPath, `#!/bin/bash\nprintf 'lower-ran' > ${JSON.stringify(lowerMarker)}\n`);
      chmodSync(lowerPath, 0o755);
      writeFileSync(upperPath, `#!/bin/bash\nprintf 'upper-ran' > ${JSON.stringify(upperMarker)}\n`);
      chmodSync(upperPath, 0o755);

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      // (a) ralph IS a discovered workflow because index.sh has a supported extension
      expect(result.exitCode).toBe(0);
      // (b) only index.sh ran (lower marker present, upper marker absent)
      expect(existsSync(lowerMarker)).toBe(true);
      expect(readFileSync(lowerMarker, "utf-8")).toBe("lower-ran");
      expect(existsSync(upperMarker)).toBe(false);
      // (c) no name-collision warning about index.SH (collisions are checked across the
      //     recognized extension set only — index.SH is not a recognized extension).
      expect(result.stderr).not.toMatch(/index\.SH/);
      expect(hasWarningCategoryFor(result.stderr, "index.SH")).toBe(false);
      expect(result.stderr).not.toMatch(/collision|conflict|duplicate/i);
    });

    it("T-DISC-16: workflow directory with only subdirectory scripts (no top-level supported-ext files) is not a workflow", async () => {
      project = await createTempProject();
      const libDir = join(project.loopxDir, "ralph", "lib");
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, "helpers.ts"), `console.log("helpers");\n`);

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // Default Entry Point (T-DISC-17, 18, 19, 20, 20a, 20b, 20c)
  // =========================================================================
  describe("SPEC: Default Entry Point", () => {
    it("T-DISC-17: loopx run ralph runs ralph:index (not another script)", async () => {
      project = await createTempProject();
      const idxMarker = join(project.dir, "marker-17-index.txt");
      const checkMarker = join(project.dir, "marker-17-check.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeValueToFile("index-ran", idxMarker),
      );
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".sh",
        writeValueToFile("check-ran", checkMarker),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(idxMarker)).toBe(true);
      expect(readFileSync(idxMarker, "utf-8")).toBe("index-ran");
      expect(existsSync(checkMarker)).toBe(false);
    });

    it("T-DISC-18: loopx run ralph:index is equivalent to loopx run ralph", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-18.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeValueToFile("disc18", marker),
      );

      const bare = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });
      expect(bare.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc18");

      // Clear marker, then run explicit :index target
      writeFileSync(marker, "");
      const explicit = await runCLI(["run", "-n", "1", "ralph:index"], { cwd: project.dir });
      expect(explicit.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc18");
    });

    it("T-DISC-19: workflow with no index script — bare run fails; explicit workflow:script succeeds", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-19.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".sh",
        writeValueToFile("disc19", marker),
      );

      const bare = await runCLI(["run", "ralph"], { cwd: project.dir });
      expect(bare.exitCode).toBe(1);

      const explicit = await runCLI(["run", "-n", "1", "ralph:check"], { cwd: project.dir });
      expect(explicit.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc19");
    });

    it("T-DISC-20: index is not otherwise special — can goto other scripts, chain runs both", async () => {
      project = await createTempProject();
      const idxMarker = join(project.dir, "marker-20-index.txt");
      const checkMarker = join(project.dir, "marker-20-check.txt");
      // index.sh writes a marker, then goto "check"
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '%s' 'index-ran' > ${JSON.stringify(idxMarker)}\nprintf '{"goto":"check"}'\n`,
      );
      // check.sh writes a marker then stops.
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".sh",
        `#!/bin/bash\nprintf '%s' 'check-ran' > ${JSON.stringify(checkMarker)}\nprintf '{"stop":true}'\n`,
      );

      const result = await runCLI(["run", "-n", "5", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(idxMarker, "utf-8")).toBe("index-ran");
      expect(readFileSync(checkMarker, "utf-8")).toBe("check-ran");
    });

    it("T-DISC-20a: package.json main is ignored — loopx run ralph runs index.ts, not main-specified check.ts", async () => {
      project = await createTempProject();
      const idxMarker = join(project.dir, "marker-20a-index.txt");
      const checkMarker = join(project.dir, "marker-20a-check.txt");
      await createWorkflowPackageJson(project, "ralph", { main: "check.ts" });
      await createWorkflowScript(project, "ralph", "index", ".ts", tsMarker(idxMarker, "index-ran"));
      await createWorkflowScript(project, "ralph", "check", ".ts", tsMarker(checkMarker, "check-ran"));

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(idxMarker)).toBe(true);
      expect(readFileSync(idxMarker, "utf-8")).toBe("index-ran");
      expect(existsSync(checkMarker)).toBe(false);
    });

    it("T-DISC-20b: package.json main does not provide a fallback entry point (no index → bare run fails)", async () => {
      project = await createTempProject();
      await createWorkflowPackageJson(project, "ralph", { main: "check.ts" });
      // check.ts deliberately exits 0 with no output so pre-ADR-0003 dir-script interpretation
      // doesn't loop forever (workflow-model expectation is exit 1 for missing index).
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".ts",
        `process.exit(0);\n`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-20c: legacy directory-script layout (main=src/run.js, no top-level scripts) is not discovered, no migration-warning category", async () => {
      project = await createTempProject();
      const wf = await createWorkflow(project, "mypipeline");
      writeFileSync(
        join(wf, "package.json"),
        JSON.stringify({ main: "src/run.js" }, null, 2),
      );
      mkdirSync(join(wf, "src"), { recursive: true });
      // run.js exits 0 immediately so pre-ADR-0003 dir-script interpretation does not hang.
      writeFileSync(join(wf, "src", "run.js"), `process.exit(0);\n`);

      const result = await runCLI(["run", "-n", "1", "mypipeline"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
      // Structural: no warning/notice/advisory/migration/deprecation line naming the legacy layout.
      expect(hasWarningCategoryFor(result.stderr, ".loopx/mypipeline/src/run.js")).toBe(false);
      expect(hasWarningCategoryFor(result.stderr, "src/run.js")).toBe(false);
      expect(hasWarningCategoryFor(result.stderr, "package.json")).toBe(false);
    });
  });

  // =========================================================================
  // Name Collisions Within Workflows (T-DISC-21, 21a, 22, 23, 24)
  // =========================================================================
  describe("SPEC: Name Collisions Within Workflows", () => {
    it("T-DISC-21: .loopx/ralph/check.sh and check.ts collide — loopx run ralph:check fails", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"idx"}'\n`,
      );
      await createWorkflowScript(project, "ralph", "check", ".sh", `#!/bin/bash\necho check-sh\n`);
      await createWorkflowScript(project, "ralph", "check", ".ts", `console.log("check-ts");\n`);

      const result = await runCLI(["run", "-n", "1", "ralph:check"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/check/);
      expect(result.stderr).toMatch(/collision|conflict|duplicate|multiple/i);
    });

    it("T-DISC-21a: index follows same collision rules — index.sh + index.ts in ralph fails", async () => {
      project = await createTempProject();
      await createWorkflowScript(project, "ralph", "index", ".sh", `#!/bin/bash\necho idx-sh\n`);
      await createWorkflowScript(project, "ralph", "index", ".ts", `console.log("idx-ts");\n`);

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/index/);
      expect(result.stderr).toMatch(/\.sh/);
      expect(result.stderr).toMatch(/\.ts/);
    });

    it("T-DISC-22: collision in one workflow is fatal for targets in any workflow (global validation)", async () => {
      project = await createTempProject();
      // ralph has a collision
      await createWorkflowScript(project, "ralph", "check", ".sh", `#!/bin/bash\necho ralph-check-sh\n`);
      await createWorkflowScript(project, "ralph", "check", ".ts", `console.log("ralph-check-ts");\n`);
      // other is valid
      await createWorkflowScript(
        project,
        "other",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"other"}'\n`,
      );

      const result = await runCLI(["run", "-n", "1", "other"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/check/);
    });

    it("T-DISC-23: same base names across different workflows coexist (no collision)", async () => {
      project = await createTempProject();
      // ralph and other both have index (no collision, different workflows)
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"idx"}'\n`,
      );
      await createWorkflowScript(
        project,
        "other",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"idx"}'\n`,
      );
      // and both have "check" under different extensions
      const ralphCheck = join(project.dir, "marker-23-ralph-check.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".sh",
        writeValueToFile("ralph-check", ralphCheck),
      );
      const otherCheck = join(project.dir, "marker-23-other-check.txt");
      await createWorkflowScript(
        project,
        "other",
        "check",
        ".ts",
        tsMarker(otherCheck, "other-check"),
      );

      const ralphRes = await runCLI(["run", "-n", "1", "ralph:check"], { cwd: project.dir });
      expect(ralphRes.exitCode).toBe(0);
      expect(readFileSync(ralphCheck, "utf-8")).toBe("ralph-check");

      const otherRes = await runCLI(["run", "-n", "1", "other:check"], { cwd: project.dir });
      expect(otherRes.exitCode).toBe(0);
      expect(readFileSync(otherCheck, "utf-8")).toBe("other-check");
    });

    it("T-DISC-24: non-conflicting scripts in same workflow coexist", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"idx"}'\n`,
      );
      const alphaMarker = join(project.dir, "marker-24-alpha.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "alpha",
        ".sh",
        writeValueToFile("alpha-ran", alphaMarker),
      );
      const betaMarker = join(project.dir, "marker-24-beta.txt");
      await createWorkflowScript(project, "ralph", "beta", ".ts", tsMarker(betaMarker, "beta-ran"));

      const alphaRes = await runCLI(["run", "-n", "1", "ralph:alpha"], { cwd: project.dir });
      expect(alphaRes.exitCode).toBe(0);
      expect(readFileSync(alphaMarker, "utf-8")).toBe("alpha-ran");

      const betaRes = await runCLI(["run", "-n", "1", "ralph:beta"], { cwd: project.dir });
      expect(betaRes.exitCode).toBe(0);
      expect(readFileSync(betaMarker, "utf-8")).toBe("beta-ran");
    });
  });

  // =========================================================================
  // Workflow and Script Naming (T-DISC-25–32, + 26a/b, 30a/b)
  // =========================================================================
  describe("SPEC: Workflow and Script Naming", () => {
    it("T-DISC-25: workflow name my-workflow (hyphen in middle) is valid", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-25.txt");
      await createWorkflowScript(
        project,
        "my-workflow",
        "index",
        ".sh",
        writeValueToFile("disc25", marker),
      );

      const result = await runCLI(["run", "-n", "1", "my-workflow"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc25");
    });

    it("T-DISC-26: workflow name _underscore (underscore prefix) is valid", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-26.txt");
      await createWorkflowScript(
        project,
        "_underscore",
        "index",
        ".sh",
        writeValueToFile("disc26", marker),
      );

      const result = await runCLI(["run", "-n", "1", "_underscore"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc26");
    });

    it("T-DISC-26a: workflow name 1flow (digit first) is valid", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-26a.txt");
      await createWorkflowScript(
        project,
        "1flow",
        "index",
        ".sh",
        writeValueToFile("disc26a", marker),
      );

      const result = await runCLI(["run", "-n", "1", "1flow"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc26a");
    });

    it("T-DISC-26b: workflow name 42 (all digits) is valid", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-26b.txt");
      await createWorkflowScript(
        project,
        "42",
        "index",
        ".sh",
        writeValueToFile("disc26b", marker),
      );

      const result = await runCLI(["run", "-n", "1", "42"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc26b");
    });

    it("T-DISC-27: workflow name -startswithdash is rejected", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "-startswithdash",
        "index",
        ".sh",
        `#!/bin/bash\necho dash\n`,
      );
      // Also create a valid workflow so we can invoke something (target parser will need a target).
      await createWorkflowScript(project, "good", "index", ".sh", `#!/bin/bash\necho good\n`);

      // Global validation should reject the invalid sibling name even when we target "good".
      const result = await runCLI(["run", "good"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-28: workflow name with space is rejected", async () => {
      project = await createTempProject();
      // Create the bad-named workflow directly via mkdirSync — createWorkflow would also work on Linux.
      const badWf = join(project.loopxDir, "has space");
      mkdirSync(badWf, { recursive: true });
      writeFileSync(join(badWf, "index.sh"), `#!/bin/bash\necho bad\n`);
      chmodSync(join(badWf, "index.sh"), 0o755);
      await createWorkflowScript(project, "good", "index", ".sh", `#!/bin/bash\necho good\n`);

      const result = await runCLI(["run", "good"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-29: workflow name with dot is rejected", async () => {
      project = await createTempProject();
      const badWf = join(project.loopxDir, "has.dot");
      mkdirSync(badWf, { recursive: true });
      writeFileSync(join(badWf, "index.sh"), `#!/bin/bash\necho bad\n`);
      chmodSync(join(badWf, "index.sh"), 0o755);
      await createWorkflowScript(project, "good", "index", ".sh", `#!/bin/bash\necho good\n`);

      const result = await runCLI(["run", "good"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-30: script name check-ready (hyphen in middle) is valid", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"idx"}'\n`,
      );
      const marker = join(project.dir, "marker-30.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "check-ready",
        ".sh",
        writeValueToFile("disc30", marker),
      );

      const result = await runCLI(["run", "-n", "1", "ralph:check-ready"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc30");
    });

    it("T-DISC-30a: script name 1start (digit first) is valid", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"idx"}'\n`,
      );
      const marker = join(project.dir, "marker-30a.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "1start",
        ".sh",
        writeValueToFile("disc30a", marker),
      );

      const result = await runCLI(["run", "-n", "1", "ralph:1start"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc30a");
    });

    it("T-DISC-30b: script name 42 (all digits) is valid", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"idx"}'\n`,
      );
      const marker = join(project.dir, "marker-30b.txt");
      await createWorkflowScript(project, "ralph", "42", ".sh", writeValueToFile("disc30b", marker));

      const result = await runCLI(["run", "-n", "1", "ralph:42"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc30b");
    });

    it("T-DISC-31: script name with colon is rejected (global validation catches sibling)", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"idx"}'\n`,
      );
      // Filesystems on Linux allow ':' in filenames. Create a script whose base name contains ':'.
      const wf = join(project.loopxDir, "ralph");
      writeFileSync(join(wf, "bad:name.sh"), `#!/bin/bash\necho bad\n`);
      chmodSync(join(wf, "bad:name.sh"), 0o755);

      const result = await runCLI(["run", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-32: workflow name with colon is rejected (global validation catches sibling)", async () => {
      project = await createTempProject();
      await createWorkflowScript(project, "good", "index", ".sh", `#!/bin/bash\necho good\n`);
      // Create bad-named workflow directory with a ':' character.
      const badWf = join(project.loopxDir, "bad:name");
      mkdirSync(badWf, { recursive: true });
      writeFileSync(join(badWf, "index.sh"), `#!/bin/bash\necho bad\n`);
      chmodSync(join(badWf, "index.sh"), 0o755);

      const result = await runCLI(["run", "good"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // Previously Reserved Names (T-DISC-33 through T-DISC-38)
  // =========================================================================
  describe("SPEC: Previously Reserved Names (Now Allowed)", () => {
    it("T-DISC-33: .loopx/output/index.sh runs via loopx run -n 1 output (not built-in)", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-33.txt");
      await createWorkflowScript(
        project,
        "output",
        "index",
        ".sh",
        writeValueToFile("disc33", marker),
      );

      const result = await runCLI(["run", "-n", "1", "output"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc33");
    });

    it("T-DISC-34: .loopx/env/index.ts runs via loopx run -n 1 env", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-34.txt");
      await createWorkflowScript(project, "env", "index", ".ts", tsMarker(marker, "disc34"));

      const result = await runCLI(["run", "-n", "1", "env"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc34");
    });

    it("T-DISC-35: .loopx/install/index.js runs via loopx run -n 1 install", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-35.txt");
      await createWorkflowScript(project, "install", "index", ".js", tsMarker(marker, "disc35"));

      const result = await runCLI(["run", "-n", "1", "install"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc35");
    });

    it("T-DISC-36: .loopx/version/index.sh runs via loopx run -n 1 version (not built-in)", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-36.txt");
      await createWorkflowScript(
        project,
        "version",
        "index",
        ".sh",
        writeValueToFile("disc36", marker),
      );

      const result = await runCLI(["run", "-n", "1", "version"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc36");
    });

    it("T-DISC-37: .loopx/run/index.sh runs via loopx run -n 1 run", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-37.txt");
      await createWorkflowScript(
        project,
        "run",
        "index",
        ".sh",
        writeValueToFile("disc37", marker),
      );

      const result = await runCLI(["run", "-n", "1", "run"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc37");
    });

    it("T-DISC-38: loopx run -h lists all five formerly-reserved-name workflows, stderr empty", async () => {
      project = await createTempProject();
      await createWorkflowScript(project, "version", "index", ".sh", `#!/bin/bash\necho v\n`);
      await createWorkflowScript(project, "output", "index", ".sh", `#!/bin/bash\necho o\n`);
      await createWorkflowScript(project, "env", "index", ".ts", `console.log("e");\n`);
      await createWorkflowScript(project, "install", "index", ".js", `console.log("i");\n`);
      await createWorkflowScript(project, "run", "index", ".sh", `#!/bin/bash\necho r\n`);

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/version/);
      expect(result.stdout).toMatch(/output/);
      expect(result.stdout).toMatch(/env/);
      expect(result.stdout).toMatch(/install/);
      expect(result.stdout).toMatch(/run/);
      expect(result.stderr).toBe("");
    });
  });

  // =========================================================================
  // Symlinks (T-DISC-39, 39a, 40, 40a–40i)
  // =========================================================================
  describe("SPEC: Symlinks", () => {
    // Helper that creates an external temp dir and registers cleanup.
    async function makeExternalDir(prefix: string): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), prefix));
      extraCleanups.push(async () => {
        await rm(dir, { recursive: true, force: true });
      });
      return dir;
    }

    it("T-DISC-39: symlinked workflow directory is discovered under the symlink's own name", async () => {
      project = await createTempProject();
      const external = await makeExternalDir("loopx-disc39-");
      const realWf = join(external, "real-workflow");
      mkdirSync(realWf, { recursive: true });
      writeFileSync(
        join(realWf, "index.sh"),
        `#!/bin/bash\nprintf '%s' 'disc39' > ${JSON.stringify(join(project.dir, "marker-39.txt"))}\n`,
      );
      chmodSync(join(realWf, "index.sh"), 0o755);

      symlinkSync(realWf, join(project.loopxDir, "my-alias"));

      const alias = await runCLI(["run", "-n", "1", "my-alias"], { cwd: project.dir });
      expect(alias.exitCode).toBe(0);
      expect(readFileSync(join(project.dir, "marker-39.txt"), "utf-8")).toBe("disc39");

      const real = await runCLI(["run", "-n", "1", "real-workflow"], { cwd: project.dir });
      expect(real.exitCode).toBe(1);
    });

    it("T-DISC-39a: LOOPX_WORKFLOW reflects the symlink name, not the target directory's basename", async () => {
      project = await createTempProject();
      const external = await makeExternalDir("loopx-disc39a-");
      const realWf = join(external, "real-workflow");
      mkdirSync(realWf, { recursive: true });
      const marker = join(project.dir, "marker-39a.txt");
      writeFileSync(
        join(realWf, "index.sh"),
        writeEnvToFile("LOOPX_WORKFLOW", marker),
      );
      chmodSync(join(realWf, "index.sh"), 0o755);

      symlinkSync(realWf, join(project.loopxDir, "my-alias"));

      const result = await runCLI(["run", "-n", "1", "my-alias"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("my-alias");
    });

    it("T-DISC-40: symlinked script file inside a workflow is discovered under the symlink's base name", async () => {
      project = await createTempProject();
      const external = await makeExternalDir("loopx-disc40-");
      const marker = join(project.dir, "marker-40.txt");
      const originalScript = join(external, "original-check.sh");
      writeFileSync(originalScript, writeValueToFile("disc40", marker));
      chmodSync(originalScript, 0o755);
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"idx"}'\n`,
      );
      symlinkSync(originalScript, join(project.loopxDir, "ralph", "my-check.sh"));

      const alias = await runCLI(["run", "-n", "1", "ralph:my-check"], { cwd: project.dir });
      expect(alias.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc40");

      const real = await runCLI(["run", "-n", "1", "ralph:original-check"], { cwd: project.dir });
      expect(real.exitCode).toBe(1);
    });

    it("T-DISC-40a: symlink to non-workflow directory is silently ignored at runtime", async () => {
      project = await createTempProject();
      const external = await makeExternalDir("loopx-disc40a-");
      const nonWfDir = join(external, "non-workflow-dir");
      mkdirSync(nonWfDir, { recursive: true });
      writeFileSync(join(nonWfDir, "README.md"), "# no scripts\n");
      symlinkSync(nonWfDir, join(project.loopxDir, "meta"));
      const marker = join(project.dir, "marker-40a.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeValueToFile("disc40a", marker),
      );

      const ralphRes = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });
      expect(ralphRes.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc40a");

      const metaRes = await runCLI(["run", "meta"], { cwd: project.dir });
      expect(metaRes.exitCode).toBe(1);
      expect(hasWarningCategoryFor(metaRes.stderr, "meta")).toBe(false);
    });

    it("T-DISC-40b: under loopx run -h, symlink to non-workflow (meta) is neither listed nor warned", async () => {
      project = await createTempProject();
      const external = await makeExternalDir("loopx-disc40b-");
      const nonWfDir = join(external, "non-workflow-dir");
      mkdirSync(nonWfDir, { recursive: true });
      writeFileSync(join(nonWfDir, "README.md"), "# no scripts\n");
      symlinkSync(nonWfDir, join(project.loopxDir, "meta"));
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/ralph/);
      expect(result.stdout + result.stderr).not.toMatch(/\bmeta\b/);
    });

    it("T-DISC-40c: symlinked workflow with invalid alias name (-bad-alias) fatal in run, warn in -h", async () => {
      project = await createTempProject();
      const external = await makeExternalDir("loopx-disc40c-");
      const realWf = join(external, "real-workflow");
      mkdirSync(realWf, { recursive: true });
      writeFileSync(join(realWf, "index.sh"), `#!/bin/bash\necho bad\n`);
      chmodSync(join(realWf, "index.sh"), 0o755);
      symlinkSync(realWf, join(project.loopxDir, "-bad-alias"));
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );

      const runRes = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });
      expect(runRes.exitCode).toBe(1);

      const helpRes = await runCLI(["run", "-h"], { cwd: project.dir });
      expect(helpRes.exitCode).toBe(0);
      expect(helpRes.stderr).toMatch(/-bad-alias/);
    });

    it("T-DISC-40d: symlinked script with invalid alias basename (-bad.sh) fatal in run, warn in -h", async () => {
      project = await createTempProject();
      const external = await makeExternalDir("loopx-disc40d-");
      const valid = join(external, "valid-check.sh");
      writeFileSync(valid, `#!/bin/bash\necho ok\n`);
      chmodSync(valid, 0o755);
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );
      symlinkSync(valid, join(project.loopxDir, "ralph", "-bad.sh"));

      const runRes = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });
      expect(runRes.exitCode).toBe(1);

      const helpRes = await runCLI(["run", "-h"], { cwd: project.dir });
      expect(helpRes.exitCode).toBe(0);
      expect(helpRes.stderr).toMatch(/-bad/);
    });

    it("T-DISC-40e: symlinked script participates in same-base-name collision detection", async () => {
      project = await createTempProject();
      const external = await makeExternalDir("loopx-disc40e-");
      const helper = join(external, "helper.ts");
      writeFileSync(helper, `console.log("helper");\n`);
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );
      await createWorkflowScript(project, "ralph", "check", ".sh", `#!/bin/bash\necho check\n`);
      symlinkSync(helper, join(project.loopxDir, "ralph", "check.ts"));

      const runRes = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });
      expect(runRes.exitCode).toBe(1);

      const helpRes = await runCLI(["run", "-h"], { cwd: project.dir });
      expect(helpRes.exitCode).toBe(0);
      expect(helpRes.stderr).toMatch(/check/);
      expect(helpRes.stderr).toMatch(/\.sh/);
      expect(helpRes.stderr).toMatch(/\.ts/);
    });

    it("T-DISC-40f: symlink to non-workflow dir with invalid alias name (-bad-link) silently ignored — never validated", async () => {
      project = await createTempProject();
      const external = await makeExternalDir("loopx-disc40f-");
      const nonWfDir = join(external, "non-workflow-dir");
      mkdirSync(nonWfDir, { recursive: true });
      writeFileSync(join(nonWfDir, "README.md"), "# no scripts\n");
      symlinkSync(nonWfDir, join(project.loopxDir, "-bad-link"));
      const marker = join(project.dir, "marker-40f.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeValueToFile("disc40f", marker),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc40f");
      expect(result.stderr).not.toMatch(/-bad-link/);
    });

    it("T-DISC-40g: under loopx run -h, -bad-link (symlink to non-workflow) neither listed nor warned", async () => {
      project = await createTempProject();
      const external = await makeExternalDir("loopx-disc40g-");
      const nonWfDir = join(external, "non-workflow-dir");
      mkdirSync(nonWfDir, { recursive: true });
      writeFileSync(join(nonWfDir, "README.md"), "# no scripts\n");
      symlinkSync(nonWfDir, join(project.loopxDir, "-bad-link"));
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/ralph/);
      expect(result.stdout + result.stderr).not.toMatch(/-bad-link/);
    });

    it("T-DISC-40h: symlink with valid alias (goodalias) to target with invalid basename (-bad-real-workflow) — target name ignored", async () => {
      project = await createTempProject();
      const external = await makeExternalDir("loopx-disc40h-");
      const badRealWf = join(external, "-bad-real-workflow");
      mkdirSync(badRealWf, { recursive: true });
      const marker = join(project.dir, "marker-40h.txt");
      writeFileSync(join(badRealWf, "index.sh"), writeValueToFile("disc40h", marker));
      chmodSync(join(badRealWf, "index.sh"), 0o755);
      symlinkSync(badRealWf, join(project.loopxDir, "goodalias"));
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );

      const runRes = await runCLI(["run", "-n", "1", "goodalias"], { cwd: project.dir });
      expect(runRes.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc40h");

      const helpRes = await runCLI(["run", "-h"], { cwd: project.dir });
      expect(helpRes.exitCode).toBe(0);
      expect(helpRes.stdout).toMatch(/goodalias/);
      expect(helpRes.stdout + helpRes.stderr).not.toMatch(/-bad-real-workflow/);
    });

    it("T-DISC-40i: symlinked script with valid alias (goodcheck.sh) to target with invalid basename (-bad-real-script.sh) — target name ignored", async () => {
      project = await createTempProject();
      const external = await makeExternalDir("loopx-disc40i-");
      const badRealScript = join(external, "-bad-real-script.sh");
      const marker = join(project.dir, "marker-40i.txt");
      writeFileSync(badRealScript, writeValueToFile("disc40i", marker));
      chmodSync(badRealScript, 0o755);
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );
      symlinkSync(badRealScript, join(project.loopxDir, "ralph", "goodcheck.sh"));

      const runRes = await runCLI(["run", "-n", "1", "ralph:goodcheck"], { cwd: project.dir });
      expect(runRes.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("disc40i");

      const helpRes = await runCLI(["run", "-h"], { cwd: project.dir });
      expect(helpRes.exitCode).toBe(0);
      expect(helpRes.stdout).toMatch(/goodcheck/);
      expect(helpRes.stdout + helpRes.stderr).not.toMatch(/-bad-real-script/);
    });
  });

  // =========================================================================
  // Discovery Caching (T-DISC-41, 42, 42a, 42b, 42c)
  // =========================================================================
  describe("SPEC: Discovery Caching", () => {
    it("T-DISC-41: new workflow created mid-loop is not seen — goto to its script errors", async () => {
      project = await createTempProject();
      const counter = join(project.dir, "counter-41.txt");
      const newWfDir = join(project.loopxDir, "newflow");
      const newScriptPath = join(newWfDir, "step.sh");

      const body = [
        `COUNT_FILE=${JSON.stringify(counter)}`,
        `printf '1' >> "$COUNT_FILE"`,
        `COUNT=$(wc -c < "$COUNT_FILE" | tr -d ' ')`,
        `if [ "$COUNT" = "1" ]; then`,
        `  mkdir -p ${JSON.stringify(newWfDir)}`,
        `  cat > ${JSON.stringify(newScriptPath)} << 'INNEREOF'`,
        `#!/bin/bash`,
        `printf '{"stop":true}'`,
        `INNEREOF`,
        `  chmod +x ${JSON.stringify(newScriptPath)}`,
        `  printf '{"goto":"newflow:step"}'`,
        `else`,
        `  printf '{"stop":true}'`,
        `fi`,
      ].join("\n");
      await createBashWorkflowScript(project, "ralph", "index", body);

      const result = await runCLI(["run", "-n", "3", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-42: modified script content takes effect on next iteration (file re-read)", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-42.txt");
      const counter = join(project.dir, "counter-42.txt");
      const scriptPath = join(project.loopxDir, "ralph", "index.sh");

      const body = [
        `COUNT_FILE=${JSON.stringify(counter)}`,
        `printf '1' >> "$COUNT_FILE"`,
        `COUNT=$(wc -c < "$COUNT_FILE" | tr -d ' ')`,
        `if [ "$COUNT" = "1" ]; then`,
        `  cat > ${JSON.stringify(scriptPath)} << 'REWRITE'`,
        `#!/bin/bash`,
        `printf '%s' 'mutated' > ${JSON.stringify(marker)}`,
        `printf '{"stop":true}'`,
        `REWRITE`,
        `  chmod +x ${JSON.stringify(scriptPath)}`,
        `  printf '{"result":"first"}'`,
        `else`,
        `  printf '{"result":"unexpected"}'`,
        `fi`,
      ].join("\n");
      await createBashWorkflowScript(project, "ralph", "index", body);

      const result = await runCLI(["run", "-n", "2", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("mutated");
    });

    it("T-DISC-42a: discovered script removed mid-loop — fails at spawn time", async () => {
      project = await createTempProject();
      const stepPath = join(project.loopxDir, "ralph", "step.sh");
      const body = [
        `rm -f ${JSON.stringify(stepPath)}`,
        `printf '{"goto":"step"}'`,
      ].join("\n");
      await createBashWorkflowScript(project, "ralph", "index", body);
      await createBashWorkflowScript(project, "ralph", "step", `printf '{"result":"step"}'`);

      const result = await runCLI(["run", "-n", "3", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-42b: discovered script renamed mid-loop — cached path is stale, fails at spawn time", async () => {
      project = await createTempProject();
      const stepPath = join(project.loopxDir, "ralph", "check.sh");
      const renamed = join(project.loopxDir, "ralph", "check-new.sh");
      const body = [
        `mv ${JSON.stringify(stepPath)} ${JSON.stringify(renamed)}`,
        `printf '{"goto":"check"}'`,
      ].join("\n");
      await createBashWorkflowScript(project, "ralph", "index", body);
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"result":"check"}'`);

      const result = await runCLI(["run", "-n", "3", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-42c: new script added to existing workflow mid-loop is not seen (not in cached discovery)", async () => {
      project = await createTempProject();
      const counter = join(project.dir, "counter-42c.txt");
      const newStep = join(project.loopxDir, "ralph", "new-step.sh");
      const body = [
        `COUNT_FILE=${JSON.stringify(counter)}`,
        `printf '1' >> "$COUNT_FILE"`,
        `COUNT=$(wc -c < "$COUNT_FILE" | tr -d ' ')`,
        `if [ "$COUNT" = "1" ]; then`,
        `  cat > ${JSON.stringify(newStep)} << 'INNEREOF'`,
        `#!/bin/bash`,
        `printf '{"stop":true}'`,
        `INNEREOF`,
        `  chmod +x ${JSON.stringify(newStep)}`,
        `  printf '{"goto":"new-step"}'`,
        `else`,
        `  printf '{"stop":true}'`,
        `fi`,
      ].join("\n");
      await createBashWorkflowScript(project, "ralph", "index", body);

      const result = await runCLI(["run", "-n", "3", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // Validation Scope (T-DISC-43 through T-DISC-47b)
  // =========================================================================
  describe("SPEC: Validation Scope", () => {
    it("T-DISC-43: loopx version succeeds without .loopx/", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const result = await runCLI(["version"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("T-DISC-44: loopx env set succeeds without .loopx/", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const setRes = await runCLI(["env", "set", "X", "Y"], { cwd: project.dir });
      expect(setRes.exitCode).toBe(0);

      const listRes = await runCLI(["env", "list"], { cwd: project.dir });
      expect(listRes.exitCode).toBe(0);
      expect(listRes.stdout).toContain("X=Y");
    });

    it("T-DISC-45: loopx output --result succeeds without .loopx/", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const result = await runCLI(["output", "--result", "x"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.result).toBe("x");
    });

    it("T-DISC-46: loopx version succeeds even when .loopx/ has collisions (no script validation)", async () => {
      project = await createTempProject();
      await createWorkflowScript(project, "ralph", "check", ".sh", `#!/bin/bash\necho check-sh\n`);
      await createWorkflowScript(project, "ralph", "check", ".ts", `console.log("check-ts");\n`);

      const result = await runCLI(["version"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(result.stderr).not.toMatch(/collision|conflict/i);
    });

    it("T-DISC-47: loopx install succeeds even when .loopx/ has collisions (install validates source, not local .loopx/)", async () => {
      project = await createTempProject();
      // Local collision in a workflow named "ralph"
      await createWorkflowScript(project, "ralph", "check", ".sh", `#!/bin/bash\necho check-sh\n`);
      await createWorkflowScript(project, "ralph", "check", ".ts", `console.log("check-ts");\n`);

      // Install source: a separate valid workflow served from a local git server.
      gitServer = await startLocalGitServer([
        {
          name: "other",
          files: {
            "index.sh": `#!/bin/bash\nprintf '{"result":"installed-ok"}'\n`,
          },
        },
      ]);

      const result = await runCLI(["install", `${gitServer.url}/other.git`], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(project.loopxDir, "other"))).toBe(true);
    });

    it("T-DISC-47a: invalid script name in sibling workflow is fatal in normal run mode", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );
      // broken workflow with invalid script name
      const broken = await createWorkflow(project, "broken");
      writeFileSync(join(broken, "-bad.sh"), `#!/bin/bash\necho bad\n`);
      chmodSync(join(broken, "-bad.sh"), 0o755);

      const result = await runCLI(["run", "ralph"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-47b: invalid workflow name in sibling is fatal in normal run mode", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "good",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );
      const badWf = join(project.loopxDir, "-bad-workflow");
      mkdirSync(badWf, { recursive: true });
      writeFileSync(join(badWf, "index.sh"), `#!/bin/bash\necho bad\n`);
      chmodSync(join(badWf, "index.sh"), 0o755);

      const result = await runCLI(["run", "good"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // Discovery Scope (T-DISC-48, 48a)
  // =========================================================================
  describe("SPEC: Discovery Scope", () => {
    it("T-DISC-48: parent directory .loopx/ is NOT discovered from a child directory", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );
      const childDir = join(project.dir, "child");
      mkdirSync(childDir, { recursive: true });

      const result = await runCLI(["run", "-n", "1", "ralph"], { cwd: childDir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-48a: programmatic API — run({ cwd: childDir }) does not search parent .loopx/", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"result":"ok"}'\n`,
      );
      const childDir = join(project.dir, "child");
      mkdirSync(childDir, { recursive: true });

      const driver = [
        `import { runPromise } from "loopx";`,
        `try {`,
        `  await runPromise("ralph", { cwd: ${JSON.stringify(childDir)}, iterations: 1 });`,
        `  console.log(JSON.stringify({ ok: true }));`,
        `} catch (err) {`,
        `  const msg = err instanceof Error ? err.message : String(err);`,
        `  console.log(JSON.stringify({ ok: false, error: msg }));`,
        `}`,
      ].join("\n");

      const result = await runAPIDriver("node", driver, { cwd: project.dir });

      // Either the driver prints {ok:false} (promise rejected) or exits non-zero (uncaught).
      const okLine = result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((entry): entry is { ok: boolean; error?: string } => entry !== null);

      if (okLine) {
        expect(okLine.ok).toBe(false);
        expect(okLine.error ?? "").toMatch(/ralph|workflow|\.loopx|not found|discover/i);
      } else {
        expect(result.exitCode).not.toBe(0);
      }
    });
  });
});
