import { describe, it, expect, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTempProject,
  createBashScript,
  runAPIDriver,
  type TempProject,
} from "../helpers/index.js";

/**
 * Helper: run the API driver with a script that calls runPromise and prints
 * the Output array as JSON.
 */
async function runParseTest(
  project: TempProject,
  scriptName: string
): Promise<{ outputs: unknown[]; exitCode: number; stderr: string }> {
  const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("${scriptName}", { cwd: "${project.dir}", maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
  const result = await runAPIDriver("node", driverCode, { cwd: project.dir });
  let outputs: unknown[] = [];
  try {
    outputs = JSON.parse(result.stdout);
  } catch {
    // If parsing fails, leave outputs empty — the test will fail with a clear message
  }
  return { outputs, exitCode: result.exitCode, stderr: result.stderr };
}

describe("SPEC: Structured Output Parsing (T-PARSE-01 through T-PARSE-29)", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  // ---------------------------------------------------------------------------
  // Valid Structured Output
  // ---------------------------------------------------------------------------

  describe("SPEC: Valid Structured Output", () => {
    it("T-PARSE-01: {\"result\":\"hello\"} yields Output with result: \"hello\"", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '{"result":"hello"}'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("hello");
      expect(output).not.toHaveProperty("goto");
      expect(output).not.toHaveProperty("stop");
    });

    it("T-PARSE-02: {\"goto\":\"next\"} transitions to script \"next\"", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '{"goto":"next"}'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.goto).toBe("next");
    });

    it("T-PARSE-03: {\"stop\":true} halts the loop, exit code 0", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '{"stop":true}'`);

      // Use maxIterations > 1 so the loop *could* continue if stop didn't halt it
      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("myscript", { cwd: "${project.dir}", maxIterations: 5 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.stop).toBe(true);
    });

    it("T-PARSE-04: {\"result\":\"x\",\"goto\":\"next\",\"stop\":true} stop takes priority, exit code 0", async () => {
      project = await createTempProject();
      await createBashScript(
        project,
        "myscript",
        `printf '{"result":"x","goto":"next","stop":true}'`
      );

      // Use maxIterations > 1 so the loop *could* follow goto if stop didn't halt it
      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("myscript", { cwd: "${project.dir}", maxIterations: 5 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.stop).toBe(true);
      // result and goto may be present in the Output object, but stop takes
      // priority for control flow — the loop halts.
    });

    it("T-PARSE-05: {\"result\":\"x\",\"extra\":\"ignored\"} extra field not in Output", async () => {
      project = await createTempProject();
      await createBashScript(
        project,
        "myscript",
        `printf '{"result":"x","extra":"ignored"}'`
      );

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("x");
      expect(output).not.toHaveProperty("extra");
      expect(output).not.toHaveProperty("goto");
      expect(output).not.toHaveProperty("stop");
    });
  });

  // ---------------------------------------------------------------------------
  // Fallback to Raw Result
  // ---------------------------------------------------------------------------

  describe("SPEC: Fallback to Raw Result", () => {
    it("T-PARSE-06: {\"unknown\":\"field\"} falls back to raw result string", async () => {
      project = await createTempProject();
      await createBashScript(
        project,
        "myscript",
        `printf '{"unknown":"field"}'`
      );

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe('{"unknown":"field"}');
    });

    it("T-PARSE-07: [1,2,3] (JSON array) falls back to raw result", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '[1,2,3]'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("[1,2,3]");
    });

    it('T-PARSE-08: "hello" (JSON string) falls back to raw result including quotes', async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '"hello"'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe('"hello"');
    });

    it("T-PARSE-09: 42 (JSON number) falls back to raw result", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '42'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("42");
    });

    it("T-PARSE-10: true (JSON boolean) falls back to raw result", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf 'true'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("true");
    });

    it("T-PARSE-11: null (JSON null) falls back to raw result", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf 'null'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("null");
    });

    it("T-PARSE-12: non-JSON text falls back to raw result", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf 'not json at all'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("not json at all");
    });

    it("T-PARSE-12a: raw fallback preserves trailing newline", async () => {
      project = await createTempProject();
      // Use printf with explicit \n to produce "hello\n"
      await createBashScript(project, "myscript", `printf 'hello\n'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("hello\n");
    });

    it("T-PARSE-13: empty stdout yields result: \"\"", async () => {
      project = await createTempProject();
      // Script produces no output at all
      await createBashScript(project, "myscript", `true`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // Type Coercion
  // ---------------------------------------------------------------------------

  describe("SPEC: Type Coercion", () => {
    it("T-PARSE-14: {\"result\":42} coerces result to string \"42\"", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '{"result":42}'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("42");
    });

    it("T-PARSE-15: {\"result\":true} coerces result to string \"true\"", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '{"result":true}'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("true");
    });

    it("T-PARSE-16: {\"result\":{\"nested\":\"obj\"}} coerces to \"[object Object]\"", async () => {
      project = await createTempProject();
      await createBashScript(
        project,
        "myscript",
        `printf '{"result":{"nested":"obj"}}'`
      );

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("[object Object]");
    });

    it("T-PARSE-17: {\"result\":null} coerces result to string \"null\"", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '{"result":null}'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("null");
    });

    it("T-PARSE-18: {\"goto\":42} invalid goto discarded, Output is {}", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '{"goto":42}'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output).not.toHaveProperty("result");
      expect(output).not.toHaveProperty("goto");
      expect(output).not.toHaveProperty("stop");
      expect(Object.keys(output)).toHaveLength(0);
    });

    it("T-PARSE-19: {\"goto\":true} invalid goto discarded, Output is {}", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '{"goto":true}'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output).not.toHaveProperty("result");
      expect(output).not.toHaveProperty("goto");
      expect(output).not.toHaveProperty("stop");
      expect(Object.keys(output)).toHaveLength(0);
    });

    it("T-PARSE-20: {\"goto\":null} invalid goto discarded, Output is {}", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '{"goto":null}'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output).not.toHaveProperty("result");
      expect(output).not.toHaveProperty("goto");
      expect(output).not.toHaveProperty("stop");
      expect(Object.keys(output)).toHaveLength(0);
    });

    it('T-PARSE-20a: {"goto":""} empty string goto preserved, not discarded → error via run() generator', async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '{"goto":""}'`);

      // Use the run() generator API: iterate with for-await, expect an error
      // on the second iteration when the empty goto is processed.
      const driverCode = `
import { run } from "loopx";
let iterationCount = 0;
let threw = false;
let errorMessage = "";
try {
  for await (const output of run("myscript", { cwd: "${project.dir}", maxIterations: 2 })) {
    iterationCount++;
  }
} catch (e) {
  threw = true;
  errorMessage = e.message;
}
console.log(JSON.stringify({ threw, iterationCount, message: errorMessage }));
`;
      const result = await runAPIDriver("node", driverCode, { cwd: project.dir });
      const parsed = JSON.parse(result.stdout);
      // Empty string goto IS a string, so parser preserves it (unlike null/true/42)
      // The generator should throw on the second iteration because "" is not a valid script name
      expect(parsed.threw).toBe(true);
      expect(parsed.message).toMatch(/goto/i);
    });

    it("T-PARSE-21: {\"stop\":\"true\"} string not boolean, Output is {}", async () => {
      project = await createTempProject();
      await createBashScript(
        project,
        "myscript",
        `printf '{"stop":"true"}'`
      );

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output).not.toHaveProperty("result");
      expect(output).not.toHaveProperty("goto");
      expect(output).not.toHaveProperty("stop");
      expect(Object.keys(output)).toHaveLength(0);
    });

    it("T-PARSE-22: {\"stop\":1} number not boolean, Output is {}", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '{"stop":1}'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output).not.toHaveProperty("result");
      expect(output).not.toHaveProperty("goto");
      expect(output).not.toHaveProperty("stop");
      expect(Object.keys(output)).toHaveLength(0);
    });

    it("T-PARSE-23: {\"stop\":false} false not treated as stop, Output is {}", async () => {
      project = await createTempProject();
      await createBashScript(project, "myscript", `printf '{"stop":false}'`);

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output).not.toHaveProperty("result");
      expect(output).not.toHaveProperty("goto");
      expect(output).not.toHaveProperty("stop");
      expect(Object.keys(output)).toHaveLength(0);
    });

    it("T-PARSE-24: {\"stop\":\"false\"} string not boolean, Output is {}", async () => {
      project = await createTempProject();
      await createBashScript(
        project,
        "myscript",
        `printf '{"stop":"false"}'`
      );

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output).not.toHaveProperty("result");
      expect(output).not.toHaveProperty("goto");
      expect(output).not.toHaveProperty("stop");
      expect(Object.keys(output)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Mixed Valid/Invalid Fields
  // ---------------------------------------------------------------------------

  describe("SPEC: Mixed Valid/Invalid Fields", () => {
    it("T-PARSE-28: {\"result\":\"x\",\"goto\":42} valid result preserved, invalid goto discarded", async () => {
      project = await createTempProject();
      await createBashScript(
        project,
        "myscript",
        `printf '{"result":"x","goto":42}'`
      );

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("x");
      expect(output).not.toHaveProperty("goto");
      expect(output).not.toHaveProperty("stop");
    });

    it("T-PARSE-29: {\"result\":\"x\",\"stop\":\"true\"} valid result preserved, invalid stop discarded", async () => {
      project = await createTempProject();
      await createBashScript(
        project,
        "myscript",
        `printf '{"result":"x","stop":"true"}'`
      );

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("x");
      expect(output).not.toHaveProperty("goto");
      expect(output).not.toHaveProperty("stop");
    });
  });

  // ---------------------------------------------------------------------------
  // Whitespace & Formatting
  // ---------------------------------------------------------------------------

  describe("SPEC: Whitespace & Formatting", () => {
    it("T-PARSE-25: JSON with trailing newline is parsed correctly", async () => {
      project = await createTempProject();
      // printf with explicit \n after JSON
      await createBashScript(
        project,
        "myscript",
        `printf '{"result":"x"}\n'`
      );

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("x");
      expect(output).not.toHaveProperty("goto");
      expect(output).not.toHaveProperty("stop");
    });

    it("T-PARSE-26: pretty-printed JSON is parsed correctly", async () => {
      project = await createTempProject();
      // Write a payload file with pretty-printed JSON to avoid shell quoting issues
      const payloadPath = join(project.dir, "pretty.json");
      const prettyJson = JSON.stringify({ result: "pretty", goto: "next" }, null, 2);
      await writeFile(payloadPath, prettyJson, "utf-8");
      await createBashScript(
        project,
        "myscript",
        `cat "${payloadPath}"`
      );

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("pretty");
      expect(output.goto).toBe("next");
    });

    it("T-PARSE-27: JSON with leading whitespace is parsed correctly", async () => {
      project = await createTempProject();
      // Write payload with leading whitespace to a file
      const payloadPath = join(project.dir, "leading-ws.json");
      await writeFile(payloadPath, '  \n  {"result":"ws"}', "utf-8");
      await createBashScript(
        project,
        "myscript",
        `cat "${payloadPath}"`
      );

      const { outputs } = await runParseTest(project, "myscript");

      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("ws");
      expect(output).not.toHaveProperty("goto");
      expect(output).not.toHaveProperty("stop");
    });
  });
});
