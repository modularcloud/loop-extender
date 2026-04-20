import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI, runCLIWithSignal } from "../helpers/cli.js";
import { forEachRuntime } from "../helpers/runtime.js";
import {
  emitStop,
  emitResult,
  counter,
  exitCode,
  emitGoto,
  signalReadyThenSleep,
} from "../helpers/fixture-scripts.js";

/**
 * Exit-code contract smoke tests.
 *
 * These intentionally overlap with other test files (cli-basics, loop-state,
 * etc.) but exist to verify the exit-code contract in a single, focused place.
 */

describe("SPEC: Exit Codes", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  // =========================================================================
  // Success exit codes (exit 0)
  // =========================================================================

  describe("SPEC: Success Exit Codes", () => {
    forEachRuntime((runtime) => {
      it("T-EXIT-01: script outputs stop -> exit 0", async () => {
        project = await createTempProject();
        await createWorkflowScript(project, "stopper", "index", ".sh", emitStop());

        const result = await runCLI(["run", "stopper"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
      });

      it("T-EXIT-02: -n limit reached -> exit 0", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");
        await createWorkflowScript(project, "counting", "index", ".sh", counter(counterFile));

        const result = await runCLI(["run", "-n", "3", "counting"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
      });

      it("T-EXIT-03: -n 0 -> exit 0", async () => {
        project = await createTempProject();
        await createWorkflowScript(project, "myscript", "index", ".sh", emitResult("x"));

        const result = await runCLI(["run", "-n", "0", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
      });

      it("T-EXIT-04: version -> exit 0", async () => {
        // version does not require .loopx/
        project = await createTempProject({ withLoopxDir: false });

        const result = await runCLI(["version"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
      });
    });
  });

  // =========================================================================
  // Error exit codes (exit 1)
  // =========================================================================

  describe("SPEC: Error Exit Codes", () => {
    forEachRuntime((runtime) => {
      it("T-EXIT-05: script exits non-zero -> exit 1", async () => {
        project = await createTempProject();
        await createWorkflowScript(project, "fail", "index", ".sh", exitCode(42));

        const result = await runCLI(["run", "-n", "1", "fail"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-EXIT-06: validation failure (name collision) -> exit 1", async () => {
        project = await createTempProject();
        // Create two scripts with the same base name but different extensions
        // within the same workflow (workflow-level same-base-name collision)
        await createWorkflowScript(project, "example", "index", ".sh", emitResult("from-sh"));
        await createWorkflowScript(project, "example", "index", ".ts", emitResult("from-ts"));

        const result = await runCLI(["run", "example"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
      });

      it("T-EXIT-07: invalid goto target -> exit 1", async () => {
        project = await createTempProject();
        // Script emits a goto to a target that does not exist
        await createWorkflowScript(project, "bad-goto", "index", ".sh", emitGoto("nonexistent"));

        const result = await runCLI(["run", "-n", "2", "bad-goto"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("nonexistent");
      });

      it("T-EXIT-08: missing script -> exit 1", async () => {
        project = await createTempProject();
        // .loopx/ exists but requested script does not

        const result = await runCLI(["run", "does-not-exist"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-EXIT-09: missing .loopx/ -> exit 1", async () => {
        project = await createTempProject({ withLoopxDir: false });

        const result = await runCLI(["run", "anyscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
      });

      it("T-EXIT-10: invalid -n -> exit 1", async () => {
        project = await createTempProject();
        await createWorkflowScript(project, "myscript", "index", ".sh", emitResult("x"));

        const result = await runCLI(["run", "-n", "abc", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-EXIT-11: missing -e file -> exit 1", async () => {
        project = await createTempProject();
        await createWorkflowScript(project, "myscript", "index", ".sh", emitResult("x"));

        const result = await runCLI(
          ["run", "-e", "nonexistent.env", "myscript"],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
      });

      it("T-EXIT-14: run with no script name -> exit 1", async () => {
        project = await createTempProject();

        const result = await runCLI(["run"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
      });

      it("T-EXIT-15: unrecognized subcommand -> exit 1", async () => {
        project = await createTempProject();

        const result = await runCLI(["myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
      });

      it("T-EXIT-16: unrecognized top-level flag -> exit 1", async () => {
        project = await createTempProject();

        const result = await runCLI(["--unknown"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
      });
    });
  });

  // =========================================================================
  // Signal exit codes
  // =========================================================================

  describe("SPEC: Signal Exit Codes", () => {
    forEachRuntime((runtime) => {
      it("T-EXIT-12: SIGINT -> exit 130", async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "signal-pid.txt");

        // Use signalReadyThenSleep fixture: writes PID to marker, "ready" to
        // stderr, then sleeps indefinitely until signalled.
        await createWorkflowScript(
          project,
          "sleeper",
          "index",
          ".sh",
          signalReadyThenSleep(markerPath),
        );

        const { result, sendSignal, waitForStderr } = runCLIWithSignal(
          ["run", "sleeper"],
          { cwd: project.dir, runtime, timeout: 15_000 },
        );

        // Wait until the script has written "ready" to stderr, meaning
        // the process is up and blocking in sleep.
        await waitForStderr("ready");

        // Send SIGINT to the loopx process
        sendSignal("SIGINT");

        const outcome = await result;
        expect(outcome.exitCode).toBe(130);
      });

      it("T-EXIT-13: SIGTERM -> exit 143", async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "signal-pid.txt");

        await createWorkflowScript(
          project,
          "sleeper",
          "index",
          ".sh",
          signalReadyThenSleep(markerPath),
        );

        const { result, sendSignal, waitForStderr } = runCLIWithSignal(
          ["run", "sleeper"],
          { cwd: project.dir, runtime, timeout: 15_000 },
        );

        await waitForStderr("ready");

        sendSignal("SIGTERM");

        const outcome = await result;
        expect(outcome.exitCode).toBe(143);
      });
    });
  });
});
