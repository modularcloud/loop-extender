import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createTempProject,
  createScript,
  createBashScript,
  createDirScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { withDelegationSetup, type DelegationFixture } from "../helpers/delegation.js";
import { isRuntimeAvailable } from "../helpers/runtime.js";
import { writeEnvToFile } from "../helpers/fixture-scripts.js";

/**
 * Read the loopx package version from its package.json.
 */
function getExpectedVersion(): string {
  const pkgPath = resolve(process.cwd(), "node_modules/loopx/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version as string;
}

/**
 * Helper: run the API driver with a script that calls runPromise and prints
 * the Output array as JSON.
 */
async function runOutputTest(
  project: TempProject,
  scriptName: string,
  opts: { maxIterations?: number; runtime?: "node" | "bun" } = {}
): Promise<{ outputs: unknown[]; exitCode: number; stderr: string }> {
  const { maxIterations = 1, runtime = "node" } = opts;
  const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("${scriptName}", { cwd: ${JSON.stringify(project.dir)}, maxIterations: ${maxIterations} });
console.log(JSON.stringify(outputs));
`;
  const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
  let outputs: unknown[] = [];
  try {
    outputs = JSON.parse(result.stdout);
  } catch {
    // If parsing fails, leave outputs empty -- the test will fail with a clear message
  }
  return { outputs, exitCode: result.exitCode, stderr: result.stderr };
}

/**
 * Helper: run the API driver with a script that calls run() (async generator)
 * and collects outputs into an array as JSON. Catches generator errors.
 */
async function runGeneratorTest(
  project: TempProject,
  scriptName: string,
  opts: { maxIterations?: number; runtime?: "node" | "bun" } = {}
): Promise<{
  outputs: unknown[];
  threwError: boolean;
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  const { maxIterations = 10, runtime = "node" } = opts;
  const driverCode = `
import { run } from "loopx";

const outputs = [];
let threwError = false;

try {
  for await (const output of run("${scriptName}", { cwd: ${JSON.stringify(project.dir)}, maxIterations: ${maxIterations} })) {
    outputs.push(output);
  }
} catch (e) {
  threwError = true;
}

console.log(JSON.stringify({ outputs, threwError }));
`;
  const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
  let parsed = { outputs: [] as unknown[], threwError: false };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // leave defaults
  }
  return {
    outputs: parsed.outputs,
    threwError: parsed.threwError,
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

// ---------------------------------------------------------------------------
// SPEC: import from "loopx" Resolution
// ---------------------------------------------------------------------------

describe("SPEC: import from \"loopx\" Resolution (T-MOD-01 through T-MOD-03a)", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  it("T-MOD-01: TS script with `import { output } from \"loopx\"` works under Node [Node]", async () => {
    project = await createTempProject();

    const tsContent = `import { output } from "loopx";
output({ result: "resolved" });
`;
    await createScript(project, "myscript", ".ts", tsContent);

    const { outputs, exitCode } = await runOutputTest(project, "myscript", {
      runtime: "node",
    });

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const output = outputs[0] as Record<string, unknown>;
    expect(output.result).toBe("resolved");
  });

  it.skipIf(!isRuntimeAvailable("bun"))(
    "T-MOD-02: TS script with `import { output } from \"loopx\"` works under Bun [Bun]",
    async () => {
      project = await createTempProject();

      const tsContent = `import { output } from "loopx";
output({ result: "resolved" });
`;
      await createScript(project, "myscript", ".ts", tsContent);

      const { outputs, exitCode } = await runOutputTest(project, "myscript", {
        runtime: "bun",
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      const output = outputs[0] as Record<string, unknown>;
      expect(output.result).toBe("resolved");
    },
  );

  it("T-MOD-03: JS script with `import { output } from \"loopx\"` works", async () => {
    project = await createTempProject();

    const jsContent = `import { output } from "loopx";
output({ result: "resolved" });
`;
    await createScript(project, "myscript", ".js", jsContent);

    const { outputs, exitCode } = await runOutputTest(project, "myscript");

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const output = outputs[0] as Record<string, unknown>;
    expect(output.result).toBe("resolved");
  });

  it("T-MOD-03a: Dir script with own node_modules/loopx resolves local package (shadow)", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "shadow-marker.txt");

    // Create a directory script with its own node_modules/loopx that shadows
    // the real loopx package. The shadow package's output() function writes
    // a distinctive marker file before writing JSON to stdout.
    await createDirScript(project, "shadow-test", "index.ts", {
      "index.ts": `import { output } from "loopx";
output({ result: "shadow-resolved" });
`,
      "node_modules/loopx/package.json": JSON.stringify({
        name: "loopx",
        version: "0.0.0-shadow",
        type: "module",
        main: "index.js",
        exports: {
          ".": "./index.js",
        },
      }),
      "node_modules/loopx/index.js": `
import { writeFileSync } from "node:fs";

export function output(data) {
  // Write marker to prove the shadow package was resolved
  writeFileSync(${JSON.stringify(markerPath)}, "shadow-was-used");
  // Emit structured output to stdout like real loopx would
  const json = JSON.stringify(typeof data === "object" && data !== null ? data : { result: String(data) });
  process.stdout.write(json);
  process.exit(0);
}

export async function input() {
  return "";
}
`,
    });

    const result = await runCLI(["run", "-n", "1", "shadow-test"], { cwd: project.dir });

    // The shadow package's marker file must exist, proving local resolution
    expect(existsSync(markerPath)).toBe(true);
    const markerContent = readFileSync(markerPath, "utf-8");
    expect(markerContent).toBe("shadow-was-used");
  });
});

// ---------------------------------------------------------------------------
// SPEC: output() Function
// ---------------------------------------------------------------------------

describe("SPEC: output() Function (T-MOD-04 through T-MOD-14a)", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  it("T-MOD-04: output({ result: \"hello\" }) yields result: \"hello\"", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";\noutput({ result: "hello" });\n`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript");

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const output = outputs[0] as Record<string, unknown>;
    expect(output.result).toBe("hello");
  });

  it("T-MOD-05: output({ result: \"x\", goto: \"y\" }) yields both fields, transitions", async () => {
    project = await createTempProject();

    // Script A outputs result and goto
    await createScript(
      project,
      "A",
      ".ts",
      `import { output } from "loopx";\noutput({ result: "x", goto: "y" });\n`,
    );

    // Script y records that it ran
    const markerPath = join(project.dir, "y-ran.txt");
    await createBashScript(
      project,
      "y",
      `printf 'y-executed' > "${markerPath}"\nprintf '{"result":"from-y"}'`,
    );

    const { outputs, threwError } = await runGeneratorTest(
      project,
      "A",
      { maxIterations: 2 },
    );

    expect(threwError).toBe(false);
    expect(outputs).toHaveLength(2);

    const firstOutput = outputs[0] as Record<string, unknown>;
    expect(firstOutput.result).toBe("x");
    expect(firstOutput.goto).toBe("y");

    // Verify transition happened -- script y ran
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("y-executed");
  });

  it("T-MOD-06: output({ stop: true }) stops the loop", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";\noutput({ stop: true });\n`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript", {
      maxIterations: 5,
    });

    expect(exitCode).toBe(0);
    // Loop should complete after one iteration due to stop: true
    expect(outputs).toHaveLength(1);
    const output = outputs[0] as Record<string, unknown>;
    expect(output.stop).toBe(true);
  });

  it("T-MOD-07: output({}) crashes (no known fields)", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";\noutput({});\n`,
    );

    const { threwError } = await runGeneratorTest(project, "myscript");

    // The script should crash, causing the generator to throw
    expect(threwError).toBe(true);
  });

  it("T-MOD-08: output(null) crashes", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";\noutput(null as any);\n`,
    );

    const { threwError } = await runGeneratorTest(project, "myscript");

    expect(threwError).toBe(true);
  });

  it("T-MOD-09: output(undefined) crashes", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";\noutput(undefined as any);\n`,
    );

    const { threwError } = await runGeneratorTest(project, "myscript");

    expect(threwError).toBe(true);
  });

  it("T-MOD-10: output(\"string\") yields result: \"string\"", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";\noutput("string" as any);\n`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript");

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const output = outputs[0] as Record<string, unknown>;
    expect(output.result).toBe("string");
  });

  it("T-MOD-11: output(42) yields result: \"42\"", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";\noutput(42 as any);\n`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript");

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const output = outputs[0] as Record<string, unknown>;
    expect(output.result).toBe("42");
  });

  it("T-MOD-12: output(true) yields result: \"true\"", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";\noutput(true as any);\n`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript");

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const output = outputs[0] as Record<string, unknown>;
    expect(output.result).toBe("true");
  });

  it("T-MOD-13: output({ result: \"x\", goto: undefined }) yields result: \"x\", no goto", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";\noutput({ result: "x", goto: undefined });\n`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript");

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const output = outputs[0] as Record<string, unknown>;
    expect(output.result).toBe("x");
    expect(output).not.toHaveProperty("goto");
  });

  it("T-MOD-13a: output([1,2,3]) crashes (array, no known fields)", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";\noutput([1, 2, 3] as any);\n`,
    );

    const { threwError } = await runGeneratorTest(project, "myscript");

    expect(threwError).toBe(true);
  });

  it("T-MOD-13b: output({ result: undefined, goto: undefined, stop: undefined }) crashes", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";\noutput({ result: undefined, goto: undefined, stop: undefined });\n`,
    );

    const { threwError } = await runGeneratorTest(project, "myscript");

    // All known fields are undefined, equivalent to output({}) -- crashes
    expect(threwError).toBe(true);
  });

  it("T-MOD-13c: output({ foo: \"bar\" }) crashes (no known fields)", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";\noutput({ foo: "bar" } as any);\n`,
    );

    const { threwError } = await runGeneratorTest(project, "myscript");

    // Object has no known fields (result, goto, stop) -- crashes
    expect(threwError).toBe(true);
  });

  it("T-MOD-13d: output({ stop: false }) accepted, parsed as {} by loop engine, continues", async () => {
    project = await createTempProject();

    const counterFile = join(project.dir, "counter.txt");

    // First iteration: output stop: false (accepted, but loop engine discards it)
    // Second iteration: produces a result to prove the loop continued
    await createScript(
      project,
      "myscript",
      ".ts",
      `import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { output } from "loopx";

// Append to counter
const prev = existsSync(${JSON.stringify(counterFile)}) ? readFileSync(${JSON.stringify(counterFile)}, "utf-8") : "";
const count = prev.length + 1;
writeFileSync(${JSON.stringify(counterFile)}, prev + "1");

if (count === 1) {
  output({ stop: false });
} else {
  output({ result: "continued", stop: true });
}
`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript", {
      maxIterations: 2,
    });

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(2);

    // First output: stop: false is discarded by loop engine, yielding {}
    const first = outputs[0] as Record<string, unknown>;
    expect(first).not.toHaveProperty("stop");
    expect(first).not.toHaveProperty("result");
    expect(first).not.toHaveProperty("goto");

    // Second output: the loop continued (not halted by stop: false)
    const second = outputs[1] as Record<string, unknown>;
    expect(second.result).toBe("continued");
  });

  it("T-MOD-13e: output({ goto: 42 }) accepted, parsed as {} by loop engine, resets", async () => {
    project = await createTempProject();

    const counterFile = join(project.dir, "counter-13e.txt");

    // First iteration: output goto: 42 (accepted, but loop engine discards non-string goto)
    // Second iteration: produces a result to prove the loop reset (not transitioned)
    await createScript(
      project,
      "myscript",
      ".ts",
      `import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { output } from "loopx";

const prev = existsSync(${JSON.stringify(counterFile)}) ? readFileSync(${JSON.stringify(counterFile)}, "utf-8") : "";
const count = prev.length + 1;
writeFileSync(${JSON.stringify(counterFile)}, prev + "1");

if (count === 1) {
  output({ goto: 42 } as any);
} else {
  output({ result: "reset-ok", stop: true });
}
`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript", {
      maxIterations: 2,
    });

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(2);

    // First output: goto: 42 is discarded, yielding {}
    const first = outputs[0] as Record<string, unknown>;
    expect(first).not.toHaveProperty("goto");
    expect(Object.keys(first)).toHaveLength(0);

    // Second output: loop reset to starting target (same script), proving no transition
    const second = outputs[1] as Record<string, unknown>;
    expect(second.result).toBe("reset-ok");
  });

  it("T-MOD-13f: output({ result: null }) accepted, result: \"null\"", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";\noutput({ result: null } as any);\n`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript");

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const output = outputs[0] as Record<string, unknown>;
    expect(output.result).toBe("null");
  });

  it("T-MOD-13g: output({ goto: null }) accepted, parsed as {}, resets", async () => {
    project = await createTempProject();

    const counterFile = join(project.dir, "counter-13g.txt");

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { output } from "loopx";

const prev = existsSync(${JSON.stringify(counterFile)}) ? readFileSync(${JSON.stringify(counterFile)}, "utf-8") : "";
const count = prev.length + 1;
writeFileSync(${JSON.stringify(counterFile)}, prev + "1");

if (count === 1) {
  output({ goto: null } as any);
} else {
  output({ result: "reset-ok", stop: true });
}
`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript", {
      maxIterations: 2,
    });

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(2);

    // First output: goto: null is discarded, yielding {}
    const first = outputs[0] as Record<string, unknown>;
    expect(first).not.toHaveProperty("goto");
    expect(Object.keys(first)).toHaveLength(0);

    // Second output: loop reset to starting target
    const second = outputs[1] as Record<string, unknown>;
    expect(second.result).toBe("reset-ok");
  });

  it("T-MOD-14: Code after output() does not execute (marker file not written)", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "after-output-marker.txt");

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";
import { writeFileSync } from "node:fs";

output({ result: "a" });
// This line should NOT execute -- output() terminates the process
writeFileSync(${JSON.stringify(markerPath)}, "ran");
`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript");

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const output = outputs[0] as Record<string, unknown>;
    expect(output.result).toBe("a");

    // The marker file must NOT exist -- code after output() must not run
    expect(existsSync(markerPath)).toBe(false);
  });

  it("T-MOD-14a: Large payload (1MB) flushes correctly", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { output } from "loopx";
output({ result: "x".repeat(1_000_000) });
`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript");

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const output = outputs[0] as Record<string, unknown>;
    expect(typeof output.result).toBe("string");
    expect((output.result as string).length).toBe(1_000_000);
    // Verify it's all "x"
    expect(output.result).toBe("x".repeat(1_000_000));
  });
});

// ---------------------------------------------------------------------------
// SPEC: input() Function
// ---------------------------------------------------------------------------

describe("SPEC: input() Function (T-MOD-15 through T-MOD-18)", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  it("T-MOD-15: input() returns \"\" on first iteration", async () => {
    project = await createTempProject();

    await createScript(
      project,
      "myscript",
      ".ts",
      `import { input, output } from "loopx";
const data = await input();
output({ result: data });
`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript");

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const output = outputs[0] as Record<string, unknown>;
    expect(output.result).toBe("");
  });

  it("T-MOD-16: A outputs result+goto:B, B calls input() and gets payload", async () => {
    project = await createTempProject();

    // Script A: outputs result and transitions to B
    await createScript(
      project,
      "A",
      ".ts",
      `import { output } from "loopx";
output({ result: "payload", goto: "B" });
`,
    );

    // Script B: reads input and outputs it as result
    await createScript(
      project,
      "B",
      ".ts",
      `import { input, output } from "loopx";
const data = await input();
output({ result: data });
`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "A", {
      maxIterations: 2,
    });

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(2);

    // B's output should have result equal to "payload" (received via input())
    const bOutput = outputs[1] as Record<string, unknown>;
    expect(bOutput.result).toBe("payload");
  });

  it("T-MOD-17: input() called twice returns same value (cached)", async () => {
    project = await createTempProject();

    // Script A: outputs result and transitions to B
    await createScript(
      project,
      "A",
      ".ts",
      `import { output } from "loopx";
output({ result: "cached-value", goto: "B" });
`,
    );

    // Script B: calls input() twice and verifies both return the same value
    await createScript(
      project,
      "B",
      ".ts",
      `import { input, output } from "loopx";
const first = await input();
const second = await input();
output({ result: first === second ? "same" : "different" });
`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "A", {
      maxIterations: 2,
    });

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(2);

    const bOutput = outputs[1] as Record<string, unknown>;
    expect(bOutput.result).toBe("same");
  });

  it("T-MOD-18: input() returns a Promise", async () => {
    project = await createTempProject();

    // Script that verifies input() returns a thenable (Promise)
    await createScript(
      project,
      "myscript",
      ".ts",
      `import { input, output } from "loopx";
const result = input();
const isPromise = result instanceof Promise || (typeof result === "object" && result !== null && typeof (result as any).then === "function");
output({ result: isPromise ? "is-promise" : "not-promise" });
`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "myscript");

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const output = outputs[0] as Record<string, unknown>;
    expect(output.result).toBe("is-promise");
  });
});

// ---------------------------------------------------------------------------
// SPEC: ESM-Only Package Contract
// ---------------------------------------------------------------------------

describe("SPEC: ESM-Only (T-MOD-22)", () => {
  it("T-MOD-22: require(\"loopx\") fails [Node]", async () => {
    // Use runAPIDriver but with a CJS consumer that tries to require("loopx").
    // The api-driver creates a temporary consumer with type: "module", so we
    // need a different approach: create a CJS file manually.
    // We can still use runAPIDriver's infrastructure by writing a script that
    // spawns a CJS child process.
    const driverCode = `
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Create a CJS consumer directory
const consumerDir = mkdtempSync(join(tmpdir(), "loopx-cjs-test-"));

// No "type": "module" -- defaults to CJS
writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "cjs-consumer" }));

// Create node_modules/loopx symlink
const nmDir = join(consumerDir, "node_modules");
mkdirSync(nmDir, { recursive: true });
const loopxPkg = join(process.cwd(), "node_modules", "loopx");
try {
  symlinkSync(loopxPkg, join(nmDir, "loopx"), "dir");
} catch {}

// Write a CJS script that requires loopx
writeFileSync(join(consumerDir, "test.cjs"), 'const loopx = require("loopx"); console.log(loopx);');

// Run it and capture result.
// Use --no-experimental-require-module to disable Node 22.12+'s CJS-can-load-ESM
// feature, so we can verify the package.json "type":"module" contract is correct.
try {
  execSync(\`node --no-experimental-require-module "\${join(consumerDir, "test.cjs")}"\`, { stdio: "pipe" });
  console.log(JSON.stringify({ succeeded: true }));
} catch (e) {
  const stderr = (e as any).stderr?.toString() ?? "";
  console.log(JSON.stringify({ succeeded: false, stderr }));
}
`;

    const result = await runAPIDriver("node", driverCode);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    // The require() call should have failed
    expect(parsed.succeeded).toBe(false);
    // Error should indicate ESM-only
    expect(parsed.stderr).toMatch(/ERR_REQUIRE_ESM|must use import|ES module/i);
  });
});

// ---------------------------------------------------------------------------
// SPEC: LOOPX_BIN in Bash Scripts
// ---------------------------------------------------------------------------

describe("SPEC: LOOPX_BIN in Bash Scripts (T-MOD-19 through T-MOD-21)", () => {
  // These tests use withDelegationSetup (not runCLI) per TEST-SPEC §4.8,
  // because runCLI's `node /path/to/bin.js` invocation does not exercise
  // delegation or realpath resolution of LOOPX_BIN.
  let fixture: DelegationFixture | null = null;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = null;
    }
  });

  it("T-MOD-19: $LOOPX_BIN output produces structured output for goto chain", async () => {
    fixture = await withDelegationSetup();
    const proj: TempProject = {
      dir: fixture.projectDir,
      loopxDir: join(fixture.projectDir, ".loopx"),
      cleanup: async () => {},
    };
    const markerPath = join(fixture.projectDir, "reader-marker.txt");

    // Remove placeholder local binary so $LOOPX_BIN subcommands don't
    // try to delegate to it (LOOPX_DELEGATED is not leaked to scripts).
    unlinkSync(fixture.localBinPath);

    // Script "sender" uses $LOOPX_BIN output to produce structured output
    // with result and goto to "reader"
    await createBashScript(
      proj,
      "sender",
      `$LOOPX_BIN output --result "payload" --goto "reader"`,
    );

    // Script "reader" reads stdin and writes the received value to marker
    await createBashScript(
      proj,
      "reader",
      `INPUT=$(cat)\nprintf '%s' "$INPUT" > "${markerPath}"\nprintf '{"stop":true}'`,
    );

    // Skip delegation (the placeholder local binary is removed above).
    // These tests exercise LOOPX_BIN functionality, not delegation.
    const result = await fixture.runGlobal(["run", "-n", "2", "sender"], {
      env: { LOOPX_DELEGATED: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(markerPath)).toBe(true);
    const markerContent = readFileSync(markerPath, "utf-8");
    expect(markerContent).toBe("payload");
  });

  it("T-MOD-20: $LOOPX_BIN is valid executable path", async () => {
    fixture = await withDelegationSetup();
    const proj: TempProject = {
      dir: fixture.projectDir,
      loopxDir: join(fixture.projectDir, ".loopx"),
      cleanup: async () => {},
    };
    const markerPath = join(fixture.projectDir, "loopx-bin-path.txt");

    // Script writes $LOOPX_BIN to a marker file
    await createScript(
      proj,
      "myscript",
      ".sh",
      writeEnvToFile("LOOPX_BIN", markerPath),
    );

    await fixture.runGlobal(["run", "-n", "1", "myscript"], {
      env: { LOOPX_DELEGATED: "1" },
    });

    expect(existsSync(markerPath)).toBe(true);
    const binPath = readFileSync(markerPath, "utf-8").trim();
    expect(binPath.length).toBeGreaterThan(0);

    // The path should point to an existing, executable file
    expect(existsSync(binPath)).toBe(true);
    const stats = statSync(binPath);
    // Check execute permission (at least one execute bit set)
    expect(stats.mode & 0o111).not.toBe(0);
  });

  it("T-MOD-21: $LOOPX_BIN version matches package.json version", async () => {
    fixture = await withDelegationSetup();
    const proj: TempProject = {
      dir: fixture.projectDir,
      loopxDir: join(fixture.projectDir, ".loopx"),
      cleanup: async () => {},
    };
    const markerPath = join(fixture.projectDir, "loopx-version.txt");

    // Remove placeholder local binary so $LOOPX_BIN subcommands don't
    // try to delegate to it (LOOPX_DELEGATED is not leaked to scripts).
    unlinkSync(fixture.localBinPath);

    // Script runs $LOOPX_BIN version and writes stdout to marker
    await createBashScript(
      proj,
      "myscript",
      `$LOOPX_BIN version > "${markerPath}"`,
    );

    await fixture.runGlobal(["run", "-n", "1", "myscript"], {
      env: { LOOPX_DELEGATED: "1" },
    });

    expect(existsSync(markerPath)).toBe(true);
    const versionOutput = readFileSync(markerPath, "utf-8").trim();

    const expectedVersion = getExpectedVersion();
    expect(versionOutput).toBe(expectedVersion);
  });
});
