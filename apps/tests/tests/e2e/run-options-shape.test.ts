import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { createEnvFile } from "../helpers/env.js";

describe("TEST-SPEC §9.5 outer RunOptions shape", () => {
  let project: TempProject | null = null;
  const extraTempDirs: string[] = [];

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
    while (extraTempDirs.length > 0) {
      await rm(extraTempDirs.pop()!, { recursive: true, force: true }).catch(
        () => {},
      );
    }
  });

  async function makeTmpParent(): Promise<string> {
    const parent = await mkdtemp(join(tmpdir(), "loopx-options-shape-"));
    extraTempDirs.push(parent);
    return parent;
  }

  function lingeringLoopxRunDirs(parent: string): string[] {
    return readdirSync(parent).filter(
      (name) =>
        name.startsWith("loopx-") && !name.startsWith("loopx-nodepath-shim-"),
    );
  }

  async function createStopWorkflow(marker: string): Promise<void> {
    await createWorkflowScript(
      project!,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran >> "${marker}"
printf '{"stop":true}'
`,
    );
  }

  it("T-API-61/T-API-61a/T-API-61b/T-API-61c/T-API-61c2: run() rejects invalid options wrappers lazily", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const marker = join(project.dir, "invalid-run-options-should-not-run.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { run } from "loopx";
const variants = [
  ["T-API-61", null],
  ["T-API-61a", []],
  ["T-API-61b", function badOptions() {}],
  ["T-API-61c", "string"],
  ["T-API-61c2-number", 42],
  ["T-API-61c2-true", true],
  ["T-API-61c2-false", false],
  ["T-API-61c2-symbol", Symbol("bad")],
  ["T-API-61c2-bigint", 1n],
];
const results = [];
for (const [id, options] of variants) {
  let syncThrow = false;
  let rejected = false;
  try {
    const gen = run("ralph", options);
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
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({ syncThrow: false, rejected: true });
    }
    expect(existsSync(marker)).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-61d/T-API-61e/T-API-61e2: runPromise() rejects invalid options wrappers as promise rejections", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const marker = join(project.dir, "invalid-promise-options-should-not-run.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { runPromise } from "loopx";
const variants = [
  ["T-API-61d", null],
  ["T-API-61e", []],
  ["T-API-61e2-function", function badOptions() {}],
  ["T-API-61e2-string", "string"],
  ["T-API-61e2-number", 42],
  ["T-API-61e2-true", true],
  ["T-API-61e2-false", false],
  ["T-API-61e2-symbol", Symbol("bad")],
  ["T-API-61e2-bigint", 1n],
];
const results = [];
for (const [id, options] of variants) {
  let syncThrow = false;
  let rejected = false;
  try {
    const p = runPromise("ralph", options);
    try {
      await p;
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
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({ syncThrow: false, rejected: true });
    }
    expect(existsSync(marker)).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-61f/T-API-61g: explicit undefined options are equivalent to omitted options", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "undefined-options-runs.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { run, runPromise } from "loopx";
await runPromise("ralph", undefined);
for await (const _ of run("ralph", undefined)) {}
console.log(JSON.stringify({ ok: true }));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(readFileSync(marker, "utf-8")).toBe("ranran");
  });

  it("T-API-61h/T-API-61h2: explicit undefined option fields are equivalent to omitted fields", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "undefined-option-fields.json");

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
  cwd: process.cwd(),
  markerOnly: process.env.LOOPX_UNDEFINED_FIELD_MARKER ?? "<unset>",
});
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(previous));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
delete process.env.LOOPX_UNDEFINED_FIELD_MARKER;
const options = {
  cwd: undefined,
  envFile: undefined,
  maxIterations: undefined,
  signal: undefined,
  env: undefined,
};
const promiseOutputs = await runPromise("ralph", options);
const runOutputs = [];
for await (const output of run("ralph", options)) {
  runOutputs.push(output);
}
console.log(JSON.stringify({
  promiseLength: promiseOutputs.length,
  runLength: runOutputs.length,
}));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      promiseLength: 1,
      runLength: 1,
    });
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual([
      { cwd: project.dir, markerOnly: "<unset>" },
      { cwd: project.dir, markerOnly: "<unset>" },
    ]);
  });

  it("T-API-61i/T-API-61j: null-prototype options are accepted on both API surfaces", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "null-prototype-options-runs.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { run, runPromise } from "loopx";
const promiseOptions = Object.create(null);
promiseOptions.cwd = ${JSON.stringify(project.dir)};
promiseOptions.maxIterations = 1;
await runPromise("ralph", promiseOptions);

const runOptions = Object.create(null);
runOptions.cwd = ${JSON.stringify(project.dir)};
runOptions.maxIterations = 1;
for await (const _ of run("ralph", runOptions)) {}
console.log(JSON.stringify({ ok: true }));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(readFileSync(marker, "utf-8")).toBe("ranran");
  });

  it("T-API-61k: class-instance options are accepted and contribute own fields", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "class-options-runs.txt");
    const cwdMarker = join(project.dir, "class-options-cwd.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran >> "${marker}"
/bin/pwd -P | tr -d '\\n' > "${cwdMarker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
class Options {
  cwd = ${JSON.stringify(project.dir)};
  maxIterations = 1;
}
await runPromise("ralph", new Options());
for await (const _ of run("ralph", new Options())) {}
console.log(JSON.stringify({ ok: true }));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(readFileSync(marker, "utf-8")).toBe("ranran");
    expect(readFileSync(cwdMarker, "utf-8")).toBe(project.dir);
  });

  it("T-API-61l: Map options are accepted but conceptual entries contribute no option fields", async () => {
    project = await createTempProject();
    const otherProject = await mkdtemp(join(tmpdir(), "loopx-map-options-other-"));
    extraTempDirs.push(otherProject);
    const marker = join(project.dir, "map-options-observed.json");

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
  projectRoot: process.env.LOOPX_PROJECT_ROOT,
  marker: process.env.MARKER ?? "<unset>",
});
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(previous));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
delete process.env.MARKER;
const options = new Map([
  ["cwd", ${JSON.stringify(otherProject)}],
  ["maxIterations", 0],
  ["env", { MARKER: "bad" }],
]);
await runPromise("ralph", options);
for await (const _ of run("ralph", options)) {}
console.log(JSON.stringify({ ok: true }));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual([
      { projectRoot: project.dir, marker: "<unset>" },
      { projectRoot: project.dir, marker: "<unset>" },
    ]);
  });

  it("T-API-61m: inherited maxIterations is honored on both API surfaces", async () => {
    project = await createTempProject();
    const countFile = join(project.dir, "inherited-max-count.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const countFile = ${JSON.stringify(countFile)};
const count = existsSync(countFile) ? readFileSync(countFile, "utf-8").length + 1 : 1;
writeFileSync(countFile, "x".repeat(count));
process.stdout.write(JSON.stringify({ stop: count >= 2 }));
`,
    );

    const driverCode = `
import { unlinkSync } from "node:fs";
import { run, runPromise } from "loopx";
const proto = { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 };
await runPromise("ralph", Object.create(proto));
unlinkSync(${JSON.stringify(countFile)});
for await (const _ of run("ralph", Object.create(proto))) {}
console.log(JSON.stringify({ ok: true }));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(readFileSync(countFile, "utf-8")).toBe("x");
  });

  it("T-API-61n/T-API-61o/T-API-61p: inherited cwd, envFile, and env are honored", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "inherited-fields.json");
    const envFile = join(project.dir, "inherited.env");
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
  projectRoot: process.env.LOOPX_PROJECT_ROOT,
  markerFile: process.env.MARKER_FILE,
  markerDirect: process.env.MARKER_DIRECT,
});
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(previous));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
const proto = {
  cwd: ${JSON.stringify(project.dir)},
  envFile: ${JSON.stringify(envFile)},
  env: { MARKER_DIRECT: "from-inherited-env" },
  maxIterations: 1,
};
await runPromise("ralph", Object.create(proto));
for await (const _ of run("ralph", Object.create(proto))) {}
console.log(JSON.stringify({ ok: true }));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual([
      {
        projectRoot: project.dir,
        markerFile: "from-env-file",
        markerDirect: "from-inherited-env",
      },
      {
        projectRoot: project.dir,
        markerFile: "from-env-file",
        markerDirect: "from-inherited-env",
      },
    ]);
  });

  it("T-API-61q/T-API-61r: inherited signal and inherited throwing getters are read via [[Get]]", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "inherited-signal-should-not-run.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { run, runPromise } from "loopx";

const abortController = new AbortController();
abortController.abort();
const signalProto = { signal: abortController.signal, cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 };

const signalResults = [];
try {
  await runPromise("ralph", Object.create(signalProto));
  signalResults.push({ surface: "promise", rejected: false });
} catch {
  signalResults.push({ surface: "promise", rejected: true });
}
try {
  const gen = run("ralph", Object.create(signalProto));
  await gen.next();
  signalResults.push({ surface: "run", rejected: false });
} catch {
  signalResults.push({ surface: "run", rejected: true });
}

const getterResults = [];
for (const surface of ["promise", "run"]) {
  let count = 0;
  const proto = { cwd: ${JSON.stringify(project.dir)} };
  Object.defineProperty(proto, "maxIterations", {
    get() {
      count += 1;
      throw new Error("inherited-getter-throw");
    },
  });
  const opts = Object.create(proto);
  let rejected = false;
  try {
    if (surface === "promise") {
      await runPromise("ralph", opts);
    } else {
      const gen = run("ralph", opts);
      await gen.next();
    }
  } catch (error) {
    rejected = String(error?.message ?? error).includes("inherited-getter-throw");
  }
  getterResults.push({ surface, rejected, count });
}

console.log(JSON.stringify({ signalResults, getterResults }));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      signalResults: [
        { surface: "promise", rejected: true },
        { surface: "run", rejected: true },
      ],
      getterResults: [
        { surface: "promise", rejected: true, count: 1 },
        { surface: "run", rejected: true, count: 1 },
      ],
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("T-API-61s/T-API-61s2: own non-enumerable recognized fields are honored", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "non-enumerable-options.json");
    const envFile = join(project.dir, "non-enumerable.env");
    await createEnvFile(envFile, { MARKER_FILE: "from-non-enum-env-file" });

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
  projectRoot: process.env.LOOPX_PROJECT_ROOT,
  markerFile: process.env.MARKER_FILE,
  markerDirect: process.env.MARKER_DIRECT,
});
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(previous));
process.stdout.write(JSON.stringify({ stop: false }));
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
function makeOptions() {
  const options = {};
  for (const [key, value] of Object.entries({
    cwd: ${JSON.stringify(project.dir)},
    envFile: ${JSON.stringify(envFile)},
    maxIterations: 1,
    env: { MARKER_DIRECT: "from-non-enum-env" },
    signal: new AbortController().signal,
  })) {
    Object.defineProperty(options, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return options;
}
await runPromise("ralph", makeOptions());
for await (const _ of run("ralph", makeOptions())) {}
console.log(JSON.stringify({ ok: true }));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual([
      {
        projectRoot: project.dir,
        markerFile: "from-non-enum-env-file",
        markerDirect: "from-non-enum-env",
      },
      {
        projectRoot: project.dir,
        markerFile: "from-non-enum-env-file",
        markerDirect: "from-non-enum-env",
      },
    ]);
  });

  it("T-API-61s3: own non-enumerable pre-aborted signal is honored", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "non-enum-signal-should-not-run.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { run, runPromise } from "loopx";
function makeOptions() {
  const controller = new AbortController();
  controller.abort();
  const options = {};
  Object.defineProperty(options, "cwd", { value: ${JSON.stringify(project.dir)}, enumerable: false });
  Object.defineProperty(options, "maxIterations", { value: 1, enumerable: false });
  Object.defineProperty(options, "signal", { value: controller.signal, enumerable: false });
  return options;
}
const results = [];
try {
  await runPromise("ralph", makeOptions());
  results.push({ surface: "promise", rejected: false });
} catch {
  results.push({ surface: "promise", rejected: true });
}
try {
  const gen = run("ralph", makeOptions());
  await gen.next();
  results.push({ surface: "run", rejected: false });
} catch {
  results.push({ surface: "run", rejected: true });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { surface: "promise", rejected: true },
      { surface: "run", rejected: true },
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  it("T-API-61t/T-API-61t2/T-API-61t3/T-API-61t4/T-API-61t5: unrecognized outer fields and enumeration traps are not read", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "unrecognized-options-runs.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};

function ownUnrecognized() {
  let count = 0;
  const options = { cwd: projectDir, maxIterations: 1 };
  Object.defineProperty(options, "unrecognized", {
    enumerable: true,
    get() {
      count += 1;
      throw new Error("unrecognized-getter-throw");
    },
  });
  return { options, getCount: () => count };
}

function inheritedUnrecognized() {
  let count = 0;
  const proto = {};
  Object.defineProperty(proto, "unrecognized", {
    enumerable: true,
    get() {
      count += 1;
      throw new Error("inherited-unrecognized-throw");
    },
  });
  const options = Object.create(proto);
  options.cwd = projectDir;
  options.maxIterations = 1;
  return { options, getCount: () => count };
}

function ownKeysProxy() {
  let count = 0;
  const options = new Proxy({ cwd: projectDir, maxIterations: 1 }, {
    ownKeys() {
      count += 1;
      throw new Error("ownKeys-trap-throw");
    },
  });
  return { options, getCount: () => count };
}

function prototypeOwnKeysProxy() {
  let count = 0;
  const proto = new Proxy({ extra: "value" }, {
    ownKeys() {
      count += 1;
      throw new Error("prototype-ownKeys-trap-throw");
    },
  });
  const options = Object.create(proto);
  options.cwd = projectDir;
  options.maxIterations = 1;
  return { options, getCount: () => count };
}

function descriptorProxy() {
  let count = 0;
  const target = { cwd: projectDir, maxIterations: 1 };
  const options = new Proxy(target, {
    ownKeys() {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor() {
      count += 1;
      throw new Error("descriptor-trap-throw");
    },
  });
  return { options, getCount: () => count };
}

const factories = [
  ["own", ownUnrecognized],
  ["inherited", inheritedUnrecognized],
  ["ownKeys", ownKeysProxy],
  ["prototypeOwnKeys", prototypeOwnKeysProxy],
  ["descriptor", descriptorProxy],
];
const results = [];
for (const [name, factory] of factories) {
  for (const surface of ["promise", "run"]) {
    const variant = factory();
    let rejected = false;
    try {
      if (surface === "promise") {
        await runPromise("ralph", variant.options);
      } else {
        for await (const _ of run("ralph", variant.options)) {}
      }
    } catch {
      rejected = true;
    }
    results.push({ name, surface, rejected, count: variant.getCount() });
  }
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({ rejected: false, count: 0 });
    }
    expect(readFileSync(marker, "utf-8")).toBe("ran".repeat(10));
  });
});
