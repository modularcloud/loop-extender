import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  createBashWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { forEachRuntime } from "../helpers/runtime.js";
import {
  catStdin,
  exitCode,
  writeStderr,
} from "../helpers/fixture-scripts.js";

// ---------------------------------------------------------------------------
// TEST-SPEC §4.6 — Loop State Machine & Control Flow
// Spec refs: 2.2, 7.1, 7.2, 6.6, 6.7 (workflow model per ADR-0003)
// ---------------------------------------------------------------------------

describe("SPEC: Loop state machine (ADR-0003 workflow model)", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  // =========================================================================
  // Basic Loop Behavior (T-LOOP-01 – T-LOOP-05)
  // =========================================================================
  describe("SPEC: Basic Loop Behavior", () => {
    forEachRuntime((runtime) => {
      it("T-LOOP-01: no output → loop resets to starting target, -n 3 yields 3 runs", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${counterFile}"`,
        );

        const result = await runCLI(["run", "-n", "3", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(counterFile, "utf-8")).toBe("111");
      });

      it("T-LOOP-02: ralph:index → goto check → check no output → reset. -n 4 yields index,check,index,check", async () => {
        project = await createTempProject();
        const orderFile = join(project.dir, "order.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'I' >> "${orderFile}"\nprintf '{"goto":"check"}'`,
        );
        await createBashWorkflowScript(
          project,
          "ralph",
          "check",
          `printf 'C' >> "${orderFile}"`,
        );

        const result = await runCLI(["run", "-n", "4", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(orderFile, "utf-8")).toBe("ICIC");
      });

      it("T-LOOP-03: ralph:index → goto setup → goto check → reset. -n 4 yields index,setup,check,index", async () => {
        project = await createTempProject();
        const orderFile = join(project.dir, "order.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'I' >> "${orderFile}"\nprintf '{"goto":"setup"}'`,
        );
        await createBashWorkflowScript(
          project,
          "ralph",
          "setup",
          `printf 'S' >> "${orderFile}"\nprintf '{"goto":"check"}'`,
        );
        await createBashWorkflowScript(
          project,
          "ralph",
          "check",
          `printf 'C' >> "${orderFile}"`,
        );

        const result = await runCLI(["run", "-n", "4", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(orderFile, "utf-8")).toBe("ISCI");
      });

      it("T-LOOP-04: stop:true on first iteration → 1 iteration, exit 0", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${counterFile}"\nprintf '{"stop":true}'`,
        );

        const result = await runCLI(["run", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(counterFile, "utf-8")).toBe("1");
      });

      it("T-LOOP-05: script runs 3 times then emits stop on 4th → exactly 4 iterations", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${counterFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')
if [ "$COUNT" -ge 4 ]; then
  printf '{"stop":true}'
fi`,
        );

        const result = await runCLI(["run", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(counterFile, "utf-8")).toBe("1111");
      });
    });
  });

  // =========================================================================
  // -n Counting (T-LOOP-06 – T-LOOP-10)
  // =========================================================================
  describe("SPEC: -n counting", () => {
    forEachRuntime((runtime) => {
      it("T-LOOP-06: -n 1 → exactly 1 iteration", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${counterFile}"`,
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(counterFile, "utf-8")).toBe("1");
      });

      it("T-LOOP-07: -n 3 with script that never stops → exactly 3 iterations", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${counterFile}"`,
        );

        const result = await runCLI(["run", "-n", "3", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(counterFile, "utf-8")).toBe("111");
      });

      it("T-LOOP-08: -n 3 with ralph:index → goto check → check no goto → yields index,check,index", async () => {
        project = await createTempProject();
        const orderFile = join(project.dir, "order.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'I' >> "${orderFile}"\nprintf '{"goto":"check"}'`,
        );
        await createBashWorkflowScript(
          project,
          "ralph",
          "check",
          `printf 'C' >> "${orderFile}"`,
        );

        const result = await runCLI(["run", "-n", "3", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(orderFile, "utf-8")).toBe("ICI");
      });

      it("T-LOOP-09: -n 2 with ralph:index → goto check → yields index,check", async () => {
        project = await createTempProject();
        const orderFile = join(project.dir, "order.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'I' >> "${orderFile}"\nprintf '{"goto":"check"}'`,
        );
        await createBashWorkflowScript(
          project,
          "ralph",
          "check",
          `printf 'C' >> "${orderFile}"`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(orderFile, "utf-8")).toBe("IC");
      });

      it("T-LOOP-10: -n 0 → no iterations, script never runs", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${counterFile}"`,
        );

        const result = await runCLI(["run", "-n", "0", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(counterFile)).toBe(false);
      });
    });
  });

  // =========================================================================
  // Input Piping (T-LOOP-11 – T-LOOP-15a)
  // =========================================================================
  describe("SPEC: Input piping", () => {
    forEachRuntime((runtime) => {
      it("T-LOOP-11: ralph:index emits {result,goto:reader}; ralph:reader reads stdin → gets payload", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"result":"payload","goto":"reader"}'`,
        );
        await createWorkflowScript(project, "ralph", "reader", ".sh", catStdin());

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(2);
        expect(outputs[1].result).toBe("payload");
      });

      it("T-LOOP-12: ralph:index emits {goto:reader} (no result); ralph:reader reads stdin → empty", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"reader"}'`,
        );
        await createWorkflowScript(project, "ralph", "reader", ".sh", catStdin());

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(2);
        expect(outputs[1].result).toBe("");
      });

      it("T-LOOP-13: ralph:index emits {result:payload} (no goto) → loop resets; index reads empty stdin on second iteration", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "iter-count.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${counterFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')
if [ "$COUNT" -eq 1 ]; then
  printf '{"result":"payload"}'
else
  INPUT=$(cat)
  printf '{"result":"%s"}' "$INPUT"
fi`,
        );

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(2);
        expect(outputs[0].result).toBe("payload");
        expect(outputs[1].result).toBe("");
      });

      it("T-LOOP-13a: cross-workflow reset clears stdin after a result-producing target", async () => {
        project = await createTempProject();
        const alphaCount = join(project.dir, "alpha-count.txt");

        await createBashWorkflowScript(
          project,
          "alpha",
          "index",
          `printf '1' >> "${alphaCount}"
COUNT=$(wc -c < "${alphaCount}" | tr -d ' ')
if [ "$COUNT" -eq 1 ]; then
  printf '{"goto":"beta:step"}'
else
  INPUT=$(cat)
  printf '{"result":"%s"}' "$INPUT"
fi`,
        );
        await createBashWorkflowScript(
          project,
          "beta",
          "step",
          `printf '{"result":"payload"}'`,
        );

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("alpha", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 3 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(3);
        expect(outputs[0].goto).toBe("beta:step");
        expect(outputs[1].result).toBe("payload");
        expect(outputs[2].result).toBe("");
      });

      it("T-LOOP-14: first iteration receives empty stdin", async () => {
        project = await createTempProject();

        await createWorkflowScript(project, "ralph", "index", ".sh", catStdin());

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(1);
        expect(outputs[0].result).toBe("");
      });

      it("T-LOOP-15: chain ralph:index → ralph:mid → ralph:tail; tail receives mid's result, not index's", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"result":"from-index","goto":"mid"}'`,
        );
        await createBashWorkflowScript(
          project,
          "ralph",
          "mid",
          `printf '{"result":"from-mid","goto":"tail"}'`,
        );
        await createWorkflowScript(project, "ralph", "tail", ".sh", catStdin());

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 3 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(3);
        expect(outputs[2].result).toBe("from-mid");
      });

      it("T-LOOP-15a: cross-workflow stdin piping — ralph:index result crosses workflow boundary to other:reader", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"result":"cross-payload","goto":"other:reader"}'`,
        );
        await createWorkflowScript(project, "other", "reader", ".sh", catStdin());

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(2);
        expect(outputs[1].result).toBe("cross-payload");
      });

      it("T-LOOP-15b: coerced non-string result is piped via stdin as String(value)", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"result":{"x":1},"goto":"reader"}'`,
        );
        await createWorkflowScript(project, "ralph", "reader", ".sh", catStdin());

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(2);
        expect(outputs[0].result).toBe("[object Object]");
        expect(outputs[1].result).toBe("[object Object]");
      });
    });
  });

  // =========================================================================
  // Goto Semantics — Intra-Workflow (T-LOOP-16 – T-LOOP-19b)
  // =========================================================================
  describe("SPEC: Goto semantics — intra-workflow", () => {
    forEachRuntime((runtime) => {
      it("T-LOOP-16: goto is transition not permanent — ralph:index → check → reset → index runs (not check)", async () => {
        project = await createTempProject();
        const orderFile = join(project.dir, "order.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'I' >> "${orderFile}"\nprintf '{"goto":"check"}'`,
        );
        await createBashWorkflowScript(
          project,
          "ralph",
          "check",
          `printf 'C' >> "${orderFile}"`,
        );

        const result = await runCLI(["run", "-n", "3", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(orderFile, "utf-8")).toBe("ICI");
      });

      it("T-LOOP-17: self-referencing bare goto — ralph:index → goto index → -n 2 runs index twice", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${counterFile}"\nprintf '{"goto":"index"}'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(counterFile, "utf-8")).toBe("11");
      });

      it("T-LOOP-18: goto to script that doesn't exist within the workflow → exit 1", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"nonexistent"}'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("nonexistent");
      });

      it("T-LOOP-18a: goto empty string → exit 1", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":""}'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
      });

      it("T-LOOP-19: bare goto to a script that exists only in a sibling workflow → exit 1 (bare resolves in current workflow)", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"check-ready"}'`,
        );
        // .loopx/other/check-ready.sh exists in a sibling workflow, but ralph has no check-ready.
        await createBashWorkflowScript(
          project,
          "other",
          "check-ready",
          `printf 'should-not-run'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-LOOP-19a: bare goto matching a workflow name does NOT jump to that workflow's index", async () => {
        project = await createTempProject();
        const otherMarker = join(project.dir, "other-index-ran.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"other"}'`,
        );
        // .loopx/other/index.sh exists (a workflow with a default entry point), and ralph has NO other.* script.
        await createBashWorkflowScript(
          project,
          "other",
          "index",
          `printf 'other-ran' > "${otherMarker}"`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(existsSync(otherMarker)).toBe(false);
      });

      it("T-LOOP-19b: bare goto disambiguation — current-workflow script wins over a same-named workflow", async () => {
        project = await createTempProject();
        const ralphApplyMarker = join(project.dir, "ralph-apply.txt");
        const applyIndexMarker = join(project.dir, "apply-index.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"apply"}'`,
        );
        await createBashWorkflowScript(
          project,
          "ralph",
          "apply",
          `printf 'ralph-apply-ran' > "${ralphApplyMarker}"`,
        );
        // .loopx/apply/index.sh exists (same-named workflow) — must NOT run.
        await createBashWorkflowScript(
          project,
          "apply",
          "index",
          `printf 'apply-index-ran' > "${applyIndexMarker}"`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(ralphApplyMarker)).toBe(true);
        expect(readFileSync(ralphApplyMarker, "utf-8")).toBe("ralph-apply-ran");
        expect(existsSync(applyIndexMarker)).toBe(false);
      });
    });
  });

  // =========================================================================
  // Goto Semantics — Cross-Workflow (T-LOOP-30 – T-LOOP-43)
  // =========================================================================
  describe("SPEC: Goto semantics — cross-workflow", () => {
    forEachRuntime((runtime) => {
      it("T-LOOP-30: qualified goto ralph:index → other:check runs other's script", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "other-check.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"other:check"}'`,
        );
        await createBashWorkflowScript(
          project,
          "other",
          "check",
          `printf 'other-check-ran' > "${marker}"`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(marker)).toBe(true);
        expect(readFileSync(marker, "utf-8")).toBe("other-check-ran");
      });

      it("T-LOOP-30a: qualified cross-workflow goto into workflow with no index script (alpha:index → beta:check)", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "beta-check.txt");

        await createBashWorkflowScript(
          project,
          "alpha",
          "index",
          `printf '{"goto":"beta:check"}'`,
        );
        // .loopx/beta/ has check.sh but no index.*
        await createBashWorkflowScript(
          project,
          "beta",
          "check",
          `printf 'beta-check-ran' > "${marker}"`,
        );

        const result = await runCLI(["run", "-n", "2", "alpha"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(marker)).toBe(true);
        expect(readFileSync(marker, "utf-8")).toBe("beta-check-ran");
      });

      it("T-LOOP-31: qualified same-workflow goto works — ralph:index → ralph:check is equivalent to bare check", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "ralph-check.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"ralph:check"}'`,
        );
        await createBashWorkflowScript(
          project,
          "ralph",
          "check",
          `printf 'ralph-check-ran' > "${marker}"`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(marker)).toBe(true);
        expect(readFileSync(marker, "utf-8")).toBe("ralph-check-ran");
      });

      it("T-LOOP-31a: cross-workflow default-entry targeting — ralph:index → other:index runs other's index", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "other-index.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"other:index"}'`,
        );
        await createBashWorkflowScript(
          project,
          "other",
          "index",
          `printf 'other-index-ran' > "${marker}"`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(marker)).toBe(true);
        expect(readFileSync(marker, "utf-8")).toBe("other-index-ran");
      });

      it("T-LOOP-31b: qualified same-workflow goto to index — ralph:check → ralph:index runs ralph's index", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "ralph-index.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "check",
          `printf '{"goto":"ralph:index"}'`,
        );
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'ralph-index-ran' > "${marker}"`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph:check"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(marker)).toBe(true);
        expect(readFileSync(marker, "utf-8")).toBe("ralph-index-ran");
      });

      it("T-LOOP-31c: qualified goto other:index where other has no index → exit 1", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"other:index"}'`,
        );
        // .loopx/other/check.sh exists but no index.*
        await createBashWorkflowScript(
          project,
          "other",
          "check",
          `printf 'should-not-run'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-LOOP-32: bare goto from cross-workflow context resolves in executing workflow — other:step1 → step2 runs other:step2", async () => {
        project = await createTempProject();
        const otherStep2Marker = join(project.dir, "other-step2.txt");
        const ralphStep2Marker = join(project.dir, "ralph-step2.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"other:step1"}'`,
        );
        await createBashWorkflowScript(
          project,
          "other",
          "step1",
          `printf '{"goto":"step2"}'`,
        );
        await createBashWorkflowScript(
          project,
          "other",
          "step2",
          `printf 'other-step2-ran' > "${otherStep2Marker}"`,
        );
        // Decoy: ralph:step2 must NOT execute
        await createBashWorkflowScript(
          project,
          "ralph",
          "step2",
          `printf 'ralph-step2-ran' > "${ralphStep2Marker}"`,
        );

        const result = await runCLI(["run", "-n", "3", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(otherStep2Marker)).toBe(true);
        expect(readFileSync(otherStep2Marker, "utf-8")).toBe("other-step2-ran");
        expect(existsSync(ralphStep2Marker)).toBe(false);
      });

      it("T-LOOP-32a: bare goto 'index' from cross-workflow context resolves to executing workflow's index", async () => {
        project = await createTempProject();
        const betaIndexMarker = join(project.dir, "beta-index.txt");
        const alphaIndexCounter = join(project.dir, "alpha-index-count.txt");

        await createBashWorkflowScript(
          project,
          "alpha",
          "index",
          `printf '1' >> "${alphaIndexCounter}"
COUNT=$(wc -c < "${alphaIndexCounter}" | tr -d ' ')
if [ "$COUNT" -eq 1 ]; then
  printf '{"goto":"beta:step"}'
fi`,
        );
        await createBashWorkflowScript(
          project,
          "beta",
          "step",
          `printf '{"goto":"index"}'`,
        );
        await createBashWorkflowScript(
          project,
          "beta",
          "index",
          `printf 'beta-index-ran' > "${betaIndexMarker}"`,
        );

        const result = await runCLI(["run", "-n", "3", "alpha"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(betaIndexMarker)).toBe(true);
        expect(readFileSync(betaIndexMarker, "utf-8")).toBe("beta-index-ran");
      });

      it("T-LOOP-33: loop reset returns to starting target (ralph:index), not other's default entry", async () => {
        project = await createTempProject();
        const orderFile = join(project.dir, "order.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'R' >> "${orderFile}"
COUNT=$(wc -c < "${orderFile}" | tr -d ' ')
if [ "$COUNT" -eq 1 ]; then
  printf '{"goto":"other:check"}'
fi`,
        );
        await createBashWorkflowScript(
          project,
          "other",
          "check",
          `printf 'C' >> "${orderFile}"`,
        );
        // Decoy: other:index exists but should NEVER run during a reset.
        await createBashWorkflowScript(
          project,
          "other",
          "index",
          `printf 'X' >> "${orderFile}"`,
        );

        const result = await runCLI(["run", "-n", "3", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        // iter 1: ralph:index (R, goto other:check)
        // iter 2: other:check (C, no goto → reset to ralph:index)
        // iter 3: ralph:index (R; counter > 1 so no goto)
        expect(readFileSync(orderFile, "utf-8")).toBe("RCR");
      });

      it("T-LOOP-34: qualified goto with missing workflow → exit 1", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"nonexistent:check"}'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-LOOP-35: qualified goto with missing script in target workflow → exit 1", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"other:nonexistent"}'`,
        );
        await createBashWorkflowScript(
          project,
          "other",
          "check",
          `printf 'should-not-run'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-LOOP-36: goto ':script' (leading colon) → exit 1", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":":check"}'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-LOOP-37: goto 'a:b:c' (multiple colons) → exit 1", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"a:b:c"}'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-LOOP-38: goto ':' (bare colon) → exit 1", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":":"}'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-LOOP-39: goto 'other:' (trailing colon) → exit 1", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"other:"}'`,
        );
        await createBashWorkflowScript(
          project,
          "other",
          "index",
          `printf 'should-not-run'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-LOOP-40: goto '-bad' (name restriction on bare name) → exit 1", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"-bad"}'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-LOOP-41: goto 'other:-bad' (name restriction on qualified script portion) → exit 1", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"other:-bad"}'`,
        );
        await createBashWorkflowScript(
          project,
          "other",
          "check",
          `printf 'should-not-run'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-LOOP-42: goto '-bad:index' (name restriction on qualified workflow portion) → exit 1", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"goto":"-bad:index"}'`,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-LOOP-43: loop reset goes to explicit script starting target (ralph:check), not ralph:index", async () => {
        project = await createTempProject();
        const orderFile = join(project.dir, "order.txt");

        // Starting target: ralph:check (NOT ralph:index)
        // ralph:check → goto other:step → other:step → no goto → reset to ralph:check
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'I' >> "${orderFile}"`,
        );
        await createBashWorkflowScript(
          project,
          "ralph",
          "check",
          `printf 'K' >> "${orderFile}"
COUNT=$(wc -c < "${orderFile}" | tr -d ' ')
if [ "$COUNT" -eq 1 ]; then
  printf '{"goto":"other:step"}'
fi`,
        );
        await createBashWorkflowScript(
          project,
          "other",
          "step",
          `printf 'S' >> "${orderFile}"`,
        );

        const result = await runCLI(["run", "-n", "3", "ralph:check"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        // iter 1: ralph:check → K, goto other:step
        // iter 2: other:step → S, no goto → reset to ralph:check
        // iter 3: ralph:check → K again (no goto this time since counter>1)
        // "I" must NOT appear (ralph:index should never execute)
        const order = readFileSync(orderFile, "utf-8");
        expect(order).toBe("KSK");
        expect(order).not.toContain("I");
      });
    });
  });

  // =========================================================================
  // Error Handling (T-LOOP-20 – T-LOOP-24)
  // =========================================================================
  describe("SPEC: Error handling", () => {
    forEachRuntime((runtime) => {
      it("T-LOOP-20: script exits with code 1 → loop stops, loopx exits 1", async () => {
        project = await createTempProject();

        await createWorkflowScript(project, "ralph", "index", ".sh", exitCode(1));

        const result = await runCLI(["run", "-n", "5", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-LOOP-21: script exits with code 2 → loopx exits 1", async () => {
        project = await createTempProject();

        await createWorkflowScript(project, "ralph", "index", ".sh", exitCode(2));

        const result = await runCLI(["run", "-n", "5", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-LOOP-22: script fails on iteration 3 of -n 5 → exactly 3 iterations ran", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${counterFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')
if [ "$COUNT" -ge 3 ]; then
  exit 1
fi
printf '{"result":"ok"}'`,
        );

        const result = await runCLI(["run", "-n", "5", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(readFileSync(counterFile, "utf-8")).toBe("111");
      });

      it("T-LOOP-23: script stderr output is visible on CLI stderr", async () => {
        project = await createTempProject();

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          writeStderr("custom-error-msg"),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.stderr).toContain("custom-error-msg");
      });

      it("T-LOOP-24: stdout is not parsed on failure — generator throws without yielding Output for failing iteration", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"result":"should-not-appear","stop":true}'\nexit 1`,
        );

        const driverCode = `
import { run } from "loopx";

const outputs = [];
let threwError = false;

try {
  for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)} })) {
    outputs.push(output);
  }
} catch (e) {
  threwError = true;
}

console.log(JSON.stringify({ outputs, threwError }));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const parsed = JSON.parse(result.stdout);
        expect(parsed.threwError).toBe(true);
        expect(parsed.outputs).toHaveLength(0);
        for (const output of parsed.outputs) {
          expect(output.result).not.toBe("should-not-appear");
        }
      });

      it("T-LOOP-24a/T-LOOP-24A: CLI stdout from a non-zero script is captured, not parsed or leaked", async () => {
        project = await createTempProject();

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s\\n' '{"stop":true}'
printf '%s\\n' 'STDERR-MARKER-T-LOOP-24A: script about to fail with exit 1' >&2
exit 1`,
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stdout).not.toContain('{"stop":true}');
        expect(result.stderr).toContain("STDERR-MARKER-T-LOOP-24A");
      });
    });
  });

  // =========================================================================
  // Max-Iteration-Before-Goto Validation (T-LOOP-44 – T-LOOP-46)
  // =========================================================================
  describe("SPEC: max-iteration before goto validation", () => {
    forEachRuntime((runtime) => {
      it("T-LOOP-44: CLI invalid goto on final counted iteration exits cleanly", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "invalid-final-goto-cli.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${marker}"
printf '{"goto":"a:b:c"}'`,
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toContain("a:b:c");
        expect(readFileSync(marker, "utf-8")).toBe("1");
      });

      it("T-LOOP-45: runPromise invalid goto on final counted iteration resolves with the parsed output", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "invalid-final-goto-promise.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${marker}"
printf '{"goto":"a:b:c"}'`,
        );

        const driverCode = `
import { runPromise } from "loopx";
try {
  const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  console.log(JSON.stringify({ resolved: true, outputs }));
} catch (error) {
  console.log(JSON.stringify({ resolved: false, message: String(error?.message ?? error) }));
}
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const parsed = JSON.parse(result.stdout);
        expect(parsed.resolved).toBe(true);
        expect(parsed.outputs).toHaveLength(1);
        expect(parsed.outputs[0].goto).toBe("a:b:c");
        expect(readFileSync(marker, "utf-8")).toBe("1");
      });

      it("T-LOOP-46: run() invalid goto on final counted iteration yields once and settles cleanly", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "invalid-final-goto-run.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${marker}"
printf '{"goto":"a:b:c"}'`,
        );

        const driverCode = `
import { run } from "loopx";
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  const first = await gen.next();
  const second = await gen.next();
  console.log(JSON.stringify({ threw: false, first, second }));
} catch (error) {
  console.log(JSON.stringify({ threw: true, message: String(error?.message ?? error) }));
}
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const parsed = JSON.parse(result.stdout);
        expect(parsed.threw).toBe(false);
        expect(parsed.first.done).toBe(false);
        expect(parsed.first.value.goto).toBe("a:b:c");
        expect(parsed.second.done).toBe(true);
        expect(readFileSync(marker, "utf-8")).toBe("1");
      });
    });
  });

  // =========================================================================
  // Final Iteration Output (T-LOOP-25)
  // =========================================================================
  describe("SPEC: Final iteration output", () => {
    forEachRuntime((runtime) => {
      it("T-LOOP-25: -n 2 with iter-N result producer — both outputs observable via programmatic API", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${counterFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')
printf '{"result":"iter-%s"}' "$COUNT"`,
        );

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(2);
        expect(outputs[0].result).toBe("iter-1");
        expect(outputs[1].result).toBe("iter-2");
      });
    });
  });
});
