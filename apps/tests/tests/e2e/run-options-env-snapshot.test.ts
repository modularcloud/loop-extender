import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runAPIDriver } from "../helpers/api-driver.js";

describe("TEST-SPEC §8.1/§9 inherited environment snapshot timing", () => {
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

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    extraTempDirs.push(dir);
    return dir;
  }

  async function writeGlobalEnv(base: string, entries: Record<string, string>): Promise<void> {
    const dir = join(base, "loopx");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "env"),
      Object.entries(entries)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
      "utf-8",
    );
  }

  it("T-API-70: runPromise has no pre-first-next consumer-cancellation carve-out", async () => {
    project = await createTempProject();
    const noLoopxDir = await makeTempDir("loopx-run-promise-no-loopx-");
    const marker = join(project.dir, "run-promise-no-carveout-should-not-run.txt");
    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".sh",
      `#!/bin/bash
printf ran >> "${marker}"
printf '{"stop":true}'
`,
    );

    const driverCode = `
import { runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
const noLoopxDir = ${JSON.stringify(noLoopxDir)};
function preAbortedOptions() {
  const controller = new AbortController();
  controller.abort();
  return { cwd: projectDir, maxIterations: 1, signal: controller.signal };
}
const variants = [
  ["invalid-target", undefined, { cwd: projectDir }],
  ["missing-loopx", "ralph", { cwd: noLoopxDir }],
  ["missing-envFile", "ralph", { cwd: projectDir, envFile: "nonexistent.env" }],
  ["invalid-maxIterations", "ralph", { cwd: projectDir, maxIterations: -1 }],
  ["pre-aborted-signal", "ralph", preAbortedOptions()],
];
const results = [];
for (const [name, target, options] of variants) {
  let syncThrow = false;
  let rejected = false;
  let returnedPromise = false;
  try {
    const promise = runPromise(target, options);
    returnedPromise = !!promise && typeof promise.then === "function";
    try { await promise; } catch { rejected = true; }
  } catch {
    syncThrow = true;
  }
  results.push({ name, syncThrow, returnedPromise, rejected });
}
console.log(JSON.stringify(results));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    for (const entry of JSON.parse(result.stdout)) {
      expect(entry).toMatchObject({
        syncThrow: false,
        returnedPromise: true,
        rejected: true,
      });
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("T-API-71/T-API-71a: run() captures inherited env lazily at first next and reuses it", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "run-env-observations.json");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const observations = existsSync(marker)
  ? JSON.parse(readFileSync(marker, "utf-8"))
  : [];
observations.push(process.env.MYVAR ?? "<unset>");
writeFileSync(marker, JSON.stringify(observations));
process.stdout.write(JSON.stringify({ stop: observations.length >= 2 }));
`,
    );

    const driverCode = `
import { run } from "loopx";
process.env.MYVAR = "A";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
process.env.MYVAR = "B";
await gen.next();
process.env.MYVAR = "C";
await gen.next();
console.log(JSON.stringify({ final: process.env.MYVAR }));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual(["B", "B"]);
    expect(JSON.parse(result.stdout)).toEqual({ final: "C" });
  });

  it("T-API-72/T-API-72a: runPromise() captures inherited env eagerly and reuses it", async () => {
    project = await createTempProject();
    const marker = join(project.dir, "run-promise-env-observations.json");
    const release = join(project.dir, "release-second-iteration.flag");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const release = ${JSON.stringify(release)};
const observations = existsSync(marker)
  ? JSON.parse(readFileSync(marker, "utf-8"))
  : [];
observations.push(process.env.MYVAR ?? "<unset>");
writeFileSync(marker, JSON.stringify(observations));
if (observations.length === 1) {
  while (!existsSync(release)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  process.stdout.write("{}");
} else {
  process.stdout.write(JSON.stringify({ stop: true }));
}
`,
    );

    const driverCode = `
import { existsSync, writeFileSync } from "node:fs";
import { runPromise } from "loopx";
async function waitFor(path) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for first observation");
}
process.env.MYVAR = "A";
const promise = runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
process.env.MYVAR = "B";
await waitFor(${JSON.stringify(marker)});
process.env.MYVAR = "C";
writeFileSync(${JSON.stringify(release)}, "");
await promise;
console.log(JSON.stringify({ final: process.env.MYVAR }));
`;
    const result = await runAPIDriver("node", driverCode, {
      timeout: 45_000,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual(["A", "A"]);
    expect(JSON.parse(result.stdout)).toEqual({ final: "C" });
  });

  it("T-API-73/T-API-73a: XDG_CONFIG_HOME global env path resolution is lazy for run() and eager for runPromise()", async () => {
    project = await createTempProject();
    const xdgA = await makeTempDir("loopx-xdg-a-");
    const xdgB = await makeTempDir("loopx-xdg-b-");
    const marker = join(project.dir, "xdg-timing-observations.json");
    await writeGlobalEnv(xdgA, { MARKER: "from-A" });
    await writeGlobalEnv(xdgB, { MARKER: "from-B" });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const observations = existsSync(marker)
  ? JSON.parse(readFileSync(marker, "utf-8"))
  : [];
observations.push(process.env.MARKER ?? "<unset>");
writeFileSync(marker, JSON.stringify(observations));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgA)};
const gen = run("ralph", { cwd: projectDir, maxIterations: 1 });
process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgB)};
await gen.next();

process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgA)};
const promise = runPromise("ralph", { cwd: projectDir, maxIterations: 1 });
process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgB)};
await promise;
console.log(JSON.stringify({ final: process.env.XDG_CONFIG_HOME }));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual([
      "from-B",
      "from-A",
    ]);
    expect(JSON.parse(result.stdout)).toEqual({ final: xdgB });
  });

  it("T-API-73b/T-API-73c: HOME fallback global env path resolution is lazy for run() and eager for runPromise()", async () => {
    project = await createTempProject();
    const homeA = await makeTempDir("loopx-home-a-");
    const homeB = await makeTempDir("loopx-home-b-");
    const marker = join(project.dir, "home-timing-observations.json");
    await writeGlobalEnv(join(homeA, ".config"), { MARKER: "from-A" });
    await writeGlobalEnv(join(homeB, ".config"), { MARKER: "from-B" });

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const observations = existsSync(marker)
  ? JSON.parse(readFileSync(marker, "utf-8"))
  : [];
observations.push(process.env.MARKER ?? "<unset>");
writeFileSync(marker, JSON.stringify(observations));
process.stdout.write(JSON.stringify({ stop: true }));
`,
    );

    const driverCode = `
import { run, runPromise } from "loopx";
const projectDir = ${JSON.stringify(project.dir)};
delete process.env.XDG_CONFIG_HOME;
process.env.HOME = ${JSON.stringify(homeA)};
const gen = run("ralph", { cwd: projectDir, maxIterations: 1 });
process.env.HOME = ${JSON.stringify(homeB)};
await gen.next();

delete process.env.XDG_CONFIG_HOME;
process.env.HOME = ${JSON.stringify(homeA)};
const promise = runPromise("ralph", { cwd: projectDir, maxIterations: 1 });
process.env.HOME = ${JSON.stringify(homeB)};
await promise;
console.log(JSON.stringify({ final: process.env.HOME }));
`;
    const result = await runAPIDriver("node", driverCode);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual([
      "from-B",
      "from-A",
    ]);
    expect(JSON.parse(result.stdout)).toEqual({ final: homeB });
  });

  it("T-API-74/T-API-74a/T-API-74b/T-API-74c: global env-file path resolution is reused across iterations", async () => {
    project = await createTempProject();
    const xdgA = await makeTempDir("loopx-xdg-reuse-a-");
    const xdgB = await makeTempDir("loopx-xdg-reuse-b-");
    const homeA = await makeTempDir("loopx-home-reuse-a-");
    const homeB = await makeTempDir("loopx-home-reuse-b-");
    await writeGlobalEnv(xdgA, { MARKER: "from-A" });
    await writeGlobalEnv(xdgB, { MARKER: "from-B" });
    await writeGlobalEnv(join(homeA, ".config"), { MARKER: "from-A" });
    await writeGlobalEnv(join(homeB, ".config"), { MARKER: "from-B" });

    const marker = join(project.dir, "path-reuse-observations.json");
    const release = join(project.dir, "path-reuse-release.flag");

    await createWorkflowScript(
      project,
      "ralph",
      "index",
      ".ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const release = ${JSON.stringify(release)};
const observations = existsSync(marker)
  ? JSON.parse(readFileSync(marker, "utf-8"))
  : [];
observations.push(process.env.MARKER ?? "<unset>");
writeFileSync(marker, JSON.stringify(observations));
if (observations.length % 2 === 1) {
  while (!existsSync(release)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  writeFileSync(release, "used-" + observations.length);
  process.stdout.write("{}");
} else {
  process.stdout.write(JSON.stringify({ stop: true }));
}
`,
    );

    const driverCode = `
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { run, runPromise } from "loopx";
async function waitForObservationCount(count) {
  const marker = ${JSON.stringify(marker)};
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      const observed = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(marker, "utf-8")));
      if (observed.length >= count) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for observation " + count);
}
function release() {
  writeFileSync(${JSON.stringify(release)}, "");
}
function resetRelease() {
  try { unlinkSync(${JSON.stringify(release)}); } catch {}
}
const projectDir = ${JSON.stringify(project.dir)};

process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgA)};
let gen = run("ralph", { cwd: projectDir, maxIterations: 2 });
let firstNext = gen.next();
await waitForObservationCount(1);
process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgB)};
release();
await firstNext;
await gen.next();
resetRelease();

process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgA)};
let promise = runPromise("ralph", { cwd: projectDir, maxIterations: 2 });
await waitForObservationCount(3);
process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgB)};
release();
await promise;
resetRelease();

delete process.env.XDG_CONFIG_HOME;
process.env.HOME = ${JSON.stringify(homeA)};
gen = run("ralph", { cwd: projectDir, maxIterations: 2 });
firstNext = gen.next();
await waitForObservationCount(5);
process.env.HOME = ${JSON.stringify(homeB)};
release();
await firstNext;
await gen.next();
resetRelease();

delete process.env.XDG_CONFIG_HOME;
process.env.HOME = ${JSON.stringify(homeA)};
promise = runPromise("ralph", { cwd: projectDir, maxIterations: 2 });
await waitForObservationCount(7);
process.env.HOME = ${JSON.stringify(homeB)};
release();
await promise;
console.log(JSON.stringify({
  home: process.env.HOME,
  xdg: process.env.XDG_CONFIG_HOME ?? null,
}));
`;
    const result = await runAPIDriver("node", driverCode, {
      timeout: 60_000,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual([
      "from-A",
      "from-A",
      "from-A",
      "from-A",
      "from-A",
      "from-A",
      "from-A",
      "from-A",
    ]);
    expect(JSON.parse(result.stdout)).toEqual({
      home: homeB,
      xdg: null,
    });
  });
});
