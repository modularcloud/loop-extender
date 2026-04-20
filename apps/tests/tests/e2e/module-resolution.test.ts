import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import {
  withDelegationSetup,
  type DelegationFixture,
} from "../helpers/delegation.js";
import { forEachRuntime, isRuntimeAvailable } from "../helpers/runtime.js";
import { writeEnvToFile } from "../helpers/fixture-scripts.js";

// ---------------------------------------------------------------------------
// TEST-SPEC §4.8 — Module Resolution & Script Helpers (ADR-0003 workflow model)
// Spec refs: 1, 3.3, 3.4, 6.4, 6.5
// ---------------------------------------------------------------------------

// ─────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────

function getExpectedVersion(): string {
  const pkgPath = resolve(process.cwd(), "node_modules/loopx/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version as string;
}

/**
 * Run a loopx target via the programmatic `runPromise` API and collect
 * the returned Output array. Drives under the requested runtime.
 */
async function runOutputTest(
  project: TempProject,
  target: string,
  opts: { maxIterations?: number; runtime?: "node" | "bun" } = {},
): Promise<{
  outputs: unknown[];
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  const { maxIterations = 1, runtime = "node" } = opts;
  const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise(${JSON.stringify(target)}, { cwd: ${JSON.stringify(
    project.dir,
  )}, maxIterations: ${maxIterations} });
console.log(JSON.stringify(outputs));
`;
  const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
  let outputs: unknown[] = [];
  try {
    outputs = JSON.parse(result.stdout);
  } catch {
    // parse failure is surfaced by the test via empty outputs
  }
  return {
    outputs,
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

/**
 * Run a loopx target via the async generator `run()` API and collect
 * the yielded Output values into an array. Captures generator errors.
 */
async function runGeneratorTest(
  project: TempProject,
  target: string,
  opts: { maxIterations?: number; runtime?: "node" | "bun" } = {},
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
  for await (const output of run(${JSON.stringify(target)}, { cwd: ${JSON.stringify(
    project.dir,
  )}, maxIterations: ${maxIterations} })) {
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
    // leave defaults; test will fail with a clear message
  }
  return {
    outputs: parsed.outputs,
    threwError: parsed.threwError,
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

// ═════════════════════════════════════════════════════════════
// §4.8.1 — import from "loopx" Resolution
// ═════════════════════════════════════════════════════════════

describe("SPEC: import from \"loopx\" Resolution", () => {
  let project: TempProject | null = null;
  let fixture: DelegationFixture | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
    if (fixture) {
      await fixture.cleanup().catch(() => {});
      fixture = null;
    }
  });

  // T-MOD-01 [Node]: TS script with import { output } from "loopx" runs under Node.
  it("T-MOD-01: TS script with `import { output } from \"loopx\"` works under Node [Node]", async () => {
    project = await createTempProject();
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { output } from "loopx";\noutput({ result: "resolved" });\n`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "ralph", {
      runtime: "node",
    });

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const out = outputs[0] as Record<string, unknown>;
    expect(out.result).toBe("resolved");
  });

  // T-MOD-02 [Bun]: same fixture under Bun.
  it.skipIf(!isRuntimeAvailable("bun"))(
    "T-MOD-02: TS script with `import { output } from \"loopx\"` works under Bun [Bun]",
    async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ result: "resolved" });\n`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        runtime: "bun",
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      const out = outputs[0] as Record<string, unknown>;
      expect(out.result).toBe("resolved");
    },
  );

  // T-MOD-03: JS script import resolution — either runtime.
  forEachRuntime((runtime) => {
    it("T-MOD-03: JS script with `import { output } from \"loopx\"` works", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".js",
        `import { output } from "loopx";\noutput({ result: "resolved" });\n`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        runtime,
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      const out = outputs[0] as Record<string, unknown>;
      expect(out.result).toBe("resolved");
    });

    // T-MOD-03a: workflow-local node_modules/loopx shadows the CLI-provided loopx.
    // Spec says the local package's sentinel must be what the script observes,
    // and NO warning about shadowed resolution is emitted per Spec 3.3.
    it("T-MOD-03a: workflow-local node_modules/loopx shadows CLI package", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "shadow-marker.txt");

      // Create the workflow and its nested node_modules/loopx.
      const workflowDir = await createWorkflow(project, "ralph");
      const localLoopxDir = join(workflowDir, "node_modules", "loopx");
      await mkdir(localLoopxDir, { recursive: true });
      await writeFile(
        join(localLoopxDir, "package.json"),
        JSON.stringify({
          name: "loopx",
          version: "0.0.0-shadow",
          type: "module",
          main: "index.js",
          exports: { ".": "./index.js" },
        }),
        "utf-8",
      );
      await writeFile(
        join(localLoopxDir, "index.js"),
        `import { writeFileSync } from "node:fs";

export const __loopxSentinel = "workflow-local-sentinel";

export function output(data) {
  writeFileSync(${JSON.stringify(markerPath)}, __loopxSentinel);
  const json = JSON.stringify(typeof data === "object" && data !== null ? data : { result: String(data) });
  process.stdout.write(json);
  process.exit(0);
}

export async function input() { return ""; }
`,
        "utf-8",
      );

      // Workflow script imports from "loopx" and invokes output().
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ result: "from-script" });\n`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      // The shadow package's output() must have fired.
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf-8")).toBe("workflow-local-sentinel");

      // No warning about workflow-local loopx resolution on stderr.
      expect(result.stderr).not.toMatch(/shadow|workflow-local.*loopx|shadowed/i);
    });

    // T-MOD-03b: full precedence chain — project-root delegation is active AND
    // the workflow has its own node_modules/loopx. The workflow-local package wins.
    it("T-MOD-03b: delegation active + workflow-local node_modules/loopx — workflow-local wins", async () => {
      const baseDir = await mkdtemp(join(tmpdir(), "loopx-mod03b-"));
      const projectDir = join(baseDir, "project");
      await mkdir(join(projectDir, ".loopx", "ralph"), { recursive: true });

      try {
        // Project-root package.json declaring loopx as a dependency.
        await writeFile(
          join(projectDir, "package.json"),
          JSON.stringify({ name: "test-project", dependencies: { loopx: "*" } }),
          "utf-8",
        );

        const markerPath = join(projectDir, "mod-03b-marker.txt");

        // Project-root node_modules/loopx — delegated-to package, wrong sentinel.
        const rootLoopxDir = join(projectDir, "node_modules", "loopx");
        await mkdir(rootLoopxDir, { recursive: true });
        await writeFile(
          join(rootLoopxDir, "package.json"),
          JSON.stringify({
            name: "loopx",
            version: "99.0.0-project-root",
            type: "module",
            main: "index.js",
            exports: { ".": "./index.js" },
          }),
          "utf-8",
        );
        await writeFile(
          join(rootLoopxDir, "index.js"),
          `import { writeFileSync } from "node:fs";

export const __loopxSentinel = "project-root-sentinel";

export function output(data) {
  writeFileSync(${JSON.stringify(markerPath)}, __loopxSentinel);
  process.stdout.write(JSON.stringify(data));
  process.exit(0);
}

export async function input() { return ""; }
`,
          "utf-8",
        );

        // Project-root node_modules/.bin/loopx — delegated-to CLI binary.
        // Points to the real loopx bin.js so the loop engine still runs.
        const pkgPath = resolve(process.cwd(), "node_modules/loopx/package.json");
        const realPkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const realBin =
          typeof realPkg.bin === "string" ? realPkg.bin : realPkg.bin?.loopx;
        const realBinPath = resolve(
          process.cwd(),
          "node_modules/loopx",
          realBin ?? "bin.js",
        );
        const localBinDir = join(projectDir, "node_modules", ".bin");
        await mkdir(localBinDir, { recursive: true });
        const localBinPath = join(localBinDir, "loopx");
        await writeFile(
          localBinPath,
          `#!/bin/bash\nexec node "${realBinPath}" "$@"\n`,
          "utf-8",
        );
        await chmod(localBinPath, 0o755);

        // Workflow-local node_modules/loopx — different sentinel, should win.
        const workflowLocalLoopx = join(
          projectDir,
          ".loopx",
          "ralph",
          "node_modules",
          "loopx",
        );
        await mkdir(workflowLocalLoopx, { recursive: true });
        await writeFile(
          join(workflowLocalLoopx, "package.json"),
          JSON.stringify({
            name: "loopx",
            version: "0.0.0-workflow-local",
            type: "module",
            main: "index.js",
            exports: { ".": "./index.js" },
          }),
          "utf-8",
        );
        await writeFile(
          join(workflowLocalLoopx, "index.js"),
          `import { writeFileSync } from "node:fs";

export const __loopxSentinel = "workflow-local-sentinel";

export function output(data) {
  writeFileSync(${JSON.stringify(markerPath)}, __loopxSentinel);
  process.stdout.write(JSON.stringify(data));
  process.exit(0);
}

export async function input() { return ""; }
`,
          "utf-8",
        );

        // The workflow script imports from "loopx" and calls output().
        await writeFile(
          join(projectDir, ".loopx", "ralph", "index.ts"),
          `import { output } from "loopx";\noutput({ result: "from-script" });\n`,
          "utf-8",
        );

        // Create a global binary wrapper that execs the real loopx.
        const globalBinDir = join(baseDir, "global", "bin");
        await mkdir(globalBinDir, { recursive: true });
        const globalBinPath = join(globalBinDir, "loopx");
        await writeFile(
          globalBinPath,
          `#!/bin/bash\nexec node "${realBinPath}" "$@"\n`,
          "utf-8",
        );
        await chmod(globalBinPath, 0o755);

        // Run the CLI directly (exercising the delegation path) in `runtime` parity:
        // the delegation fixture does not itself parameterize runtime, so we
        // launch node/bun via runCLI's resolution of the loopx bin.
        await runCLI(["run", "-n", "1", "ralph"], {
          cwd: projectDir,
          runtime,
        });

        expect(existsSync(markerPath)).toBe(true);
        expect(readFileSync(markerPath, "utf-8")).toBe(
          "workflow-local-sentinel",
        );
      } finally {
        await rm(baseDir, { recursive: true, force: true });
      }
    });
  });

  // T-MOD-03c [Node]: workflow package.json `type: "module"` enables ESM for
  // intra-workflow .js imports through Node's standard module resolution.
  it("T-MOD-03c: workflow package.json type:module enables ESM for intra-workflow .js imports [Node]", async () => {
    project = await createTempProject();

    await createWorkflowPackageJson(project, "ralph", { type: "module" });

    const workflowDir = join(project.loopxDir, "ralph");
    await mkdir(join(workflowDir, "lib"), { recursive: true });
    await writeFile(
      join(workflowDir, "lib", "helper.js"),
      `export const value = "esm-resolved";\n`,
      "utf-8",
    );

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { value } from "./lib/helper.js";
import { output } from "loopx";
output({ result: value });
`,
    );

    const { outputs, exitCode } = await runOutputTest(project, "ralph", {
      runtime: "node",
    });

    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    const out = outputs[0] as Record<string, unknown>;
    expect(out.result).toBe("esm-resolved");
  });
});

// ═════════════════════════════════════════════════════════════
// §4.8.2 — output() function
// ═════════════════════════════════════════════════════════════

describe("SPEC: output() function", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    it("T-MOD-04: output({ result: \"hello\" }) yields result: \"hello\"", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ result: "hello" });\n`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        runtime,
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      expect((outputs[0] as Record<string, unknown>).result).toBe("hello");
    });

    it("T-MOD-05: output({ result, goto }) yields both fields and loop transitions (intra-workflow)", async () => {
      project = await createTempProject();

      // ralph:index outputs result + bare goto "y" (intra-workflow target).
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ result: "x", goto: "y" });\n`,
      );

      const yMarkerPath = join(project.dir, "y-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "y",
        `printf 'y-executed' > "${yMarkerPath}"\nprintf '{"result":"from-y"}'`,
      );

      const { outputs, threwError } = await runGeneratorTest(project, "ralph", {
        maxIterations: 2,
        runtime,
      });

      expect(threwError).toBe(false);
      expect(outputs).toHaveLength(2);
      const first = outputs[0] as Record<string, unknown>;
      expect(first.result).toBe("x");
      expect(first.goto).toBe("y");

      expect(existsSync(yMarkerPath)).toBe(true);
      expect(readFileSync(yMarkerPath, "utf-8")).toBe("y-executed");
    });

    it("T-MOD-05a: JS/TS output() with cross-workflow qualified goto transitions correctly", async () => {
      project = await createTempProject();

      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ goto: "beta:index" });\n`,
      );

      const markerPath = join(project.dir, "beta-ran.txt");
      await createWorkflowScript(
        project,
        "beta",
        "index",
        ".ts",
        `import { output } from "loopx";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerPath)}, "beta-arrived");
output({ stop: true });
`,
      );

      const { threwError, exitCode } = await runGeneratorTest(
        project,
        "alpha",
        { maxIterations: 5, runtime },
      );

      expect(threwError).toBe(false);
      expect(exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf-8")).toBe("beta-arrived");
    });

    it("T-MOD-06: output({ stop: true }) halts the loop after one iteration", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ stop: true });\n`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        maxIterations: 5,
        runtime,
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      expect((outputs[0] as Record<string, unknown>).stop).toBe(true);
    });

    it("T-MOD-07: output({}) crashes (no known fields)", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({});\n`,
      );

      const { threwError } = await runGeneratorTest(project, "ralph", {
        runtime,
      });
      expect(threwError).toBe(true);
    });

    it("T-MOD-08: output(null) crashes", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput(null as any);\n`,
      );

      const { threwError } = await runGeneratorTest(project, "ralph", {
        runtime,
      });
      expect(threwError).toBe(true);
    });

    it("T-MOD-09: output(undefined) crashes", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput(undefined as any);\n`,
      );

      const { threwError } = await runGeneratorTest(project, "ralph", {
        runtime,
      });
      expect(threwError).toBe(true);
    });

    it("T-MOD-10: output(\"string\") yields result: \"string\"", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput("string" as any);\n`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        runtime,
      });
      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      expect((outputs[0] as Record<string, unknown>).result).toBe("string");
    });

    it("T-MOD-11: output(42) yields result: \"42\"", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput(42 as any);\n`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        runtime,
      });
      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      expect((outputs[0] as Record<string, unknown>).result).toBe("42");
    });

    it("T-MOD-12: output(true) yields result: \"true\"", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput(true as any);\n`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        runtime,
      });
      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      expect((outputs[0] as Record<string, unknown>).result).toBe("true");
    });

    it("T-MOD-13: output({ result, goto: undefined }) yields result only, no goto", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ result: "x", goto: undefined });\n`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        runtime,
      });
      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      const out = outputs[0] as Record<string, unknown>;
      expect(out.result).toBe("x");
      expect(out).not.toHaveProperty("goto");
    });

    it("T-MOD-13a: output([1,2,3]) crashes (array, no known fields)", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput([1, 2, 3] as any);\n`,
      );

      const { threwError } = await runGeneratorTest(project, "ralph", {
        runtime,
      });
      expect(threwError).toBe(true);
    });

    it("T-MOD-13b: output({ result, goto, stop }) all undefined — equivalent to {} — crashes", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ result: undefined, goto: undefined, stop: undefined });\n`,
      );

      const { threwError } = await runGeneratorTest(project, "ralph", {
        runtime,
      });
      expect(threwError).toBe(true);
    });

    it("T-MOD-13c: output({ foo: \"bar\" }) crashes (no known fields)", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ foo: "bar" } as any);\n`,
      );

      const { threwError } = await runGeneratorTest(project, "ralph", {
        runtime,
      });
      expect(threwError).toBe(true);
    });

    it("T-MOD-13d: output({ stop: false }) accepted; loop engine parses as {} and continues", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { output } from "loopx";
const prev = existsSync(${JSON.stringify(counterFile)}) ? readFileSync(${JSON.stringify(
          counterFile,
        )}, "utf-8") : "";
const count = prev.length + 1;
writeFileSync(${JSON.stringify(counterFile)}, prev + "1");
if (count === 1) {
  output({ stop: false });
} else {
  output({ result: "continued", stop: true });
}
`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        maxIterations: 2,
        runtime,
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(2);

      const first = outputs[0] as Record<string, unknown>;
      expect(first).not.toHaveProperty("stop");
      expect(first).not.toHaveProperty("result");
      expect(first).not.toHaveProperty("goto");

      const second = outputs[1] as Record<string, unknown>;
      expect(second.result).toBe("continued");
    });

    it("T-MOD-13e: output({ goto: 42 }) accepted; loop engine parses as {} and resets", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter-13e.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { output } from "loopx";
const prev = existsSync(${JSON.stringify(counterFile)}) ? readFileSync(${JSON.stringify(
          counterFile,
        )}, "utf-8") : "";
const count = prev.length + 1;
writeFileSync(${JSON.stringify(counterFile)}, prev + "1");
if (count === 1) {
  output({ goto: 42 } as any);
} else {
  output({ result: "reset-ok", stop: true });
}
`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        maxIterations: 2,
        runtime,
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(2);

      const first = outputs[0] as Record<string, unknown>;
      expect(first).not.toHaveProperty("goto");
      expect(Object.keys(first)).toHaveLength(0);

      const second = outputs[1] as Record<string, unknown>;
      expect(second.result).toBe("reset-ok");
    });

    it("T-MOD-13f: output({ result: null }) yields result: \"null\"", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ result: null } as any);\n`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        runtime,
      });
      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      expect((outputs[0] as Record<string, unknown>).result).toBe("null");
    });

    it("T-MOD-13g: output({ goto: null }) accepted; loop engine parses as {} and resets", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter-13g.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { output } from "loopx";
const prev = existsSync(${JSON.stringify(counterFile)}) ? readFileSync(${JSON.stringify(
          counterFile,
        )}, "utf-8") : "";
const count = prev.length + 1;
writeFileSync(${JSON.stringify(counterFile)}, prev + "1");
if (count === 1) {
  output({ goto: null } as any);
} else {
  output({ result: "reset-ok", stop: true });
}
`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        maxIterations: 2,
        runtime,
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(2);

      const first = outputs[0] as Record<string, unknown>;
      expect(first).not.toHaveProperty("goto");
      expect(Object.keys(first)).toHaveLength(0);

      const second = outputs[1] as Record<string, unknown>;
      expect(second.result).toBe("reset-ok");
    });

    // T-MOD-13h..13p: the helper does NOT validate goto shape at serialization time.
    // It always writes the value and only the loop engine rejects invalid targets
    // at transition time. Each test: the script must exit 0 (serialization succeeded),
    // the first yielded output preserves the raw goto value, and the generator throws
    // when the loop tries to transition.

    it("T-MOD-13h: output({ goto: \"a:b:c\" }) — helper does not validate; loop throws at transition", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "test",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ goto: "a:b:c" });\n`,
      );

      const { outputs, threwError } = await runGeneratorTest(project, "test", {
        maxIterations: 3,
        runtime,
      });

      expect(outputs.length).toBeGreaterThanOrEqual(1);
      expect((outputs[0] as Record<string, unknown>).goto).toBe("a:b:c");
      expect(threwError).toBe(true);
    });

    it("T-MOD-13i: output({ goto: \":script\" }) — leading colon; loop throws at transition", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "test",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ goto: ":script" });\n`,
      );

      const { outputs, threwError } = await runGeneratorTest(project, "test", {
        maxIterations: 3,
        runtime,
      });

      expect(outputs.length).toBeGreaterThanOrEqual(1);
      expect((outputs[0] as Record<string, unknown>).goto).toBe(":script");
      expect(threwError).toBe(true);
    });

    it("T-MOD-13j: output({ goto: \"workflow:\" }) — trailing colon; loop throws at transition", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "test",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ goto: "workflow:" });\n`,
      );

      const { outputs, threwError } = await runGeneratorTest(project, "test", {
        maxIterations: 3,
        runtime,
      });

      expect(outputs.length).toBeGreaterThanOrEqual(1);
      expect((outputs[0] as Record<string, unknown>).goto).toBe("workflow:");
      expect(threwError).toBe(true);
    });

    it("T-MOD-13k: output({ goto: \"\" }) — empty string; helper must serialize falsy value", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "test",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ goto: "" });\n`,
      );

      const { outputs, threwError } = await runGeneratorTest(project, "test", {
        maxIterations: 3,
        runtime,
      });

      // An implementation that incorrectly rejects falsy "" at serialization time
      // would emit no Output at all; the first output must have goto === "".
      expect(outputs.length).toBeGreaterThanOrEqual(1);
      expect((outputs[0] as Record<string, unknown>).goto).toBe("");
      expect(threwError).toBe(true);
    });

    it("T-MOD-13l: output({ goto: \":\" }) — bare colon; loop throws at transition", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "test",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ goto: ":" });\n`,
      );

      const { outputs, threwError } = await runGeneratorTest(project, "test", {
        maxIterations: 3,
        runtime,
      });

      expect(outputs.length).toBeGreaterThanOrEqual(1);
      expect((outputs[0] as Record<string, unknown>).goto).toBe(":");
      expect(threwError).toBe(true);
    });

    it("T-MOD-13m: output({ goto: \"missing-workflow:missing-script\" }) — valid shape, nonexistent target; loop throws", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "test",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ goto: "missing-workflow:missing-script" });\n`,
      );

      const { outputs, threwError } = await runGeneratorTest(project, "test", {
        maxIterations: 3,
        runtime,
      });

      expect(outputs.length).toBeGreaterThanOrEqual(1);
      expect((outputs[0] as Record<string, unknown>).goto).toBe(
        "missing-workflow:missing-script",
      );
      expect(threwError).toBe(true);
    });

    it("T-MOD-13n: output({ goto: \"bad.name\" }) — name-pattern violation; loop throws", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "test",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ goto: "bad.name" });\n`,
      );

      const { outputs, threwError } = await runGeneratorTest(project, "test", {
        maxIterations: 3,
        runtime,
      });

      expect(outputs.length).toBeGreaterThanOrEqual(1);
      expect((outputs[0] as Record<string, unknown>).goto).toBe("bad.name");
      expect(threwError).toBe(true);
    });

    it("T-MOD-13o: output({ goto: \"bad.name:index\" }) — qualified target with name-pattern violation in workflow portion", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "test",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ goto: "bad.name:index" });\n`,
      );

      const { outputs, threwError } = await runGeneratorTest(project, "test", {
        maxIterations: 3,
        runtime,
      });

      expect(outputs.length).toBeGreaterThanOrEqual(1);
      expect((outputs[0] as Record<string, unknown>).goto).toBe(
        "bad.name:index",
      );
      expect(threwError).toBe(true);
    });

    it("T-MOD-13p: output({ goto: \"ralph:bad.name\" }) — qualified target with name-pattern violation in script portion", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "test",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ goto: "ralph:bad.name" });\n`,
      );

      const { outputs, threwError } = await runGeneratorTest(project, "test", {
        maxIterations: 3,
        runtime,
      });

      expect(outputs.length).toBeGreaterThanOrEqual(1);
      expect((outputs[0] as Record<string, unknown>).goto).toBe(
        "ralph:bad.name",
      );
      expect(threwError).toBe(true);
    });

    it("T-MOD-14: code after output() does not execute", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "after-output-marker.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";
import { writeFileSync } from "node:fs";
output({ result: "a" });
writeFileSync(${JSON.stringify(markerPath)}, "ran");
`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        runtime,
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      expect((outputs[0] as Record<string, unknown>).result).toBe("a");

      // The post-output writeFileSync must not have run.
      expect(existsSync(markerPath)).toBe(false);
    });

    it("T-MOD-14a: output({ result: 1MB string }) preserves full payload", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";
output({ result: "x".repeat(1_000_000) });
`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        runtime,
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      const out = outputs[0] as Record<string, unknown>;
      expect(typeof out.result).toBe("string");
      expect((out.result as string).length).toBe(1_000_000);
      expect(out.result).toBe("x".repeat(1_000_000));
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.8.3 — input() function
// ═════════════════════════════════════════════════════════════

describe("SPEC: input() function", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    it("T-MOD-15: input() returns \"\" on first iteration", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { input, output } from "loopx";
const data = await input();
output({ result: data });
`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        runtime,
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      expect((outputs[0] as Record<string, unknown>).result).toBe("");
    });

    it("T-MOD-16: ralph:index result piped to ralph:reader via input()", async () => {
      project = await createTempProject();

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ result: "payload", goto: "reader" });\n`,
      );
      await createWorkflowScript(
        project,
        "ralph",
        "reader",
        ".ts",
        `import { input, output } from "loopx";
const data = await input();
output({ result: data });
`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        maxIterations: 2,
        runtime,
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(2);
      const second = outputs[1] as Record<string, unknown>;
      expect(second.result).toBe("payload");
    });

    it("T-MOD-17: input() is cached — two calls return same value", async () => {
      project = await createTempProject();

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { output } from "loopx";\noutput({ result: "cached-value", goto: "reader" });\n`,
      );
      await createWorkflowScript(
        project,
        "ralph",
        "reader",
        ".ts",
        `import { input, output } from "loopx";
const first = await input();
const second = await input();
output({ result: first === second ? "same" : "different" });
`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        maxIterations: 2,
        runtime,
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(2);
      expect((outputs[1] as Record<string, unknown>).result).toBe("same");
    });

    it("T-MOD-18: input() returns a Promise (thenable)", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { input, output } from "loopx";
const result = input();
const isPromise = result instanceof Promise || (typeof result === "object" && result !== null && typeof (result as any).then === "function");
output({ result: isPromise ? "is-promise" : "not-promise" });
`,
      );

      const { outputs, exitCode } = await runOutputTest(project, "ralph", {
        runtime,
      });

      expect(exitCode).toBe(0);
      expect(outputs).toHaveLength(1);
      expect((outputs[0] as Record<string, unknown>).result).toBe("is-promise");
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.8.4 — LOOPX_BIN in Bash Scripts
// Per TEST-SPEC §4.8, these use withDelegationSetup (real executable on PATH),
// not runCLI — so $LOOPX_BIN points at a real resolvable binary.
// ═════════════════════════════════════════════════════════════

describe("SPEC: LOOPX_BIN in Bash Scripts", () => {
  let fixture: DelegationFixture | null = null;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup().catch(() => {});
      fixture = null;
    }
  });

  it("T-MOD-19: $LOOPX_BIN output --result/--goto drives intra-workflow goto", async () => {
    fixture = await withDelegationSetup();
    const proj: TempProject = {
      dir: fixture.projectDir,
      loopxDir: join(fixture.projectDir, ".loopx"),
      cleanup: async () => {},
    };
    const markerPath = join(fixture.projectDir, "reader-marker.txt");

    // Remove the delegation placeholder — $LOOPX_BIN subcommands must use the
    // real loopx binary, and LOOPX_DELEGATED=1 is set below to skip delegation.
    unlinkSync(fixture.localBinPath);

    // ralph:index emits result+goto via $LOOPX_BIN output; ralph:reader consumes via stdin.
    await createBashWorkflowScript(
      proj,
      "ralph",
      "index",
      `$LOOPX_BIN output --result "payload" --goto "reader"`,
    );
    await createBashWorkflowScript(
      proj,
      "ralph",
      "reader",
      `INPUT=$(cat)\nprintf '%s' "$INPUT" > "${markerPath}"\nprintf '{"stop":true}'`,
    );

    const result = await fixture.runGlobal(["run", "-n", "2", "ralph"], {
      env: { LOOPX_DELEGATED: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("payload");
  });

  it("T-MOD-20: $LOOPX_BIN is an executable path", async () => {
    fixture = await withDelegationSetup();
    const proj: TempProject = {
      dir: fixture.projectDir,
      loopxDir: join(fixture.projectDir, ".loopx"),
      cleanup: async () => {},
    };
    const markerPath = join(fixture.projectDir, "loopx-bin-path.txt");

    await createBashWorkflowScript(
      proj,
      "ralph",
      "index",
      writeEnvToFile("LOOPX_BIN", markerPath).replace(/^#!\/bin\/bash\n/, ""),
    );

    await fixture.runGlobal(["run", "-n", "1", "ralph"], {
      env: { LOOPX_DELEGATED: "1" },
    });

    expect(existsSync(markerPath)).toBe(true);
    const binPath = readFileSync(markerPath, "utf-8").trim();
    expect(binPath.length).toBeGreaterThan(0);
    expect(existsSync(binPath)).toBe(true);
    const stats = statSync(binPath);
    expect(stats.mode & 0o111).not.toBe(0);
  });

  it("T-MOD-21: $LOOPX_BIN version matches the package version", async () => {
    fixture = await withDelegationSetup();
    const proj: TempProject = {
      dir: fixture.projectDir,
      loopxDir: join(fixture.projectDir, ".loopx"),
      cleanup: async () => {},
    };
    const markerPath = join(fixture.projectDir, "loopx-version.txt");

    // Remove the placeholder — $LOOPX_BIN version must not delegate to it.
    unlinkSync(fixture.localBinPath);

    await createBashWorkflowScript(
      proj,
      "ralph",
      "index",
      `$LOOPX_BIN version > "${markerPath}"`,
    );

    await fixture.runGlobal(["run", "-n", "1", "ralph"], {
      env: { LOOPX_DELEGATED: "1" },
    });

    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8").trim()).toBe(getExpectedVersion());
  });

  it("T-MOD-21a: $LOOPX_BIN output --goto with qualified target drives cross-workflow transition", async () => {
    fixture = await withDelegationSetup();
    const proj: TempProject = {
      dir: fixture.projectDir,
      loopxDir: join(fixture.projectDir, ".loopx"),
      cleanup: async () => {},
    };
    const markerPath = join(fixture.projectDir, "beta-arrived.txt");

    // Remove delegation placeholder — subcommand calls must reach the real binary.
    unlinkSync(fixture.localBinPath);

    // alpha:index → $LOOPX_BIN output --goto "beta:index"
    await createBashWorkflowScript(
      proj,
      "alpha",
      "index",
      `$LOOPX_BIN output --goto "beta:index"`,
    );
    // beta:index writes marker then halts with $LOOPX_BIN output --stop.
    await createBashWorkflowScript(
      proj,
      "beta",
      "index",
      `printf '%s' "arrived" > "${markerPath}"\n$LOOPX_BIN output --result "arrived" --stop`,
    );

    const result = await fixture.runGlobal(["run", "alpha"], {
      env: { LOOPX_DELEGATED: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("arrived");
  });
});

// ═════════════════════════════════════════════════════════════
// §4.8.5 — ESM-only Package Contract
// ═════════════════════════════════════════════════════════════

describe("SPEC: ESM-Only Package Contract", () => {
  it("T-MOD-22: require(\"loopx\") fails with ERR_REQUIRE_ESM [Node]", async () => {
    // Drive a separate CJS consumer: a new tmp dir without `type: "module"`,
    // with its own node_modules/loopx symlinked to the real package.
    const driverCode = `
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const consumerDir = mkdtempSync(join(tmpdir(), "loopx-cjs-test-"));

// No "type": "module" → CJS default.
writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "cjs-consumer" }));

const nmDir = join(consumerDir, "node_modules");
mkdirSync(nmDir, { recursive: true });
const loopxPkg = resolve(process.cwd(), "node_modules", "loopx");
try {
  symlinkSync(loopxPkg, join(nmDir, "loopx"), "dir");
} catch {}

writeFileSync(join(consumerDir, "test.cjs"), 'const loopx = require("loopx"); console.log(loopx);');

// --no-experimental-require-module disables Node 22.12+'s CJS-loads-ESM
// feature so the package.json "type":"module" contract is enforced.
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
    expect(parsed.succeeded).toBe(false);
    expect(parsed.stderr).toMatch(/ERR_REQUIRE_ESM|must use import|ES module/i);
  });
});
