import { afterEach, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runAPIDriver } from "../helpers/api-driver.js";

const IS_ROOT =
  typeof process.getuid === "function" && process.getuid() === 0;

describe("TEST-SPEC §9.1 pre-first-next throw carve-out", () => {
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
    const parent = await mkdtemp(join(tmpdir(), "loopx-throw-carveout-"));
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

  it("T-API-69/T-API-69a/T-API-69b/T-API-69c/T-API-69e/T-API-69f/T-API-69g/T-API-69h/T-API-69i/T-API-69j/T-API-69k/T-API-69l/T-API-69m/T-API-69r/T-API-69r2/T-API-69u: throw() first surfaces consumer error and suppresses pre-iteration failures", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const noLoopxDir = await mkdtemp(join(tmpdir(), "loopx-throw-no-loopx-"));
    extraTempDirs.push(noLoopxDir);
    const marker = join(project.dir, "throw-carveout-should-not-run.txt");
    await createStopWorkflow(marker);
    await createWorkflowScript(
      project,
      "noindex",
      "check",
      ".sh",
      "#!/bin/bash\nprintf '{\"stop\":true}'\n",
    );

    const driverCode = `
import { existsSync } from "node:fs";
import { run } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const noLoopxDir = ${JSON.stringify(noLoopxDir)};
function throwingOptions(field, message) {
  const opts = { cwd: projectDir };
  Object.defineProperty(opts, field, { enumerable: true, get() { throw new Error(message); } });
  return opts;
}
function preAbortedSignal() {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}
function liveAbortVariant() {
  const controller = new AbortController();
  return { options: { cwd: projectDir, signal: controller.signal }, afterRun() { controller.abort(); } };
}
function reentrantDuck(mutates) {
  return {
    aborted: false,
    addEventListener(type, fn) {
      if (type === "abort") {
        if (mutates) this.aborted = true;
        fn();
      }
    },
  };
}
const variants = [
  ["T-API-69", undefined, {}],
  ["T-API-69a", "ralph", { cwd: projectDir, envFile: "nonexistent.env" }],
  ["T-API-69b", "ralph", { cwd: projectDir, signal: preAbortedSignal() }],
  ["T-API-69e", "ralph", throwingOptions("env", "evil-env-getter")],
  ["T-API-69f", "ralph", { cwd: noLoopxDir }],
  ["T-API-69g-missing-workflow", "missing-workflow", { cwd: projectDir }],
  ["T-API-69g-missing-script", "ralph:missing", { cwd: projectDir }],
  ["T-API-69g-missing-index", "noindex", { cwd: projectDir }],
  ["T-API-69h-options-null", "ralph", null],
  ["T-API-69h-options-array", "ralph", []],
  ["T-API-69h-options-function", "ralph", () => {}],
  ["T-API-69h-options-number", "ralph", 42],
  ["T-API-69h-signal-shape", "ralph", { cwd: projectDir, signal: "not-a-signal" }],
  ["T-API-69h-cwd-type", "ralph", { cwd: 42 }],
  ["T-API-69h-envFile-type", "ralph", { cwd: projectDir, envFile: 42 }],
  ["T-API-69h-max-negative", "ralph", { cwd: projectDir, maxIterations: -1 }],
  ["T-API-69h-max-fraction", "ralph", { cwd: projectDir, maxIterations: 1.5 }],
  ["T-API-69h-max-nan", "ralph", { cwd: projectDir, maxIterations: NaN }],
  ["T-API-69h-max-infinity", "ralph", { cwd: projectDir, maxIterations: Infinity }],
  ["T-API-69h-max-null", "ralph", { cwd: projectDir, maxIterations: null }],
  ["T-API-69h-max-string", "ralph", { cwd: projectDir, maxIterations: "1" }],
  ["T-API-69h-env-shape", "ralph", { cwd: projectDir, env: [] }],
  ["T-API-69h-env-value", "ralph", { cwd: projectDir, env: { KEY: 42 } }],
  ["T-API-69h-env-ownKeys", "ralph", { cwd: projectDir, env: new Proxy({}, { ownKeys() { throw new Error("ownKeys-trap-boom"); } }) }],
  ["T-API-69h-env-entry-getter", "ralph", { cwd: projectDir, env: Object.defineProperty({}, "KEY", { enumerable: true, get() { throw new Error("env-entry-getter-boom"); } }) }],
  ["T-API-69h-env-descriptor", "ralph", { cwd: projectDir, env: new Proxy({ A: "a" }, { getOwnPropertyDescriptor() { throw new Error("descriptor-trap-boom"); } }) }],
  ["T-API-69h-env-get", "ralph", { cwd: projectDir, env: new Proxy({ A: "a" }, { ownKeys() { return ["A"]; }, getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; }, get() { throw new Error("get-trap-boom"); } }) }],
  ["T-API-69h-target-syntax", "a:b:c", { cwd: projectDir }],
  ["T-API-69j", "ralph", throwingOptions("signal", "evil-signal-getter")],
  ["T-API-69k", "ralph", throwingOptions("cwd", "evil-cwd-getter")],
  ["T-API-69l", "ralph", throwingOptions("envFile", "evil-envFile-getter")],
  ["T-API-69m", "ralph", throwingOptions("maxIterations", "evil-maxIterations-getter")],
  ["T-API-69r", "ralph", { cwd: projectDir, signal: reentrantDuck(true), maxIterations: 1 }],
  ["T-API-69r2", "ralph", { cwd: projectDir, signal: reentrantDuck(false), maxIterations: 1 }],
  ["T-API-69u", "ralph", { cwd: projectDir, signal: { aborted: true, addEventListener() {} }, maxIterations: 1 }],
];
const live = liveAbortVariant();
variants.push(["T-API-69i", "ralph", live.options, live.afterRun]);

const results = [];
for (const [id, target, options, afterRun] of variants) {
  let message = "";
  try {
    const gen = target === undefined ? run(target, options) : run(target, options);
    if (afterRun) afterRun();
    await gen.throw(new Error("my-err"));
  } catch (error) {
    message = String(error?.message ?? error);
  }
  results.push({
    id,
    consumerError: /my-err/.test(message),
    abortError: /abort/i.test(message),
    message,
  });
}
console.log(JSON.stringify({ results, markerExists: existsSync(${JSON.stringify(marker)}) }));
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: tmpParent },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    for (const entry of parsed.results) {
      expect(entry.consumerError).toBe(true);
      expect(entry.abortError).toBe(false);
    }
    expect(parsed.markerExists).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
    expect(result.stderr).toBe("");
  });

  it.skipIf(IS_ROOT)(
    "T-API-69d/T-API-69n/T-API-69t: throw() first suppresses tmpdir and unreadable env-file failures",
    async () => {
      project = await createTempProject();
      const badTmpParent = await mkdtemp(join(tmpdir(), "loopx-throw-bad-tmp-"));
      const xdgConfigHome = await mkdtemp(join(tmpdir(), "loopx-throw-xdg-"));
      extraTempDirs.push(badTmpParent, xdgConfigHome);
      const badTmp = join(badTmpParent, "missing-child");
      const marker = join(project.dir, "throw-unreadable-should-not-run.txt");
      const localEnv = join(project.dir, "local.env");
      const globalEnvDir = join(xdgConfigHome, "loopx");
      await createStopWorkflow(marker);
      await writeFile(localEnv, "OK=fine\n", "utf-8");
      await mkdir(globalEnvDir, { recursive: true });
      await writeFile(join(globalEnvDir, "env"), "OK=fine\n", "utf-8");
      await chmod(localEnv, 0o000);
      await chmod(join(globalEnvDir, "env"), 0o000);
      await chmod(badTmpParent, 0o555);

      const driverCode = `
import { existsSync } from "node:fs";
import { run } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const variants = [
  ["T-API-69d", { cwd: projectDir }],
  ["T-API-69n", { cwd: projectDir }],
  ["T-API-69t", { cwd: projectDir, envFile: ${JSON.stringify(localEnv)} }],
];
const results = [];
for (const [id, options] of variants) {
  let message = "";
  try { await run("ralph", options).throw(new Error("my-err")); }
  catch (error) { message = String(error?.message ?? error); }
  results.push({ id, consumerError: /my-err/.test(message), message });
}
console.log(JSON.stringify({ results, markerExists: existsSync(${JSON.stringify(marker)}) }));
`;
      const result = await runAPIDriver("node", driverCode, {
        cwd: project.dir,
        env: { TMPDIR: badTmp, XDG_CONFIG_HOME: xdgConfigHome },
      });

      await chmod(badTmpParent, 0o755).catch(() => {});
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      for (const entry of parsed.results) {
        expect(entry.consumerError).toBe(true);
      }
      expect(parsed.markerExists).toBe(false);
      expect(lingeringLoopxRunDirs(badTmpParent)).toEqual([]);
      expect(result.stderr).toBe("");
    },
  );

  it("T-API-69o/T-API-69p/T-API-69q/T-API-69s: throw() first suppresses env, package, and discovery warnings", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const xdgConfigHome = await mkdtemp(join(tmpdir(), "loopx-throw-warning-xdg-"));
    extraTempDirs.push(xdgConfigHome);
    const marker = join(project.dir, "throw-warning-should-not-run.txt");
    const localEnv = join(project.dir, "local-warning.env");
    const globalEnvDir = join(xdgConfigHome, "loopx");
    await createStopWorkflow(marker);
    await writeFile(localEnv, "1BAD=bad\nOK=fine\n", "utf-8");
    await mkdir(globalEnvDir, { recursive: true });
    await writeFile(join(globalEnvDir, "env"), "1BAD=bad\nOK=fine\n", "utf-8");
    await writeFile(
      join(project.loopxDir, "ralph", "package.json"),
      JSON.stringify({ dependencies: { loopx: ">=999.0.0" } }),
      "utf-8",
    );
    await createWorkflowScript(project, "broken", "check", ".sh", "#!/bin/bash\nprintf '{\"stop\":true}'\n");
    await createWorkflowScript(project, "broken", "check", ".ts", "process.stdout.write(JSON.stringify({ stop: true }));\n");
    await createWorkflowScript(project, "-bad-workflow", "index", ".sh", "#!/bin/bash\nprintf '{\"stop\":true}'\n");
    await createWorkflowScript(project, "badscript", "-bad", ".sh", "#!/bin/bash\nprintf '{\"stop\":true}'\n");

    const driverCode = `
import { existsSync } from "node:fs";
import { run } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const variants = [
  ["T-API-69o", { cwd: projectDir, envFile: ${JSON.stringify(localEnv)} }],
  ["T-API-69p", { cwd: projectDir }],
  ["T-API-69q", { cwd: projectDir }],
  ["T-API-69s", { cwd: projectDir }],
];
const results = [];
for (const [id, options] of variants) {
  let message = "";
  try { await run("ralph", options).throw(new Error("my-err")); }
  catch (error) { message = String(error?.message ?? error); }
  results.push({ id, consumerError: /my-err/.test(message), message });
}
console.log(JSON.stringify({ results, markerExists: existsSync(${JSON.stringify(marker)}) }));
`;
    const result = await runAPIDriver("node", driverCode, {
      cwd: project.dir,
      env: { TMPDIR: tmpParent, XDG_CONFIG_HOME: xdgConfigHome },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    for (const entry of parsed.results) {
      expect(entry.consumerError).toBe(true);
    }
    expect(parsed.markerExists).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
    expect(result.stderr).toBe("");
  });
});
