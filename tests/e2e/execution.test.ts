import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createTempProject,
  createScript,
  createBashScript,
  createDirScript,
  type TempProject,
} from "../helpers/fixtures.js";
import {
  writeCwdToFile,
  writeEnvToFile,
  writeValueToFile,
  writeStderr,
  emitResult,
} from "../helpers/fixture-scripts.js";
import { runCLI } from "../helpers/cli.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { forEachRuntime, isRuntimeAvailable } from "../helpers/runtime.js";

// ---------------------------------------------------------------------------
// SPEC: 6.1 Working Directory
// ---------------------------------------------------------------------------

describe("SPEC: 6.1 Working Directory", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  // T-EXEC-01: File script CWD = invocation dir
  it("T-EXEC-01: file script CWD equals invocation directory", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "cwd-marker.txt");

    // Create a bash file script that writes $PWD to a marker file
    await createBashScript(project, "check-cwd", writeCwdToFile(markerPath).replace("#!/bin/bash\n", ""));

    const result = await runCLI(["run", "-n", "1", "check-cwd"], { cwd: project.dir });

    expect(existsSync(markerPath)).toBe(true);
    const recordedCwd = readFileSync(markerPath, "utf-8");
    // File scripts run with CWD = the invocation directory (project root)
    expect(recordedCwd).toBe(project.dir);
  });

  // T-EXEC-02: Dir script CWD = script's own dir
  it("T-EXEC-02: directory script CWD equals the script's own directory", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "dir-cwd-marker.txt");

    // Create a directory script whose entry point writes $PWD to a marker
    const scriptDir = await createDirScript(project, "mypipe", "run.sh", {
      "run.sh": `#!/bin/bash\nprintf '%s' "$PWD" > "${markerPath}"\n`,
    });

    const result = await runCLI(["run", "-n", "1", "mypipe"], { cwd: project.dir });

    expect(existsSync(markerPath)).toBe(true);
    const recordedCwd = readFileSync(markerPath, "utf-8");
    // Directory scripts run with CWD = the script's own directory
    expect(recordedCwd).toBe(scriptDir);
  });

  // T-EXEC-03: File script LOOPX_PROJECT_ROOT = invocation dir
  it("T-EXEC-03: file script LOOPX_PROJECT_ROOT equals invocation directory", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "projroot-marker.txt");

    // Write $LOOPX_PROJECT_ROOT to marker
    await createScript(
      project,
      "check-projroot",
      ".sh",
      writeEnvToFile("LOOPX_PROJECT_ROOT", markerPath),
    );

    await runCLI(["run", "-n", "1", "check-projroot"], { cwd: project.dir });

    expect(existsSync(markerPath)).toBe(true);
    const recordedRoot = readFileSync(markerPath, "utf-8");
    expect(recordedRoot).toBe(project.dir);
  });

  // T-EXEC-04: Dir script LOOPX_PROJECT_ROOT = invocation dir (NOT script's own dir)
  it("T-EXEC-04: directory script LOOPX_PROJECT_ROOT equals invocation directory", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "dir-projroot-marker.txt");

    const scriptDir = await createDirScript(project, "mypipe2", "run.sh", {
      "run.sh": `#!/bin/bash\nprintf '%s' "$LOOPX_PROJECT_ROOT" > "${markerPath}"\n`,
    });

    await runCLI(["run", "-n", "1", "mypipe2"], { cwd: project.dir });

    expect(existsSync(markerPath)).toBe(true);
    const recordedRoot = readFileSync(markerPath, "utf-8");
    // LOOPX_PROJECT_ROOT is always the invocation directory, not the script dir
    expect(recordedRoot).toBe(project.dir);
    expect(recordedRoot).not.toBe(scriptDir);
  });
});

// ---------------------------------------------------------------------------
// SPEC: 6.2 Bash Scripts
// ---------------------------------------------------------------------------

describe("SPEC: 6.2 Bash Scripts", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  // T-EXEC-05: Bash stdout captured as structured output
  it("T-EXEC-05: bash stdout is captured as structured output", async () => {
    project = await createTempProject();

    // Create a bash script that emits JSON result to stdout
    await createScript(project, "hello", ".sh", emitResult("bash-output-captured"));

    // Use runAPIDriver to observe the output via the programmatic API
    const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("hello", {
  maxIterations: 1,
  cwd: ${JSON.stringify(project.dir)},
});
process.stdout.write(JSON.stringify(outputs));
`;

    const result = await runAPIDriver("node", driverCode);
    expect(result.exitCode).toBe(0);

    const outputs = JSON.parse(result.stdout);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].result).toBe("bash-output-captured");
  });

  // T-EXEC-06: Bash stderr passes through to CLI stderr
  it("T-EXEC-06: bash stderr passes through to CLI stderr", async () => {
    project = await createTempProject();

    // Create a bash script that writes a known string to stderr
    await createScript(project, "stderr-test", ".sh", writeStderr("STDERR_SENTINEL_MSG"));

    const result = await runCLI(["run", "-n", "1", "stderr-test"], { cwd: project.dir });

    // stderr from the script should appear in CLI's stderr
    expect(result.stderr).toContain("STDERR_SENTINEL_MSG");
  });

  // T-EXEC-07: Bash without shebang still runs
  it("T-EXEC-07: bash script without shebang still executes", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "no-shebang-marker.txt");

    // Create a script WITHOUT the #!/bin/bash shebang — just raw bash commands
    // loopx should invoke it via /bin/bash explicitly, not relying on the shebang
    const scriptContent = `printf '%s' 'no-shebang-ran' > "${markerPath}"\nprintf '{"result":"ok"}'\n`;
    await createScript(project, "no-shebang", ".sh", scriptContent);

    await runCLI(["run", "-n", "1", "no-shebang"], { cwd: project.dir });

    expect(existsSync(markerPath)).toBe(true);
    const markerContent = readFileSync(markerPath, "utf-8");
    expect(markerContent).toBe("no-shebang-ran");
  });
});

// ---------------------------------------------------------------------------
// SPEC: 6.3 JS/TS Scripts
// ---------------------------------------------------------------------------

describe("SPEC: 6.3 JS/TS Scripts", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  // T-EXEC-08: .ts script runs and produces output
  it("T-EXEC-08: .ts script runs and produces structured output", async () => {
    project = await createTempProject();

    const tsContent = `process.stdout.write(JSON.stringify({ result: "ts-output-ok" }));\n`;
    await createScript(project, "ts-test", ".ts", tsContent);

    const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("ts-test", {
  maxIterations: 1,
  cwd: ${JSON.stringify(project.dir)},
});
process.stdout.write(JSON.stringify(outputs));
`;

    const result = await runAPIDriver("node", driverCode);
    expect(result.exitCode).toBe(0);

    const outputs = JSON.parse(result.stdout);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].result).toBe("ts-output-ok");
  });

  // T-EXEC-09: .js script runs and produces output
  it("T-EXEC-09: .js script runs and produces structured output", async () => {
    project = await createTempProject();

    const jsContent = `process.stdout.write(JSON.stringify({ result: "js-output-ok" }));\n`;
    await createScript(project, "js-test", ".js", jsContent);

    const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("js-test", {
  maxIterations: 1,
  cwd: ${JSON.stringify(project.dir)},
});
process.stdout.write(JSON.stringify(outputs));
`;

    const result = await runAPIDriver("node", driverCode);
    expect(result.exitCode).toBe(0);

    const outputs = JSON.parse(result.stdout);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].result).toBe("js-output-ok");
  });

  // T-EXEC-10: .tsx script with actual TSX syntax runs
  it("T-EXEC-10: .tsx script with actual TSX syntax produces output", async () => {
    project = await createTempProject();

    // Use a self-contained JSX shim: define React.createElement so TSX compiles
    const tsxContent = `const React = { createElement: (tag: string) => tag };
const el = <div/>;
process.stdout.write(JSON.stringify({ result: String(el) }));
`;
    await createScript(project, "tsx-test", ".tsx", tsxContent);

    const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("tsx-test", {
  maxIterations: 1,
  cwd: ${JSON.stringify(project.dir)},
});
process.stdout.write(JSON.stringify(outputs));
`;

    const result = await runAPIDriver("node", driverCode);
    expect(result.exitCode).toBe(0);

    const outputs = JSON.parse(result.stdout);
    expect(outputs).toHaveLength(1);
    // React.createElement("div") returns "div"
    expect(outputs[0].result).toBe("div");
  });

  // T-EXEC-11: .jsx script with actual JSX syntax runs
  it("T-EXEC-11: .jsx script with actual JSX syntax produces output", async () => {
    project = await createTempProject();

    // Same approach as T-EXEC-10 but with .jsx extension and no TS annotations
    const jsxContent = `const React = { createElement: (tag) => tag };
const el = <span/>;
process.stdout.write(JSON.stringify({ result: String(el) }));
`;
    await createScript(project, "jsx-test", ".jsx", jsxContent);

    const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("jsx-test", {
  maxIterations: 1,
  cwd: ${JSON.stringify(project.dir)},
});
process.stdout.write(JSON.stringify(outputs));
`;

    const result = await runAPIDriver("node", driverCode);
    expect(result.exitCode).toBe(0);

    const outputs = JSON.parse(result.stdout);
    expect(outputs).toHaveLength(1);
    // React.createElement("span") returns "span"
    expect(outputs[0].result).toBe("span");
  });

  // T-EXEC-12: JS/TS stderr passes through
  it("T-EXEC-12: JS/TS script stderr passes through to CLI stderr", async () => {
    project = await createTempProject();

    const tsContent = `process.stderr.write("TS_STDERR_SENTINEL\\n");
process.stdout.write(JSON.stringify({ result: "ok" }));
`;
    await createScript(project, "ts-stderr", ".ts", tsContent);

    const result = await runCLI(["run", "-n", "1", "ts-stderr"], { cwd: project.dir });

    expect(result.stderr).toContain("TS_STDERR_SENTINEL");
  });

  // T-EXEC-13: TypeScript annotations work [Node]
  it("T-EXEC-13: TypeScript annotations work under Node.js (via tsx)", async () => {
    project = await createTempProject();

    // Script uses genuine TypeScript syntax: type annotations, interfaces, generics
    const tsContent = `interface Greeting {
  message: string;
  count: number;
}

function greet(name: string, times: number): Greeting {
  return { message: \`hello \${name}\`, count: times };
}

const result: Greeting = greet("world", 42);
process.stdout.write(JSON.stringify({ result: result.message }));
`;
    await createScript(project, "ts-annotations", ".ts", tsContent);

    const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("ts-annotations", {
  maxIterations: 1,
  cwd: ${JSON.stringify(project.dir)},
});
process.stdout.write(JSON.stringify(outputs));
`;

    // Explicitly run under Node runtime (which uses tsx)
    const result = await runAPIDriver("node", driverCode);
    expect(result.exitCode).toBe(0);

    const outputs = JSON.parse(result.stdout);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].result).toBe("hello world");
  });

  // T-EXEC-13b: TypeScript annotations work [Bun]
  it.skipIf(!isRuntimeAvailable("bun"))(
    "T-EXEC-13b: TypeScript annotations work under Bun (native TS support)",
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
      await createScript(project, "ts-bun-test", ".ts", tsContent);

      const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("ts-bun-test", {
  maxIterations: 1,
  cwd: ${JSON.stringify(project.dir)},
});
process.stdout.write(JSON.stringify(outputs));
`;

      // Explicitly run under Bun runtime
      const result = await runAPIDriver("bun", driverCode);
      expect(result.exitCode).toBe(0);

      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("42");
    },
  );

  // T-EXEC-13a: CJS require() fails
  it("T-EXEC-13a: CJS require() in a .js script fails with an error", async () => {
    project = await createTempProject();

    // Script uses CommonJS require() which is not supported
    const cjsContent = `const fs = require("fs");
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`;
    await createScript(project, "cjs-test", ".js", cjsContent);

    const result = await runCLI(["run", "-n", "1", "cjs-test"], { cwd: project.dir });

    // CJS is rejected — the script should fail and loopx should exit non-zero
    expect(result.exitCode).not.toBe(0);
  });

  // T-EXEC-14: Bun native runtime execution
  it.skipIf(!isRuntimeAvailable("bun"))(
    "T-EXEC-14: Under Bun, TS scripts run via Bun's native runtime (not tsx)",
    async () => {
      project = await createTempProject();

      const tsContent = `import { output } from "loopx";
output({ result: JSON.stringify({ bunVersion: process.versions.bun }) });
`;
      await createScript(project, "bun-check", ".ts", tsContent);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("bun-check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver("bun", driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);

      const parsed = JSON.parse(outputs[0].result);
      expect(parsed.bunVersion).toBeTruthy();
      expect(typeof parsed.bunVersion).toBe("string");
    },
  );
});

// ---------------------------------------------------------------------------
// SPEC: 6.4 Directory Scripts
// ---------------------------------------------------------------------------

describe("SPEC: 6.4 Directory Scripts", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  // T-EXEC-15: Dir script with main: index.ts executes
  it("T-EXEC-15: directory script with main index.ts is executed", async () => {
    project = await createTempProject();

    await createDirScript(project, "ts-dir", "index.ts", {
      "index.ts": `process.stdout.write(JSON.stringify({ result: "dir-ts-ok" }));\n`,
    });

    const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("ts-dir", {
  maxIterations: 1,
  cwd: ${JSON.stringify(project.dir)},
});
process.stdout.write(JSON.stringify(outputs));
`;

    const result = await runAPIDriver("node", driverCode);
    expect(result.exitCode).toBe(0);

    const outputs = JSON.parse(result.stdout);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].result).toBe("dir-ts-ok");
  });

  // T-EXEC-16: Dir script with main: run.sh executes via bash
  it("T-EXEC-16: directory script with main run.sh is executed via bash", async () => {
    project = await createTempProject();

    await createDirScript(project, "sh-dir", "run.sh", {
      "run.sh": `#!/bin/bash\nprintf '{"result":"dir-sh-ok"}'\n`,
    });

    const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("sh-dir", {
  maxIterations: 1,
  cwd: ${JSON.stringify(project.dir)},
});
process.stdout.write(JSON.stringify(outputs));
`;

    const result = await runAPIDriver("node", driverCode);
    expect(result.exitCode).toBe(0);

    const outputs = JSON.parse(result.stdout);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].result).toBe("dir-sh-ok");
  });

  // T-EXEC-17: Dir script can import from own node_modules
  it("T-EXEC-17: directory script can import from its own node_modules", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "import-marker.txt");

    // Create a directory script with a local dependency in node_modules/
    // The dependency is a simple ESM module that exports a value
    await createDirScript(project, "with-deps", "index.ts", {
      "index.ts": `import { writeFileSync } from "node:fs";
import { greeting } from "my-local-lib";
writeFileSync(${JSON.stringify(markerPath)}, greeting);
process.stdout.write(JSON.stringify({ result: greeting }));
`,
      "node_modules/my-local-lib/package.json": JSON.stringify({
        name: "my-local-lib",
        type: "module",
        main: "index.js",
      }),
      "node_modules/my-local-lib/index.js": `export const greeting = "hello-from-local-dep";\n`,
    });

    const result = await runCLI(["run", "-n", "1", "with-deps"], { cwd: project.dir });

    // Verify the import succeeded by checking the marker file
    expect(existsSync(markerPath)).toBe(true);
    const markerContent = readFileSync(markerPath, "utf-8");
    expect(markerContent).toBe("hello-from-local-dep");
  });

  // T-EXEC-18: Dir script CWD is its own directory
  it("T-EXEC-18: directory script CWD is its own directory (via process.cwd)", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "dir-cwd-ts-marker.txt");

    const scriptDir = await createDirScript(project, "cwd-check", "index.ts", {
      "index.ts": `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerPath)}, process.cwd());
process.stdout.write(JSON.stringify({ result: "ok" }));
`,
    });

    await runCLI(["run", "-n", "1", "cwd-check"], { cwd: project.dir });

    expect(existsSync(markerPath)).toBe(true);
    const recordedCwd = readFileSync(markerPath, "utf-8");
    // Directory scripts run with CWD = the script's own directory
    expect(recordedCwd).toBe(scriptDir);
  });

  // T-EXEC-18a: Dir script missing dependency -> error, exit 1
  it("T-EXEC-18a: directory script with missing dependency fails with exit code 1", async () => {
    project = await createTempProject();

    // Create a directory script that imports a package NOT in its node_modules
    await createDirScript(project, "missing-dep", "index.ts", {
      "index.ts": `import "nonexistent-pkg";
process.stdout.write(JSON.stringify({ result: "should-not-reach" }));
`,
    });

    const result = await runCLI(["run", "missing-dep"], { cwd: project.dir });

    // The script should fail due to module resolution error
    expect(result.exitCode).toBe(1);
  });
});
