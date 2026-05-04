import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  createBashWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import {
  emitResult,
  writeCwdToFile,
  writeEnvToFile,
  writeStderr,
} from "../helpers/fixture-scripts.js";
import { runCLI } from "../helpers/cli.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { withFakeNpm } from "../helpers/fake-npm.js";
import { forEachRuntime, isRuntimeAvailable } from "../helpers/runtime.js";

// ============================================================================
// TEST-SPEC §4.4 — Script Execution
// Spec refs: 6.1–6.5, 8.3, 2.1, 2.2 (and ADR-0004 §3 / §4 for cwd + WORKFLOW_DIR)
//
// All scripts live in workflow subdirectories of .loopx/ (e.g.
// .loopx/ralph/index.sh). Per SPEC 6.1 (rewritten by ADR-0004), every spawned
// script runs with LOOPX_PROJECT_ROOT as its working directory — not the
// workflow directory. The workflow-relative path is exposed via
// LOOPX_WORKFLOW_DIR. LOOPX_WORKFLOW always contains the current workflow's
// name and is refreshed on every cross-workflow transition (including loop
// reset).
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
    it("T-EXEC-01: script in ralph workflow runs with cwd = project root (not workflow dir)", async () => {
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
      // Per SPEC 6.1 (rewritten by ADR-0004 §3): every script spawn uses
      // LOOPX_PROJECT_ROOT — the loopx-observed process.cwd() at invocation —
      // as its cwd. /bin/pwd -P returns the kernel-canonical form, so compare
      // against realpath of the project dir (loopx's process.cwd() at spawn).
      const expectedRoot = realpathSync(project.dir);
      const workflowDir = join(project.loopxDir, "ralph");
      expect(recordedCwd).toBe(expectedRoot);
      expect(recordedCwd).not.toBe(workflowDir);
    });

    it("T-EXEC-02: script in 'other' workflow also runs with cwd = project root", async () => {
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
      // Multiple workflows in the same run all spawn with project-root cwd —
      // cwd does not differ by workflow (SPEC 6.1).
      const expectedRoot = realpathSync(project.dir);
      const otherDir = join(project.loopxDir, "other");
      expect(recordedCwd).toBe(expectedRoot);
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

    it("T-EXEC-03b: child cd does not leak across spawns (intra-workflow goto)", async () => {
      project = await createTempProject();
      const cwdMarker = join(project.dir, "check-cwd.txt");

      // ralph:index cd's to /tmp then transitions intra-workflow to ralph:check.
      // Per SPEC 6.1, cd is scoped to that child — the next spawn must reset to
      // project-root cwd. /bin/pwd -P returns the kernel-canonical form (which
      // matches realpathSync(project.dir) on POSIX).
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
cd /tmp
printf '{"goto":"check"}'
`,
      );
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".sh",
        `#!/bin/bash
printf '%s' "$(/bin/pwd -P)" > "${cwdMarker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(cwdMarker)).toBe(true);
      const recordedCwd = readFileSync(cwdMarker, "utf-8");
      // Kernel-canonical project root — NOT /tmp where the prior child cd'd.
      const expectedRoot = realpathSync(project.dir);
      expect(recordedCwd).toBe(expectedRoot);
      expect(recordedCwd).not.toBe("/tmp");
    });

    it("T-EXEC-03c: bash cd does not leak across loop reset (no-goto path)", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "iter-count");
      const cwdMarker = join(project.dir, "iter2-cwd.txt");

      // ralph:index increments a counter; iteration 1 cd's to /tmp and emits
      // empty output (loop reset back to ralph:index); iteration 2 records its
      // own cwd into a marker and emits stop:true. The next-spawn cwd reset is
      // independent of how the next spawn was reached (goto vs. no-goto reset).
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
if [ -f "${counterFile}" ]; then
  COUNT=$(cat "${counterFile}")
else
  COUNT=0
fi
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" > "${counterFile}"
if [ "$COUNT" = "1" ]; then
  cd /tmp
  exit 0
fi
printf '%s' "$(/bin/pwd -P)" > "${cwdMarker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(cwdMarker)).toBe(true);
      const recordedCwd = readFileSync(cwdMarker, "utf-8");
      const expectedRoot = realpathSync(project.dir);
      expect(recordedCwd).toBe(expectedRoot);
      expect(recordedCwd).not.toBe("/tmp");
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

    it("T-EXEC-07a: a .sh script without the executable bit still runs", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "no-exec-bit-marker.txt");

      // SPEC 6.2: loopx invokes Bash scripts as `/bin/bash <script>`. Read
      // permission is sufficient — the executable bit is not required.
      const scriptPath = await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '%s' 'no-exec-bit-ran' > "${markerPath}"\nprintf '{"stop":true}'\n`,
      );
      // Override the helper's default 0o755. mode 0o644 = readable but not
      // executable.
      await chmod(scriptPath, 0o644);

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf-8")).toBe("no-exec-bit-ran");
      // loopx did not silently chmod the script.
      const mode = statSync(scriptPath).mode & 0o777;
      expect(mode).toBe(0o644);
    });

    it("T-EXEC-07b: bash scripts are invoked via the absolute path /bin/bash (not PATH-resolved)", async () => {
      project = await createTempProject();
      const realBashMarker = join(project.dir, "real-bash-marker.txt");
      const fakeBashMarker = join(project.dir, "fake-bash-marker.txt");

      // Create a throwaway dir containing a fake `bash` shim that writes a
      // sentinel and exits non-zero. If loopx resolves `bash` from PATH, the
      // fake will be invoked and the script never runs.
      const shimDir = await mkdtemp(join(tmpdir(), "loopx-fake-bash-"));
      const fakeBashPath = join(shimDir, "bash");
      await writeFile(
        fakeBashPath,
        `#!/bin/bash\nprintf 'FAKE-BASH-INVOKED' > "${fakeBashMarker}"\nexit 99\n`,
        "utf-8",
      );
      await chmod(fakeBashPath, 0o755);

      try {
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          `#!/bin/bash\nprintf '%s' 'real-bash-ran' > "${realBashMarker}"\nprintf '{"stop":true}'\n`,
        );

        // Prepend the shim dir to PATH. If loopx invokes `bash` via PATH
        // resolution, the fake shim wins. The absolute path /bin/bash is
        // unaffected and still resolves to the real bash.
        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: {
            PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          },
        });

        // Real bash ran (script exited 0); fake shim was never invoked.
        expect(result.exitCode).toBe(0);
        expect(existsSync(realBashMarker)).toBe(true);
        expect(readFileSync(realBashMarker, "utf-8")).toBe("real-bash-ran");
        expect(existsSync(fakeBashMarker)).toBe(false);
      } finally {
        await rm(shimDir, { recursive: true, force: true }).catch(() => {});
      }
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

    // SPEC 6.3 CJS-rejection matrix: 3 forms × 4 extensions.
    // T-EXEC-13a covers (.js, require). The remaining 11 combinations follow.
    // The fixture pattern across all of them: an ESM-allowed shape (an `import`
    // from "node:fs") plus the CJS form. Under proper ESM module evaluation,
    // the CJS binding (`require`, `module`, or `exports`) is not in scope and
    // the reference fails at execution time.

    // For .tsx/.jsx fixtures, include a tiny `React.createElement` shim so the
    // file is syntactically a JSX-using module (matching SPEC 6.3 semantics);
    // the JSX literal itself is not load-bearing for the CJS-rejection test.

    // ----- module.exports rejection -----

    it("T-EXEC-13c: a .js script that uses module.exports (CJS) fails", async () => {
      project = await createTempProject();
      const content = `import "node:fs";
module.exports = { value: "x" };
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`;
      await createWorkflowScript(project, "ralph", "index", ".js", content);
      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });
      expect(result.exitCode).not.toBe(0);
    });

    it("T-EXEC-13h: a .ts script that uses module.exports (CJS) fails", async () => {
      project = await createTempProject();
      const content = `import "node:fs";
module.exports = { value: "x" };
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`;
      await createWorkflowScript(project, "ralph", "index", ".ts", content);
      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });
      expect(result.exitCode).not.toBe(0);
    });

    it("T-EXEC-13i: a .jsx script that uses module.exports (CJS) fails", async () => {
      project = await createTempProject();
      const content = `import "node:fs";
const React = { createElement: (tag) => tag };
const _el = <div/>;
module.exports = { value: "x" };
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`;
      await createWorkflowScript(project, "ralph", "index", ".jsx", content);
      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });
      expect(result.exitCode).not.toBe(0);
    });

    it("T-EXEC-13j: a .tsx script that uses module.exports (CJS) fails", async () => {
      project = await createTempProject();
      const content = `import "node:fs";
const React = { createElement: (tag: string) => tag };
const _el = <div/>;
module.exports = { value: "x" };
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`;
      await createWorkflowScript(project, "ralph", "index", ".tsx", content);
      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });
      expect(result.exitCode).not.toBe(0);
    });

    // ----- exports.foo rejection -----

    it("T-EXEC-13d: a .js script that uses exports.foo = ... (CJS) fails", async () => {
      project = await createTempProject();
      const content = `import "node:fs";
exports.value = "x";
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`;
      await createWorkflowScript(project, "ralph", "index", ".js", content);
      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });
      expect(result.exitCode).not.toBe(0);
    });

    it("T-EXEC-13k: a .ts script that uses exports.foo = ... (CJS) fails", async () => {
      project = await createTempProject();
      const content = `import "node:fs";
exports.value = "x";
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`;
      await createWorkflowScript(project, "ralph", "index", ".ts", content);
      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });
      expect(result.exitCode).not.toBe(0);
    });

    it("T-EXEC-13l: a .jsx script that uses exports.foo = ... (CJS) fails", async () => {
      project = await createTempProject();
      const content = `import "node:fs";
const React = { createElement: (tag) => tag };
const _el = <div/>;
exports.value = "x";
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`;
      await createWorkflowScript(project, "ralph", "index", ".jsx", content);
      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });
      expect(result.exitCode).not.toBe(0);
    });

    it("T-EXEC-13m: a .tsx script that uses exports.foo = ... (CJS) fails", async () => {
      project = await createTempProject();
      const content = `import "node:fs";
const React = { createElement: (tag: string) => tag };
const _el = <div/>;
exports.value = "x";
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`;
      await createWorkflowScript(project, "ralph", "index", ".tsx", content);
      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });
      expect(result.exitCode).not.toBe(0);
    });

    // ----- require() rejection across .ts/.jsx/.tsx (.js is T-EXEC-13a) -----

    it("T-EXEC-13e: a .ts script that uses require() (CJS) fails", async () => {
      project = await createTempProject();
      const content = `import "node:fs";
const _x = require("node:os");
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`;
      await createWorkflowScript(project, "ralph", "index", ".ts", content);
      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });
      expect(result.exitCode).not.toBe(0);
    });

    it("T-EXEC-13f: a .jsx script that uses require() (CJS) fails", async () => {
      project = await createTempProject();
      const content = `import "node:fs";
const React = { createElement: (tag) => tag };
const _el = <div/>;
const _x = require("node:os");
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`;
      await createWorkflowScript(project, "ralph", "index", ".jsx", content);
      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });
      expect(result.exitCode).not.toBe(0);
    });

    it("T-EXEC-13g: a .tsx script that uses require() (CJS) fails", async () => {
      project = await createTempProject();
      const content = `import "node:fs";
const React = { createElement: (tag: string) => tag };
const _el = <div/>;
const _x = require("node:os");
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`;
      await createWorkflowScript(project, "ralph", "index", ".tsx", content);
      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });
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
// Workflow-Local Dependencies & cwd semantics (T-EXEC-15, 15a, 15b, 15c, 16, 16a, 16b)
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
      // all resolve bare specifiers starting from cwd (= workflow dir).
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

    it("T-EXEC-15a: loopx run does NOT auto-install workflow dependencies (CLI surface)", async () => {
      // SPEC §2.1: "At runtime, loopx does not re-install dependencies — loopx
      // run does not invoke `npm install` on a missing `node_modules/`." This
      // is the runtime counterpart to the install-time auto-install coverage
      // (T-INST-110 block); the auto-install seam is exclusive to `loopx
      // install`. A buggy implementation that gated auto-install on the run
      // surface (e.g., enabled it under run() but disabled it under the CLI)
      // would pass T-EXEC-15b/15c but fail this test.
      project = await createTempProject();
      const markerPath = join(project.dir, "ran.marker");
      const logFile = join(project.dir, "fake-npm.log");

      // index.sh writes a marker (proving execution succeeded) and emits
      // {"stop":true} so the loop halts after one iteration.
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '' > "${markerPath}"
printf '{"stop":true}'`,
      );
      // Workflow has package.json declaring a dependency, but no node_modules/.
      await writeFile(
        join(project.loopxDir, "ralph", "package.json"),
        JSON.stringify({
          name: "ralph",
          version: "1.0.0",
          dependencies: { "some-pkg": "*" },
        }),
        "utf-8",
      );

      await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project!.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        // Zero npm invocations — `loopx run` does not trigger auto-install.
        expect(fake.readInvocations().length).toBe(0);
        // node_modules/ was not created.
        expect(
          existsSync(join(project!.loopxDir, "ralph", "node_modules")),
        ).toBe(false);
        // The script ran (marker exists).
        expect(existsSync(markerPath)).toBe(true);
      });
    });

    it("T-EXEC-15b: runPromise() does NOT auto-install workflow dependencies (programmatic API surface)", async () => {
      // Programmatic-API counterpart to T-EXEC-15a per SPEC §2.1 / §9.2.
      project = await createTempProject();
      const markerPath = join(project.dir, "ran.marker");
      const logFile = join(project.dir, "fake-npm.log");

      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '' > "${markerPath}"
printf '{"stop":true}'`,
      );
      await writeFile(
        join(project.loopxDir, "ralph", "package.json"),
        JSON.stringify({
          name: "ralph",
          version: "1.0.0",
          dependencies: { "some-pkg": "*" },
        }),
        "utf-8",
      );

      await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project!.dir)},
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length, hasStop: outputs[0]?.stop === true }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.count).toBe(1);
        expect(parsed.hasStop).toBe(true);
        // Zero npm invocations — runPromise() does not trigger auto-install.
        expect(fake.readInvocations().length).toBe(0);
        expect(
          existsSync(join(project!.loopxDir, "ralph", "node_modules")),
        ).toBe(false);
        expect(existsSync(markerPath)).toBe(true);
      });
    });

    it("T-EXEC-15c: run() generator does NOT auto-install workflow dependencies (generator API surface)", async () => {
      // Generator-API counterpart to T-EXEC-15a / T-EXEC-15b per SPEC §2.1 /
      // §9.1 / §10.10. Closes the third API-surface gap and completes the
      // "no runtime auto-install" coverage across all three run surfaces
      // (CLI, runPromise(), run()).
      project = await createTempProject();
      const markerPath = join(project.dir, "ran.marker");
      const logFile = join(project.dir, "fake-npm.log");

      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '' > "${markerPath}"
printf '{"stop":true}'`,
      );
      await writeFile(
        join(project.loopxDir, "ralph", "package.json"),
        JSON.stringify({
          name: "ralph",
          version: "1.0.0",
          dependencies: { "some-pkg": "*" },
        }),
        "utf-8",
      );

      await withFakeNpm({ exitCode: 0, logFile }, async (fake) => {
        const driverCode = `
import { run } from "loopx";
const outputs = [];
for await (const output of run("ralph", {
  cwd: ${JSON.stringify(project!.dir)},
  maxIterations: 1,
})) {
  outputs.push(output);
}
console.log(JSON.stringify({ count: outputs.length, hasStop: outputs[0]?.stop === true }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.count).toBe(1);
        expect(parsed.hasStop).toBe(true);
        // Zero npm invocations — run() does not trigger auto-install.
        expect(fake.readInvocations().length).toBe(0);
        expect(
          existsSync(join(project!.loopxDir, "ralph", "node_modules")),
        ).toBe(false);
        expect(existsSync(markerPath)).toBe(true);
      });
    });

    it("T-EXEC-16: script cwd is the project root in JS/TS runtimes too", async () => {
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
      const recordedCwd = readFileSync(markerPath, "utf-8");
      // Per SPEC 6.1 (rewritten by ADR-0004 §3): JS/TS scripts also spawn at
      // project-root cwd. process.cwd() returns the runtime-canonicalized
      // (getcwd(3)) form per SPEC 6.1 "Directory identity vs. string spelling";
      // compare against realpath of project.dir (loopx's process.cwd() at
      // invocation when supplied via the CLI).
      const expectedRoot = realpathSync(project.dir);
      const workflowDir = join(project.loopxDir, "ralph");
      expect(recordedCwd).toBe(expectedRoot);
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

    it("T-EXEC-16b: cross-workflow goto preserves project-root cwd (does NOT switch cwd)", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "cross-cwd-marker.txt");
      const wfdirMarkerPath = join(project.dir, "cross-wfdir-marker.txt");

      // ralph:index transitions into other:check
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"goto":"other:check"}'`,
      );
      // other:check records its own kernel cwd (/bin/pwd -P) and the
      // injected LOOPX_WORKFLOW_DIR, then stops so the chain ends.
      await createWorkflowScript(
        project,
        "other",
        "check",
        ".sh",
        `#!/bin/bash
printf '%s' "$(/bin/pwd -P)" > "${markerPath}"
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarkerPath}"
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
      // Per SPEC 6.1 (rewritten by ADR-0004 §3): cross-workflow goto changes
      // LOOPX_WORKFLOW / LOOPX_WORKFLOW_DIR but NOT cwd; every spawn in the
      // run uses project-root cwd.
      const expectedRoot = realpathSync(project.dir);
      const otherDir = join(project.loopxDir, "other");
      expect(recordedCwd).toBe(expectedRoot);
      expect(recordedCwd).not.toBe(otherDir);
      // LOOPX_WORKFLOW_DIR did refresh to the target workflow — cwd and
      // LOOPX_WORKFLOW_DIR are independent surfaces.
      expect(existsSync(wfdirMarkerPath)).toBe(true);
      expect(readFileSync(wfdirMarkerPath, "utf-8")).toBe(otherDir);
    });

    it("T-EXEC-16c: JS/TS process.chdir() does not leak across spawns (intra-workflow goto)", async () => {
      project = await createTempProject();
      const cwdMarker = join(project.dir, "ts-check-cwd.txt");

      // ralph:index calls process.chdir("/tmp") then transitions intra-workflow
      // to ralph:check. Per SPEC 6.1, process.chdir() is scoped to that child;
      // the next spawn must reset to project-root cwd.
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `process.chdir("/tmp");
process.stdout.write(JSON.stringify({ goto: "check" }));
`,
      );
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".ts",
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(cwdMarker)}, process.cwd());
process.stdout.write(JSON.stringify({ stop: true }));
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(cwdMarker)).toBe(true);
      const recordedCwd = readFileSync(cwdMarker, "utf-8");
      // Directory identity matches project root (compared via realpath; the
      // exact string spelling may be the runtime-canonicalized form).
      const expectedRoot = realpathSync(project.dir);
      expect(recordedCwd).toBe(expectedRoot);
      // /tmp could canonicalize to /private/tmp on macOS, so guard against
      // string equality only in the projectRoot direction. The directory
      // identity assertion is the load-bearing check above.
      expect(recordedCwd).not.toBe("/tmp");
    });

    it("T-EXEC-16d: JS/TS process.chdir() does not leak across loop reset (no-goto path)", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "iter-count");
      const cwdMarker = join(project.dir, "iter2-ts-cwd.txt");

      // ralph:index increments a counter; iteration 1 chdir's to /tmp and
      // exits without writing to stdout (empty output ⇒ result:"" ⇒ no goto,
      // no stop ⇒ loop reset back to ralph:index for iteration 2).
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const counterPath = ${JSON.stringify(counterFile)};
const markerPath = ${JSON.stringify(cwdMarker)};
let count = 0;
if (existsSync(counterPath)) {
  count = Number(readFileSync(counterPath, "utf-8")) || 0;
}
count += 1;
writeFileSync(counterPath, String(count));
if (count === 1) {
  process.chdir("/tmp");
  // Empty stdout: result:"" ⇒ no goto, no stop ⇒ loop reset.
  process.exit(0);
}
writeFileSync(markerPath, process.cwd());
process.stdout.write(JSON.stringify({ stop: true }));
`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(cwdMarker)).toBe(true);
      const recordedCwd = readFileSync(cwdMarker, "utf-8");
      const expectedRoot = realpathSync(project.dir);
      expect(recordedCwd).toBe(expectedRoot);
      expect(recordedCwd).not.toBe("/tmp");
    });
  });
});
