import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  createTempProject,
  createWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { createEnvFile } from "../helpers/env.js";
import { join } from "node:path";

describe("TEST-SPEC §9.5 RunOptions snapshot semantics", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  async function createStopWorkflow(marker: string): Promise<void> {
    await createWorkflowScript(
      project!,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran > "${marker}"
printf '{"stop":true}'
`,
    );
  }

  it("T-API-62/T-API-62a/T-API-62b/T-API-62c/T-API-62d/T-API-62e/T-API-62f/T-API-62f3: run() captures snapshot-time option/env throws", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "snapshot-throws-run-should-not-run.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { run } from "loopx";
const variants = [
  ["T-API-62", () => {
    const opts = {};
    Object.defineProperty(opts, "env", { get() { throw new Error("outer-env-getter-boom"); } });
    return opts;
  }],
  ["T-API-62a", () => {
    const opts = {};
    Object.defineProperty(opts, "signal", { get() { throw new Error("signal-getter-boom"); } });
    return opts;
  }],
  ["T-API-62b", () => {
    const opts = {};
    Object.defineProperty(opts, "cwd", { get() { throw new Error("cwd-getter-boom"); } });
    return opts;
  }],
  ["T-API-62c", () => {
    const opts = {};
    Object.defineProperty(opts, "envFile", { get() { throw new Error("envFile-getter-boom"); } });
    return opts;
  }],
  ["T-API-62d", () => {
    const opts = {};
    Object.defineProperty(opts, "maxIterations", { get() { throw new Error("maxIterations-getter-boom"); } });
    return opts;
  }],
  ["T-API-62e", () => {
    const env = { A: "a" };
    Object.defineProperty(env, "B", { enumerable: true, get() { throw new Error("env-entry-getter-boom"); } });
    return { env };
  }],
  ["T-API-62f", () => ({
    env: new Proxy({ A: "a" }, {
      ownKeys() { throw new Error("ownKeys-boom"); },
    }),
  })],
  ["T-API-62f3", () => ({
    env: new Proxy({ A: "a" }, {
      ownKeys() { return ["A"]; },
      getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
      get() { throw new Error("get-trap-boom"); },
    }),
  })],
];

const results = [];
for (const [id, makeOptions] of variants) {
  let syncThrow = false;
  let rejected = false;
  try {
    const gen = run("ralph", makeOptions());
    try {
      await gen.next();
    } catch {
      rejected = true;
    }
  } catch {
    syncThrow = true;
  }
  results.push({ id, syncThrow, rejected });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({ syncThrow: false, rejected: true });
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("T-API-62g: runPromise() captures throwing options.env getter as rejection, not sync throw", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "snapshot-throws-promise-should-not-run.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { runPromise } from "loopx";
const opts = new Proxy({}, {
  get(_, key) {
    if (key === "env") throw new Error("outer-env-getter-boom");
    return undefined;
  },
});
let syncThrow = false;
let rejected = false;
try {
  const p = runPromise("ralph", opts);
  try {
    await p;
  } catch {
    rejected = true;
  }
} catch {
  syncThrow = true;
}
console.log(JSON.stringify({ syncThrow, rejected }));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      syncThrow: false,
      rejected: true,
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("T-API-62f2: descriptor-trap behavior while enumerating options.env is characterized", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "descriptor-trap-observation.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { existsSync } from "node:fs";
import { run } from "loopx";

let syncThrow = false;
let rejected = false;
let message = "";
try {
  const env = new Proxy({ A: "a" }, {
    getOwnPropertyDescriptor() {
      throw new Error("descriptor-trap-boom");
    },
  });
  const gen = run("ralph", { env });
  try {
    await gen.next();
  } catch (error) {
    rejected = true;
    message = String(error?.message ?? error);
  }
} catch (error) {
  syncThrow = true;
  message = String(error?.message ?? error);
}
console.log(JSON.stringify({
  syncThrow,
  rejected,
  message,
  markerExists: existsSync(${JSON.stringify(marker)}),
}));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.syncThrow).toBe(false);
    expect(
      (parsed.rejected === true &&
        parsed.markerExists === false &&
        parsed.message.includes("descriptor-trap-boom")) ||
        (parsed.rejected === false && parsed.markerExists === true),
    ).toBe(true);
  });

  it("T-API-62h/T-API-62h2/T-API-62i/T-API-62i2: option getters are read once at call site", async () => {
    project = await createTempProject();
    const envFile = join(project.dir, "snapshot.env");
    const marker = join(project.dir, "snapshot-getters.json");
    await createEnvFile(envFile, { MARKER_FILE: "from-env-file" });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const previous = existsSync(${JSON.stringify(marker)})
  ? JSON.parse(readFileSync(${JSON.stringify(marker)}, "utf-8"))
  : [];
previous.push({
  markerFile: process.env.MARKER_FILE,
  markerDirect: process.env.MARKER_DIRECT,
});
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(previous));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
function makeOptions() {
  const counts = { signal: 0, cwd: 0, envFile: 0, maxIterations: 0, env: 0 };
  const opts = {};
  Object.defineProperty(opts, "signal", { get() { counts.signal += 1; return new AbortController().signal; } });
  Object.defineProperty(opts, "cwd", { get() { counts.cwd += 1; return ${JSON.stringify(project.dir)}; } });
  Object.defineProperty(opts, "envFile", { get() { counts.envFile += 1; return ${JSON.stringify(envFile)}; } });
  Object.defineProperty(opts, "maxIterations", { get() { counts.maxIterations += 1; return 1; } });
  Object.defineProperty(opts, "env", { get() { counts.env += 1; return { MARKER_DIRECT: "from-options-env" }; } });
  return { opts, counts };
}
const promiseVariant = makeOptions();
const p = runPromise("ralph", promiseVariant.opts);
const promiseCountsAfterCall = { ...promiseVariant.counts };
await p;

const runVariant = makeOptions();
const gen = run("ralph", runVariant.opts);
const runCountsAfterCall = { ...runVariant.counts };
for await (const _ of gen) {}

console.log(JSON.stringify({
  promiseCountsAfterCall,
  promiseCountsAfterSettle: promiseVariant.counts,
  runCountsAfterCall,
  runCountsAfterSettle: runVariant.counts,
}));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      promiseCountsAfterCall: {
        signal: 1,
        cwd: 1,
        envFile: 1,
        maxIterations: 1,
        env: 1,
      },
      promiseCountsAfterSettle: {
        signal: 1,
        cwd: 1,
        envFile: 1,
        maxIterations: 1,
        env: 1,
      },
      runCountsAfterCall: {
        signal: 1,
        cwd: 1,
        envFile: 1,
        maxIterations: 1,
        env: 1,
      },
      runCountsAfterSettle: {
        signal: 1,
        cwd: 1,
        envFile: 1,
        maxIterations: 1,
        env: 1,
      },
    });
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual([
      { markerFile: "from-env-file", markerDirect: "from-options-env" },
      { markerFile: "from-env-file", markerDirect: "from-options-env" },
    ]);
  });

  it("T-API-62i3: run() invokes throwing non-signal option getters exactly once at call site", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "throwing-getter-callsite-run-should-not-run.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { run } from "loopx";
const variants = ["cwd", "envFile", "maxIterations", "env"];
const results = [];
for (const field of variants) {
  let throwCount = 0;
  const opts = {};
  Object.defineProperty(opts, field, {
    enumerable: true,
    get() {
      throwCount += 1;
      throw new Error(field + "-getter-boom");
    },
  });
  const sibling = field === "maxIterations" ? "cwd" : "maxIterations";
  Object.defineProperty(opts, sibling, {
    enumerable: true,
    get() {
      return sibling === "maxIterations" ? 1 : undefined;
    },
  });

  let syncThrow = false;
  let rejected = false;
  let afterCallCount = -1;
  try {
    const gen = run("ralph", opts);
    afterCallCount = throwCount;
    try {
      await gen.next();
    } catch (error) {
      rejected = String(error?.message ?? error).includes(field + "-getter-boom");
    }
  } catch {
    syncThrow = true;
    afterCallCount = throwCount;
  }
  results.push({ field, syncThrow, rejected, afterCallCount, finalCount: throwCount });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({
        syncThrow: false,
        rejected: true,
        afterCallCount: 1,
        finalCount: 1,
      });
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("T-API-62i4: runPromise() invokes throwing non-signal option getters exactly once at call site", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "throwing-getter-callsite-promise-should-not-run.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { runPromise } from "loopx";
const variants = ["cwd", "envFile", "maxIterations", "env"];
const results = [];
for (const field of variants) {
  let throwCount = 0;
  const opts = {};
  Object.defineProperty(opts, field, {
    enumerable: true,
    get() {
      throwCount += 1;
      throw new Error(field + "-getter-boom");
    },
  });
  const sibling = field === "maxIterations" ? "cwd" : "maxIterations";
  Object.defineProperty(opts, sibling, {
    enumerable: true,
    get() {
      return sibling === "maxIterations" ? 1 : undefined;
    },
  });

  let syncThrow = false;
  let rejected = false;
  let afterCallCount = -1;
  try {
    const promise = runPromise("ralph", opts);
    afterCallCount = throwCount;
    try {
      await promise;
    } catch (error) {
      rejected = String(error?.message ?? error).includes(field + "-getter-boom");
    }
  } catch {
    syncThrow = true;
    afterCallCount = throwCount;
  }
  results.push({ field, syncThrow, rejected, afterCallCount, finalCount: throwCount });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({
        syncThrow: false,
        rejected: true,
        afterCallCount: 1,
        finalCount: 1,
      });
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("T-API-62h3/T-API-62h4/T-API-62h5/T-API-62h6/T-API-62h7/T-API-62h8/T-API-62h9/T-API-62h10/T-API-62h11: throwing snapshot paths are not retried", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "snapshot-no-retry-should-not-run.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { run, runPromise } from "loopx";
const factories = [
  ["envGetter", () => {
    let count = 0;
    const opts = {};
    Object.defineProperty(opts, "env", { get() { count += 1; throw new Error("env-getter-boom"); } });
    return { opts, getCount: () => count };
  }],
  ["signalGetter", () => {
    let count = 0;
    const opts = {};
    Object.defineProperty(opts, "signal", { get() { count += 1; throw new Error("signal-getter-boom"); } });
    return { opts, getCount: () => count };
  }],
  ["ownKeys", () => {
    let count = 0;
    const env = new Proxy({ A: "a" }, {
      ownKeys() { count += 1; throw new Error("ownKeys-boom"); },
    });
    return { opts: { env }, getCount: () => count };
  }],
  ["getTrap", () => {
    let count = 0;
    const env = new Proxy({ A: "a" }, {
      ownKeys() { return ["A"]; },
      getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
      get() { count += 1; throw new Error("get-trap-boom"); },
    });
    return { opts: { env }, getCount: () => count };
  }],
  ["entryGetter", () => {
    let count = 0;
    const env = { A: "a" };
    Object.defineProperty(env, "B", { enumerable: true, get() { count += 1; throw new Error("entry-getter-boom"); } });
    return { opts: { env }, getCount: () => count };
  }],
];
const results = [];
for (const [name, factory] of factories) {
  for (const surface of ["run", "promise"]) {
    const variant = factory();
    let rejected = false;
    try {
      if (surface === "run") {
        const gen = run("ralph", variant.opts);
        await gen.next();
      } else {
        await runPromise("ralph", variant.opts);
      }
    } catch {
      rejected = true;
    }
    results.push({ name, surface, rejected, count: variant.getCount() });
  }
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({ rejected: true, count: 1 });
    }
    expect(existsSync(marker)).toBe(false);
  });
});
