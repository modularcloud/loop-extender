import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runAPIDriver } from "../helpers/api-driver.js";

describe("TEST-SPEC §9.1-§9.5 RunOptions signal and error-surface semantics", () => {
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
    const parent = await mkdtemp(join(tmpdir(), "loopx-options-signal-"));
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

  it("T-API-63/T-API-63a: invalid inputs never throw at call site on either API surface", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "invalid-input-surface-should-not-run.txt");
    const missingCwd = join(project.dir, "missing-cwd");
    const missingEnvFile = join(project.dir, "missing.env");
    await createStopWorkflow(marker);

    const driverCode = `
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const missingCwd = ${JSON.stringify(missingCwd)};
const missingEnvFile = ${JSON.stringify(missingEnvFile)};
function throwingGetterOptions() {
  const opts = {};
  Object.defineProperty(opts, "cwd", { get() { throw new Error("cwd-getter-boom"); } });
  return opts;
}
function preAbortedOptions() {
  const ac = new AbortController();
  ac.abort();
  return { cwd: projectDir, maxIterations: 1, signal: ac.signal };
}
const variants = [
  ["invalid-target", "a:b:c", { cwd: projectDir, maxIterations: 1 }],
  ["invalid-options-shape", "ralph", null],
  ["throwing-option-getter", "ralph", throwingGetterOptions()],
  ["already-aborted-signal", "ralph", preAbortedOptions()],
  ["invalid-cwd", "ralph", { cwd: missingCwd, maxIterations: 1 }],
  ["invalid-envFile", "ralph", { cwd: projectDir, envFile: missingEnvFile, maxIterations: 1 }],
  ["invalid-maxIterations", "ralph", { cwd: projectDir, maxIterations: -1 }],
  ["invalid-env", "ralph", { cwd: projectDir, maxIterations: 1, env: { BAD: 42 } }],
];
const results = [];
for (const [name, target, options] of variants) {
  let runSyncThrow = false;
  let runReturnedGenerator = false;
  let runRejected = false;
  try {
    const gen = run(target, options);
    runReturnedGenerator =
      !!gen &&
      typeof gen.next === "function" &&
      typeof gen.return === "function" &&
      typeof gen.throw === "function";
    try {
      await gen.next();
    } catch {
      runRejected = true;
    }
  } catch {
    runSyncThrow = true;
  }

  let promiseSyncThrow = false;
  let promiseReturned = false;
  let promiseRejected = false;
  try {
    const promise = runPromise(target, options);
    promiseReturned = !!promise && typeof promise.then === "function";
    try {
      await promise;
    } catch {
      promiseRejected = true;
    }
  } catch {
    promiseSyncThrow = true;
  }
  results.push({
    name,
    runSyncThrow,
    runReturnedGenerator,
    runRejected,
    promiseSyncThrow,
    promiseReturned,
    promiseRejected,
  });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({
        runSyncThrow: false,
        runReturnedGenerator: true,
        runRejected: true,
        promiseSyncThrow: false,
        promiseReturned: true,
        promiseRejected: true,
      });
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("T-API-64/T-API-64f/T-API-64g/T-API-64h/T-API-64h2/T-API-64i/T-API-64i2/T-API-64i3/T-API-64i4/T-API-64j/T-API-64j2/T-API-64m/T-API-64m2: invalid signal shapes are option errors", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const marker = join(project.dir, "invalid-signal-should-not-run.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const variants = [
  ["T-API-64", () => "not-a-signal"],
  ["T-API-64f/T-API-64g", () => ({ aborted: false, addEventListener() { throw new Error("ae-call-boom"); } })],
  ["T-API-64h/T-API-64h2", () => {
    const duck = { addEventListener() {} };
    Object.defineProperty(duck, "aborted", { get() { throw new Error("aborted-getter-boom"); } });
    return duck;
  }],
  ["T-API-64i/T-API-64i2", () => ({ aborted: false, addEventListener: 42 })],
  ["T-API-64i3/T-API-64i4", () => ({ aborted: false })],
  ["T-API-64j/T-API-64j2-missing", () => ({ addEventListener() {} })],
  ["T-API-64j/T-API-64j2-undefined", () => ({ aborted: undefined, addEventListener() {} })],
  ["T-API-64j/T-API-64j2-string", () => ({ aborted: "false", addEventListener() {} })],
  ["T-API-64j/T-API-64j2-zero", () => ({ aborted: 0, addEventListener() {} })],
  ["T-API-64j/T-API-64j2-null", () => ({ aborted: null, addEventListener() {} })],
  ["T-API-64j/T-API-64j2-one", () => ({ aborted: 1, addEventListener() {} })],
  ["T-API-64j/T-API-64j2-object", () => ({ aborted: {}, addEventListener() {} })],
  ["T-API-64m/T-API-64m2", () => {
    const duck = { aborted: false };
    Object.defineProperty(duck, "addEventListener", { get() { throw new Error("ae-getter-boom"); } });
    return duck;
  }],
];
const results = [];
for (const [id, makeSignal] of variants) {
  for (const surface of ["run", "promise"]) {
    let syncThrow = false;
    let rejected = false;
    let message = "";
    try {
      const options = { cwd: projectDir, maxIterations: 1, signal: makeSignal() };
      if (surface === "run") {
        const gen = run("ralph", options);
        try {
          await gen.next();
        } catch (error) {
          rejected = true;
          message = String(error?.message ?? error);
        }
      } else {
        try {
          await runPromise("ralph", options);
        } catch (error) {
          rejected = true;
          message = String(error?.message ?? error);
        }
      }
    } catch (error) {
      syncThrow = true;
      message = String(error?.message ?? error);
    }
    results.push({
      id,
      surface,
      syncThrow,
      rejected,
      message,
      abortError: /abort/i.test(message) && !/signal|option|addEventListener|aborted|ae-|getter/.test(message),
    });
  }
}
console.log(JSON.stringify({ results, markerExists: existsSync(${JSON.stringify(marker)}) }));
`;
    const result = await runAPIDriver("node", driverCode, {
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    for (const entry of parsed.results) {
      expect(entry.syncThrow).toBe(false);
      expect(entry.rejected).toBe(true);
      expect(entry.abortError).toBe(false);
    }
    expect(parsed.markerExists).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-64p/T-API-64p2/T-API-64p3: aborted true does not turn non-compatible signal shapes into aborts", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const marker = join(project.dir, "aborted-true-invalid-signal-should-not-run.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const variants = [
  ["missing", () => ({ aborted: true })],
  ["non-callable", () => ({ aborted: true, addEventListener: 123 })],
  ["throwing", () => ({ aborted: true, addEventListener() { throw new Error("listener-register-failed"); } })],
];
const results = [];
for (const maxIterations of [1, 0]) {
  for (const [name, makeSignal] of variants) {
    for (const surface of ["run", "promise"]) {
      let syncThrow = false;
      let rejected = false;
      let message = "";
      try {
        const options = { cwd: projectDir, maxIterations, signal: makeSignal() };
        if (surface === "run") {
          const gen = run("ralph", options);
          try {
            await gen.next();
          } catch (error) {
            rejected = true;
            message = String(error?.message ?? error);
          }
        } else {
          try {
            await runPromise("ralph", options);
          } catch (error) {
            rejected = true;
            message = String(error?.message ?? error);
          }
        }
      } catch (error) {
        syncThrow = true;
        message = String(error?.message ?? error);
      }
      results.push({
        maxIterations,
        name,
        surface,
        syncThrow,
        rejected,
        abortError: /abort/i.test(message) && !/signal|option|addEventListener|listener/.test(message),
      });
    }
  }
}
console.log(JSON.stringify({ results, markerExists: existsSync(${JSON.stringify(marker)}) }));
`;
    const result = await runAPIDriver("node", driverCode, {
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    for (const entry of parsed.results) {
      expect(entry.syncThrow).toBe(false);
      expect(entry.rejected).toBe(true);
      expect(entry.abortError).toBe(false);
    }
    expect(parsed.markerExists).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-64b/T-API-64b2/T-API-64c/T-API-64d: reentrant, duck pre-aborted, and real pre-aborted signals abort before spawning", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const marker = join(project.dir, "duck-preabort-should-not-run.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const variants = [
  ["T-API-64b", () => ({
    aborted: false,
    addEventListener(type, fn) {
      if (type === "abort") {
        this.aborted = true;
        fn();
      }
    },
  })],
  ["T-API-64b2", () => ({
    aborted: false,
    addEventListener(type, fn) {
      if (type === "abort") fn();
    },
  })],
  ["T-API-64c", () => ({
    aborted: true,
    addEventListener() {},
  })],
  ["T-API-64d", () => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }],
];
const results = [];
for (const [id, makeSignal] of variants) {
  for (const surface of ["run", "promise"]) {
    let rejected = false;
    let message = "";
    try {
      const options = { cwd: projectDir, maxIterations: 1, signal: makeSignal() };
      if (surface === "run") {
        const gen = run("ralph", options);
        await gen.next();
      } else {
        await runPromise("ralph", options);
      }
    } catch (error) {
      rejected = true;
      message = String(error?.message ?? error);
    }
    results.push({ id, surface, rejected, abortMessage: /abort/i.test(message) });
  }
}
console.log(JSON.stringify({ results, markerExists: existsSync(${JSON.stringify(marker)}) }));
`;
    const result = await runAPIDriver("node", driverCode, {
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    for (const entry of parsed.results) {
      expect(entry).toMatchObject({ rejected: true, abortMessage: true });
    }
    expect(parsed.markerExists).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-64k/T-API-64k2: signal.addEventListener is registered at the call site", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "signal-callsite-registration.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
function makeSignal() {
  let count = 0;
  return {
    duck: {
      aborted: false,
      addEventListener(type, fn) {
        if (type === "abort") {
          count += 1;
          this._listener = fn;
        }
      },
    },
    getCount: () => count,
  };
}
const runVariant = makeSignal();
const gen = run("ralph", { cwd: projectDir, maxIterations: 1, signal: runVariant.duck });
const runCountAfterCall = runVariant.getCount();
for await (const _ of gen) {}

const promiseVariant = makeSignal();
const promise = runPromise("ralph", { cwd: projectDir, maxIterations: 1, signal: promiseVariant.duck });
const promiseCountAfterCall = promiseVariant.getCount();
await promise;

console.log(JSON.stringify({ runCountAfterCall, promiseCountAfterCall }));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      runCountAfterCall: 1,
      promiseCountAfterCall: 1,
    });
    expect(readFileSync(marker, "utf-8")).toBe("ranran");
  });

  it("T-API-64e/T-API-64k3: options.signal is read before every other recognized RunOptions field", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "signal-read-first.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const fields = ["env", "cwd", "envFile", "maxIterations"];
function makeOptions(field) {
  const order = [];
  const opts = {};
  const duck = { aborted: false, addEventListener() {} };
  Object.defineProperty(opts, "signal", {
    enumerable: true,
    get() {
      order.push("signal");
      return duck;
    },
  });
  Object.defineProperty(opts, field, {
    enumerable: true,
    get() {
      order.push(field);
      if (field === "maxIterations") return 1;
      if (field === "cwd") return projectDir;
      return undefined;
    },
  });
  if (field !== "cwd") opts.cwd = projectDir;
  if (field !== "maxIterations") opts.maxIterations = 1;
  return { opts, order };
}
const results = [];
for (const field of fields) {
  const runVariant = makeOptions(field);
  const gen = run("ralph", runVariant.opts);
  results.push({ surface: "run", field, first: runVariant.order[0] });
  for await (const _ of gen) {}

  const promiseVariant = makeOptions(field);
  const promise = runPromise("ralph", promiseVariant.opts);
  results.push({ surface: "promise", field, first: promiseVariant.order[0] });
  await promise;
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry.first).toBe("signal");
    }
    expect(readFileSync(marker, "utf-8")).toBe("ran".repeat(8));
  });

  it("T-API-64a/T-API-64a2/T-API-64n/T-API-64n2/T-API-64q/T-API-64q2: compatible duck signals abort active runs", async () => {
    project = await createTempProject();
    const pidMarker = join(project.dir, "duck-signal-active-pids.txt");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf '%s\\n' "$$" >> "${pidMarker}"
sleep 999999
`,
    );

    const driverCode = `
import { existsSync, readFileSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const pidMarker = ${JSON.stringify(pidMarker)};

function readPids() {
  if (!existsSync(pidMarker)) return [];
  return readFileSync(pidMarker, "utf-8").trim().split(/\\n/).filter(Boolean).map(Number);
}

async function waitForPidCount(count) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const pids = readPids();
    if (pids.length >= count) return pids[pids.length - 1];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for active child");
}

async function settle(promise, timeout = 1000) {
  let timer;
  return await Promise.race([
    promise.then(
      () => ({ status: "resolved", message: "" }),
      (error) => ({ status: "rejected", message: String(error?.message ?? error) }),
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: "timeout", message: "" }), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

function killPid(pid) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGTERM");
    } catch {}
  }
}

function ownDuck(returnValue) {
  return {
    duck: {
      aborted: false,
      addEventListener(type, fn) {
        if (type === "abort") this._listener = fn;
        return typeof returnValue === "function" ? returnValue(fn) : returnValue;
      },
      _fire() {
        this.aborted = true;
        this._listener?.();
      },
    },
    fire(signal) {
      signal._fire();
    },
  };
}

function inheritedDuck() {
  class DuckSignal {
    addEventListener(type, fn) {
      if (type === "abort") this._listener = fn;
    }
    _fire() {
      this.aborted = true;
      this._listener?.();
    }
  }
  DuckSignal.prototype.aborted = false;
  const duck = new DuckSignal();
  return {
    duck,
    fire(signal) {
      signal._fire();
    },
  };
}

const variants = [
  ["own-default", () => ownDuck(undefined)],
  ["inherited", () => inheritedDuck()],
  ["return-string", () => ownDuck("registered")],
  ["return-number", () => ownDuck(123)],
  ["return-listener", () => ownDuck((fn) => fn)],
  ["return-object", () => ownDuck({ ok: true })],
];

const results = [];
let expectedPidCount = 0;
for (const [name, makeSignal] of variants) {
  for (const surface of ["run", "promise"]) {
    const signal = makeSignal();
    const promise =
      surface === "run"
        ? run("ralph", { cwd: projectDir, maxIterations: 1, signal: signal.duck }).next()
        : runPromise("ralph", { cwd: projectDir, maxIterations: 1, signal: signal.duck });

    expectedPidCount += 1;
    let active = false;
    let pid = 0;
    let outcome;
    try {
      pid = await waitForPidCount(expectedPidCount);
      active = true;
      signal.fire(signal.duck);
      outcome = await settle(promise);
      if (outcome.status === "timeout") {
        killPid(pid);
        outcome = await settle(promise, 3000);
      }
    } catch (error) {
      outcome = await settle(promise);
      if (pid) killPid(pid);
      results.push({
        name,
        surface,
        active,
        status: "setup-error",
        message: String(error?.message ?? error),
        outcome,
      });
      continue;
    }
    results.push({
      name,
      surface,
      active,
      status: outcome.status,
      abortMessage: /abort/i.test(outcome.message),
      optionError: /signal|option|addEventListener|aborted/i.test(outcome.message),
    });
  }
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      timeout: 45_000,
    });

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({
        active: true,
        status: "rejected",
        abortMessage: true,
        optionError: false,
      });
    }
  });

  it("T-API-64o/T-API-64o2: duck signals without removeEventListener are accepted under normal completion", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "duck-no-remove-normal-completion.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
function makeSignal() {
  return {
    aborted: false,
    addEventListener(type, fn) {
      if (type === "abort") this._listener = fn;
    },
  };
}
const runOutputs = [];
for await (const output of run("ralph", { cwd: projectDir, maxIterations: 5, signal: makeSignal() })) {
  runOutputs.push(output);
}
const promiseOutputs = await runPromise("ralph", {
  cwd: projectDir,
  maxIterations: 5,
  signal: makeSignal(),
});
console.log(JSON.stringify({ runLength: runOutputs.length, promiseLength: promiseOutputs.length }));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      runLength: 1,
      promiseLength: 1,
    });
    expect(readFileSync(marker, "utf-8")).toBe("ranran");
    expect(result.stderr).not.toMatch(/removeEventListener|signal-method/i);
  });
});
