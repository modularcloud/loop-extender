import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runAPIDriver, runAPIDriverLive } from "../helpers/api-driver.js";

const IS_ROOT =
  typeof process.getuid === "function" && process.getuid() === 0;

describe("TEST-SPEC programmatic API remaining gap coverage", () => {
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
    const parent = await mkdtemp(join(tmpdir(), "loopx-api-gap-"));
    extraTempDirs.push(parent);
    return parent;
  }

  function lingeringLoopxRunDirs(parent: string): string[] {
    return readdirSync(parent).filter(
      (name) =>
        name.startsWith("loopx-") && !name.startsWith("loopx-nodepath-shim-"),
    );
  }

  function processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function createStopWorkflow(marker?: string): Promise<void> {
    await createWorkflowScript(
      project!,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
${marker ? `printf ran >> "${marker}"` : ""}
printf '{"stop":true}'
`,
    );
  }

  async function createManualShellWorkflow(
    projectDir: string,
    body: string,
  ): Promise<void> {
    const workflowDir = join(projectDir, ".loopx", "ralph");
    await mkdir(workflowDir, { recursive: true });
    const scriptPath = join(workflowDir, "index.sh");
    await writeFile(scriptPath, `#!/bin/bash\n${body}\n`, "utf-8");
    await chmod(scriptPath, 0o755);
  }

  async function createEnvObservationProject(
    projectDir: string,
    marker: string,
    id: string,
    envValue: string,
  ): Promise<void> {
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "local.env"), `MARKER_VAR=${envValue}\n`);
    await createManualShellWorkflow(
      projectDir,
      `node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ id: process.argv[2], root: process.env.LOOPX_PROJECT_ROOT, marker: process.env.MARKER_VAR ?? null }))' ${JSON.stringify(marker)} ${JSON.stringify(id)}
printf '{"stop":true,"id":"%s","marker":"%s"}' ${JSON.stringify(id)} "$MARKER_VAR"`,
    );
  }

  it("T-API-10i: abort during pre-iteration before first child spawn wins and cleans tmpdir", async () => {
    project = await createTempProject();
    const scriptMarker = join(project.dir, "should-not-run");
    await createStopWorkflow(scriptMarker);

    const driverCode = `
import { existsSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const marker = ${JSON.stringify(join(project.dir, "pre-first-spawn.json"))};
async function waitForMarker() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(marker)) return JSON.parse(readFileSync(marker, "utf-8"));
    await delay(20);
  }
  throw new Error("timed out waiting for pre-iteration marker");
}
async function runCase(surface) {
  rmSync(marker, { force: true });
  const controller = new AbortController();
  let operation;
  if (surface === "run") {
    const gen = run("ralph", { cwd: projectDir, signal: controller.signal });
    operation = gen.next();
  } else {
    operation = runPromise("ralph", { cwd: projectDir, signal: controller.signal });
  }
  const pause = await waitForMarker();
  controller.abort();
  let rejected = false;
  let message = "";
  try {
    await operation;
  } catch (err) {
    rejected = true;
    message = err?.name || err?.message || String(err);
  }
  return {
    surface,
    rejected,
    message,
    tmpExistsAfter: existsSync(pause.tmpDir),
  };
}
const first = await runCase("run");
await delay(50);
const second = await runCase("promise");
console.log(JSON.stringify({ first, second, scriptRan: existsSync(${JSON.stringify(scriptMarker)}) }));
`;
    const result = await runAPIDriver("node", driverCode, {
      env: {
        NODE_ENV: "test",
        LOOPX_TEST_PREITERATION_PAUSE: "pre-first-child-spawn",
        LOOPX_TEST_PREITERATION_PAUSE_MARKER: join(
          project.dir,
          "pre-first-spawn.json",
        ),
      },
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    for (const entry of [parsed.first, parsed.second]) {
      expect(entry.rejected).toBe(true);
      expect(entry.message).toMatch(/abort/i);
      expect(entry.tmpExistsAfter).toBe(false);
    }
    expect(parsed.scriptRan).toBe(false);
  });

  it("T-API-10j: abort concurrent with partial tmpdir creation failure wins on API surfaces", async () => {
    project = await createTempProject();
    await createStopWorkflow();

    const driverCode = `
import { existsSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const marker = ${JSON.stringify(join(project.dir, "tmpdir-fault-pause.json"))};
async function waitForMarker() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(marker)) return JSON.parse(readFileSync(marker, "utf-8"));
    await delay(20);
  }
  throw new Error("timed out waiting for tmpdir fault marker");
}
async function runCase(surface) {
  rmSync(marker, { force: true });
  const controller = new AbortController();
  let operation;
  if (surface === "run") {
    const gen = run("ralph", { cwd: projectDir, signal: controller.signal });
    operation = gen.next();
  } else {
    operation = runPromise("ralph", { cwd: projectDir, signal: controller.signal });
  }
  const pause = await waitForMarker();
  controller.abort();
  let rejected = false;
  let message = "";
  try {
    await operation;
  } catch (err) {
    rejected = true;
    message = err?.name || err?.message || String(err);
  }
  return {
    surface,
    rejected,
    message,
    tmpExistsAfter: existsSync(pause.tmpDir),
  };
}
const first = await runCase("run");
const second = await runCase("promise");
console.log(JSON.stringify({ first, second }));
`;
    const result = await runAPIDriver("node", driverCode, {
      env: {
        NODE_ENV: "test",
        LOOPX_TEST_TMPDIR_FAULT: "mode-secure-fail",
        LOOPX_TEST_PREITERATION_PAUSE: "tmpdir-created-before-fault",
        LOOPX_TEST_PREITERATION_PAUSE_MARKER: join(
          project.dir,
          "tmpdir-fault-pause.json",
        ),
      },
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    for (const entry of [parsed.first, parsed.second]) {
      expect(entry.rejected).toBe(true);
      expect(entry.message).toMatch(/abort/i);
      expect(entry.message).not.toMatch(/mode-secure-fail/);
      expect(entry.tmpExistsAfter).toBe(false);
    }
  });

  it("T-API-24c/T-API-24d/T-API-24e/T-API-24f/T-API-24g/T-API-24h: invalid maxIterations values reject on both API surfaces", async () => {
    project = await createTempProject();
    await createStopWorkflow();

    const driverCode = `
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const variants = [
  ["infinity", Infinity],
  ["null", null],
  ["string", "1"],
];
const results = [];
for (const [name, maxIterations] of variants) {
  let runRejected = false;
  try {
    const gen = run("ralph", { cwd: projectDir, maxIterations });
    await gen.next();
  } catch { runRejected = true; }

  let promiseRejected = false;
  try {
    await runPromise("ralph", { cwd: projectDir, maxIterations });
  } catch { promiseRejected = true; }
  results.push({ name, runRejected, promiseRejected });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({
        runRejected: true,
        promiseRejected: true,
      });
    }
  });

  it("T-API-24i/T-API-24j: maxIterations counts intra-workflow and cross-workflow goto hops", async () => {
    project = await createTempProject();
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf '{"goto":"check","result":"A"}'
`,
    );
    await createWorkflowScript(
      project,
      "ralph",
      "check",
      ".sh",
      `#!/bin/bash
printf '{"goto":"other:step","result":"B"}'
`,
    );
    await createWorkflowScript(
      project,
      "other",
      "step",
      ".sh",
      `#!/bin/bash
printf '{"stop":true,"result":"C"}'
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
async function collectRun(maxIterations) {
  const outputs = [];
  for await (const output of run("ralph", { cwd: projectDir, maxIterations })) {
    outputs.push(output.result);
  }
  return outputs;
}
const promise2 = (await runPromise("ralph", { cwd: projectDir, maxIterations: 2 })).map((o) => o.result);
const promise3 = (await runPromise("ralph", { cwd: projectDir, maxIterations: 3 })).map((o) => o.result);
const run2 = await collectRun(2);
const run3 = await collectRun(3);
console.log(JSON.stringify({ promise2, promise3, run2, run3 }));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      promise2: ["A", "B"],
      promise3: ["A", "B", "C"],
      run2: ["A", "B"],
      run3: ["A", "B", "C"],
    });
  });

  it("T-API-19a: runPromise rejects instead of resolving partial outputs when a later iteration fails", async () => {
    project = await createTempProject();
    const startMarker = join(project.dir, "start-ran.txt");
    await createWorkflowScript(
      project,
      "start",
      "index",
      ".sh",
      `#!/bin/bash
printf ran > ${JSON.stringify(startMarker)}
printf '{"goto":"finish:index","result":"first-iteration-marker"}'
`,
    );
    await createWorkflowScript(
      project,
      "finish",
      "index",
      ".sh",
      `#!/bin/bash
exit 1
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
let resolved;
let message = "";
try {
  resolved = await runPromise("start", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5 });
} catch (error) {
  rejected = true;
  message = String(error?.message ?? error);
}
console.log(JSON.stringify({ rejected, resolved, message }));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.rejected).toBe(true);
    expect(parsed.resolved).toBeUndefined();
    expect(parsed.message).toMatch(/exit|failed|non.?zero|1/i);
    expect(readFileSync(startMarker, "utf-8")).toBe("ran");
  });

  it.skipIf(IS_ROOT)(
    "T-API-20d2/T-API-20e2: unreadable envFile rejects on normal run and runPromise execution paths",
    async () => {
      project = await createTempProject();
      const envFile = join(project.dir, "unreadable.env");
      await writeFile(envFile, "MYVAR=value\n", "utf-8");
      await chmod(envFile, 0o000);
      await createStopWorkflow();

      const driverCode = `
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const results = [];
{
  const gen = run("ralph", { cwd: projectDir, envFile: "unreadable.env", maxIterations: 1 });
  let rejected = false;
  try { await gen.next(); } catch { rejected = true; }
  results.push({ id: "T-API-20d2", rejected });
}
{
  let rejected = false;
  try { await runPromise("ralph", { cwd: projectDir, envFile: "unreadable.env", maxIterations: 1 }); } catch { rejected = true; }
  results.push({ id: "T-API-20e2", rejected });
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver("node", driverCode, {
        cwd: project.dir,
      });

      await chmod(envFile, 0o644).catch(() => {});
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        { id: "T-API-20d2", rejected: true },
        { id: "T-API-20e2", rejected: true },
      ]);
    },
  );

  it("T-API-07b/T-API-07c: relative cwd resolution is lexical and preserves symlink spelling", async () => {
    const parent = await makeTmpParent();
    const lexicalProject = join(parent, "project");
    const realProject = join(parent, "real-project");
    const linkProject = join(parent, "link-project");
    const lexicalMarker = join(parent, "lexical-root.txt");
    const symlinkMarker = join(parent, "symlink-root.txt");

    await createManualShellWorkflow(
      lexicalProject,
      `printf '%s' "$LOOPX_PROJECT_ROOT" > ${JSON.stringify(lexicalMarker)}
printf '{"stop":true}'`,
    );
    await createManualShellWorkflow(
      realProject,
      `printf '%s' "$LOOPX_PROJECT_ROOT" > ${JSON.stringify(symlinkMarker)}
printf '{"stop":true}'`,
    );
    await symlink(realProject, linkProject, "dir");

    const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", { cwd: "./sub/../project", maxIterations: 1 });
await runPromise("ralph", { cwd: "link-project", maxIterations: 1 });
`;
    const result = await runAPIDriver("node", driverCode, { cwd: parent });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(lexicalMarker, "utf-8")).toBe(resolve(parent, "project"));
    expect(readFileSync(lexicalMarker, "utf-8")).not.toContain("..");
    expect(readFileSync(symlinkMarker, "utf-8")).toBe(resolve(parent, "link-project"));
    expect(readFileSync(symlinkMarker, "utf-8")).not.toBe(resolve(parent, "real-project"));
    const realStat = statSync(realProject);
    const linkStat = statSync(linkProject);
    expect([linkStat.dev, linkStat.ino]).toEqual([realStat.dev, realStat.ino]);
  });

  it("T-API-08k2/T-API-08m2: runPromise maxIterations:0 parses malformed env files and resolves [] with warnings", async () => {
    project = await createTempProject();
    const xdgConfigHome = await makeTmpParent();
    const globalEnvDir = join(xdgConfigHome, "loopx");
    const localEnv = join(project.dir, "malformed.env");
    await mkdir(globalEnvDir, { recursive: true });
    await writeFile(localEnv, "1BAD=val\nOK=fine\n", "utf-8");
    await writeFile(join(globalEnvDir, "env"), "1BAD=val\nOK=fine\n", "utf-8");
    await createStopWorkflow();

    const driverCode = `
import { runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const local = await runPromise("ralph", {
  cwd: projectDir,
  maxIterations: 0,
  envFile: "malformed.env",
});
const global = await runPromise("ralph", {
  cwd: projectDir,
  maxIterations: 0,
});
console.log(JSON.stringify({ local, global }));
`;
    const result = await runAPIDriver("node", driverCode, {
      env: { XDG_CONFIG_HOME: xdgConfigHome },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ local: [], global: [] });
    expect(result.stderr).toMatch(/warn|invalid|ignored|malformed/i);
  });

  it.skipIf(IS_ROOT)(
    "T-API-08l2: runPromise maxIterations:0 with unreadable global env file rejects",
    async () => {
      project = await createTempProject();
      const xdgConfigHome = await makeTmpParent();
      const globalEnvDir = join(xdgConfigHome, "loopx");
      await mkdir(globalEnvDir, { recursive: true });
      const globalEnv = join(globalEnvDir, "env");
      await writeFile(globalEnv, "OK=fine\n", "utf-8");
      await chmod(globalEnv, 0o000);
      await createStopWorkflow();

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try {
  await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    maxIterations: 0,
  });
} catch {
  rejected = true;
}
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver("node", driverCode, {
        env: { XDG_CONFIG_HOME: xdgConfigHome },
      });

      await chmod(globalEnv, 0o644).catch(() => {});
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ rejected: true });
    },
  );

  it("T-API-09d/T-API-09e: return() and throw() after a yield complete silently when no child is active", async () => {
    project = await createTempProject();
    const counter = join(project.dir, "yield-cancel-count.txt");
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const counter = ${JSON.stringify(counter)};
const count = existsSync(counter) ? Number(readFileSync(counter, "utf-8")) + 1 : 1;
writeFileSync(counter, String(count));
process.stdout.write(JSON.stringify({ result: "ok" }));
`,
    );

    const driverCode = `
import { unlinkSync } from "node:fs";
import { run } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const counter = ${JSON.stringify(counter)};

const returnGen = run("ralph", { cwd: projectDir, maxIterations: 10 });
const firstReturn = await returnGen.next();
const returnSettled = await returnGen.return(undefined);
const returnCount = await import("node:fs").then((fs) => fs.readFileSync(counter, "utf-8"));

unlinkSync(counter);
const throwGen = run("ralph", { cwd: projectDir, maxIterations: 10 });
const firstThrow = await throwGen.next();
let throwRejected = false;
let throwSettled;
try {
  throwSettled = await throwGen.throw(new Error("consumer-err"));
} catch {
  throwRejected = true;
}
const throwCount = await import("node:fs").then((fs) => fs.readFileSync(counter, "utf-8"));
console.log(JSON.stringify({
  firstReturn,
  returnSettled,
  returnCount,
  firstThrow,
  throwSettled,
  throwRejected,
  throwCount,
}));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.firstReturn.value.result).toBe("ok");
    expect(parsed.returnSettled.done).toBe(true);
    expect(parsed.returnCount).toBe("1");
    expect(parsed.firstThrow.value.result).toBe("ok");
    expect(parsed.throwRejected).toBe(false);
    expect(parsed.throwSettled.done).toBe(true);
    expect(parsed.throwCount).toBe("1");
  });

  it("T-API-10b2/T-API-10c2/T-API-10c3/T-API-10c4/T-API-10c5/T-API-10c6/T-API-10c7/T-API-10c8/T-API-10c9/T-API-10c10: abort before first iteration beats maxIterations and prevents spawn", async () => {
    project = await createTempProject();
    const tmpParent = await makeTmpParent();
    const marker = join(project.dir, "abort-before-first-should-not-run.txt");
    await createStopWorkflow(marker);

    const driverCode = `
import { existsSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
async function observe(id, promise) {
  let rejected = false;
  let message = "";
  try { await promise; } catch (error) {
    rejected = true;
    message = String(error?.message ?? error);
  }
  return { id, rejected, abortMessage: /abort/i.test(message) };
}
const results = [];

{
  const controller = new AbortController();
  const gen = run("ralph", { cwd: projectDir, maxIterations: 1, signal: controller.signal });
  controller.abort();
  results.push(await observe("T-API-10b2", gen.next()));
}
{
  const controller = new AbortController();
  controller.abort();
  results.push(await observe("T-API-10c2", runPromise("ralph", { cwd: projectDir, maxIterations: 0, signal: controller.signal })));
}
{
  const controller = new AbortController();
  controller.abort();
  const gen = run("ralph", { cwd: projectDir, maxIterations: 0, signal: controller.signal });
  results.push(await observe("T-API-10c3", gen.next()));
}
{
  const controller = new AbortController();
  const gen = run("ralph", { cwd: projectDir, maxIterations: 0, signal: controller.signal });
  controller.abort();
  results.push(await observe("T-API-10c4", gen.next()));
}
{
  const controller = new AbortController();
  const promise = runPromise("ralph", { cwd: projectDir, maxIterations: 0, signal: controller.signal });
  controller.abort();
  results.push(await observe("T-API-10c5", promise));
}
{
  const controller = new AbortController();
  const promise = runPromise("ralph", { cwd: projectDir, maxIterations: 1, signal: controller.signal });
  controller.abort();
  results.push(await observe("T-API-10c6", promise));
}
{
  const duck = { aborted: true, addEventListener(type, fn) { if (type === "abort") this.listener = fn; } };
  const gen = run("ralph", { cwd: projectDir, maxIterations: 0, signal: duck });
  results.push(await observe("T-API-10c7", gen.next()));
}
{
  const duck = { aborted: true, addEventListener(type, fn) { if (type === "abort") this.listener = fn; } };
  results.push(await observe("T-API-10c8", runPromise("ralph", { cwd: projectDir, maxIterations: 0, signal: duck })));
}
{
  const duck = { aborted: false, addEventListener(type, fn) { if (type === "abort") { this.listener = fn; fn(); } } };
  const gen = run("ralph", { cwd: projectDir, maxIterations: 0, signal: duck });
  results.push(await observe("T-API-10c9", gen.next()));
}
{
  const duck = { aborted: false, addEventListener(type, fn) { if (type === "abort") { this.listener = fn; fn(); } } };
  results.push(await observe("T-API-10c10", runPromise("ralph", { cwd: projectDir, maxIterations: 0, signal: duck })));
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

  it("T-API-10d/T-API-10d-promise: AbortSignal terminates the active child process group on both API surfaces", async () => {
    project = await createTempProject();
    const runMarker = join(project.dir, "abort-run-pids.txt");
    const promiseMarker = join(project.dir, "abort-promise-pids.txt");
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
sleep 3600 &
printf '%s\\n' "$$" > "$LOOPX_PID_MARKER"
printf '%s\\n' "$!" >> "$LOOPX_PID_MARKER"
echo "ready" >&2
wait
`,
    );

    async function runCase(id: string, surface: "run" | "promise", marker: string) {
      const driverCode = `
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const marker = ${JSON.stringify(marker)};
async function observe(promise) {
  try {
    await promise;
    return { rejected: false, abortMessage: false };
  } catch (error) {
    return { rejected: true, abortMessage: /abort/i.test(String(error?.message ?? error)) };
  }
}
const controller = new AbortController();
let operation;
if (${JSON.stringify(surface)} === "run") {
  const gen = run("ralph", { cwd: projectDir, signal: controller.signal, env: { LOOPX_PID_MARKER: marker } });
  operation = observe(gen.next());
} else {
  operation = observe(runPromise("ralph", { cwd: projectDir, signal: controller.signal, env: { LOOPX_PID_MARKER: marker } }));
}
process.stdin.once("data", () => controller.abort());
const outcome = await operation;
console.log(JSON.stringify({ id: ${JSON.stringify(id)}, outcome }));
`;
      const live = await runAPIDriverLive("node", driverCode, { timeout: 15_000 });
      await live.waitForStderr("ready");
      const [childPid, grandchildPid] = readFileSync(marker, "utf-8")
        .trim()
        .split("\n")
        .map(Number);
      live.writeStdin("cancel\n");
      const result = await live.waitForExit(15_000);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).outcome).toEqual({
        rejected: true,
        abortMessage: true,
      });
      expect(processIsAlive(childPid!)).toBe(false);
      expect(processIsAlive(grandchildPid!)).toBe(false);
    }

    await runCase("T-API-10d", "run", runMarker);
    await runCase("T-API-10d-promise", "promise", promiseMarker);
  }, 40_000);

  it("T-API-10e/T-API-10e-promise: AbortSignal escalates to SIGKILL after the grace period on both API surfaces", async () => {
    project = await createTempProject();
    const runMarker = join(project.dir, "abort-run-ignore-pid.txt");
    const runTmpMarker = join(project.dir, "abort-run-tmpdir.txt");
    const promiseMarker = join(project.dir, "abort-promise-ignore-pid.txt");
    const promiseTmpMarker = join(project.dir, "abort-promise-tmpdir.txt");
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
trap '' TERM
printf '%s' "$$" > "$LOOPX_PID_MARKER"
printf '%s' "$LOOPX_TMPDIR" > "$LOOPX_TMPDIR_MARKER"
echo "ready" >&2
sleep 999999
`,
    );

    async function runCase(
      id: string,
      surface: "run" | "promise",
      marker: string,
      tmpMarker: string,
    ) {
      const driverCode = `
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const marker = ${JSON.stringify(marker)};
const tmpMarker = ${JSON.stringify(tmpMarker)};
async function observe(promise) {
  const start = Date.now();
  try {
    await promise;
    return { rejected: false, abortMessage: false, elapsed: Date.now() - start };
  } catch (error) {
    return { rejected: true, abortMessage: /abort/i.test(String(error?.message ?? error)), elapsed: Date.now() - start };
  }
}
const controller = new AbortController();
let operation;
if (${JSON.stringify(surface)} === "run") {
  const gen = run("ralph", { cwd: projectDir, signal: controller.signal, env: { LOOPX_PID_MARKER: marker, LOOPX_TMPDIR_MARKER: tmpMarker } });
  operation = gen.next();
} else {
  operation = runPromise("ralph", { cwd: projectDir, signal: controller.signal, env: { LOOPX_PID_MARKER: marker, LOOPX_TMPDIR_MARKER: tmpMarker } });
}
await new Promise((resolve) => process.stdin.once("data", resolve));
const observed = observe(operation);
controller.abort();
const outcome = await observed;
console.log(JSON.stringify({ id: ${JSON.stringify(id)}, outcome }));
`;
      const live = await runAPIDriverLive("node", driverCode, { timeout: 20_000 });
      await live.waitForStderr("ready");
      const childPid = Number(readFileSync(marker, "utf-8"));
      const observedTmpdir = readFileSync(tmpMarker, "utf-8");
      live.writeStdin("cancel\n");
      const result = await live.waitForExit(20_000);
      expect(result.exitCode).toBe(0);
      const outcome = JSON.parse(result.stdout).outcome;
      expect(outcome.rejected).toBe(true);
      expect(outcome.abortMessage).toBe(true);
      expect(outcome.elapsed).toBeGreaterThanOrEqual(4_000);
      expect(outcome.elapsed).toBeLessThan(8_000);
      expect(processIsAlive(childPid)).toBe(false);
      expect(existsSync(observedTmpdir)).toBe(false);
    }

    await runCase("T-API-10e", "run", runMarker, runTmpMarker);
    await runCase("T-API-10e-promise", "promise", promiseMarker, promiseTmpMarker);
  }, 50_000);

  it("T-API-10f/T-API-10f-throw: generator return() and throw() terminate the active child process group", async () => {
    project = await createTempProject();
    const returnMarker = join(project.dir, "return-process-group-pids.txt");
    const throwMarker = join(project.dir, "throw-process-group-pids.txt");
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
sleep 3600 &
printf '%s\\n' "$$" > "$LOOPX_PID_MARKER"
printf '%s\\n' "$!" >> "$LOOPX_PID_MARKER"
echo "ready" >&2
wait
`,
    );

    async function runCase(id: string, action: "return" | "throw", marker: string) {
      const driverCode = `
import { run } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const marker = ${JSON.stringify(marker)};
async function observe(promise) {
  try {
    const value = await promise;
    return { rejected: false, done: value?.done === true };
  } catch (error) {
    return { rejected: true, message: String(error?.message ?? error) };
  }
}
const gen = run("ralph", { cwd: projectDir, env: { LOOPX_PID_MARKER: marker } });
const nextP = observe(gen.next());
await new Promise((resolve) => process.stdin.once("data", resolve));
const cancelP = observe(${JSON.stringify(action)} === "return" ? gen.return(undefined) : gen.throw(new Error("consumer-err")));
const cancelOutcome = await cancelP;
const nextOutcome = await nextP;
console.log(JSON.stringify({ id: ${JSON.stringify(id)}, cancelOutcome, nextOutcome }));
`;
      const live = await runAPIDriverLive("node", driverCode, { timeout: 15_000 });
      await live.waitForStderr("ready");
      const [childPid, grandchildPid] = readFileSync(marker, "utf-8")
        .trim()
        .split("\n")
        .map(Number);
      live.writeStdin("cancel\n");
      const result = await live.waitForExit(15_000);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.cancelOutcome.rejected).toBe(false);
      expect(parsed.cancelOutcome.done).toBe(true);
      expect(processIsAlive(childPid!)).toBe(false);
      expect(processIsAlive(grandchildPid!)).toBe(false);
    }

    await runCase("T-API-10f", "return", returnMarker);
    await runCase("T-API-10f-throw", "throw", throwMarker);
  }, 40_000);

  it("T-API-10g/T-API-10h: generator return() and throw() escalate to SIGKILL and clean LOOPX_TMPDIR", async () => {
    project = await createTempProject();
    const returnMarker = join(project.dir, "return-ignore-pid.txt");
    const returnTmpMarker = join(project.dir, "return-ignore-tmpdir.txt");
    const throwMarker = join(project.dir, "throw-ignore-pid.txt");
    const throwTmpMarker = join(project.dir, "throw-ignore-tmpdir.txt");
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
trap '' TERM
printf '%s' "$$" > "$LOOPX_PID_MARKER"
printf '%s' "$LOOPX_TMPDIR" > "$LOOPX_TMPDIR_MARKER"
echo "ready" >&2
sleep 999999
`,
    );

    async function runCase(
      id: string,
      action: "return" | "throw",
      marker: string,
      tmpMarker: string,
    ) {
      const driverCode = `
import { run } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const marker = ${JSON.stringify(marker)};
const tmpMarker = ${JSON.stringify(tmpMarker)};
async function observe(promise) {
  const start = Date.now();
  try {
    const value = await promise;
    return { rejected: false, done: value?.done === true, elapsed: Date.now() - start };
  } catch (error) {
    return { rejected: true, message: String(error?.message ?? error), elapsed: Date.now() - start };
  }
}
const gen = run("ralph", { cwd: projectDir, env: { LOOPX_PID_MARKER: marker, LOOPX_TMPDIR_MARKER: tmpMarker } });
const nextP = observe(gen.next());
await new Promise((resolve) => process.stdin.once("data", resolve));
const cancelP = observe(${JSON.stringify(action)} === "return" ? gen.return(undefined) : gen.throw(new Error("consumer-err")));
const cancelOutcome = await cancelP;
const nextOutcome = await nextP;
console.log(JSON.stringify({ id: ${JSON.stringify(id)}, cancelOutcome, nextOutcome }));
`;
      const live = await runAPIDriverLive("node", driverCode, { timeout: 20_000 });
      await live.waitForStderr("ready");
      const childPid = Number(readFileSync(marker, "utf-8"));
      const observedTmpdir = readFileSync(tmpMarker, "utf-8");
      live.writeStdin("cancel\n");
      const result = await live.waitForExit(20_000);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.cancelOutcome.elapsed).toBeGreaterThanOrEqual(4_000);
      expect(parsed.cancelOutcome.elapsed).toBeLessThan(8_000);
      expect(processIsAlive(childPid)).toBe(false);
      expect(existsSync(observedTmpdir)).toBe(false);
      if (action === "return") {
        expect(parsed.cancelOutcome).toMatchObject({ rejected: false, done: true });
      } else {
        expect(parsed.cancelOutcome).toHaveProperty("rejected");
      }
    }

    await runCase("T-API-10g", "return", returnMarker, returnTmpMarker);
    await runCase("T-API-10h", "throw", throwMarker, throwTmpMarker);
  }, 50_000);

  it("T-API-21e/T-API-21e2: absolute envFile paths are used unchanged on both API surfaces", async () => {
    const parent = await makeTmpParent();
    const projectDir = join(parent, "project");
    const outsideDir = join(parent, "outside-envs");
    const marker = join(parent, "absolute-env-marker.json");
    const envFile = join(outsideDir, "absolute.env");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(envFile, "MARKER_VAR=absolute-path-win\n");
    await createEnvObservationProject(projectDir, marker, "absolute-project", "wrong-project-env");

    const driverCode = `
import { readFileSync } from "node:fs";
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(projectDir)};
const envFile = ${JSON.stringify(envFile)};
const marker = ${JSON.stringify(marker)};
const promiseOutputs = await runPromise("ralph", { cwd: projectDir, envFile, maxIterations: 1 });
const promiseMarker = JSON.parse(readFileSync(marker, "utf-8"));
const runOutputs = [];
for await (const output of run("ralph", { cwd: projectDir, envFile, maxIterations: 1 })) {
  runOutputs.push(output);
}
const runMarker = JSON.parse(readFileSync(marker, "utf-8"));
console.log(JSON.stringify({ promiseOutputs, promiseMarker, runOutputs, runMarker }));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.promiseMarker.marker).toBe("absolute-path-win");
    expect(parsed.runMarker.marker).toBe("absolute-path-win");
    expect(parsed.promiseOutputs[0]).toEqual({ stop: true });
    expect(parsed.runOutputs[0]).toEqual({ stop: true });
  });

  it("T-API-21f/T-API-21g/T-API-21h/T-API-21i/T-API-21j/T-API-21k: relative cwd and envFile are resolved at call time", async () => {
    const parent = await makeTmpParent();
    const atCall = join(parent, "projects-at-call");
    const atNext = join(parent, "projects-at-next");
    const projectAtCall = join(atCall, "my-project");
    const projectAtNext = join(atNext, "my-project");
    const noCwdAtCall = join(parent, "no-cwd-at-call");
    const noCwdAtNext = join(parent, "no-cwd-at-next");
    const marker = join(parent, "relative-resolution-marker.json");

    await createEnvObservationProject(projectAtCall, marker, "relative-project-A", "from-A");
    await createEnvObservationProject(projectAtNext, marker, "relative-project-B", "from-B");
    await createEnvObservationProject(noCwdAtCall, marker, "no-cwd-A", "from-A");
    await createEnvObservationProject(noCwdAtNext, marker, "no-cwd-B", "from-B");

    const driverCode = `
import { readFileSync } from "node:fs";
import { run, runPromise } from "loopx";
const atCall = ${JSON.stringify(atCall)};
const atNext = ${JSON.stringify(atNext)};
const noCwdAtCall = ${JSON.stringify(noCwdAtCall)};
const noCwdAtNext = ${JSON.stringify(noCwdAtNext)};
const marker = ${JSON.stringify(marker)};
const originalCwd = process.cwd();
const results = [];
function readMarker(id) {
  results.push({ case: id, ...JSON.parse(readFileSync(marker, "utf-8")) });
}
try {
  process.chdir(noCwdAtCall);
  const envRun = run("ralph", { envFile: "local.env", maxIterations: 1 });
  process.chdir(noCwdAtNext);
  await envRun.next();
  readMarker("T-API-21f");

  process.chdir(atCall);
  const cwdRun = run("ralph", { cwd: "./my-project", maxIterations: 1 });
  process.chdir(atNext);
  await cwdRun.next();
  readMarker("T-API-21g");

  process.chdir(noCwdAtCall);
  const envPromise = runPromise("ralph", { envFile: "local.env", maxIterations: 1 });
  process.chdir(noCwdAtNext);
  await envPromise;
  readMarker("T-API-21h");

  process.chdir(atCall);
  const cwdPromise = runPromise("ralph", { cwd: "./my-project", maxIterations: 1 });
  process.chdir(atNext);
  await cwdPromise;
  readMarker("T-API-21i");

  process.chdir(atCall);
  const combinedPromise = runPromise("ralph", { cwd: "./my-project", envFile: "local.env", maxIterations: 1 });
  process.chdir(atNext);
  await combinedPromise;
  readMarker("T-API-21j");

  process.chdir(atCall);
  const combinedRun = run("ralph", { cwd: "./my-project", envFile: "local.env", maxIterations: 1 });
  process.chdir(atNext);
  await combinedRun.next();
  readMarker("T-API-21k");
} finally {
  process.chdir(originalCwd);
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual([
      {
        case: "T-API-21f",
        id: "no-cwd-A",
        root: noCwdAtCall,
        marker: "from-A",
      },
      {
        case: "T-API-21g",
        id: "relative-project-A",
        root: projectAtCall,
        marker: null,
      },
      {
        case: "T-API-21h",
        id: "no-cwd-A",
        root: noCwdAtCall,
        marker: "from-A",
      },
      {
        case: "T-API-21i",
        id: "relative-project-A",
        root: projectAtCall,
        marker: null,
      },
      {
        case: "T-API-21j",
        id: "relative-project-A",
        root: projectAtCall,
        marker: "from-A",
      },
      {
        case: "T-API-21k",
        id: "relative-project-A",
        root: projectAtCall,
        marker: "from-A",
      },
    ]);
  });
});
