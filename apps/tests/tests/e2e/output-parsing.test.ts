import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createTempProject,
  createBashWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { runCLI } from "../helpers/cli.js";
import { forEachRuntime } from "../helpers/runtime.js";

// ---------------------------------------------------------------------------
// TEST-SPEC §4.5 — Structured Output Parsing (ADR-0003 workflow model)
// Spec refs: 2.3
//
// All fixture scripts live inside a workflow (e.g. `.loopx/test/index.sh`).
// `runPromise` / `run` calls target the workflow by name ("test").
//
// Parsing correctness is asserted by examining the actual yielded `Output`
// object via `runPromise()` / `run()` through `runAPIDriver`, not by inferring
// from loop behavior alone.
// ---------------------------------------------------------------------------

/** Spawn a driver that calls runPromise on the `test` workflow with maxIterations: 1. */
async function runParseTest(
  runtime: "node" | "bun",
  project: TempProject,
): Promise<{ outputs: unknown[]; exitCode: number; stderr: string; stdout: string }> {
  const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("test", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
  const result = await runAPIDriver(runtime, driverCode);
  let outputs: unknown[] = [];
  try {
    outputs = JSON.parse(result.stdout);
  } catch {
    // Parse failure leaves outputs as []; the test will surface the real failure
    // through the stderr/exitCode assertions.
  }
  return {
    outputs,
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

describe("SPEC: Structured Output Parsing (T-PARSE-01 through T-PARSE-29)", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // -------------------------------------------------------------------------
    // Valid Structured Output
    // -------------------------------------------------------------------------
    describe("Valid Structured Output", () => {
      it('T-PARSE-01: {"result":"hello"} yields Output with result: "hello"', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"result":"hello"}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output.result).toBe("hello");
        expect(output).not.toHaveProperty("goto");
        expect(output).not.toHaveProperty("stop");
      });

      it('T-PARSE-02: {"goto":"next"} transitions to script "next" (same workflow)', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"goto":"next"}'`,
        );
        // "next" script exists to prove transition semantics, though with
        // maxIterations: 1 the transition is not actually performed.
        await createBashWorkflowScript(
          project,
          "test",
          "next",
          `printf '{"result":"arrived"}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output.goto).toBe("next");
      });

      it('T-PARSE-03: {"stop":true} halts the loop, exit code 0', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"stop":true}'`,
        );

        // maxIterations > 1 proves stop halts control flow, not the iteration cap.
        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("test", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5 });
console.log(JSON.stringify(outputs));
`;
        const result = await runAPIDriver(runtime, driverCode);

        expect(result.exitCode).toBe(0);
        const outputs = JSON.parse(result.stdout) as unknown[];
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output.stop).toBe(true);
      });

      it('T-PARSE-04: {"result":"x","goto":"next","stop":true} → stop priority, 1 iteration', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"result":"x","goto":"next","stop":true}'`,
        );
        await createBashWorkflowScript(
          project,
          "test",
          "next",
          `printf '{"result":"never"}'`,
        );

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("test", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5 });
console.log(JSON.stringify(outputs));
`;
        const result = await runAPIDriver(runtime, driverCode);

        expect(result.exitCode).toBe(0);
        const outputs = JSON.parse(result.stdout) as unknown[];
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output.stop).toBe(true);
      });

      it('T-PARSE-04a: stop:true beats invalid goto (validation short-circuited)', async () => {
        // SPEC 2.3 "Field precedence": stop:true wins over goto, AND wins
        // before goto-target validation runs. T-PARSE-04 used a *valid*
        // goto target; this test pins down that an *invalid* goto
        // (multi-colon "a:b:c", per SPEC 4.1) triggers no validation
        // error path when stop:true is set in the same Output.
        project = await createTempProject();
        const counterFile = join(project.dir, "iter-count");
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `n=0
[ -f '${counterFile}' ] && n=$(cat '${counterFile}')
echo $((n + 1)) > '${counterFile}'
printf '{"stop":true,"goto":"a:b:c"}'`,
        );

        // (a) CLI surface: maxIterations 5 proves stop halts the loop, not the cap.
        const cliResult = await runCLI(["run", "test", "-n", "5"], {
          cwd: project.dir,
          runtime,
        });
        expect(cliResult.exitCode).toBe(0);
        // (b) stderr contains no goto-validation error path.
        expect(cliResult.stderr).not.toMatch(/Invalid goto/);
        expect(cliResult.stderr).not.toMatch(/only one ':' delimiter/);
        expect(cliResult.stderr).not.toMatch(/not found in workflow/);
        expect(cliResult.stderr).not.toMatch(/not found in \.loopx/);
        // (d) Counter file proves the script ran exactly once under CLI.
        expect(existsSync(counterFile)).toBe(true);
        expect((await readFile(counterFile, "utf-8")).trim()).toBe("1");

        // (c) runPromise surface: resolves with one Output containing stop:true,
        // does not reject. Counter goes from 1 → 2 (delta proves single execution).
        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("test", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5 });
console.log(JSON.stringify(outputs));
`;
        const apiResult = await runAPIDriver(runtime, driverCode);
        expect(apiResult.exitCode).toBe(0);
        // No goto-validation error written by the API driver either.
        expect(apiResult.stderr).not.toMatch(/Invalid goto/);
        expect(apiResult.stderr).not.toMatch(/only one ':' delimiter/);
        const outputs = JSON.parse(apiResult.stdout) as unknown[];
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output.stop).toBe(true);
        // Counter delta from runPromise confirms a single iteration too.
        expect((await readFile(counterFile, "utf-8")).trim()).toBe("2");
      });

      it('T-PARSE-05: {"result":"x","extra":"ignored"} drops unknown fields', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"result":"x","extra":"ignored"}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output.result).toBe("x");
        expect(output).not.toHaveProperty("extra");
        expect(output).not.toHaveProperty("goto");
        expect(output).not.toHaveProperty("stop");
      });
    });

    // -------------------------------------------------------------------------
    // Fallback to Raw Result
    // -------------------------------------------------------------------------
    describe("Fallback to Raw Result", () => {
      it('T-PARSE-06: {"unknown":"field"} falls back to raw string', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"unknown":"field"}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe(
          '{"unknown":"field"}',
        );
      });

      it("T-PARSE-07: [1,2,3] (JSON array) falls back to raw result", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '[1,2,3]'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe("[1,2,3]");
      });

      it('T-PARSE-08: "hello" (JSON string) falls back to raw result including quotes', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '"hello"'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe('"hello"');
      });

      it("T-PARSE-09: 42 (JSON number) falls back to raw result", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '42'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe("42");
      });

      it("T-PARSE-10: true (JSON boolean) falls back to raw result", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf 'true'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe("true");
      });

      it("T-PARSE-11: null (JSON null) falls back to raw result", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf 'null'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe("null");
      });

      it("T-PARSE-12: non-JSON text falls back to raw result", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf 'not json at all'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe(
          "not json at all",
        );
      });

      it("T-PARSE-12a: raw fallback preserves trailing newline", async () => {
        project = await createTempProject();
        // Use explicit \n via printf to emit "hello\n" exactly.
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf 'hello\n'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe("hello\n");
      });

      it('T-PARSE-13: empty stdout yields result: ""', async () => {
        project = await createTempProject();
        // Script exits cleanly with no stdout at all.
        await createBashWorkflowScript(project, "test", "index", `true`);

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe("");
      });

      it('T-PARSE-13a: whitespace-only stdout falls back to raw with bytes preserved', async () => {
        // SPEC 2.3 raw-fallback rule: stdout that does not parse as a JSON
        // object with at least one known field becomes `result` verbatim.
        // Whitespace-only ("   ") is the boundary case between empty
        // (T-PARSE-13 → result:"") and non-empty raw text (T-PARSE-12).
        // A trim-before-fallback bug would collapse this to "".
        project = await createTempProject();
        // printf with a literal three-space format string (no escapes,
        // no %), no trailing newline.
        await createBashWorkflowScript(project, "test", "index", `printf '   '`);

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe("   ");
      });
    });

    // -------------------------------------------------------------------------
    // Type Coercion
    // -------------------------------------------------------------------------
    describe("Type Coercion", () => {
      it('T-PARSE-14: {"result":42} coerces to "42"', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"result":42}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe("42");
      });

      it('T-PARSE-15: {"result":true} coerces to "true"', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"result":true}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe("true");
      });

      it('T-PARSE-16: {"result":{"nested":"obj"}} coerces to "[object Object]"', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"result":{"nested":"obj"}}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe(
          "[object Object]",
        );
      });

      it('T-PARSE-17: {"result":null} coerces to "null"', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"result":null}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe("null");
      });

      it('T-PARSE-17a: {"result":[1,2]} (array) coerces via String() to "1,2"', async () => {
        // SPEC 2.3: "If `result` is present but not a string, it is
        // coerced via `String(value)`." T-PARSE-14..17 cover number/
        // boolean/object/null; the array case is distinct because
        // `String([1,2])` joins with "," (no surrounding brackets),
        // and a hand-rolled `JSON.stringify` shortcut would emit
        // "[1,2]" instead.
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"result":[1,2]}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        expect((outputs[0] as Record<string, unknown>).result).toBe("1,2");
      });

      it('T-PARSE-18: {"goto":42} invalid goto discarded, Output is {}', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"goto":42}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output).not.toHaveProperty("result");
        expect(output).not.toHaveProperty("goto");
        expect(output).not.toHaveProperty("stop");
        expect(Object.keys(output)).toHaveLength(0);
      });

      it('T-PARSE-19: {"goto":true} invalid goto discarded, Output is {}', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"goto":true}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output).not.toHaveProperty("result");
        expect(output).not.toHaveProperty("goto");
        expect(output).not.toHaveProperty("stop");
        expect(Object.keys(output)).toHaveLength(0);
      });

      it('T-PARSE-20: {"goto":null} invalid goto discarded, Output is {}', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"goto":null}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output).not.toHaveProperty("result");
        expect(output).not.toHaveProperty("goto");
        expect(output).not.toHaveProperty("stop");
        expect(Object.keys(output)).toHaveLength(0);
      });

      it('T-PARSE-20a: {"goto":""} preserved at parse, rejected at transition', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"goto":""}'`,
        );

        // Observe via run(): first yield has goto: "", generator throws when
        // advancing past the first iteration.
        const runDriver = `
import { run } from "loopx";
const gen = run("test", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
const first = await gen.next();
let threw = false;
let message = "";
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = (e && e.message) ? e.message : String(e);
}
console.log(JSON.stringify({
  firstDone: first.done,
  firstValue: first.value,
  threw,
  message,
}));
`;
        const runResult = await runAPIDriver(runtime, runDriver);
        expect(runResult.exitCode).toBe(0);
        const runParsed = JSON.parse(runResult.stdout);
        expect(runParsed.firstDone).toBe(false);
        expect(runParsed.firstValue).toHaveProperty("goto", "");
        expect(runParsed.threw).toBe(true);
        expect(runParsed.message).toMatch(/goto|target/i);

        // runPromise() rejects with the same invalid-target error because the
        // transition past the first iteration fails.
        const promiseDriver = `
import { runPromise } from "loopx";
let threw = false;
let message = "";
try {
  await runPromise("test", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
} catch (e) {
  threw = true;
  message = (e && e.message) ? e.message : String(e);
}
console.log(JSON.stringify({ threw, message }));
`;
        const promiseResult = await runAPIDriver(runtime, promiseDriver);
        expect(promiseResult.exitCode).toBe(0);
        const promiseParsed = JSON.parse(promiseResult.stdout);
        expect(promiseParsed.threw).toBe(true);
        expect(promiseParsed.message).toMatch(/goto|target/i);
      });

      it('T-PARSE-21: {"stop":"true"} (string) discarded, Output is {}', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"stop":"true"}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output).not.toHaveProperty("result");
        expect(output).not.toHaveProperty("goto");
        expect(output).not.toHaveProperty("stop");
        expect(Object.keys(output)).toHaveLength(0);
      });

      it('T-PARSE-22: {"stop":1} (number) discarded, Output is {}', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"stop":1}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output).not.toHaveProperty("result");
        expect(output).not.toHaveProperty("goto");
        expect(output).not.toHaveProperty("stop");
        expect(Object.keys(output)).toHaveLength(0);
      });

      it('T-PARSE-23: {"stop":false} not treated as stop, Output is {}', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"stop":false}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output).not.toHaveProperty("result");
        expect(output).not.toHaveProperty("goto");
        expect(output).not.toHaveProperty("stop");
        expect(Object.keys(output)).toHaveLength(0);
      });

      it('T-PARSE-24: {"stop":"false"} (string) discarded, Output is {}', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"stop":"false"}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output).not.toHaveProperty("result");
        expect(output).not.toHaveProperty("goto");
        expect(output).not.toHaveProperty("stop");
        expect(Object.keys(output)).toHaveLength(0);
      });
    });

    // -------------------------------------------------------------------------
    // Mixed Valid / Invalid Fields
    // -------------------------------------------------------------------------
    describe("Mixed Valid/Invalid Fields", () => {
      it('T-PARSE-28: {"result":"x","goto":42} keeps result, drops goto', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"result":"x","goto":42}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output.result).toBe("x");
        expect(output).not.toHaveProperty("goto");
        expect(output).not.toHaveProperty("stop");
      });

      it('T-PARSE-29: {"result":"x","stop":"true"} keeps result, drops stop', async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"result":"x","stop":"true"}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output.result).toBe("x");
        expect(output).not.toHaveProperty("goto");
        expect(output).not.toHaveProperty("stop");
      });
    });

    // -------------------------------------------------------------------------
    // Whitespace & Formatting
    // -------------------------------------------------------------------------
    describe("Whitespace & Formatting", () => {
      it("T-PARSE-25: JSON with trailing newline is parsed correctly", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `printf '{"result":"x"}\n'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output.result).toBe("x");
        expect(output).not.toHaveProperty("goto");
        expect(output).not.toHaveProperty("stop");
      });

      it("T-PARSE-26: pretty-printed JSON is parsed correctly", async () => {
        project = await createTempProject();
        // Write pretty JSON to a payload file and cat it — avoids shell quoting.
        const payloadPath = join(project.dir, "pretty.json");
        const prettyJson = JSON.stringify(
          { result: "pretty", goto: "next" },
          null,
          2,
        );
        await writeFile(payloadPath, prettyJson, "utf-8");
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `cat "${payloadPath}"`,
        );
        await createBashWorkflowScript(
          project,
          "test",
          "next",
          `printf '{"result":"arrived"}'`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output.result).toBe("pretty");
        expect(output.goto).toBe("next");
      });

      it("T-PARSE-27: JSON with leading whitespace is parsed correctly", async () => {
        project = await createTempProject();
        const payloadPath = join(project.dir, "leading-ws.json");
        await writeFile(payloadPath, '  \n  {"result":"ws"}', "utf-8");
        await createBashWorkflowScript(
          project,
          "test",
          "index",
          `cat "${payloadPath}"`,
        );

        const { outputs, exitCode } = await runParseTest(runtime, project);

        expect(exitCode).toBe(0);
        expect(outputs).toHaveLength(1);
        const output = outputs[0] as Record<string, unknown>;
        expect(output.result).toBe("ws");
        expect(output).not.toHaveProperty("goto");
        expect(output).not.toHaveProperty("stop");
      });
    });
  });
});
