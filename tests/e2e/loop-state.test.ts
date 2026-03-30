import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTempProject,
  createScript,
  createBashScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { forEachRuntime } from "../helpers/runtime.js";
import {
  emitResult,
  emitGoto,
  emitStop,
  emitResultGoto,
  counter,
  catStdin,
  exitCode,
  writeStderr,
  emitRaw,
} from "../helpers/fixture-scripts.js";

// ---------------------------------------------------------------------------
// SPEC: §7.1 — Basic Loop State Machine & Control Flow
// ---------------------------------------------------------------------------

describe("SPEC: Loop state machine (§2.2, §7.1, §7.2)", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  // =========================================================================
  // Basic Loop Behavior
  // =========================================================================

  describe("SPEC: Basic Loop Behavior", () => {
    forEachRuntime((runtime) => {
      // T-LOOP-01: No output → loop resets, runs 3 times with -n 3
      it("T-LOOP-01: no output → loop resets to starting target, runs 3 times with -n 3", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        // Script that increments counter but produces no structured output
        await createBashScript(
          project,
          "noop",
          `printf '1' >> "${counterFile}"`
        );

        const result = await runCLI(["-n", "3", "noop"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const count = readFileSync(counterFile, "utf-8");
        expect(count).toBe("111"); // 3 invocations
      });

      // T-LOOP-02: A→goto:B→B no output→A again. -n 4: A,B,A,B
      it("T-LOOP-02: A→goto:B→B no output→loop resets to A. -n 4 yields A,B,A,B", async () => {
        project = await createTempProject();
        const orderFile = join(project.dir, "order.txt");

        // A: records "A", gotos B
        await createBashScript(
          project,
          "A",
          `printf 'A' >> "${orderFile}"\nprintf '{"goto":"B"}'`
        );

        // B: records "B", no output (no goto, no stop)
        await createBashScript(
          project,
          "B",
          `printf 'B' >> "${orderFile}"`
        );

        const result = await runCLI(["-n", "4", "A"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const order = readFileSync(orderFile, "utf-8");
        expect(order).toBe("ABAB");
      });

      // T-LOOP-03: A→B→C→A. -n 4: A,B,C,A
      it("T-LOOP-03: A→goto:B→B→goto:C→C no goto→reset to A. -n 4 yields A,B,C,A", async () => {
        project = await createTempProject();
        const orderFile = join(project.dir, "order.txt");

        // A: records "A", gotos B
        await createBashScript(
          project,
          "A",
          `printf 'A' >> "${orderFile}"\nprintf '{"goto":"B"}'`
        );

        // B: records "B", gotos C
        await createBashScript(
          project,
          "B",
          `printf 'B' >> "${orderFile}"\nprintf '{"goto":"C"}'`
        );

        // C: records "C", no goto (resets to starting target A)
        await createBashScript(
          project,
          "C",
          `printf 'C' >> "${orderFile}"`
        );

        const result = await runCLI(["-n", "4", "A"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const order = readFileSync(orderFile, "utf-8");
        expect(order).toBe("ABCA");
      });

      // T-LOOP-04: stop:true on first → 1 iteration, exit 0
      it("T-LOOP-04: stop:true on first iteration → 1 iteration, exit 0", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        // Script emits stop and records execution
        await createBashScript(
          project,
          "stopper",
          `printf '1' >> "${counterFile}"\nprintf '{"stop":true}'`
        );

        const result = await runCLI(["stopper"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const count = readFileSync(counterFile, "utf-8");
        expect(count).toBe("1"); // exactly 1 iteration
      });

      // T-LOOP-05: Counter-based: runs 3 times, stops on 4th
      it("T-LOOP-05: script runs 3 times without stop, stops on 4th → exactly 4 iterations", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        // Script: increments counter, on 4th invocation emits stop
        await createBashScript(
          project,
          "conditional-stop",
          `printf '1' >> "${counterFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')
if [ "$COUNT" -ge 4 ]; then
  printf '{"stop":true}'
fi`
        );

        const result = await runCLI(["conditional-stop"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const count = readFileSync(counterFile, "utf-8");
        expect(count).toBe("1111"); // exactly 4 iterations
      });
    });
  });

  // =========================================================================
  // -n Counting
  // =========================================================================

  describe("SPEC: -n counting (§7.1)", () => {
    forEachRuntime((runtime) => {
      // T-LOOP-06: -n 1 → exactly 1 iteration
      it("T-LOOP-06: -n 1 → exactly 1 iteration", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        await createScript(project, "count", ".sh", counter(counterFile));

        const result = await runCLI(["-n", "1", "count"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const count = readFileSync(counterFile, "utf-8");
        expect(count).toBe("1");
      });

      // T-LOOP-07: -n 3 with no stop → exactly 3
      it("T-LOOP-07: -n 3 with script that never stops → exactly 3 iterations", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        await createScript(project, "count", ".sh", counter(counterFile));

        const result = await runCLI(["-n", "3", "count"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const count = readFileSync(counterFile, "utf-8");
        expect(count).toBe("111");
      });

      // T-LOOP-08: -n 3 with A→goto:B→B no goto. A,B,A = 3
      it("T-LOOP-08: -n 3 with A→goto:B→B no goto → A,B,A = 3 iterations", async () => {
        project = await createTempProject();
        const orderFile = join(project.dir, "order.txt");

        await createBashScript(
          project,
          "A",
          `printf 'A' >> "${orderFile}"\nprintf '{"goto":"B"}'`
        );

        await createBashScript(
          project,
          "B",
          `printf 'B' >> "${orderFile}"`
        );

        const result = await runCLI(["-n", "3", "A"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const order = readFileSync(orderFile, "utf-8");
        expect(order).toBe("ABA");
      });

      // T-LOOP-09: -n 2 with A→goto:B. A(1),B(2)
      it("T-LOOP-09: -n 2 with A→goto:B → A(1),B(2), A does not run again", async () => {
        project = await createTempProject();
        const orderFile = join(project.dir, "order.txt");

        await createBashScript(
          project,
          "A",
          `printf 'A' >> "${orderFile}"\nprintf '{"goto":"B"}'`
        );

        await createBashScript(
          project,
          "B",
          `printf 'B' >> "${orderFile}"`
        );

        const result = await runCLI(["-n", "2", "A"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const order = readFileSync(orderFile, "utf-8");
        expect(order).toBe("AB");
      });

      // T-LOOP-10: -n 0 → no iterations
      it("T-LOOP-10: -n 0 → no iterations, script never runs", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        await createScript(project, "count", ".sh", counter(counterFile));

        const result = await runCLI(["-n", "0", "count"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        // Counter file should not exist since script never ran
        expect(() => readFileSync(counterFile, "utf-8")).toThrow();
      });
    });
  });

  // =========================================================================
  // Input Piping
  // =========================================================================

  describe("SPEC: Input piping (§6.7, §6.8)", () => {
    forEachRuntime((runtime) => {
      // T-LOOP-11: A outputs result+goto:B, B reads stdin → gets payload
      it("T-LOOP-11: A outputs result+goto:B, B reads stdin and gets the payload", async () => {
        project = await createTempProject();

        // A: emits result "payload" and goto B
        await createScript(project, "A", ".sh", emitResultGoto("payload", "B"));

        // B: reads stdin and echoes it as result
        await createScript(project, "B", ".sh", catStdin());

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("A", { cwd: "${project.dir}", maxIterations: 2 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        // Second output (B's output) should have result equal to "payload"
        expect(outputs).toHaveLength(2);
        expect(outputs[1].result).toBe("payload");
      });

      // T-LOOP-12: A outputs goto:B (no result), B reads stdin → empty
      it("T-LOOP-12: A outputs goto:B with no result, B reads stdin → empty string", async () => {
        project = await createTempProject();

        // A: emits only goto B (no result)
        await createScript(project, "A", ".sh", emitGoto("B"));

        // B: reads stdin and echoes it as result
        await createScript(project, "B", ".sh", catStdin());

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("A", { cwd: "${project.dir}", maxIterations: 2 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(2);
        expect(outputs[1].result).toBe("");
      });

      // T-LOOP-13: A outputs result (no goto), loop resets, A reads stdin → empty
      it("T-LOOP-13: A outputs result with no goto, loop resets, A reads stdin → empty (result not piped on reset)", async () => {
        project = await createTempProject();

        const counterFile = join(project.dir, "iter-count.txt");

        // A: on first call emits result "payload" (no goto).
        // On second call reads stdin and echoes it.
        // Use a counter to differentiate iterations.
        await createBashScript(
          project,
          "A",
          `printf '1' >> "${counterFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')
if [ "$COUNT" -eq 1 ]; then
  printf '{"result":"payload"}'
else
  INPUT=$(cat)
  printf '{"result":"%s"}' "$INPUT"
fi`
        );

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("A", { cwd: "${project.dir}", maxIterations: 2 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(2);
        // First iteration produces "payload"
        expect(outputs[0].result).toBe("payload");
        // Second iteration (reset, no input piped) should get empty stdin
        expect(outputs[1].result).toBe("");
      });

      // T-LOOP-14: First iteration reads stdin → empty
      it("T-LOOP-14: first iteration receives empty stdin", async () => {
        project = await createTempProject();

        // Script reads stdin and echoes it as result
        await createScript(project, "echo-stdin", ".sh", catStdin());

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("echo-stdin", { cwd: "${project.dir}", maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(1);
        expect(outputs[0].result).toBe("");
      });

      // T-LOOP-15: A→B→C chain, C gets B's result not A's
      it("T-LOOP-15: A→B→C chain, C receives B's result not A's", async () => {
        project = await createTempProject();

        // A: emits result "from-A" and goto B
        await createScript(project, "A", ".sh", emitResultGoto("from-A", "B"));

        // B: reads stdin (gets "from-A"), emits result "from-B" and goto C
        // We want B to emit its own result regardless of input
        await createBashScript(
          project,
          "B",
          `printf '{"result":"from-B","goto":"C"}'`
        );

        // C: reads stdin and echoes it as result
        await createScript(project, "C", ".sh", catStdin());

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("A", { cwd: "${project.dir}", maxIterations: 3 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(3);
        // C should receive B's result, not A's
        expect(outputs[2].result).toBe("from-B");
      });
    });
  });

  // =========================================================================
  // Goto Behavior
  // =========================================================================

  describe("SPEC: Goto behavior (§2.2)", () => {
    forEachRuntime((runtime) => {
      // T-LOOP-16: Goto is transition not permanent
      it("T-LOOP-16: goto is a transition, not permanent — A→goto:B→B no goto→A runs again", async () => {
        project = await createTempProject();
        const orderFile = join(project.dir, "order.txt");

        // A: records "A", gotos B
        await createBashScript(
          project,
          "A",
          `printf 'A' >> "${orderFile}"\nprintf '{"goto":"B"}'`
        );

        // B: records "B", no goto → resets to starting target A
        await createBashScript(
          project,
          "B",
          `printf 'B' >> "${orderFile}"`
        );

        const result = await runCLI(["-n", "3", "A"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const order = readFileSync(orderFile, "utf-8");
        // A(1), B(2), A(3) — not A,B,B
        expect(order).toBe("ABA");
      });

      // T-LOOP-17: Self-goto (A→A)
      it("T-LOOP-17: self-goto A→goto:A works, A runs twice with -n 2", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        // A: records execution, self-goto
        await createBashScript(
          project,
          "A",
          `printf '1' >> "${counterFile}"\nprintf '{"goto":"A"}'`
        );

        const result = await runCLI(["-n", "2", "A"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const count = readFileSync(counterFile, "utf-8");
        expect(count).toBe("11"); // ran exactly twice
      });

      // T-LOOP-18: Invalid goto target → exit 1
      it("T-LOOP-18: goto to non-existent target → exit 1, stderr mentions target", async () => {
        project = await createTempProject();

        // A: gotos a target that doesn't exist
        await createBashScript(
          project,
          "A",
          `printf '{"goto":"nonexistent"}'`
        );

        const result = await runCLI(["-n", "2", "A"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("nonexistent");
      });

      // T-LOOP-19: Goto to undiscoverable script → exit 1
      it("T-LOOP-19: goto to undiscoverable script (e.g., .mjs) → exit 1", async () => {
        project = await createTempProject();

        // A: gotos "hidden" which is a .mjs file (not discoverable)
        await createBashScript(
          project,
          "A",
          `printf '{"goto":"hidden"}'`
        );

        // Create a .mjs file — this extension is not discoverable by loopx
        await createScript(
          project,
          "hidden",
          ".mjs",
          'console.log(JSON.stringify({ result: "found" }));\n'
        );

        const result = await runCLI(["-n", "2", "A"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });
    });
  });

  // =========================================================================
  // Error Handling
  // =========================================================================

  describe("SPEC: Error handling (§7.2)", () => {
    forEachRuntime((runtime) => {
      // T-LOOP-20: Script exit 1 → loop stops, loopx exit 1
      it("T-LOOP-20: script exits with code 1 → loop stops, loopx exits 1", async () => {
        project = await createTempProject();

        await createScript(project, "fail", ".sh", exitCode(1));

        const result = await runCLI(["-n", "5", "fail"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      // T-LOOP-21: Script exit 2 → same
      it("T-LOOP-21: script exits with code 2 → loop stops, loopx exits 1", async () => {
        project = await createTempProject();

        await createScript(project, "fail2", ".sh", exitCode(2));

        const result = await runCLI(["-n", "5", "fail2"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      // T-LOOP-22: Fails on iteration 3 of 5 → exactly 3 ran
      it("T-LOOP-22: script fails on iteration 3 of -n 5 → exactly 3 iterations ran", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        // Script runs normally first 2 times, fails on 3rd
        await createBashScript(
          project,
          "fail-on-3",
          `printf '1' >> "${counterFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')
if [ "$COUNT" -ge 3 ]; then
  exit 1
fi
printf '{"result":"ok"}'`
        );

        const result = await runCLI(["-n", "5", "fail-on-3"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        const count = readFileSync(counterFile, "utf-8");
        expect(count).toBe("111"); // exactly 3 iterations ran
      });

      // T-LOOP-23: Script stderr visible on CLI stderr
      it("T-LOOP-23: script stderr output is visible on CLI stderr", async () => {
        project = await createTempProject();

        await createScript(project, "stderr-script", ".sh", writeStderr("custom-error-msg"));

        const result = await runCLI(["-n", "1", "stderr-script"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.stderr).toContain("custom-error-msg");
      });

      // T-LOOP-24: stdout NOT parsed on failure (generator throws, no yield)
      it("T-LOOP-24: stdout is not parsed on failure — generator throws without yielding Output for failing iteration", async () => {
        project = await createTempProject();

        // Script outputs valid JSON with result AND stop:true, then exits 1
        // If stdout were parsed on failure, it would yield the result and stop cleanly.
        // Instead, the generator should throw an error for this iteration.
        await createBashScript(
          project,
          "fail-with-output",
          `printf '{"result":"should-not-appear","stop":true}'\nexit 1`
        );

        const driverCode = `
import { run } from "loopx";

const outputs = [];
let threwError = false;

try {
  for await (const output of run("fail-with-output", { cwd: "${project.dir}" })) {
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
        // The generator should throw, not yield an Output for the failing iteration
        expect(parsed.threwError).toBe(true);
        // No outputs should have been yielded for the failing iteration
        expect(parsed.outputs).toHaveLength(0);
        // Specifically, "should-not-appear" must not be in any result
        for (const output of parsed.outputs) {
          expect(output.result).not.toBe("should-not-appear");
        }
      });
    });
  });

  // =========================================================================
  // Final Iteration Output
  // =========================================================================

  describe("SPEC: Final iteration output (§7.1)", () => {
    forEachRuntime((runtime) => {
      // T-LOOP-25: -n 2 → both outputs observable via programmatic API
      it("T-LOOP-25: -n 2 with result-producing script → both outputs observable via API", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");

        // Script uses counter to produce unique result per iteration
        await createScript(project, "numbered", ".sh", counter(counterFile));

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("numbered", { cwd: "${project.dir}", maxIterations: 2 });
console.log(JSON.stringify(outputs));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        const outputs = JSON.parse(result.stdout);
        expect(outputs).toHaveLength(2);
        // First iteration: counter = 1
        expect(outputs[0].result).toBe("1");
        // Second iteration: counter = 2
        expect(outputs[1].result).toBe("2");
      });
    });
  });
});
