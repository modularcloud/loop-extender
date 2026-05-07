import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowPackageJson,
  createWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runAPIDriver } from "../helpers/api-driver.js";

const IS_ROOT =
  typeof process.getuid === "function" && process.getuid() === 0;

describe("TEST-SPEC §9.3 abort precedence", () => {
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
    const parent = await mkdtemp(join(tmpdir(), "loopx-abort-precedence-"));
    extraTempDirs.push(parent);
    return parent;
  }

  function lingeringLoopxRunDirs(parent: string): string[] {
    return readdirSync(parent).filter(
      (name) =>
        name.startsWith("loopx-") && !name.startsWith("loopx-nodepath-shim-"),
    );
  }

  async function createStopWorkflow(workflow: string, marker: string): Promise<void> {
    await createWorkflowScript(
      project!,
      workflow,
      "index",
      ".sh",
      `#!/bin/bash
printf ran >> "${marker}"
printf '{"stop":true}'
`,
    );
  }

  it("T-API-65/T-API-65a/T-API-65a2/T-API-65b/T-API-65h/T-API-65i/T-API-65j/T-API-65k/T-API-65l/T-API-65m/T-API-65o: pre-aborted real signals beat later pre-iteration failures", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const marker = join(project.dir, "abort-precedence-should-not-run.txt");
    const noLoopxDir = await mkdtemp(join(tmpdir(), "loopx-no-loopx-"));
    extraTempDirs.push(noLoopxDir);
    await createStopWorkflow("ralph", marker);
    await createWorkflowScript(
      project,
      "noindex",
      "check",
      ".sh",
      `#!/bin/bash
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const noLoopxDir = ${JSON.stringify(noLoopxDir)};
const variants = [
  ["T-API-65/T-API-65k", "ralph", { cwd: projectDir, envFile: "nonexistent.env", maxIterations: 1 }],
  ["T-API-65a/T-API-65l", ":bad", { cwd: projectDir, maxIterations: 1 }],
  ["T-API-65a2-undefined", undefined, { cwd: projectDir, maxIterations: 1 }],
  ["T-API-65a2-null", null, { cwd: projectDir, maxIterations: 1 }],
  ["T-API-65a2-number", 42, { cwd: projectDir, maxIterations: 1 }],
  ["T-API-65b/T-API-65m", "ralph", { cwd: noLoopxDir, maxIterations: 1 }],
  ["T-API-65h/T-API-65o-missing-workflow", "missing-workflow", { cwd: projectDir, maxIterations: 1 }],
  ["T-API-65i/T-API-65o-missing-script", "ralph:missing", { cwd: projectDir, maxIterations: 1 }],
  ["T-API-65j/T-API-65o-missing-index", "noindex", { cwd: projectDir, maxIterations: 1 }],
];
const results = [];
for (const [id, target, baseOptions] of variants) {
  for (const surface of ["run", "promise"]) {
    const controller = new AbortController();
    controller.abort();
    const options = { ...baseOptions, signal: controller.signal };
    let syncThrow = false;
    let rejected = false;
    let message = "";
    try {
      if (surface === "run") {
        const gen = run(target, options);
        try {
          await gen.next();
        } catch (error) {
          rejected = true;
          message = String(error?.message ?? error);
        }
      } else {
        try {
          await runPromise(target, options);
        } catch (error) {
          rejected = true;
          message = String(error?.message ?? error);
        }
      }
    } catch (error) {
      syncThrow = true;
      message = String(error?.message ?? error);
    }
    results.push({ id, surface, syncThrow, rejected, abortMessage: /abort/i.test(message) });
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
      expect(entry).toMatchObject({
        syncThrow: false,
        rejected: true,
        abortMessage: true,
      });
    }
    expect(parsed.markerExists).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-65e/T-API-65v/T-API-65w: unusable option wrappers or signal shapes do not enter abort precedence", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const marker = join(project.dir, "abort-carveout-should-not-run.txt");
    await createStopWorkflow("ralph", marker);

    const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const controller = new AbortController();
controller.abort();

const invalidWrapper = [];
invalidWrapper.signal = controller.signal;
const variants = [
  ["T-API-65e", "ralph", { cwd: projectDir, signal: "not-a-signal", envFile: "nonexistent.env", maxIterations: 1 }],
  ["T-API-65v/T-API-65w", "ralph", invalidWrapper],
];
const results = [];
for (const [id, target, options] of variants) {
  for (const surface of ["run", "promise"]) {
    let syncThrow = false;
    let rejected = false;
    let message = "";
    try {
      if (surface === "run") {
        const gen = run(target, options);
        try {
          await gen.next();
        } catch (error) {
          rejected = true;
          message = String(error?.message ?? error);
        }
      } else {
        try {
          await runPromise(target, options);
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
      abortMessage: /abort/i.test(message) && !/signal|option|env/i.test(message),
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
      expect(entry.abortMessage).toBe(false);
    }
    expect(parsed.markerExists).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-65f/T-API-65g/T-API-65p/T-API-65q: pre-aborted signals beat option-snapshot failures", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const marker = join(project.dir, "abort-option-snapshot-should-not-run.txt");
    await createStopWorkflow("ralph", marker);

    const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
function preAborted() {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}
function base() {
  return { cwd: projectDir, maxIterations: 1, signal: preAborted() };
}
const variants = [
  ["max-negative", () => ({ cwd: projectDir, maxIterations: -1, signal: preAborted() })],
  ["max-fraction", () => ({ cwd: projectDir, maxIterations: 1.5, signal: preAborted() })],
  ["max-nan", () => ({ cwd: projectDir, maxIterations: NaN, signal: preAborted() })],
  ["max-infinity", () => ({ cwd: projectDir, maxIterations: Infinity, signal: preAborted() })],
  ["max-null", () => ({ cwd: projectDir, maxIterations: null, signal: preAborted() })],
  ["max-string", () => ({ cwd: projectDir, maxIterations: "1", signal: preAborted() })],
  ["cwd-type", () => ({ cwd: 42, maxIterations: 1, signal: preAborted() })],
  ["cwd-getter", () => {
    const opts = { maxIterations: 1, signal: preAborted() };
    Object.defineProperty(opts, "cwd", { enumerable: true, get() { throw new Error("cwd-getter-boom"); } });
    return opts;
  }],
  ["envFile-type", () => ({ cwd: projectDir, envFile: 42, maxIterations: 1, signal: preAborted() })],
  ["envFile-getter", () => {
    const opts = { cwd: projectDir, maxIterations: 1, signal: preAborted() };
    Object.defineProperty(opts, "envFile", { enumerable: true, get() { throw new Error("envFile-getter-boom"); } });
    return opts;
  }],
  ["env-getter-T-API-65f-T-API-65g", () => {
    const opts = { cwd: projectDir, maxIterations: 1, signal: preAborted() };
    Object.defineProperty(opts, "env", { enumerable: true, get() { throw new Error("env-getter-boom"); } });
    return opts;
  }],
  ["env-shape", () => ({ ...base(), env: [] })],
  ["env-entry-value", () => ({ ...base(), env: { KEY: 42 } })],
  ["env-entry-getter", () => {
    const env = {};
    Object.defineProperty(env, "KEY", { enumerable: true, get() { throw new Error("env-entry-getter-boom"); } });
    return { ...base(), env };
  }],
  ["env-ownKeys", () => ({ ...base(), env: new Proxy({}, { ownKeys() { throw new Error("ownKeys-trap-boom"); } }) })],
  ["env-get-trap", () => ({
    ...base(),
    env: new Proxy({ KEY: "value" }, {
      ownKeys() { return ["KEY"]; },
      getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
      get() { throw new Error("get-trap-boom"); },
    }),
  })],
  ["max-getter", () => {
    const opts = { cwd: projectDir, signal: preAborted() };
    Object.defineProperty(opts, "maxIterations", { enumerable: true, get() { throw new Error("maxIterations-getter-boom"); } });
    return opts;
  }],
];
const results = [];
for (const [name, makeOptions] of variants) {
  for (const surface of ["run", "promise"]) {
    const options = makeOptions();
    let syncThrow = false;
    let rejected = false;
    let message = "";
    try {
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
    results.push({ name, surface, syncThrow, rejected, abortMessage: /abort/i.test(message) });
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
      expect(entry).toMatchObject({
        syncThrow: false,
        rejected: true,
        abortMessage: true,
      });
    }
    expect(parsed.markerExists).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it.skipIf(IS_ROOT)(
    "T-API-65c/T-API-65r: pre-aborted signals beat unreadable local and global env-file failures",
    async () => {
      project = await createTempProject();
      const tmpParent = await makeTmpParent();
      const xdgConfigHome = await mkdtemp(join(tmpdir(), "loopx-abort-xdg-"));
      extraTempDirs.push(xdgConfigHome);
      const marker = join(project.dir, "abort-unreadable-env-should-not-run.txt");
      const localEnv = join(project.dir, "unreadable.env");
      const globalEnvDir = join(xdgConfigHome, "loopx");
      const globalEnv = join(globalEnvDir, "env");
      await createStopWorkflow("ralph", marker);
      await writeFile(localEnv, "A=1\n", "utf-8");
      await mkdir(globalEnvDir, { recursive: true });
      await writeFile(globalEnv, "A=1\n", "utf-8");
      await chmod(localEnv, 0o000);
      await chmod(globalEnv, 0o000);

      const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const variants = [
  ["T-API-65c", { cwd: projectDir, envFile: "unreadable.env", maxIterations: 1 }],
  ["T-API-65r", { cwd: projectDir, maxIterations: 1 }],
];
const results = [];
for (const [id, baseOptions] of variants) {
  for (const surface of ["run", "promise"]) {
    const controller = new AbortController();
    controller.abort();
    const options = { ...baseOptions, signal: controller.signal };
    let rejected = false;
    let message = "";
    if (surface === "run") {
      const gen = run("ralph", options);
      try { await gen.next(); } catch (error) {
        rejected = true;
        message = String(error?.message ?? error);
      }
    } else {
      try { await runPromise("ralph", options); } catch (error) {
        rejected = true;
        message = String(error?.message ?? error);
      }
    }
    results.push({ id, surface, rejected, abortMessage: /abort/i.test(message) });
  }
}
console.log(JSON.stringify({ results, markerExists: existsSync(${JSON.stringify(marker)}) }));
`;
      const result = await runAPIDriver("node", driverCode, {
        env: { TMPDIR: tmpParent, XDG_CONFIG_HOME: xdgConfigHome },
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      for (const entry of parsed.results) {
        expect(entry).toMatchObject({ rejected: true, abortMessage: true });
      }
      expect(parsed.markerExists).toBe(false);
      expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
    },
  );

  it.skipIf(IS_ROOT)(
    "T-API-65d/T-API-65n: pre-aborted signals beat tmpdir-creation failure",
    async () => {
      project = await createTempProject();
      const badTmpParent = await mkdtemp(join(tmpdir(), "loopx-abort-bad-tmp-"));
      extraTempDirs.push(badTmpParent);
      const impossibleTmp = join(badTmpParent, "missing-child");
      const marker = join(project.dir, "abort-tmpdir-should-not-run.txt");
      await createStopWorkflow("ralph", marker);
      await chmod(badTmpParent, 0o555);

      const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const results = [];
for (const surface of ["run", "promise"]) {
  const controller = new AbortController();
  controller.abort();
  const options = { cwd: projectDir, maxIterations: 1, signal: controller.signal };
  let rejected = false;
  let message = "";
  if (surface === "run") {
    const gen = run("ralph", options);
    try { await gen.next(); } catch (error) {
      rejected = true;
      message = String(error?.message ?? error);
    }
  } else {
    try { await runPromise("ralph", options); } catch (error) {
      rejected = true;
      message = String(error?.message ?? error);
    }
  }
  results.push({ surface, rejected, abortMessage: /abort/i.test(message) });
}
console.log(JSON.stringify({ results, markerExists: existsSync(${JSON.stringify(marker)}) }));
`;
      const result = await runAPIDriver("node", driverCode, {
        env: { TMPDIR: impossibleTmp },
      });

      await chmod(badTmpParent, 0o755).catch(() => {});
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      for (const entry of parsed.results) {
        expect(entry).toMatchObject({ rejected: true, abortMessage: true });
      }
      expect(parsed.markerExists).toBe(false);
      expect(lingeringLoopxRunDirs(badTmpParent)).toEqual([]);
    },
  );

  it("T-API-65s/T-API-65t: pre-aborted signals beat discovery validation failures", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const marker = join(project.dir, "abort-discovery-validation-should-not-run.txt");
    await createStopWorkflow("ralph", marker);
    await createWorkflowScript(
      project,
      "broken",
      "check",
      ".sh",
      "#!/bin/bash\nprintf '{\"stop\":true}'\n",
    );
    await createWorkflowScript(
      project,
      "broken",
      "check",
      ".ts",
      "process.stdout.write(JSON.stringify({ stop: true }));\n",
    );
    await createWorkflowScript(
      project,
      "-bad-workflow",
      "index",
      ".sh",
      "#!/bin/bash\nprintf '{\"stop\":true}'\n",
    );
    await createWorkflowScript(
      project,
      "badscript",
      "-bad",
      ".sh",
      "#!/bin/bash\nprintf '{\"stop\":true}'\n",
    );

    const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const results = [];
for (const surface of ["run", "promise"]) {
  const controller = new AbortController();
  controller.abort();
  const options = { cwd: projectDir, maxIterations: 1, signal: controller.signal };
  let rejected = false;
  let message = "";
  if (surface === "run") {
    const gen = run("ralph", options);
    try { await gen.next(); } catch (error) {
      rejected = true;
      message = String(error?.message ?? error);
    }
  } else {
    try { await runPromise("ralph", options); } catch (error) {
      rejected = true;
      message = String(error?.message ?? error);
    }
  }
  results.push({ surface, rejected, abortMessage: /abort/i.test(message) });
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

  it("T-API-65u/T-API-65u2/T-API-65u3: duck-signal call-time abort beats later pre-iteration failures", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const marker = join(project.dir, "abort-duck-precedence-should-not-run.txt");
    await createStopWorkflow("other", marker);

    const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const signals = [
  ["T-API-65u", () => ({
    aborted: false,
    addEventListener(type, fn) {
      if (type === "abort") {
        this.aborted = true;
        fn();
      }
    },
  })],
  ["T-API-65u2", () => ({
    aborted: false,
    addEventListener(type, fn) {
      if (type === "abort") fn();
    },
  })],
  ["T-API-65u3", () => ({
    aborted: true,
    addEventListener() {},
  })],
];
const failures = [
  ["missing-env", "other", { cwd: projectDir, envFile: "nonexistent.env", maxIterations: 1 }],
  ["missing-workflow", "ralph", { cwd: projectDir, maxIterations: 1 }],
];
const results = [];
for (const [id, makeSignal] of signals) {
  for (const [failure, target, baseOptions] of failures) {
    for (const surface of ["run", "promise"]) {
      const options = { ...baseOptions, signal: makeSignal() };
      let rejected = false;
      let message = "";
      if (surface === "run") {
        const gen = run(target, options);
        try { await gen.next(); } catch (error) {
          rejected = true;
          message = String(error?.message ?? error);
        }
      } else {
        try { await runPromise(target, options); } catch (error) {
          rejected = true;
          message = String(error?.message ?? error);
        }
      }
      results.push({ id, failure, surface, rejected, abortMessage: /abort/i.test(message) });
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
      expect(entry).toMatchObject({ rejected: true, abortMessage: true });
    }
    expect(parsed.markerExists).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
  });

  it("T-API-65x/T-API-65y: pre-aborted signals still surface abort with workflow-level version warnings present", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const marker = join(project.dir, "abort-version-warning-should-not-run.txt");
    await createStopWorkflow("ralph", marker);
    await createWorkflowPackageJson(project, "ralph", {
      dependencies: { loopx: ">=999.0.0" },
    });

    const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const results = [];
for (const surface of ["run", "promise"]) {
  const controller = new AbortController();
  controller.abort();
  const options = { cwd: projectDir, maxIterations: 1, signal: controller.signal };
  let rejected = false;
  let message = "";
  if (surface === "run") {
    const gen = run("ralph", options);
    try { await gen.next(); } catch (error) {
      rejected = true;
      message = String(error?.message ?? error);
    }
  } else {
    try { await runPromise("ralph", options); } catch (error) {
      rejected = true;
      message = String(error?.message ?? error);
    }
  }
  results.push({ surface, rejected, abortMessage: /abort/i.test(message) });
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

  it.skipIf(IS_ROOT)(
    "T-API-67/T-API-67a/T-API-67b/T-API-67c/T-API-67d/T-API-67e/T-API-67f/T-API-67g: cwd/envFile shape errors precede project-root-dependent failures",
    async () => {
      project = await createTempProject();
      const tmpParent = await makeTmpParent();
      const noLoopxDir = await mkdtemp(join(tmpdir(), "loopx-order-no-loopx-"));
      const badTmpParent = await mkdtemp(join(tmpdir(), "loopx-order-bad-tmp-"));
      const xdgConfigHome = await mkdtemp(join(tmpdir(), "loopx-order-xdg-"));
      extraTempDirs.push(noLoopxDir, badTmpParent, xdgConfigHome);
      const badTmp = join(badTmpParent, "missing-child");
      const globalEnvDir = join(xdgConfigHome, "loopx");
      const globalEnv = join(globalEnvDir, "env");
      const marker = join(project.dir, "cwd-envfile-order-should-not-run.txt");
      await createStopWorkflow("ralph", marker);
      await mkdir(globalEnvDir, { recursive: true });
      await writeFile(globalEnv, "A=1\n", "utf-8");
      await chmod(globalEnv, 0o000);
      await chmod(badTmpParent, 0o555);

      const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const noLoopxDir = ${JSON.stringify(noLoopxDir)};
const badTmp = ${JSON.stringify(badTmp)};
const xdgConfigHome = ${JSON.stringify(xdgConfigHome)};
const originalCwd = process.cwd();
const originalTmp = process.env.TMPDIR;
const originalXdg = process.env.XDG_CONFIG_HOME;

function resetEnv() {
  process.chdir(originalCwd);
  if (originalTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmp;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
}

function configureDownstream(kind) {
  resetEnv();
  const config = { target: "ralph", cwd: projectDir };
  if (kind === "discovery") config.cwd = noLoopxDir;
  if (kind === "env-load") process.env.XDG_CONFIG_HOME = xdgConfigHome;
  if (kind === "target-resolution") config.target = "missing-workflow";
  if (kind === "tmpdir") process.env.TMPDIR = badTmp;
  return config;
}

function makeOptions(field, downstream) {
  const config = configureDownstream(downstream);
  const options = { cwd: config.cwd, maxIterations: 1 };
  if (field === "cwd-invalid") options.cwd = 42;
  if (field === "cwd-getter") {
    delete options.cwd;
    Object.defineProperty(options, "cwd", {
      enumerable: true,
      get() { throw new Error("cwd-getter-boom"); },
    });
  }
  if (field === "envFile-invalid") options.envFile = 42;
  if (field === "envFile-getter") {
    Object.defineProperty(options, "envFile", {
      enumerable: true,
      get() { throw new Error("envFile-getter-boom"); },
    });
  }
  return { target: config.target, options };
}

const fields = ["cwd-invalid", "cwd-getter", "envFile-invalid", "envFile-getter"];
const downstreams = ["discovery", "env-load", "target-resolution", "tmpdir"];
const results = [];
for (const field of fields) {
  for (const downstream of downstreams) {
    for (const surface of ["run", "promise"]) {
      const { target, options } = makeOptions(field, downstream);
      let rejected = false;
      let message = "";
      try {
        if (surface === "run") {
          const gen = run(target, options);
          await gen.next();
        } else {
          await runPromise(target, options);
        }
      } catch (error) {
        rejected = true;
        message = String(error?.message ?? error);
      } finally {
        resetEnv();
      }
      const expectedError =
        field === "cwd-getter" ? /cwd-getter-boom/.test(message) :
        field === "envFile-getter" ? /envFile-getter-boom/.test(message) :
        field === "cwd-invalid" ? /cwd/i.test(message) :
        /envFile|env file/i.test(message);
      results.push({ field, downstream, surface, rejected, expectedError, message });
    }
  }
}
console.log(JSON.stringify({ results, markerExists: existsSync(${JSON.stringify(marker)}) }));
`;
      const result = await runAPIDriver("node", driverCode, {
        cwd: project.dir,
        env: { TMPDIR: tmpParent },
      });

      await chmod(badTmpParent, 0o755).catch(() => {});
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      for (const entry of parsed.results) {
        expect(entry.rejected).toBe(true);
        expect(entry.expectedError).toBe(true);
      }
      expect(parsed.markerExists).toBe(false);
    },
  );
});
