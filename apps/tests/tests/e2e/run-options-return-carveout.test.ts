import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
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

describe("TEST-SPEC §9.1 pre-first-next return carve-out", () => {
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
    const parent = await mkdtemp(join(tmpdir(), "loopx-return-carveout-"));
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

  it("T-API-68/T-API-68a/T-API-68b/T-API-68c/T-API-68d/T-API-68e/T-API-68f/T-API-68h/T-API-68i/T-API-68j/T-API-68k/T-API-68l/T-API-68m/T-API-68n/T-API-68s/T-API-68s2/T-API-68v: return() first suppresses captured errors and abort observations", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const noLoopxDir = await mkdtemp(join(tmpdir(), "loopx-return-no-loopx-"));
    extraTempDirs.push(noLoopxDir);
    const marker = join(project.dir, "return-carveout-should-not-run.txt");
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
  Object.defineProperty(opts, field, {
    enumerable: true,
    get() { throw new Error(message); },
  });
  return opts;
}

function preAbortedSignal() {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

function liveAbortVariant() {
  const controller = new AbortController();
  return {
    options: { cwd: projectDir, signal: controller.signal },
    afterRun() { controller.abort(); },
    value: "my-return-value",
  };
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
  ["T-API-68", undefined, {}, undefined],
  ["T-API-68a", "ralph", { cwd: noLoopxDir }, undefined],
  ["T-API-68b", "ralph", { cwd: projectDir, envFile: "nonexistent.env" }, undefined],
  ["T-API-68c", "ralph", { cwd: projectDir, maxIterations: -1 }, undefined],
  ["T-API-68d", "ralph", { cwd: projectDir, signal: preAbortedSignal() }, undefined],
  ["T-API-68f", undefined, {}, "my-return-value"],
  ["T-API-68h", "ralph", throwingOptions("env", "evil-env-getter"), undefined],
  ["T-API-68k", "ralph", throwingOptions("signal", "evil-signal-getter"), undefined],
  ["T-API-68l", "ralph", throwingOptions("cwd", "evil-cwd-getter"), undefined],
  ["T-API-68m", "ralph", throwingOptions("envFile", "evil-envFile-getter"), undefined],
  ["T-API-68n", "ralph", throwingOptions("maxIterations", "evil-maxIterations-getter"), undefined],
  ["T-API-68i-options-null", "ralph", null, undefined],
  ["T-API-68i-options-array", "ralph", [], undefined],
  ["T-API-68i-options-function", "ralph", () => {}, undefined],
  ["T-API-68i-options-number", "ralph", 42, undefined],
  ["T-API-68i-signal-shape", "ralph", { cwd: projectDir, signal: "not-a-signal" }, undefined],
  ["T-API-68i-cwd-type", "ralph", { cwd: 42 }, undefined],
  ["T-API-68i-envFile-type", "ralph", { cwd: projectDir, envFile: 42 }, undefined],
  ["T-API-68i-max-fraction", "ralph", { cwd: projectDir, maxIterations: 1.5 }, undefined],
  ["T-API-68i-max-nan", "ralph", { cwd: projectDir, maxIterations: NaN }, undefined],
  ["T-API-68i-max-infinity", "ralph", { cwd: projectDir, maxIterations: Infinity }, undefined],
  ["T-API-68i-max-null", "ralph", { cwd: projectDir, maxIterations: null }, undefined],
  ["T-API-68i-max-string", "ralph", { cwd: projectDir, maxIterations: "1" }, undefined],
  ["T-API-68i-env-shape", "ralph", { cwd: projectDir, env: [] }, undefined],
  ["T-API-68i-env-value", "ralph", { cwd: projectDir, env: { KEY: 42 } }, undefined],
  ["T-API-68i-env-ownKeys", "ralph", { cwd: projectDir, env: new Proxy({}, { ownKeys() { throw new Error("ownKeys-trap-boom"); } }) }, undefined],
  ["T-API-68i-env-entry-getter", "ralph", { cwd: projectDir, env: Object.defineProperty({}, "KEY", { enumerable: true, get() { throw new Error("env-entry-getter-boom"); } }) }, undefined],
  ["T-API-68i-env-descriptor", "ralph", { cwd: projectDir, env: new Proxy({ A: "a" }, { getOwnPropertyDescriptor() { throw new Error("descriptor-trap-boom"); } }) }, undefined],
  ["T-API-68i-env-get", "ralph", { cwd: projectDir, env: new Proxy({ A: "a" }, { ownKeys() { return ["A"]; }, getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; }, get() { throw new Error("get-trap-boom"); } }) }, undefined],
  ["T-API-68i-missing-workflow", "missing-workflow", { cwd: projectDir }, undefined],
  ["T-API-68i-missing-script", "ralph:missing", { cwd: projectDir }, undefined],
  ["T-API-68i-missing-index", "noindex", { cwd: projectDir }, undefined],
  ["T-API-68i-target-syntax", "a:b:c", { cwd: projectDir }, undefined],
  ["T-API-68s", "ralph", { cwd: projectDir, signal: reentrantDuck(true), maxIterations: 1 }, "my-return-value"],
  ["T-API-68s2", "ralph", { cwd: projectDir, signal: reentrantDuck(false), maxIterations: 1 }, "my-return-value"],
  ["T-API-68v", "ralph", { cwd: projectDir, signal: { aborted: true, addEventListener() {} }, maxIterations: 1 }, "my-return-value"],
];

const live = liveAbortVariant();
variants.push(["T-API-68j", "ralph", live.options, live.value, live.afterRun]);

const results = [];
for (const [id, target, options, value, afterRun] of variants) {
  let threw = false;
  let result;
  let exhausted;
  try {
    const gen = target === undefined ? run(target, options) : run(target, options);
    if (afterRun) afterRun();
    result = await gen.return(value);
    exhausted = await gen.next();
  } catch (error) {
    threw = true;
    result = { message: String(error?.message ?? error) };
  }
  results.push({ id, threw, result, exhausted });
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
      expect(entry.threw).toBe(false);
      expect(entry.result.done).toBe(true);
      if (
        ["T-API-68f", "T-API-68j", "T-API-68s", "T-API-68s2", "T-API-68v"].includes(
          entry.id,
        )
      ) {
        expect(entry.result.value).toBe("my-return-value");
      }
      expect(entry.exhausted).toEqual({ done: true });
    }
    expect(parsed.markerExists).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
    expect(result.stderr).toBe("");
  });

  it.skipIf(IS_ROOT)(
    "T-API-68g/T-API-68o/T-API-68u: return() first suppresses tmpdir and unreadable env-file failures",
    async () => {
      project = await createTempProject();
      const badTmpParent = await mkdtemp(join(tmpdir(), "loopx-return-bad-tmp-"));
      const xdgConfigHome = await mkdtemp(join(tmpdir(), "loopx-return-xdg-"));
      extraTempDirs.push(badTmpParent, xdgConfigHome);
      const badTmp = join(badTmpParent, "missing-child");
      const marker = join(project.dir, "return-unreadable-should-not-run.txt");
      const localEnv = join(project.dir, "local.env");
      const globalEnvDir = join(xdgConfigHome, "loopx");
      const globalEnv = join(globalEnvDir, "env");
      await createStopWorkflow(marker);
      await writeFile(localEnv, "OK=fine\n", "utf-8");
      await mkdir(globalEnvDir, { recursive: true });
      await writeFile(globalEnv, "OK=fine\n", "utf-8");
      await chmod(localEnv, 0o000);
      await chmod(globalEnv, 0o000);
      await chmod(badTmpParent, 0o555);

      const driverCode = `
import { existsSync } from "node:fs";
import { run } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const variants = [
  ["T-API-68g", "ralph", { cwd: projectDir }],
  ["T-API-68o", "ralph", { cwd: projectDir }],
  ["T-API-68u", "ralph", { cwd: projectDir, envFile: ${JSON.stringify(localEnv)} }],
];
const results = [];
for (const [id, target, options] of variants) {
  let threw = false;
  let result;
  try {
    result = await run(target, options).return(undefined);
  } catch (error) {
    threw = true;
    result = { message: String(error?.message ?? error) };
  }
  results.push({ id, threw, result });
}
console.log(JSON.stringify({ results, markerExists: existsSync(${JSON.stringify(marker)}) }));
`;
      const result = await runAPIDriver("node", driverCode, {
        cwd: project.dir,
        env: {
          TMPDIR: badTmp,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
      });

      await chmod(badTmpParent, 0o755).catch(() => {});
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      for (const entry of parsed.results) {
        expect(entry.threw).toBe(false);
        expect(entry.result).toEqual({ done: true });
      }
      expect(parsed.markerExists).toBe(false);
      expect(lingeringLoopxRunDirs(badTmpParent)).toEqual([]);
      expect(result.stderr).toBe("");
    },
  );

  it("T-API-68p/T-API-68q/T-API-68r/T-API-68t: return() first suppresses env, package, and discovery warnings", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const xdgConfigHome = await mkdtemp(join(tmpdir(), "loopx-return-warning-xdg-"));
    extraTempDirs.push(xdgConfigHome);
    const marker = join(project.dir, "return-warning-should-not-run.txt");
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
import { run } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const variants = [
  ["T-API-68p", { cwd: projectDir, envFile: ${JSON.stringify(localEnv)} }],
  ["T-API-68q", { cwd: projectDir }],
  ["T-API-68r", { cwd: projectDir }],
  ["T-API-68t", { cwd: projectDir }],
];
const results = [];
for (const [id, options] of variants) {
  let threw = false;
  let result;
  try {
    result = await run("ralph", options).return(undefined);
  } catch (error) {
    threw = true;
    result = { message: String(error?.message ?? error) };
  }
  results.push({ id, threw, result });
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
      expect(entry.threw).toBe(false);
      expect(entry.result).toEqual({ done: true });
    }
    expect(parsed.markerExists).toBe(false);
    expect(lingeringLoopxRunDirs(tmpParent)).toEqual([]);
    expect(result.stderr).toBe("");
  });
});
