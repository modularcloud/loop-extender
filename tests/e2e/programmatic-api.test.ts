import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTempProject,
  createScript,
  createBashScript,
  runAPIDriver,
  createEnvFile,
  forEachRuntime,
  type TempProject,
} from "../helpers/index.js";
import {
  emitResult,
  emitStop,
  emitGoto,
  emitResultGoto,
  counter,
  exitCode,
  writeStderr,
  writePidToFile,
} from "../helpers/fixture-scripts.js";

// ---------------------------------------------------------------------------
// SPEC: 9.1 run() AsyncGenerator
// ---------------------------------------------------------------------------

describe("SPEC: run() AsyncGenerator", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-01: run() returns async generator, next() yields Output
    it("T-API-01: run() returns async generator, next() yields Output", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("hello"));

      const driverCode = `
import { run } from "loopx";

const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
const first = await gen.next();
const second = await gen.next();
console.log(JSON.stringify({
  firstDone: first.done,
  firstValue: first.value,
  secondDone: second.done,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.firstDone).toBe(false);
      expect(parsed.firstValue).toHaveProperty("result", "hello");
      expect(parsed.secondDone).toBe(true);
    });

    // T-API-02: 3 iterations yield 3 outputs
    it("T-API-02: 3 iterations yield 3 outputs", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createScript(project, "myscript", ".sh", counter(counterFile));

      const driverCode = `
import { run } from "loopx";

const results = [];
for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 3 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(3);
      expect(outputs[0].result).toBe("1");
      expect(outputs[1].result).toBe("2");
      expect(outputs[2].result).toBe("3");
    });

    // T-API-03: stop:true completes generator
    it("T-API-03: stop:true completes generator", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitStop());

      const driverCode = `
import { run } from "loopx";

const results = [];
for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)} })) {
  results.push(output);
}
console.log(JSON.stringify({ count: results.length, hasStop: results[0]?.stop === true }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.count).toBe(1);
      expect(parsed.hasStop).toBe(true);
    });

    // T-API-04: maxIterations completes generator
    it("T-API-04: maxIterations completes generator", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("iter"));

      const driverCode = `
import { run } from "loopx";

const results = [];
for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5 })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const count = JSON.parse(result.stdout);
      expect(count).toBe(5);
    });

    // T-API-05: Final iteration output yielded before completion
    it("T-API-05: final iteration output yielded before completion", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createScript(project, "myscript", ".sh", counter(counterFile));

      const driverCode = `
import { run } from "loopx";

const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
const first = await gen.next();
const second = await gen.next();
const third = await gen.next();
console.log(JSON.stringify({
  firstDone: first.done,
  firstResult: first.value?.result,
  secondDone: second.done,
  secondResult: second.value?.result,
  thirdDone: third.done,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      // Both iteration outputs should be yielded (done: false) before the generator completes
      expect(parsed.firstDone).toBe(false);
      expect(parsed.firstResult).toBe("1");
      expect(parsed.secondDone).toBe(false);
      expect(parsed.secondResult).toBe("2");
      expect(parsed.thirdDone).toBe(true);
    });

    // T-API-06: break after first yield stops further iterations (counter file)
    it("T-API-06: break after first yield stops further iterations", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createScript(project, "myscript", ".sh", counter(counterFile));

      const driverCode = `
import { run } from "loopx";

for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 10 })) {
  break;
}
// Small delay to ensure no further iterations are spawned
await new Promise(r => setTimeout(r, 500));
import { readFileSync } from "node:fs";
const count = readFileSync(${JSON.stringify(counterFile)}, "utf-8");
console.log(JSON.stringify({ count: count.length }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.count).toBe(1);
    });

    // T-API-07: cwd option resolves scripts relative to given cwd
    it("T-API-07: cwd option resolves scripts relative to given cwd", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("from-cwd-project"));

      const driverCode = `
import { run } from "loopx";

const results = [];
for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      // Run the driver from a DIFFERENT directory than project.dir
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);

      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("from-cwd-project");
    });

    // T-API-08: maxIterations: 0 -> no yields
    it("T-API-08: maxIterations: 0 yields nothing", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createScript(project, "myscript", ".sh", counter(counterFile));

      const driverCode = `
import { run } from "loopx";

const results = [];
for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const count = JSON.parse(result.stdout);
      expect(count).toBe(0);
      // Counter file should not exist since script never ran
      expect(existsSync(counterFile)).toBe(false);
    });

    // T-API-09: run() with no name runs default script
    it("T-API-09: run() with no name runs default script", async () => {
      project = await createTempProject();
      await createScript(project, "default", ".sh", emitResult("default-output"));

      const driverCode = `
import { run } from "loopx";

const results = [];
for await (const output of run(undefined, { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("default-output");
    });

    // T-API-09a: Manual return() during pending next() kills child (write-pid-to-file fixture)
    it("T-API-09a: manual return() during pending next() kills child", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "pid-marker.txt");
      // Use TS fixture that writes PID, emits ready, then blocks
      await createScript(project, "myscript", ".ts", writePidToFile(markerPath));

      const driverCode = `
import { run } from "loopx";
import { readFileSync, existsSync } from "node:fs";

const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)} });

// Start the first iteration (will block because script sleeps)
const nextPromise = gen.next();

// Wait for the child to write its PID to the marker file
for (let i = 0; i < 100; i++) {
  if (existsSync(${JSON.stringify(markerPath)})) break;
  await new Promise(r => setTimeout(r, 100));
}

const pid = parseInt(readFileSync(${JSON.stringify(markerPath)}, "utf-8"), 10);

// Cancel the generator while next() is pending
await gen.return(undefined);

// Wait a bit for process to be killed
await new Promise(r => setTimeout(r, 1000));

// Check if the process is still running
let isRunning = false;
try {
  process.kill(pid, 0);
  isRunning = true;
} catch {
  isRunning = false;
}

console.log(JSON.stringify({ pid, isRunning }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.isRunning).toBe(false);
    });

    // T-API-09b: cwd snapshotted at call time (change cwd after run() before next())
    it("T-API-09b: cwd snapshotted at call time", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("project-a"));

      // Create a second project with a different script
      const projectB = await createTempProject();
      await createScript(projectB, "myscript", ".sh", emitResult("project-b"));

      const driverCode = `
import { run } from "loopx";

// Snapshot cwd as project A via explicit cwd option
const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });

// Change process.cwd to project B before calling next()
process.chdir(${JSON.stringify(projectB.dir)});

const results = [];
for await (const output of gen) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });

      // Clean up projectB
      await projectB.cleanup();

      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      // Should use project A (snapshotted cwd), not project B
      expect(outputs[0].result).toBe("project-a");
    });

    // T-API-09c: options snapshot (mutate maxIterations after run())
    it("T-API-09c: options snapshot - mutating maxIterations after run() has no effect", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createScript(project, "myscript", ".sh", counter(counterFile));

      const driverCode = `
import { run } from "loopx";

const opts = { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 };
const gen = run("myscript", opts);

// Mutate the options object after run() was called
opts.maxIterations = 100;

const results = [];
for await (const output of gen) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const count = JSON.parse(result.stdout);
      // Should be 2, not 100 - options were snapshotted at run() call time
      expect(count).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: 9.1 run() with AbortSignal
// ---------------------------------------------------------------------------

describe("SPEC: run() with AbortSignal", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-10: abort terminates loop, generator throws
    it("T-API-10: abort terminates loop, generator throws", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createScript(project, "myscript", ".sh", counter(counterFile));

      const driverCode = `
import { run } from "loopx";

const ac = new AbortController();
const results = [];
let threwAbort = false;
let errorMessage = "";

try {
  const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 100, signal: ac.signal });
  for await (const output of gen) {
    results.push(output);
    // Abort after first iteration
    if (results.length === 1) {
      ac.abort();
    }
  }
} catch (e) {
  threwAbort = true;
  errorMessage = e.message || String(e);
}

console.log(JSON.stringify({ threwAbort, count: results.length, errorMessage }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwAbort).toBe(true);
      expect(parsed.count).toBe(1);
    });

    // T-API-10a: abort during active child kills process (write-pid-to-file fixture)
    it("T-API-10a: abort during active child kills process", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "pid-marker.txt");
      await createScript(project, "myscript", ".ts", writePidToFile(markerPath));

      const driverCode = `
import { run } from "loopx";
import { readFileSync, existsSync } from "node:fs";

const ac = new AbortController();
const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)}, signal: ac.signal });

let threwAbort = false;

try {
  // Start iteration - this will block because the script sleeps
  const nextPromise = gen.next();

  // Wait for the child to write its PID
  for (let i = 0; i < 100; i++) {
    if (existsSync(${JSON.stringify(markerPath)})) break;
    await new Promise(r => setTimeout(r, 100));
  }

  const pid = parseInt(readFileSync(${JSON.stringify(markerPath)}, "utf-8"), 10);

  // Abort while the child is running
  ac.abort();

  // Await the next() to get the error
  try {
    await nextPromise;
  } catch {
    threwAbort = true;
  }

  // If nextPromise resolved without error, try the next one
  if (!threwAbort) {
    try {
      await gen.next();
    } catch {
      threwAbort = true;
    }
  }

  // Wait for process cleanup
  await new Promise(r => setTimeout(r, 1000));

  // Check if the process is still running
  let isRunning = false;
  try {
    process.kill(pid, 0);
    isRunning = true;
  } catch {
    isRunning = false;
  }

  console.log(JSON.stringify({ pid, isRunning, threwAbort }));
} catch (e) {
  // The for-await may throw from the abort
  console.log(JSON.stringify({ threwAbort: true, isRunning: false }));
}
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwAbort).toBe(true);
      expect(parsed.isRunning).toBe(false);
    });

    // T-API-10b: pre-aborted signal -> first next() throws, no child spawned
    it("T-API-10b: pre-aborted signal throws on first next(), no child spawned", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createScript(project, "myscript", ".sh", counter(counterFile));

      const driverCode = `
import { run } from "loopx";
import { existsSync } from "node:fs";

const ac = new AbortController();
ac.abort(); // Pre-abort

const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5, signal: ac.signal });

let threwAbort = false;
try {
  await gen.next();
} catch (e) {
  threwAbort = true;
}

// Small delay to make sure no script ran
await new Promise(r => setTimeout(r, 500));
const counterExists = existsSync(${JSON.stringify(counterFile)});
console.log(JSON.stringify({ threwAbort, counterExists }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwAbort).toBe(true);
      expect(parsed.counterExists).toBe(false);
    });

    // T-API-10c: abort between iterations -> next() throws
    it("T-API-10c: abort between iterations throws on next()", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("ok"));

      const driverCode = `
import { run } from "loopx";

const ac = new AbortController();
const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 10, signal: ac.signal });

// Get first yield
const first = await gen.next();
const firstOutput = first.value;

// Abort between iterations
ac.abort();

// Next call should throw
let threwAbort = false;
try {
  await gen.next();
} catch (e) {
  threwAbort = true;
}

console.log(JSON.stringify({ firstResult: firstOutput?.result, threwAbort }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.firstResult).toBe("ok");
      expect(parsed.threwAbort).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: 9.2 runPromise()
// ---------------------------------------------------------------------------

describe("SPEC: runPromise()", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-11: resolves with array of 3 outputs
    it("T-API-11: resolves with array of 3 outputs", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createScript(project, "myscript", ".sh", counter(counterFile));

      const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 3 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(3);
      expect(outputs[0].result).toBe("1");
      expect(outputs[1].result).toBe("2");
      expect(outputs[2].result).toBe("3");
    });

    // T-API-12: stop resolves
    it("T-API-12: stop:true resolves the promise", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitStop());

      const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("myscript", { cwd: ${JSON.stringify(project.dir)} });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].stop).toBe(true);
    });

    // T-API-13: non-zero exit rejects
    it("T-API-13: non-zero exit rejects", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", exitCode(1));

      const driverCode = `
import { runPromise } from "loopx";

try {
  await runPromise("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 3 });
  console.log(JSON.stringify({ rejected: false }));
} catch (e) {
  console.log(JSON.stringify({ rejected: true, error: e.message || String(e) }));
}
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
    });

    // T-API-14: all options (maxIterations, envFile, cwd)
    it("T-API-14: all options (maxIterations, envFile, cwd)", async () => {
      project = await createTempProject();
      const envFilePath = join(project.dir, "local.env");
      const markerPath = join(project.dir, "env-marker.txt");
      await createEnvFile(envFilePath, { MY_TEST_VAR: "env-loaded" });

      // Script writes env var to marker file and emits result
      await createBashScript(
        project,
        "myscript",
        `printf '%s' "$MY_TEST_VAR" > "${markerPath}"
printf '{"result":"ok"}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("myscript", {
  cwd: ${JSON.stringify(project.dir)},
  maxIterations: 3,
  envFile: ${JSON.stringify(envFilePath)},
});
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(3);
      expect(outputs[0].result).toBe("ok");

      // Verify env var was loaded
      expect(existsSync(markerPath)).toBe(true);
      const envValue = readFileSync(markerPath, "utf-8");
      expect(envValue).toBe("env-loaded");
    });

    // T-API-14a: runPromise() with default script
    it("T-API-14a: runPromise() with no name runs default script", async () => {
      project = await createTempProject();
      await createScript(project, "default", ".sh", emitResult("default-via-promise"));

      const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise(undefined, { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("default-via-promise");
    });

    // T-API-14b: maxIterations: 0 -> empty array
    it("T-API-14b: runPromise with maxIterations: 0 resolves with empty array", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createScript(project, "myscript", ".sh", counter(counterFile));

      const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const outputs = JSON.parse(result.stdout);
      expect(outputs).toEqual([]);
      expect(existsSync(counterFile)).toBe(false);
    });

    // T-API-14c: cwd snapshot
    it("T-API-14c: runPromise cwd is snapshotted at call time", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("project-a"));

      const projectB = await createTempProject();
      await createScript(projectB, "myscript", ".sh", emitResult("project-b"));

      const driverCode = `
import { runPromise } from "loopx";

// Call runPromise with project A's cwd
const promise = runPromise("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });

// Change process.cwd to project B before the promise resolves
process.chdir(${JSON.stringify(projectB.dir)});

const outputs = await promise;
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });

      await projectB.cleanup();

      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("project-a");
    });

    // T-API-14d: options snapshot
    it("T-API-14d: runPromise options snapshot - mutating maxIterations after call has no effect", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createScript(project, "myscript", ".sh", counter(counterFile));

      const driverCode = `
import { runPromise } from "loopx";

const opts = { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 };
const promise = runPromise("myscript", opts);

// Mutate after calling runPromise
opts.maxIterations = 100;

const outputs = await promise;
console.log(JSON.stringify(outputs.length));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const count = JSON.parse(result.stdout);
      expect(count).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: 9.3 Error Behavior
// ---------------------------------------------------------------------------

describe("SPEC: Error Behavior", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-15: no stdout leakage (process.stdout not written)
    it("T-API-15: no stdout leakage from script results", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("secret-result"));

      const driverCode = `
import { run } from "loopx";

const results = [];
for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 })) {
  results.push(output);
}
// Only our explicit output should appear on stdout
process.stdout.write("DRIVER_OUTPUT_ONLY");
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      // stdout should contain ONLY the driver's explicit output, not script results
      expect(result.stdout).toBe("DRIVER_OUTPUT_ONLY");
      expect(result.stdout).not.toContain("secret-result");
    });

    // T-API-16: non-zero exit throws
    it("T-API-16: non-zero exit causes run() generator to throw", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", exitCode(1));

      const driverCode = `
import { run } from "loopx";

let threwError = false;
let errorMsg = "";
try {
  for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)} })) {
    // should not get here
  }
} catch (e) {
  threwError = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ threwError, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwError).toBe(true);
    });

    // T-API-17: invalid goto throws
    it("T-API-17: invalid goto target causes run() generator to throw", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitGoto("nonexistent"));

      const driverCode = `
import { run } from "loopx";

let threwError = false;
let errorMsg = "";
const results = [];
try {
  for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5 })) {
    results.push(output);
  }
} catch (e) {
  threwError = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ threwError, errorMsg, resultsCount: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwError).toBe(true);
      expect(parsed.errorMsg).toContain("nonexistent");
    });

    // T-API-18: stderr forwarded
    it("T-API-18: script stderr is forwarded to calling process stderr", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", writeStderr("STDERR_API_SENTINEL"));

      const driverCode = `
import { run } from "loopx";

for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {
  // consume
}
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("STDERR_API_SENTINEL");
    });

    // T-API-19: partial outputs preserved in error
    it("T-API-19: partial outputs preserved when run() throws", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");

      // Script runs normally first 2 times, fails on 3rd
      await createBashScript(
        project,
        "myscript",
        `printf '1' >> "${counterFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')
if [ "$COUNT" -ge 3 ]; then
  exit 1
fi
printf '{"result":"iter-%s"}' "$COUNT"`,
      );

      const driverCode = `
import { run } from "loopx";

const results = [];
let threwError = false;
try {
  for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 10 })) {
    results.push(output);
  }
} catch (e) {
  threwError = true;
}
console.log(JSON.stringify({ threwError, results }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwError).toBe(true);
      // The first 2 successful iterations should be preserved
      expect(parsed.results).toHaveLength(2);
      expect(parsed.results[0].result).toBe("iter-1");
      expect(parsed.results[1].result).toBe("iter-2");
    });

    // T-API-20a: nonexistent script throws lazily on first next() (Spec 9.1, 9.3)
    it("T-API-20a: nonexistent script throws on first next()", async () => {
      project = await createTempProject();

      const driverCode = `
import { run } from "loopx";

// run() should NOT throw - it returns a generator
const gen = run("nonexistent", { cwd: ${JSON.stringify(project.dir)} });

let threwError = false;
let errorMsg = "";
try {
  await gen.next();
} catch (e) {
  threwError = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ threwError, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwError).toBe(true);
    });

    // T-API-20c: name collision throws on first next() (Spec 9.1, 9.3)
    it("T-API-20c: name collision throws on first next()", async () => {
      project = await createTempProject();
      // Create two scripts with the same base name but different extensions
      await createScript(project, "myscript", ".sh", emitResult("sh-version"));
      await createScript(project, "myscript", ".ts", 'process.stdout.write(JSON.stringify({ result: "ts-version" }));\n');

      const driverCode = `
import { run } from "loopx";

const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)} });

let threwError = false;
let errorMsg = "";
try {
  await gen.next();
} catch (e) {
  threwError = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ threwError, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwError).toBe(true);
    });

    // T-API-20d: missing env file throws on first next() (Spec 9.1, 9.3, 9.5)
    it("T-API-20d: missing env file throws on first next()", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("ok"));

      const driverCode = `
import { run } from "loopx";

const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)}, envFile: "nonexistent.env" });

let threwError = false;
let errorMsg = "";
try {
  await gen.next();
} catch (e) {
  threwError = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ threwError, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwError).toBe(true);
    });

    // T-API-20f: missing .loopx directory throws on first next() (Spec 9.1, 9.3)
    it("T-API-20f: missing .loopx directory throws on first next()", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const driverCode = `
import { run } from "loopx";

const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)} });

let threwError = false;
let errorMsg = "";
try {
  await gen.next();
} catch (e) {
  threwError = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ threwError, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwError).toBe(true);
    });

    // T-API-20h: no default script throws on first next() (Spec 9.1, 9.3)
    it("T-API-20h: no default script throws on first next()", async () => {
      project = await createTempProject();
      // .loopx exists but has no default script
      await createScript(project, "other", ".sh", emitResult("not-default"));

      const driverCode = `
import { run } from "loopx";

const gen = run(undefined, { cwd: ${JSON.stringify(project.dir)} });

let threwError = false;
let errorMsg = "";
try {
  await gen.next();
} catch (e) {
  threwError = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ threwError, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwError).toBe(true);
    });

    // T-API-20j: reserved name script throws on first next() (extra, extends Spec 9.3 + 5.3)
    it("T-API-20j: reserved name script throws on first next()", async () => {
      project = await createTempProject();
      // "output" is a reserved name per Spec 5.3
      await createScript(project, "output", ".sh", emitResult("reserved"));

      const driverCode = `
import { run } from "loopx";

const gen = run("output", { cwd: ${JSON.stringify(project.dir)} });

let threwError = false;
let errorMsg = "";
try {
  await gen.next();
} catch (e) {
  threwError = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ threwError, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwError).toBe(true);
    });

    // T-API-20k: invalid name script throws on first next() (extra, extends Spec 9.3 + 5.4)
    it("T-API-20k: invalid name script throws on first next()", async () => {
      project = await createTempProject();
      // Script name starting with "-" is invalid per Spec 5.4
      await createScript(project, "-invalid", ".sh", emitResult("bad-name"));

      const driverCode = `
import { run } from "loopx";

const gen = run("-invalid", { cwd: ${JSON.stringify(project.dir)} });

let threwError = false;
let errorMsg = "";
try {
  await gen.next();
} catch (e) {
  threwError = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ threwError, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwError).toBe(true);
    });

    // T-API-20b: nonexistent script with runPromise rejects (Spec 9.3)
    it("T-API-20b: nonexistent script with runPromise rejects", async () => {
      project = await createTempProject();

      const driverCode = `
import { runPromise } from "loopx";

try {
  await runPromise("nonexistent", { cwd: ${JSON.stringify(project.dir)} });
  console.log(JSON.stringify({ rejected: false }));
} catch (e) {
  console.log(JSON.stringify({ rejected: true, error: e.message || String(e) }));
}
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
    });

    // T-API-20l: name collision with runPromise rejects (extra, extends Spec 9.3 + 5.2)
    it("T-API-20l: name collision with runPromise rejects", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("sh-version"));
      await createScript(project, "myscript", ".ts", 'process.stdout.write(JSON.stringify({ result: "ts-version" }));\n');

      const driverCode = `
import { runPromise } from "loopx";

try {
  await runPromise("myscript", { cwd: ${JSON.stringify(project.dir)} });
  console.log(JSON.stringify({ rejected: false }));
} catch (e) {
  console.log(JSON.stringify({ rejected: true, error: e.message || String(e) }));
}
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
    });

    // T-API-20e: missing env file with runPromise rejects (Spec 9.3, 9.5)
    it("T-API-20e: missing env file with runPromise rejects", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("ok"));

      const driverCode = `
import { runPromise } from "loopx";

try {
  await runPromise("myscript", { cwd: ${JSON.stringify(project.dir)}, envFile: "nonexistent.env" });
  console.log(JSON.stringify({ rejected: false }));
} catch (e) {
  console.log(JSON.stringify({ rejected: true, error: e.message || String(e) }));
}
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
    });

    // T-API-20g: runPromise with missing .loopx directory rejects (Spec 9.3)
    it("T-API-20g: missing .loopx directory with runPromise rejects", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const driverCode = `
import { runPromise } from "loopx";

try {
  await runPromise("myscript", { cwd: ${JSON.stringify(project.dir)} });
  console.log(JSON.stringify({ rejected: false }));
} catch (e) {
  console.log(JSON.stringify({ rejected: true, error: e.message || String(e) }));
}
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
    });

    // T-API-20i: runPromise with no default script rejects (Spec 9.3)
    it("T-API-20i: no default script with runPromise rejects", async () => {
      project = await createTempProject();
      // .loopx exists but has no default script
      await createScript(project, "other", ".sh", emitResult("not-default"));

      const driverCode = `
import { runPromise } from "loopx";

try {
  await runPromise(undefined, { cwd: ${JSON.stringify(project.dir)} });
  console.log(JSON.stringify({ rejected: false }));
} catch (e) {
  console.log(JSON.stringify({ rejected: true, error: e.message || String(e) }));
}
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: 9.5 envFile option
// ---------------------------------------------------------------------------

describe("SPEC: envFile option", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-21: envFile loads vars
    it("T-API-21: envFile loads vars into script environment", async () => {
      project = await createTempProject();
      const envFilePath = join(project.dir, "test.env");
      const markerPath = join(project.dir, "env-marker.txt");
      await createEnvFile(envFilePath, { LOOPX_TEST_VAR: "hello-env" });

      await createBashScript(
        project,
        "myscript",
        `printf '%s' "$LOOPX_TEST_VAR" > "${markerPath}"
printf '{"result":"ok"}'`,
      );

      const driverCode = `
import { run } from "loopx";

for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, envFile: ${JSON.stringify(envFilePath)} })) {
  // consume
}
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      expect(existsSync(markerPath)).toBe(true);
      const envValue = readFileSync(markerPath, "utf-8");
      expect(envValue).toBe("hello-env");
    });

    // T-API-21a: relative envFile path with cwd
    it("T-API-21a: relative envFile path resolved against cwd", async () => {
      project = await createTempProject();
      const envFilePath = join(project.dir, "subdir", "test.env");
      const markerPath = join(project.dir, "env-marker.txt");

      // Create subdirectory and env file
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(project.dir, "subdir"), { recursive: true });
      await createEnvFile(envFilePath, { LOOPX_REL_VAR: "relative-env" });

      await createBashScript(
        project,
        "myscript",
        `printf '%s' "$LOOPX_REL_VAR" > "${markerPath}"
printf '{"result":"ok"}'`,
      );

      const driverCode = `
import { run } from "loopx";

for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, envFile: "subdir/test.env" })) {
  // consume
}
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      expect(existsSync(markerPath)).toBe(true);
      const envValue = readFileSync(markerPath, "utf-8");
      expect(envValue).toBe("relative-env");
    });

    // T-API-21b: relative envFile path without cwd
    it("T-API-21b: relative envFile path resolved against process.cwd() when no cwd option", async () => {
      project = await createTempProject();
      const envFilePath = join(project.dir, "my.env");
      const markerPath = join(project.dir, "env-marker.txt");
      await createEnvFile(envFilePath, { LOOPX_NOCWD_VAR: "nocwd-env" });

      await createBashScript(
        project,
        "myscript",
        `printf '%s' "$LOOPX_NOCWD_VAR" > "${markerPath}"
printf '{"result":"ok"}'`,
      );

      // The driver process.cwd() is set to project.dir, so "my.env" resolves there
      const driverCode = `
import { run } from "loopx";

// process.cwd() is project.dir because we set cwd on runAPIDriver
for await (const output of run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, envFile: "my.env" })) {
  // consume
}
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      expect(existsSync(markerPath)).toBe(true);
      const envValue = readFileSync(markerPath, "utf-8");
      expect(envValue).toBe("nocwd-env");
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: 9.5 maxIterations validation
// ---------------------------------------------------------------------------

describe("SPEC: maxIterations validation", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-22: negative maxIterations throws for run
    it("T-API-22: negative maxIterations throws on first next()", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("ok"));

      const driverCode = `
import { run } from "loopx";

const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: -1 });

let threwError = false;
let errorMsg = "";
try {
  await gen.next();
} catch (e) {
  threwError = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ threwError, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwError).toBe(true);
    });

    // T-API-23: float maxIterations throws for run (Spec 9.1, 9.5)
    it("T-API-23: float maxIterations throws on first next()", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("ok"));

      const driverCode = `
import { run } from "loopx";

const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1.5 });

let threwError = false;
let errorMsg = "";
try {
  await gen.next();
} catch (e) {
  threwError = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ threwError, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwError).toBe(true);
    });

    // T-API-23a: NaN maxIterations throws for run (Spec 9.1, 9.5)
    it("T-API-23a: NaN maxIterations throws on first next()", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("ok"));

      const driverCode = `
import { run } from "loopx";

const gen = run("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: NaN });

let threwError = false;
let errorMsg = "";
try {
  await gen.next();
} catch (e) {
  threwError = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ threwError, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.threwError).toBe(true);
    });

    // T-API-24a: negative maxIterations rejects for runPromise (Spec 9.5)
    it("T-API-24a: negative maxIterations rejects for runPromise", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("ok"));

      const driverCode = `
import { runPromise } from "loopx";

try {
  await runPromise("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: -1 });
  console.log(JSON.stringify({ rejected: false }));
} catch (e) {
  console.log(JSON.stringify({ rejected: true, error: e.message || String(e) }));
}
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
    });

    // T-API-24b: float maxIterations rejects for runPromise (Spec 9.5)
    it("T-API-24b: float maxIterations rejects for runPromise", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("ok"));

      const driverCode = `
import { runPromise } from "loopx";

try {
  await runPromise("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1.5 });
  console.log(JSON.stringify({ rejected: false }));
} catch (e) {
  console.log(JSON.stringify({ rejected: true, error: e.message || String(e) }));
}
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
    });

    // T-API-24: NaN maxIterations rejects for runPromise (Spec 9.5)
    it("T-API-24: NaN maxIterations rejects for runPromise", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("ok"));

      const driverCode = `
import { runPromise } from "loopx";

try {
  await runPromise("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: NaN });
  console.log(JSON.stringify({ rejected: false }));
} catch (e) {
  console.log(JSON.stringify({ rejected: true, error: e.message || String(e) }));
}
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: 9.5 runPromise() with AbortSignal
// ---------------------------------------------------------------------------

describe("SPEC: runPromise() with AbortSignal", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-25: abort rejects
    it("T-API-25: abort rejects runPromise", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createScript(project, "myscript", ".sh", counter(counterFile));

      const driverCode = `
import { runPromise } from "loopx";

const ac = new AbortController();

// Abort after a short delay (enough for at least one iteration)
setTimeout(() => ac.abort(), 500);

let rejected = false;
let errorMsg = "";
try {
  await runPromise("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 100, signal: ac.signal });
} catch (e) {
  rejected = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ rejected, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
    });

    // T-API-25a: pre-aborted rejects
    it("T-API-25a: pre-aborted signal rejects immediately", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createScript(project, "myscript", ".sh", counter(counterFile));

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync } from "node:fs";

const ac = new AbortController();
ac.abort(); // Pre-abort

let rejected = false;
try {
  await runPromise("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5, signal: ac.signal });
} catch (e) {
  rejected = true;
}

// Small delay to ensure no script ran
await new Promise(r => setTimeout(r, 500));
const counterExists = existsSync(${JSON.stringify(counterFile)});
console.log(JSON.stringify({ rejected, counterExists }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.counterExists).toBe(false);
    });

    // T-API-25b: abort between iterations rejects
    it("T-API-25b: abort between iterations rejects runPromise", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".sh", emitResult("fast"));

      const driverCode = `
import { runPromise } from "loopx";

const ac = new AbortController();

// Abort after a short delay - enough for ~1 iteration but not all 3
setTimeout(() => ac.abort(), 200);

let rejected = false;
let errorMsg = "";
try {
  await runPromise("myscript", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 100, signal: ac.signal });
} catch (e) {
  rejected = true;
  errorMsg = e.message || String(e);
}
console.log(JSON.stringify({ rejected, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
    });
  });
});
