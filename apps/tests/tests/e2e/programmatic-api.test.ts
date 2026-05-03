import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  createTempProject,
  createWorkflowScript,
  createBashWorkflowScript,
  createWorkflowPackageJson,
  type TempProject,
} from "../helpers/fixtures.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { forEachRuntime } from "../helpers/runtime.js";
import {
  createEnvFile,
  writeEnvFileRaw,
  withGlobalEnv,
} from "../helpers/env.js";
import {
  counter,
  writePidToFile,
} from "../helpers/fixture-scripts.js";

// ---------------------------------------------------------------------------
// TEST-SPEC §4.9 — Programmatic API (ADR-0003 workflow model)
// Spec refs: 9.1–9.5
// Runtime-matrix methodology: all tests use runAPIDriver() to spawn a driver
// process under the target runtime so that `import { run } from "loopx"`
// exercises the real package exports for both Node and Bun.
// ---------------------------------------------------------------------------

// ─────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────

function getRunningVersion(): string {
  const pkgPath = resolve(process.cwd(), "node_modules/loopx/package.json");
  return JSON.parse(readFileSync(pkgPath, "utf-8")).version as string;
}

/** A semver range that is guaranteed NOT to be satisfied by the running loopx. */
const UNSATISFIED_RANGE = ">=999.0.0";
/** A value that is valid JSON but not a valid semver range. */
const INVALID_SEMVER = "not-a-range!!!";
/** Broken/unparseable JSON content. */
const BROKEN_JSON = "{broken";

// Warning predicates (tolerant, pattern-based — shape not phrasing).
// Mirrors the predicates in version-check.test.ts.

function hasVersionMismatchWarning(stderr: string, workflow: string): boolean {
  return (
    stderr.includes(workflow) &&
    /version|mismatch|range|satisf/i.test(stderr)
  );
}

function countVersionMismatchWarnings(stderr: string, workflow: string): number {
  return stderr
    .split("\n")
    .filter(
      (line) =>
        line.includes(workflow) &&
        /version|mismatch|range|satisf/i.test(line),
    ).length;
}

function hasInvalidJsonWarning(stderr: string, workflow: string): boolean {
  return (
    stderr.includes(workflow) &&
    /(invalid.*json|parse|parsing|package\.json)/i.test(stderr)
  );
}

function countInvalidJsonWarnings(stderr: string, workflow: string): number {
  return stderr
    .split("\n")
    .filter(
      (line) =>
        line.includes(workflow) &&
        /(invalid.*json|parse|parsing|package\.json)/i.test(line),
    ).length;
}

function hasInvalidSemverWarning(stderr: string, workflow: string): boolean {
  return (
    stderr.includes(workflow) &&
    /(semver|range|not.*(valid|parse))/i.test(stderr)
  );
}

function countInvalidSemverWarnings(stderr: string, workflow: string): number {
  return stderr
    .split("\n")
    .filter(
      (line) =>
        line.includes(workflow) &&
        /(semver|range|invalid)/i.test(line),
    ).length;
}

function hasUnreadableWarning(stderr: string, workflow: string): boolean {
  return (
    stderr.includes(workflow) &&
    /(unreadable|permission|EACCES|EPERM|cannot.*read|read.*fail|denied)/i.test(
      stderr,
    )
  );
}

function countUnreadableWarnings(stderr: string, workflow: string): number {
  return stderr
    .split("\n")
    .filter(
      (line) =>
        line.includes(workflow) &&
        /(unreadable|permission|EACCES|EPERM|cannot.*read|read.*fail|denied)/i.test(
          line,
        ),
    ).length;
}

function hasAnyPackageJsonWarning(stderr: string, workflow: string): boolean {
  return (
    hasInvalidJsonWarning(stderr, workflow) ||
    hasInvalidSemverWarning(stderr, workflow) ||
    hasUnreadableWarning(stderr, workflow)
  );
}

/** Restore read permissions recursively so cleanup doesn't leave stale files. */
function restorePerms(dir: string): void {
  try {
    execSync(`chmod -R u+rw "${dir}"`, { stdio: "ignore" });
  } catch {
    // best-effort
  }
}

/** Skip unreadable-file tests when running as root (chmod 000 is no-op). */
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

// ═════════════════════════════════════════════════════════════
// §4.9.1 — run() (AsyncGenerator)
// ═════════════════════════════════════════════════════════════

describe("SPEC: run() (AsyncGenerator)", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      restorePerms(project.dir);
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-01: run("ralph") returns async generator; next() yields Output.
    it("T-API-01: run() returns async generator, next() yields Output", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"hello"}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
const first = await gen.next();
const second = await gen.next();
console.log(JSON.stringify({
  firstDone: first.done,
  firstValue: first.value,
  secondDone: second.done,
}));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.firstDone).toBe(false);
      expect(parsed.firstValue).toHaveProperty("result", "hello");
      expect(parsed.secondDone).toBe(true);
    });

    // T-API-02: maxIterations: 3 yields 3 outputs.
    it("T-API-02: 3 iterations yield 3 outputs", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createBashWorkflowScript(project, "ralph", "index", counter(counterFile).replace(/^#!\/bin\/bash\n/, ""));

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 3 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(3);
      expect(outputs[0].result).toBe("1");
      expect(outputs[1].result).toBe("2");
      expect(outputs[2].result).toBe("3");
    });

    // T-API-03: stop:true completes the generator.
    it("T-API-03: stop:true completes the generator", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)} })) {
  results.push(output);
}
console.log(JSON.stringify({ count: results.length, hasStop: results[0]?.stop === true }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.count).toBe(1);
      expect(parsed.hasStop).toBe(true);
    });

    // T-API-04: maxIterations completes the generator.
    it("T-API-04: maxIterations completes the generator", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"iter"}'`);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5 })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(5);
    });

    // T-API-05: output from the final iteration is yielded before completion.
    it("T-API-05: final iteration output yielded before completion", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createBashWorkflowScript(project, "ralph", "index", counter(counterFile).replace(/^#!\/bin\/bash\n/, ""));

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
const first = await gen.next();
const second = await gen.next();
const third = await gen.next();
console.log(JSON.stringify({
  firstDone: first.done, firstResult: first.value?.result,
  secondDone: second.done, secondResult: second.value?.result,
  thirdDone: third.done,
}));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.firstDone).toBe(false);
      expect(parsed.firstResult).toBe("1");
      expect(parsed.secondDone).toBe(false);
      expect(parsed.secondResult).toBe("2");
      expect(parsed.thirdDone).toBe(true);
    });

    // T-API-06: breaking the for-await after the first yield prevents further iterations.
    it("T-API-06: break after first yield stops further iterations", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createBashWorkflowScript(project, "ralph", "index", counter(counterFile).replace(/^#!\/bin\/bash\n/, ""));

      const driverCode = `
import { run } from "loopx";
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 10 })) {
  break;
}
await new Promise(r => setTimeout(r, 500));
import { readFileSync } from "node:fs";
const count = readFileSync(${JSON.stringify(counterFile)}, "utf-8");
console.log(JSON.stringify({ count: count.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.count).toBe(1);
    });

    // T-API-07: cwd option resolves workflows relative to given cwd; cwd is project root;
    //           LOOPX_PROJECT_ROOT must equal the provided cwd value.
    it("T-API-07: cwd option resolves workflows relative to given cwd, LOOPX_PROJECT_ROOT set from cwd", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "root-marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_PROJECT_ROOT" > "${markerPath}"
printf '{"result":"from-cwd-project"}'`,
      );

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      // Run the driver from a DIFFERENT directory than project.dir (default consumerDir).
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("from-cwd-project");
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf-8")).toBe(project.dir);
    });

    // T-API-07a: RunOptions.cwd controls script execution cwd (project-root-unified per
    //            ADR-0004 §3 / SPEC 9.5). Script execution cwd equals the project root,
    //            and LOOPX_WORKFLOW_DIR exposes the workflow-relative path independently.
    it("T-API-07a: RunOptions.cwd controls script execution cwd (project-root-unified)", async () => {
      project = await createTempProject();
      const cwdMarker = join(project.dir, "cwd-marker.txt");
      const wfdirMarker = join(project.dir, "wfdir-marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$(/bin/pwd -P)" > "${cwdMarker}"
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfdirMarker}"
printf '{"stop":true}'`,
      );

      const workflowDir = join(project.loopxDir, "ralph");

      const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {}
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(existsSync(cwdMarker)).toBe(true);
      // Per SPEC 9.5 (rewritten by ADR-0004 §3): RunOptions.cwd specifies BOTH
      // the project root and the script execution cwd. The previous "cwd does
      // not control script execution cwd" disclaimer no longer applies.
      // /bin/pwd -P returns the kernel-canonical form, so compare against
      // realpath(project.dir).
      const actualCwd = readFileSync(cwdMarker, "utf-8");
      const expectedRoot = realpathSync(project.dir);
      expect(actualCwd).toBe(expectedRoot);
      expect(actualCwd).not.toBe(workflowDir);
      // The workflow-relative path is exposed via LOOPX_WORKFLOW_DIR, not cwd.
      expect(existsSync(wfdirMarker)).toBe(true);
      expect(readFileSync(wfdirMarker, "utf-8")).toBe(workflowDir);
    });

    // T-API-08: maxIterations: 0 → completes immediately, no yields, no child spawn.
    it("T-API-08: maxIterations: 0 yields nothing", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createBashWorkflowScript(project, "ralph", "index", counter(counterFile).replace(/^#!\/bin\/bash\n/, ""));

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(0);
      expect(existsSync(counterFile)).toBe(false);
    });

    // T-API-08a: run("nonexistent", { maxIterations: 0 }) — validation runs; generator throws.
    it("T-API-08a: run() with nonexistent workflow under maxIterations: 0 throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("nonexistent", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
let threw = false, message = "";
try { await gen.next(); } catch (e) { threw = true; message = e.message || String(e); }
console.log(JSON.stringify({ threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(true);
      expect(parsed.message).toMatch(/nonexistent/i);
    });

    // T-API-08b: runPromise("ralph", { maxIterations: 0 }) skips workflow version checking.
    it("T-API-08b: runPromise() maxIterations:0 skips workflow version check (unsatisfied range)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-08c: maxIterations:0 + workflow without index → throws on first next().
    it("T-API-08c: maxIterations:0 with workflow lacking index throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
let threw = false, message = "";
try { await gen.next(); } catch (e) { threw = true; message = e.message || String(e); }
console.log(JSON.stringify({ threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(true);
    });

    // T-API-08d: maxIterations:0 + workflow:missing script → throws on first next().
    it("T-API-08d: run(ralph:missing) maxIterations:0 throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph:missing", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
let threw = false, message = "";
try { await gen.next(); } catch (e) { threw = true; message = e.message || String(e); }
console.log(JSON.stringify({ threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-08e: maxIterations:0 + missing env file → generator throws on first next().
    it("T-API-08e: run() maxIterations:0 with missing envFile throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0, envFile: "missing.env" });
let threw = false, message = "";
try { await gen.next(); } catch (e) { threw = true; message = e.message || String(e); }
console.log(JSON.stringify({ threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-08f: runPromise maxIterations:0 with missing envFile → rejects.
    it("T-API-08f: runPromise() maxIterations:0 with missing envFile rejects", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try {
  await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0, envFile: "missing.env" });
} catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-08g: run() maxIterations:0 skips entire version-check path (invalid semver).
    it("T-API-08g: run() maxIterations:0 skips version check (invalid semver)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: INVALID_SEMVER },
      });

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(0);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-08h: maxIterations:0 — sibling same-base-name collision is fatal.
    it("T-API-08h: maxIterations:0 — sibling same-base-name collision throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      await createBashWorkflowScript(project, "broken", "check", `printf '{"stop":true}'`);
      await createWorkflowScript(project, "broken", "check", ".ts", `process.stdout.write('{"stop":true}');`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
let threw = false, message = "";
try { await gen.next(); } catch (e) { threw = true; message = e.message || String(e); }
console.log(JSON.stringify({ threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-08i: maxIterations:0 — sibling invalid script name is fatal.
    it("T-API-08i: maxIterations:0 — sibling invalid script name throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      await createBashWorkflowScript(project, "broken", "-bad", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-08j: maxIterations:0 — sibling invalid workflow name is fatal.
    it("T-API-08j: maxIterations:0 — sibling invalid workflow name throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      await createBashWorkflowScript(project, "-bad-workflow", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-08k: maxIterations:0 with malformed envFile → parser warning, no yields.
    it("T-API-08k: maxIterations:0 with malformed envFile parses env and warns (no yields)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      const envFilePath = join(project.dir, "malformed.env");
      await writeEnvFileRaw(envFilePath, "1BAD=val\n");

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0, envFile: "malformed.env" })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(0);
      expect(result.stderr).toMatch(/warning/i);
    });

    // T-API-08l: maxIterations:0 with unreadable global env file → generator throws.
    it.skipIf(IS_ROOT)("T-API-08l: maxIterations:0 with unreadable global env file throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project!, "ralph", "index", `printf '{"stop":true}'`);

      await withGlobalEnv({}, async () => {
        const globalEnvPath = join(process.env.XDG_CONFIG_HOME!, "loopx", "env");
        await chmod(globalEnvPath, 0o000);

        const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project!.dir)}, maxIterations: 0 });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME! },
        });

        // Best-effort: restore permissions so withGlobalEnv cleanup succeeds.
        try { await chmod(globalEnvPath, 0o644); } catch {}

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).threw).toBe(true);
      });
    });

    // T-API-08m: maxIterations:0 with malformed-but-readable global env file → parser warning.
    it("T-API-08m: maxIterations:0 with malformed global env file warns and yields nothing", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project!, "ralph", "index", `printf '{"stop":true}'`);

      await withGlobalEnv({}, async () => {
        const globalEnvPath = join(process.env.XDG_CONFIG_HOME!, "loopx", "env");
        await writeEnvFileRaw(globalEnvPath, "1BAD=val\n");

        const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project!.dir)}, maxIterations: 0 })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME! },
        });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toBe(0);
        expect(result.stderr).toMatch(/warning/i);
      });
    });

    // T-API-08n: runPromise("a:b:c", { maxIterations: 0 }) → rejects.
    it("T-API-08n: runPromise(a:b:c) maxIterations:0 rejects (malformed target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false, errorMsg = "";
try {
  await runPromise("a:b:c", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
} catch (e) { rejected = true; errorMsg = e.message || String(e); }
console.log(JSON.stringify({ rejected, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-08n1: run("a:b:c", { maxIterations: 0 }) → generator throws on first next().
    it("T-API-08n1: run(a:b:c) maxIterations:0 throws on first next() (malformed target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("a:b:c", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
let threw = false, message = "";
try { await gen.next(); } catch (e) { threw = true; message = e.message || String(e); }
console.log(JSON.stringify({ threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-08o: maxIterations:0 with unreadable workflow package.json → no yields, no warning.
    it.skipIf(IS_ROOT)("T-API-08o: maxIterations:0 with unreadable package.json — no warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      const pkgPath = await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
      });
      await chmod(pkgPath, 0o000);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(0);
      expect(hasUnreadableWarning(result.stderr, "ralph")).toBe(false);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-08p: maxIterations:0 with unreadable envFile → throws.
    it.skipIf(IS_ROOT)("T-API-08p: run() maxIterations:0 with unreadable envFile throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      const envFilePath = join(project.dir, "unreadable.env");
      await writeEnvFileRaw(envFilePath, "FOO=bar\n");
      await chmod(envFilePath, 0o000);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0, envFile: "unreadable.env" });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-08p2: runPromise — maxIterations:0 with unreadable envFile rejects.
    it.skipIf(IS_ROOT)("T-API-08p2: runPromise() maxIterations:0 with unreadable envFile rejects", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      const envFilePath = join(project.dir, "unreadable.env");
      await writeEnvFileRaw(envFilePath, "FOO=bar\n");
      await chmod(envFilePath, 0o000);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try {
  await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0, envFile: "unreadable.env" });
} catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-08q: maxIterations:0 with invalid JSON package.json → no yields, no warning.
    it("T-API-08q: maxIterations:0 with invalid-JSON package.json — no warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(0);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-08r: run("ralph:check") maxIterations:0 — no-index workflow valid.
    it("T-API-08r: run(ralph:check) maxIterations:0 completes with no yields (no-index workflow)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(0);
    });

    // T-API-08s: Normal-execution version mismatch warning via run() (unsatisfied range).
    it("T-API-08s: run() normal-execution emits version mismatch warning (unsatisfied range)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("ok");
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-08t: Cross-workflow first-entry version warning — goto into beta:index.
    it("T-API-08t: run() cross-workflow first-entry version warning (beta via goto)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "alpha", "index", `printf '{"goto":"beta:index"}'`);
      await createBashWorkflowScript(project, "beta", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "beta", {
        name: "beta",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("alpha", { cwd: ${JSON.stringify(project.dir)} })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countVersionMismatchWarnings(result.stderr, "beta")).toBe(1);
      expect(hasVersionMismatchWarning(result.stderr, "alpha")).toBe(false);
    });

    // T-API-08t2: Cross-workflow first-entry invalid-JSON warning via run() (goto into broken:index).
    it("T-API-08t2: run() cross-workflow first-entry invalid-JSON warning (broken via goto)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "clean", "index", `printf '{"goto":"broken:index"}'`);
      await createBashWorkflowScript(project, "broken", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "broken", BROKEN_JSON);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("clean", { cwd: ${JSON.stringify(project.dir)} })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countInvalidJsonWarnings(result.stderr, "broken")).toBe(1);
      expect(hasInvalidJsonWarning(result.stderr, "clean")).toBe(false);
    });

    // T-API-08t3: Cross-workflow first-entry unreadable package.json via run().
    it.skipIf(IS_ROOT)("T-API-08t3: run() cross-workflow first-entry unreadable package.json warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "clean", "index", `printf '{"goto":"broken:index"}'`);
      await createBashWorkflowScript(project, "broken", "index", `printf '{"stop":true}'`);
      const pkgPath = await createWorkflowPackageJson(project, "broken", {
        name: "broken",
        version: "1.0.0",
      });
      await chmod(pkgPath, 0o000);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("clean", { cwd: ${JSON.stringify(project.dir)} })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countUnreadableWarnings(result.stderr, "broken")).toBe(1);
      expect(hasUnreadableWarning(result.stderr, "clean")).toBe(false);
    });

    // T-API-08t4: Cross-workflow first-entry invalid-semver via run().
    it("T-API-08t4: run() cross-workflow first-entry invalid-semver warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "clean", "index", `printf '{"goto":"broken:index"}'`);
      await createBashWorkflowScript(project, "broken", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "broken", {
        name: "broken",
        version: "1.0.0",
        dependencies: { loopx: INVALID_SEMVER },
      });

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("clean", { cwd: ${JSON.stringify(project.dir)} })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countInvalidSemverWarnings(result.stderr, "broken")).toBe(1);
      expect(hasInvalidSemverWarning(result.stderr, "clean")).toBe(false);
    });

    // T-API-08t5: Cross-workflow first-entry version warning for no-index workflow via qualified goto.
    it("T-API-08t5: run() cross-workflow first-entry version warning (no-index target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "alpha", "index", `printf '{"goto":"beta:check"}'`);
      await createBashWorkflowScript(project, "beta", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "beta", {
        name: "beta",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("alpha", { cwd: ${JSON.stringify(project.dir)} })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countVersionMismatchWarnings(result.stderr, "beta")).toBe(1);
      expect(hasVersionMismatchWarning(result.stderr, "alpha")).toBe(false);
    });

    // T-API-08t6: Cross-workflow first-entry invalid-JSON warning for no-index via qualified goto.
    it("T-API-08t6: run() cross-workflow first-entry invalid-JSON warning (no-index target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "alpha", "index", `printf '{"goto":"beta:check"}'`);
      await createBashWorkflowScript(project, "beta", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "beta", BROKEN_JSON);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("alpha", { cwd: ${JSON.stringify(project.dir)} })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countInvalidJsonWarnings(result.stderr, "beta")).toBe(1);
      expect(hasInvalidJsonWarning(result.stderr, "alpha")).toBe(false);
    });

    // T-API-08t7: Cross-workflow first-entry unreadable warning for no-index via qualified goto.
    it.skipIf(IS_ROOT)("T-API-08t7: run() cross-workflow first-entry unreadable warning (no-index target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "alpha", "index", `printf '{"goto":"beta:check"}'`);
      await createBashWorkflowScript(project, "beta", "check", `printf '{"stop":true}'`);
      const pkgPath = await createWorkflowPackageJson(project, "beta", {
        name: "beta",
        version: "1.0.0",
      });
      await chmod(pkgPath, 0o000);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("alpha", { cwd: ${JSON.stringify(project.dir)} })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countUnreadableWarnings(result.stderr, "beta")).toBe(1);
      expect(hasUnreadableWarning(result.stderr, "alpha")).toBe(false);
    });

    // T-API-08t8: Cross-workflow first-entry invalid-semver warning for no-index via qualified goto.
    it("T-API-08t8: run() cross-workflow first-entry invalid-semver warning (no-index target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "alpha", "index", `printf '{"goto":"beta:check"}'`);
      await createBashWorkflowScript(project, "beta", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "beta", {
        name: "beta",
        version: "1.0.0",
        dependencies: { loopx: INVALID_SEMVER },
      });

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("alpha", { cwd: ${JSON.stringify(project.dir)} })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countInvalidSemverWarnings(result.stderr, "beta")).toBe(1);
      expect(hasInvalidSemverWarning(result.stderr, "alpha")).toBe(false);
    });

    // T-API-08u: Broken workflow package.json (invalid JSON) warning on normal run() execution.
    it("T-API-08u: run() normal execution warns on invalid-JSON package.json", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-08u2: Unreadable package.json warning on normal run() execution.
    it.skipIf(IS_ROOT)("T-API-08u2: run() normal execution warns on unreadable package.json", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"ok"}'`);
      const pkgPath = await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
      });
      await chmod(pkgPath, 0o000);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasUnreadableWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-08u3: Invalid-semver package.json warning on normal run() execution.
    it("T-API-08u3: run() normal execution warns on invalid-semver package.json", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: INVALID_SEMVER },
      });

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-08v: Explicit `workflow:script` target maxIterations:0 skips version-check (unsatisfied range).
    it("T-API-08v: run(ralph:check) maxIterations:0 skips version-check (unsatisfied range)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-08w: Explicit target maxIterations:0 skips version-check (invalid JSON).
    it("T-API-08w: run(ralph:check) maxIterations:0 skips version-check (invalid JSON)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(0);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-08x: Explicit target maxIterations:0 skips version-check (invalid semver).
    it("T-API-08x: run(ralph:check) maxIterations:0 skips version-check (invalid semver)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: INVALID_SEMVER },
      });

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(0);
      expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-08y: Explicit target maxIterations:0 skips version-check (unreadable).
    it.skipIf(IS_ROOT)("T-API-08y: run(ralph:check) maxIterations:0 skips version-check (unreadable)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);
      const pkgPath = await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
      });
      await chmod(pkgPath, 0o000);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(0);
      expect(hasUnreadableWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-08z: Normal-execution version mismatch warning on explicit workflow:script into no-index workflow.
    it("T-API-08z: run(ralph:check) normal-execution emits version mismatch warning (no-index target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-08z2: Invalid-JSON warning on explicit workflow:script into no-index workflow.
    it("T-API-08z2: run(ralph:check) normal-execution warns on invalid-JSON package.json", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-08z3: Invalid-semver warning on explicit workflow:script into no-index workflow.
    it("T-API-08z3: run(ralph:check) normal-execution warns on invalid-semver package.json", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: INVALID_SEMVER },
      });

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-08z4: Unreadable warning on explicit workflow:script into no-index workflow.
    it.skipIf(IS_ROOT)("T-API-08z4: run(ralph:check) normal-execution warns on unreadable package.json", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"result":"ok"}'`);
      const pkgPath = await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
      });
      await chmod(pkgPath, 0o000);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasUnreadableWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-08aa: First-entry-only version-warning deduplication on re-entry via run().
    it("T-API-08aa: run() deduplicates version warning across loop-reset re-entries", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 3 })) {
  results.push(output);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(3);
      expect(countVersionMismatchWarnings(result.stderr, "ralph")).toBe(1);
    });

    // T-API-08ab: Cross-workflow alternating re-entry dedupe via run().
    it("T-API-08ab: run() deduplicates version warnings across alternating cross-workflow re-entries", async () => {
      project = await createTempProject();
      // alpha:index iteration 1 → goto beta:index; beta ends the chain (loop reset); alpha runs again; goto beta; beta stops.
      // Use counter to choose behavior per iteration.
      const alphaCounter = join(project.dir, "alpha-counter.txt");
      const betaCounter = join(project.dir, "beta-counter.txt");
      await createBashWorkflowScript(
        project,
        "alpha",
        "index",
        `printf '1' >> "${alphaCounter}"
printf '{"goto":"beta:index"}'`,
      );
      await createBashWorkflowScript(
        project,
        "beta",
        "index",
        `printf '1' >> "${betaCounter}"
COUNT=$(wc -c < "${betaCounter}" | tr -d ' ')
if [ "$COUNT" -ge 2 ]; then
  printf '{"stop":true}'
fi`,
      );
      await createWorkflowPackageJson(project, "alpha", {
        name: "alpha",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });
      await createWorkflowPackageJson(project, "beta", {
        name: "beta",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const output of run("alpha", { cwd: ${JSON.stringify(project.dir)} })) {
  results.push(output);
}
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(countVersionMismatchWarnings(result.stderr, "alpha")).toBe(1);
      expect(countVersionMismatchWarnings(result.stderr, "beta")).toBe(1);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9.2 — run() with Invalid target
// `target` is a required parameter. Runtime-invalid target values are rejected
// lazily (on first iteration / as a promise rejection).
// ═════════════════════════════════════════════════════════════

describe("SPEC: run() with Invalid target", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  // Shared lazy-error helper: builds a driver that calls run(<target>) and reports
  // whether run() itself threw (sync), whether first next() threw, and the error message.
  function makeLazyErrorDriver(target: string, projectDir: string): string {
    return `
import { run } from "loopx";
let syncThrew = false, gen;
try {
  gen = run(${target}, { cwd: ${JSON.stringify(projectDir)} });
} catch (e) { syncThrew = true; }
let nextThrew = false, errorMsg = "";
if (!syncThrew && gen) {
  try { await gen.next(); } catch (e) { nextThrew = true; errorMsg = e.message || String(e); }
}
console.log(JSON.stringify({ syncThrew, nextThrew, errorMsg }));
`;
  }

  forEachRuntime((runtime) => {
    // T-API-09: run(undefined as any) returns generator without throwing; throws on first next().
    it("T-API-09: run(undefined) returns a generator; first next() throws", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makeLazyErrorDriver("undefined", project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.syncThrew).toBe(false);
      expect(parsed.nextThrew).toBe(true);
    });

    // T-API-20h: run(null as any) — same lazy pattern.
    it("T-API-20h: run(null) returns a generator; first next() throws", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makeLazyErrorDriver("null", project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.syncThrew).toBe(false);
      expect(parsed.nextThrew).toBe(true);
    });

    // T-API-20i: run(42 as any) — same lazy pattern.
    it("T-API-20i: run(42) returns a generator; first next() throws", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makeLazyErrorDriver("42", project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.syncThrew).toBe(false);
      expect(parsed.nextThrew).toBe(true);
    });

    // T-API-30: run("") → error references invalid target format, not missing-workflow.
    it("T-API-30: run('') throws on first next() (empty string target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makeLazyErrorDriver(`""`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.nextThrew).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|malformed|empty|target|format/i);
    });

    // T-API-31: run(":") → throws.
    it("T-API-31: run(':') throws on first next() (bare colon)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makeLazyErrorDriver(`":"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.nextThrew).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|malformed|target|format|colon/i);
    });

    // T-API-32: run(":script") → throws (leading colon).
    it("T-API-32: run(':script') throws on first next() (leading colon)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makeLazyErrorDriver(`":script"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.nextThrew).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|malformed|target|format|colon/i);
    });

    // T-API-33: run("workflow:") → throws (trailing colon).
    it("T-API-33: run('workflow:') throws on first next() (trailing colon)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makeLazyErrorDriver(`"workflow:"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.nextThrew).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|malformed|target|format|colon/i);
    });

    // T-API-34: run("a:b:c") → throws (multiple colons).
    it("T-API-34: run('a:b:c') throws on first next() (multiple colons)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makeLazyErrorDriver(`"a:b:c"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.nextThrew).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|malformed|target|format|colon/i);
    });

    // T-API-35a: run("-bad:index") → throws (workflow name violates name restrictions).
    it("T-API-35a: run('-bad:index') throws on first next() (name restriction violation)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makeLazyErrorDriver(`"-bad:index"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.nextThrew).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|name|restriction|pattern|bad/i);
    });

    // T-API-35b: run("ralph:-bad") → throws (script name violates).
    it("T-API-35b: run('ralph:-bad') throws on first next() (script name violation)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makeLazyErrorDriver(`"ralph:-bad"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.nextThrew).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|name|restriction|pattern|bad/i);
    });

    // T-API-35d: run("bad.name") → throws (bare target name violation).
    it("T-API-35d: run('bad.name') throws on first next() (bare name violation)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makeLazyErrorDriver(`"bad.name"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.nextThrew).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|name|restriction|pattern|bad/i);
    });

    // T-API-35c: Invalid colon-shape target is rejected AFTER discovery/global validation.
    //            Error mentions the sibling name-collision in `broken`.
    it("T-API-35c: run(':script') throws after global validation mentioning sibling collision", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "valid", "index", `printf '{"stop":true}'`);
      await createBashWorkflowScript(project, "broken", "check", `printf '{"stop":true}'`);
      await createWorkflowScript(project, "broken", "check", ".ts", `process.stdout.write('{"stop":true}');`);

      const result = await runAPIDriver(runtime, makeLazyErrorDriver(`":script"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.nextThrew).toBe(true);
      expect(parsed.errorMsg).toContain("broken");
    });

    // T-API-35f: Invalid name-pattern target is rejected after discovery/global validation.
    it("T-API-35f: run('bad.name') throws after global validation mentioning sibling collision", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "valid", "index", `printf '{"stop":true}'`);
      await createBashWorkflowScript(project, "broken", "check", `printf '{"stop":true}'`);
      await createWorkflowScript(project, "broken", "check", ".ts", `process.stdout.write('{"stop":true}');`);

      const result = await runAPIDriver(runtime, makeLazyErrorDriver(`"bad.name"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.nextThrew).toBe(true);
      expect(parsed.errorMsg).toContain("broken");
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9.3 — run() Target Semantics
// ═════════════════════════════════════════════════════════════

describe("SPEC: run() Target Semantics", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-35: run("ralph") runs ralph:index.
    it("T-API-35: run('ralph') runs ralph:index", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "index-marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'index-ran' > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", { cwd: ${JSON.stringify(project.dir)} })) {}
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("index-ran");
    });

    // T-API-36: run("ralph:check-ready") runs the check-ready script.
    it("T-API-36: run('ralph:check-ready') runs the qualified script", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "check-marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "check-ready",
        `printf 'check-ran' > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph:check-ready", { cwd: ${JSON.stringify(project.dir)} })) {}
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("check-ran");
    });

    // T-API-36a: run("ralph:check") works in a workflow without an index script.
    it("T-API-36a: run('ralph:check') runs in a no-index workflow", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"result":"no-index-ok"}'`);

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const o of run("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {
  results.push(o);
}
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("no-index-ok");
    });

    // T-API-37: run("ralph:index") ≡ run("ralph").
    it("T-API-37: run('ralph:index') is equivalent to run('ralph')", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"equiv"}'`);

      const driverCode = `
import { runPromise } from "loopx";
const a = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
const b = await runPromise("ralph:index", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify({ a, b }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.a).toEqual(parsed.b);
    });

    // T-API-35e: Bare run() target is a workflow, not a script inside another workflow.
    it("T-API-35e: run('check-ready') throws when no matching workflow exists", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "check-marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "check-ready",
        `printf 'executed' > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
const gen = run("check-ready", { cwd: ${JSON.stringify(project.dir)} });
let threw = false, message = "";
try { await gen.next(); } catch (e) { threw = true; message = e.message || String(e); }
console.log(JSON.stringify({ threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
      // Assert that ralph:check-ready was NOT executed.
      expect(existsSync(marker)).toBe(false);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9.4 — run() Snapshot & Cancellation
// ═════════════════════════════════════════════════════════════

describe("SPEC: run() Snapshot & Cancellation", () => {
  let project: TempProject | null = null;
  let projectB: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
    if (projectB) {
      await projectB.cleanup().catch(() => {});
      projectB = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-09b: cwd snapshot at run() call time (before iteration).
    it("T-API-09b: cwd snapshotted at run() call time", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'project-a' > "${marker}"
printf '{"stop":true}'`,
      );

      projectB = await createTempProject({ withLoopxDir: false });

      const driverCode = `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
const gen = run("ralph", { maxIterations: 1 });
process.chdir(${JSON.stringify(projectB.dir)});
const results = [];
for await (const o of gen) { results.push(o); }
console.log(JSON.stringify(results));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(readFileSync(marker, "utf-8")).toBe("project-a");
    });

    // T-API-09a: Manual iterator return() during pending next() kills the child.
    it("T-API-09a: gen.return() during pending next() terminates child", async () => {
      project = await createTempProject();
      const pidMarker = join(project.dir, "pid-marker.txt");
      await createWorkflowScript(project, "ralph", "index", ".ts", writePidToFile(pidMarker));

      const driverCode = `
import { run } from "loopx";
import { readFileSync, existsSync } from "node:fs";

const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)} });
const nextPromise = gen.next();

for (let i = 0; i < 100; i++) {
  if (existsSync(${JSON.stringify(pidMarker)})) break;
  await new Promise(r => setTimeout(r, 100));
}

const pid = parseInt(readFileSync(${JSON.stringify(pidMarker)}, "utf-8"), 10);
await gen.return(undefined);
await new Promise(r => setTimeout(r, 1000));

let isRunning = false;
try { process.kill(pid, 0); isRunning = true; } catch { isRunning = false; }
console.log(JSON.stringify({ pid, isRunning }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).isRunning).toBe(false);
    });

    // T-API-09c: Options snapshotted at run() call time.
    it("T-API-09c: run() options are snapshotted — post-call mutation has no effect", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        counter(counterFile).replace(/^#!\/bin\/bash\n/, ""),
      );

      const driverCode = `
import { run } from "loopx";
const opts = { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 };
const gen = run("ralph", opts);
opts.maxIterations = 1;
const results = [];
for await (const o of gen) { results.push(o); }
console.log(JSON.stringify(results.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(2);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9.5 — run() with AbortSignal
// ═════════════════════════════════════════════════════════════

describe("SPEC: run() with AbortSignal", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-10: Abort terminates loop; generator throws.
    it("T-API-10: abort terminates the loop; generator throws", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        counter(counterFile).replace(/^#!\/bin\/bash\n/, ""),
      );

      const driverCode = `
import { run } from "loopx";
const ac = new AbortController();
const results = [];
let threw = false;
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 100, signal: ac.signal });
  for await (const output of gen) {
    results.push(output);
    if (results.length === 1) ac.abort();
  }
} catch { threw = true; }
console.log(JSON.stringify({ threw, count: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(true);
      expect(parsed.count).toBe(1);
    });

    // T-API-10a: Abort while child active kills the child process group.
    it("T-API-10a: abort during active child terminates process group", async () => {
      project = await createTempProject();
      const pidMarker = join(project.dir, "pid-marker.txt");
      await createWorkflowScript(project, "ralph", "index", ".ts", writePidToFile(pidMarker));

      const driverCode = `
import { run } from "loopx";
import { readFileSync, existsSync } from "node:fs";

const ac = new AbortController();
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, signal: ac.signal });
let threw = false;

try {
  const nextPromise = gen.next();
  for (let i = 0; i < 100; i++) {
    if (existsSync(${JSON.stringify(pidMarker)})) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const pid = parseInt(readFileSync(${JSON.stringify(pidMarker)}, "utf-8"), 10);
  ac.abort();
  try { await nextPromise; } catch { threw = true; }
  if (!threw) {
    try { await gen.next(); } catch { threw = true; }
  }
  await new Promise(r => setTimeout(r, 1000));
  let isRunning = false;
  try { process.kill(pid, 0); isRunning = true; } catch {}
  console.log(JSON.stringify({ pid, isRunning, threw }));
} catch {
  console.log(JSON.stringify({ threw: true, isRunning: false }));
}
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(true);
      expect(parsed.isRunning).toBe(false);
    });

    // T-API-10b: Pre-aborted signal → first next() throws; no child spawned.
    it("T-API-10b: pre-aborted signal throws on first next(), no child spawned", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        counter(counterFile).replace(/^#!\/bin\/bash\n/, ""),
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync } from "node:fs";

const ac = new AbortController();
ac.abort();
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5, signal: ac.signal });

let threw = false;
try { await gen.next(); } catch { threw = true; }

await new Promise(r => setTimeout(r, 500));
const counterExists = existsSync(${JSON.stringify(counterFile)});
console.log(JSON.stringify({ threw, counterExists }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(true);
      expect(parsed.counterExists).toBe(false);
    });

    // T-API-10c: Abort between iterations → next next() throws.
    it("T-API-10c: abort between iterations throws on next next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"ok"}'`);

      const driverCode = `
import { run } from "loopx";

const ac = new AbortController();
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 10, signal: ac.signal });

const first = await gen.next();
const firstValue = first.value;
ac.abort();

let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ firstResult: firstValue?.result, threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.firstResult).toBe("ok");
      expect(parsed.threw).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9.6 — runPromise()
// ═════════════════════════════════════════════════════════════

describe("SPEC: runPromise()", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-11: resolves with array of 3 outputs.
    it("T-API-11: runPromise with maxIterations:3 resolves with array of 3 Outputs", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        counter(counterFile).replace(/^#!\/bin\/bash\n/, ""),
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 3 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(3);
      expect(outputs[0].result).toBe("1");
      expect(outputs[1].result).toBe("2");
      expect(outputs[2].result).toBe("3");
    });

    // T-API-12: stop:true resolves.
    it("T-API-12: stop:true resolves the promise", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)} });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].stop).toBe(true);
    });

    // T-API-13: non-zero exit rejects.
    it("T-API-13: non-zero script exit rejects runPromise", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `exit 1`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 3 }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-14: All options (maxIterations, envFile, cwd) — env var loaded, outputs returned.
    it("T-API-14: runPromise honors maxIterations + envFile + cwd", async () => {
      project = await createTempProject();
      const envFilePath = join(project.dir, "local.env");
      const markerPath = join(project.dir, "env-marker.txt");
      await createEnvFile(envFilePath, { MY_TEST_VAR: "env-loaded" });
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$MY_TEST_VAR" > "${markerPath}"
printf '{"result":"ok"}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  maxIterations: 3,
  envFile: ${JSON.stringify(envFilePath)},
});
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(3);
      expect(outputs[0].result).toBe("ok");
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf-8")).toBe("env-loaded");
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9.7 — runPromise() Target Semantics
// ═════════════════════════════════════════════════════════════

describe("SPEC: runPromise() Target Semantics", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-47: runPromise("ralph:check-ready") resolves with output from check-ready.
    it("T-API-47: runPromise('ralph:check-ready') resolves with the qualified script's output", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "check-ready",
        `printf '{"result":"check-ready-output"}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph:check-ready", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("check-ready-output");
    });

    // T-API-48: runPromise("ralph:index") ≡ runPromise("ralph").
    it("T-API-48: runPromise('ralph:index') is equivalent to runPromise('ralph')", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"equiv"}'`);

      const driverCode = `
import { runPromise } from "loopx";
const a = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
const b = await runPromise("ralph:index", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify({ a, b }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.a).toEqual(parsed.b);
    });

    // T-API-48a: runPromise("check-ready") rejects (bare target is a workflow name).
    it("T-API-48a: runPromise('check-ready') rejects when no matching workflow exists", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "check-marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "check-ready",
        `printf 'executed' > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("check-ready", { cwd: ${JSON.stringify(project.dir)} }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
      expect(existsSync(marker)).toBe(false);
    });

    // T-API-47a: runPromise("ralph:check") in a no-index workflow.
    it("T-API-47a: runPromise('ralph:check') resolves in a no-index workflow", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"result":"no-index-ok"}'`);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].result).toBe("no-index-ok");
    });

    // T-API-47b: runPromise — RunOptions.cwd sets BOTH LOOPX_PROJECT_ROOT and the
    //            script execution cwd. LOOPX_WORKFLOW_DIR independently exposes the
    //            workflow-relative path.
    it("T-API-47b: runPromise — cwd sets LOOPX_PROJECT_ROOT and script execution cwd", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "cwd-marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"cwd":"%s","root":"%s","wfdir":"%s"}' "$(/bin/pwd -P)" "$LOOPX_PROJECT_ROOT" "$LOOPX_WORKFLOW_DIR" > "${markerPath}"
printf '{"stop":true}'`,
      );
      const workflowDir = join(project.loopxDir, "ralph");

      const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(markerPath, "utf-8"));
      // Per SPEC 9.5 (rewritten by ADR-0004 §3): RunOptions.cwd specifies BOTH
      // the project root AND the script execution cwd. /bin/pwd -P yields the
      // kernel-canonical form, so the cwd assertion uses realpath(project.dir).
      const expectedRoot = realpathSync(project.dir);
      expect(parsed.cwd).toBe(expectedRoot);
      expect(parsed.root).toBe(project.dir);
      // LOOPX_WORKFLOW_DIR exposes the workflow-relative path (independent of cwd).
      expect(parsed.wfdir).toBe(workflowDir);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9.8 — runPromise() with Invalid target
// ═════════════════════════════════════════════════════════════

describe("SPEC: runPromise() with Invalid target", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  function makePromiseRejectDriver(target: string, projectDir: string): string {
    return `
import { runPromise } from "loopx";
let syncThrew = false, returnValue;
try { returnValue = runPromise(${target}, { cwd: ${JSON.stringify(projectDir)} }); }
catch (e) { syncThrew = true; }
const isPromise = returnValue != null && (returnValue instanceof Promise || typeof returnValue.then === "function");
let rejected = false, errorMsg = "";
if (!syncThrew && isPromise) {
  try { await returnValue; } catch (e) { rejected = true; errorMsg = e.message || String(e); }
}
console.log(JSON.stringify({ syncThrew, isPromise, rejected, errorMsg }));
`;
  }

  forEachRuntime((runtime) => {
    // T-API-14a: runPromise(undefined as any) returns rejected promise, not sync throw.
    it("T-API-14a: runPromise(undefined) returns a rejected promise (no sync throw)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makePromiseRejectDriver("undefined", project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.syncThrew).toBe(false);
      expect(parsed.isPromise).toBe(true);
      expect(parsed.rejected).toBe(true);
    });

    // T-API-14a2: runPromise(null as any) returns rejected promise.
    it("T-API-14a2: runPromise(null) returns a rejected promise (no sync throw)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makePromiseRejectDriver("null", project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.syncThrew).toBe(false);
      expect(parsed.isPromise).toBe(true);
      expect(parsed.rejected).toBe(true);
    });

    // T-API-14a3: runPromise(42 as any) returns rejected promise.
    it("T-API-14a3: runPromise(42) returns a rejected promise (no sync throw)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makePromiseRejectDriver("42", project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.syncThrew).toBe(false);
      expect(parsed.isPromise).toBe(true);
      expect(parsed.rejected).toBe(true);
    });

    // T-API-38: runPromise("") rejects (empty string).
    it("T-API-38: runPromise('') rejects (empty target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makePromiseRejectDriver(`""`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|malformed|empty|target|format/i);
    });

    // T-API-39: runPromise("a:b:c") rejects (multiple colons).
    it("T-API-39: runPromise('a:b:c') rejects (multiple colons)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makePromiseRejectDriver(`"a:b:c"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|malformed|target|format|colon/i);
    });

    // T-API-40: runPromise(":") rejects (bare colon).
    it("T-API-40: runPromise(':') rejects (bare colon)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makePromiseRejectDriver(`":"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|malformed|target|format|colon/i);
    });

    // T-API-41: runPromise(":script") rejects (leading colon).
    it("T-API-41: runPromise(':script') rejects (leading colon)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makePromiseRejectDriver(`":script"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|malformed|target|format|colon/i);
    });

    // T-API-42: runPromise("workflow:") rejects (trailing colon).
    it("T-API-42: runPromise('workflow:') rejects (trailing colon)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makePromiseRejectDriver(`"workflow:"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|malformed|target|format|colon/i);
    });

    // T-API-43: runPromise("-bad:index") rejects (name restriction violation, workflow).
    it("T-API-43: runPromise('-bad:index') rejects (workflow name violation)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makePromiseRejectDriver(`"-bad:index"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|name|restriction|pattern|bad/i);
    });

    // T-API-44: runPromise("ralph:-bad") rejects (script name violation).
    it("T-API-44: runPromise('ralph:-bad') rejects (script name violation)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makePromiseRejectDriver(`"ralph:-bad"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|name|restriction|pattern|bad/i);
    });

    // T-API-44a: runPromise("bad.name") rejects (bare name violation).
    it("T-API-44a: runPromise('bad.name') rejects (bare name violation)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const result = await runAPIDriver(runtime, makePromiseRejectDriver(`"bad.name"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.errorMsg).toMatch(/invalid|name|restriction|pattern|bad/i);
    });

    // T-API-44b: Invalid colon-shape target rejected AFTER discovery/global validation.
    it("T-API-44b: runPromise(':script') rejects after global validation (mentions collision)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "valid", "index", `printf '{"stop":true}'`);
      await createBashWorkflowScript(project, "broken", "check", `printf '{"stop":true}'`);
      await createWorkflowScript(project, "broken", "check", ".ts", `process.stdout.write('{"stop":true}');`);

      const result = await runAPIDriver(runtime, makePromiseRejectDriver(`":script"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.errorMsg).toContain("broken");
    });

    // T-API-44c: Invalid name-pattern target rejected after global validation (name-restriction path).
    it("T-API-44c: runPromise('bad.name') rejects after global validation (mentions collision)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "valid", "index", `printf '{"stop":true}'`);
      await createBashWorkflowScript(project, "broken", "check", `printf '{"stop":true}'`);
      await createWorkflowScript(project, "broken", "check", ".ts", `process.stdout.write('{"stop":true}');`);

      const result = await runAPIDriver(runtime, makePromiseRejectDriver(`"bad.name"`, project.dir));
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.errorMsg).toContain("broken");
    });

    // T-API-45: runPromise("ralph") rejects when workflow has no index.
    it("T-API-45: runPromise('ralph') rejects when workflow has no index script", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false, errorMsg = "";
try { await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)} }); }
catch (e) { rejected = true; errorMsg = e.message || String(e); }
console.log(JSON.stringify({ rejected, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-45a: runPromise("ralph:index") rejects when workflow has no index.
    it("T-API-45a: runPromise('ralph:index') rejects when workflow has no index", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false, errorMsg = "";
try { await runPromise("ralph:index", { cwd: ${JSON.stringify(project.dir)} }); }
catch (e) { rejected = true; errorMsg = e.message || String(e); }
console.log(JSON.stringify({ rejected, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-46: runPromise("ralph:missing") rejects.
    it("T-API-46: runPromise('ralph:missing') rejects when script is missing", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("ralph:missing", { cwd: ${JSON.stringify(project.dir)} }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9.9 — runPromise() Snapshot & Options (full matrix)
// ═════════════════════════════════════════════════════════════

describe("SPEC: runPromise() Snapshot & Options", () => {
  let project: TempProject | null = null;
  let projectB: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      restorePerms(project.dir);
      await project.cleanup().catch(() => {});
      project = null;
    }
    if (projectB) {
      await projectB.cleanup().catch(() => {});
      projectB = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-14b: maxIterations: 0 → empty array.
    it("T-API-14b: runPromise() maxIterations:0 resolves with []", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        counter(counterFile).replace(/^#!\/bin\/bash\n/, ""),
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
      expect(existsSync(counterFile)).toBe(false);
    });

    // T-API-14b2: maxIterations:0 skips version check (invalid JSON).
    it("T-API-14b2: runPromise() maxIterations:0 skips version check (invalid JSON)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-14b3: maxIterations:0 skips version check (unreadable).
    it.skipIf(IS_ROOT)("T-API-14b3: runPromise() maxIterations:0 skips version check (unreadable)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      const pkgPath = await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
      });
      await chmod(pkgPath, 0o000);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
      expect(hasUnreadableWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-14b4: maxIterations:0 skips version check (invalid semver).
    it("T-API-14b4: runPromise() maxIterations:0 skips version check (invalid semver)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: INVALID_SEMVER },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
      expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-14c: runPromise cwd snapshot at call time.
    it("T-API-14c: runPromise cwd is snapshotted at call time", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'project-a' > "${marker}"
printf '{"stop":true}'`,
      );

      projectB = await createTempProject({ withLoopxDir: false });

      const driverCode = `
import { runPromise } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
const promise = runPromise("ralph", { maxIterations: 1 });
process.chdir(${JSON.stringify(projectB.dir)});
const outputs = await promise;
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(readFileSync(marker, "utf-8")).toBe("project-a");
    });

    // T-API-14d: runPromise options snapshot.
    it("T-API-14d: runPromise() options are snapshotted at call time", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        counter(counterFile).replace(/^#!\/bin\/bash\n/, ""),
      );

      const driverCode = `
import { runPromise } from "loopx";
const opts = { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 };
const promise = runPromise("ralph", opts);
opts.maxIterations = 1;
const outputs = await promise;
console.log(JSON.stringify(outputs.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(2);
    });

    // T-API-14e: runPromise("nonexistent", { maxIterations: 0 }) rejects.
    it("T-API-14e: runPromise('nonexistent') maxIterations:0 rejects", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false, errorMsg = "";
try { await runPromise("nonexistent", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 }); }
catch (e) { rejected = true; errorMsg = e.message || String(e); }
console.log(JSON.stringify({ rejected, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.errorMsg).toMatch(/nonexistent/i);
    });

    // T-API-14f: runPromise("ralph") rejects when workflow has no index, maxIterations:0.
    it("T-API-14f: runPromise('ralph') maxIterations:0 rejects when no index", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-14g: runPromise("ralph:missing") maxIterations:0 rejects.
    it("T-API-14g: runPromise('ralph:missing') maxIterations:0 rejects", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("ralph:missing", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-14h: runPromise("ralph:check") maxIterations:0 → [] (no-index workflow).
    it("T-API-14h: runPromise('ralph:check') maxIterations:0 resolves with [] (no-index workflow)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
    });

    // T-API-14i: Normal-execution version mismatch warning via runPromise().
    it("T-API-14i: runPromise() normal-execution emits version mismatch warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-14j: Cross-workflow first-entry version warning via runPromise().
    it("T-API-14j: runPromise() cross-workflow first-entry version warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "alpha", "index", `printf '{"goto":"beta:index"}'`);
      await createBashWorkflowScript(project, "beta", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "beta", {
        name: "beta",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("alpha", { cwd: ${JSON.stringify(project.dir)} });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countVersionMismatchWarnings(result.stderr, "beta")).toBe(1);
      expect(hasVersionMismatchWarning(result.stderr, "alpha")).toBe(false);
    });

    // T-API-14j2: Cross-workflow first-entry invalid-JSON warning via runPromise().
    it("T-API-14j2: runPromise() cross-workflow first-entry invalid-JSON warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "clean", "index", `printf '{"goto":"broken:index"}'`);
      await createBashWorkflowScript(project, "broken", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "broken", BROKEN_JSON);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("clean", { cwd: ${JSON.stringify(project.dir)} });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countInvalidJsonWarnings(result.stderr, "broken")).toBe(1);
      expect(hasInvalidJsonWarning(result.stderr, "clean")).toBe(false);
    });

    // T-API-14j3: Cross-workflow first-entry unreadable warning via runPromise().
    it.skipIf(IS_ROOT)("T-API-14j3: runPromise() cross-workflow first-entry unreadable warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "clean", "index", `printf '{"goto":"broken:index"}'`);
      await createBashWorkflowScript(project, "broken", "index", `printf '{"stop":true}'`);
      const pkgPath = await createWorkflowPackageJson(project, "broken", {
        name: "broken",
        version: "1.0.0",
      });
      await chmod(pkgPath, 0o000);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("clean", { cwd: ${JSON.stringify(project.dir)} });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countUnreadableWarnings(result.stderr, "broken")).toBe(1);
      expect(hasUnreadableWarning(result.stderr, "clean")).toBe(false);
    });

    // T-API-14j4: Cross-workflow first-entry invalid-semver warning via runPromise().
    it("T-API-14j4: runPromise() cross-workflow first-entry invalid-semver warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "clean", "index", `printf '{"goto":"broken:index"}'`);
      await createBashWorkflowScript(project, "broken", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "broken", {
        name: "broken",
        version: "1.0.0",
        dependencies: { loopx: INVALID_SEMVER },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("clean", { cwd: ${JSON.stringify(project.dir)} });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countInvalidSemverWarnings(result.stderr, "broken")).toBe(1);
      expect(hasInvalidSemverWarning(result.stderr, "clean")).toBe(false);
    });

    // T-API-14j5: Cross-workflow first-entry version warning for no-index target.
    it("T-API-14j5: runPromise() cross-workflow first-entry version warning (no-index target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "alpha", "index", `printf '{"goto":"beta:check"}'`);
      await createBashWorkflowScript(project, "beta", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "beta", {
        name: "beta",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("alpha", { cwd: ${JSON.stringify(project.dir)} });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countVersionMismatchWarnings(result.stderr, "beta")).toBe(1);
      expect(hasVersionMismatchWarning(result.stderr, "alpha")).toBe(false);
    });

    // T-API-14j6: Cross-workflow first-entry invalid-JSON warning for no-index target.
    it("T-API-14j6: runPromise() cross-workflow first-entry invalid-JSON warning (no-index target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "alpha", "index", `printf '{"goto":"beta:check"}'`);
      await createBashWorkflowScript(project, "beta", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "beta", BROKEN_JSON);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("alpha", { cwd: ${JSON.stringify(project.dir)} });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countInvalidJsonWarnings(result.stderr, "beta")).toBe(1);
      expect(hasInvalidJsonWarning(result.stderr, "alpha")).toBe(false);
    });

    // T-API-14j7: Cross-workflow first-entry unreadable warning for no-index target.
    it.skipIf(IS_ROOT)("T-API-14j7: runPromise() cross-workflow first-entry unreadable warning (no-index target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "alpha", "index", `printf '{"goto":"beta:check"}'`);
      await createBashWorkflowScript(project, "beta", "check", `printf '{"stop":true}'`);
      const pkgPath = await createWorkflowPackageJson(project, "beta", {
        name: "beta",
        version: "1.0.0",
      });
      await chmod(pkgPath, 0o000);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("alpha", { cwd: ${JSON.stringify(project.dir)} });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countUnreadableWarnings(result.stderr, "beta")).toBe(1);
      expect(hasUnreadableWarning(result.stderr, "alpha")).toBe(false);
    });

    // T-API-14j8: Cross-workflow first-entry invalid-semver warning for no-index target.
    it("T-API-14j8: runPromise() cross-workflow first-entry invalid-semver warning (no-index target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "alpha", "index", `printf '{"goto":"beta:check"}'`);
      await createBashWorkflowScript(project, "beta", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "beta", {
        name: "beta",
        version: "1.0.0",
        dependencies: { loopx: INVALID_SEMVER },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("alpha", { cwd: ${JSON.stringify(project.dir)} });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
      expect(countInvalidSemverWarnings(result.stderr, "beta")).toBe(1);
      expect(hasInvalidSemverWarning(result.stderr, "alpha")).toBe(false);
    });

    // T-API-14k: Invalid-JSON package.json warning on normal runPromise() execution.
    it("T-API-14k: runPromise() normal-execution warns on invalid-JSON package.json", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-14k2: Unreadable package.json warning on normal runPromise() execution.
    it.skipIf(IS_ROOT)("T-API-14k2: runPromise() normal-execution warns on unreadable package.json", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"ok"}'`);
      const pkgPath = await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
      });
      await chmod(pkgPath, 0o000);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasUnreadableWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-14k3: Invalid-semver package.json warning on normal runPromise() execution.
    it("T-API-14k3: runPromise() normal-execution warns on invalid-semver package.json", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: INVALID_SEMVER },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-14l: Explicit target maxIterations:0 skips version-check (unsatisfied range).
    it("T-API-14l: runPromise('ralph:check') maxIterations:0 skips version-check (unsatisfied range)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-14m: Explicit target maxIterations:0 skips version-check (invalid JSON).
    it("T-API-14m: runPromise('ralph:check') maxIterations:0 skips version-check (invalid JSON)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-14n: Explicit target maxIterations:0 skips version-check (invalid semver).
    it("T-API-14n: runPromise('ralph:check') maxIterations:0 skips version-check (invalid semver)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: INVALID_SEMVER },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
      expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-14o: Explicit target maxIterations:0 skips version-check (unreadable).
    it.skipIf(IS_ROOT)("T-API-14o: runPromise('ralph:check') maxIterations:0 skips version-check (unreadable)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);
      const pkgPath = await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
      });
      await chmod(pkgPath, 0o000);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
      expect(hasUnreadableWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-14p: Normal-execution version mismatch on explicit workflow:script into no-index workflow.
    it("T-API-14p: runPromise('ralph:check') normal-execution emits version mismatch warning (no-index target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-14p2: Invalid-JSON warning on explicit workflow:script into no-index workflow.
    it("T-API-14p2: runPromise('ralph:check') normal-execution warns on invalid-JSON package.json (no-index target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-14p3: Invalid-semver warning on explicit workflow:script into no-index workflow.
    it("T-API-14p3: runPromise('ralph:check') normal-execution warns on invalid-semver package.json (no-index target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: INVALID_SEMVER },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-14p4: Unreadable warning on explicit workflow:script into no-index workflow.
    it.skipIf(IS_ROOT)("T-API-14p4: runPromise('ralph:check') normal-execution warns on unreadable package.json (no-index target)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"result":"ok"}'`);
      const pkgPath = await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
      });
      await chmod(pkgPath, 0o000);

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(1);
      expect(hasUnreadableWarning(result.stderr, "ralph")).toBe(true);
    });

    // T-API-14q: First-entry-only version-warning deduplication on re-entry via runPromise().
    it("T-API-14q: runPromise() deduplicates version warning across loop-reset re-entries", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"ok"}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 3 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(3);
      expect(countVersionMismatchWarnings(result.stderr, "ralph")).toBe(1);
    });

    // T-API-14r: Cross-workflow alternating re-entry dedupe via runPromise().
    it("T-API-14r: runPromise() deduplicates version warnings across alternating cross-workflow re-entries", async () => {
      project = await createTempProject();
      const alphaCounter = join(project.dir, "alpha-counter.txt");
      const betaCounter = join(project.dir, "beta-counter.txt");
      await createBashWorkflowScript(
        project,
        "alpha",
        "index",
        `printf '1' >> "${alphaCounter}"
printf '{"goto":"beta:index"}'`,
      );
      await createBashWorkflowScript(
        project,
        "beta",
        "index",
        `printf '1' >> "${betaCounter}"
COUNT=$(wc -c < "${betaCounter}" | tr -d ' ')
if [ "$COUNT" -ge 2 ]; then
  printf '{"stop":true}'
fi`,
      );
      await createWorkflowPackageJson(project, "alpha", {
        name: "alpha",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });
      await createWorkflowPackageJson(project, "beta", {
        name: "beta",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("alpha", { cwd: ${JSON.stringify(project.dir)} });
console.log(JSON.stringify(outputs.length));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(countVersionMismatchWarnings(result.stderr, "alpha")).toBe(1);
      expect(countVersionMismatchWarnings(result.stderr, "beta")).toBe(1);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9.10 — Error Behavior
// ═════════════════════════════════════════════════════════════

describe("SPEC: Error Behavior", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-15: Programmatic API never prints `result` to stdout.
    it("T-API-15: programmatic API never prints result to stdout", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"secret-result"}'`);

      const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 })) {}
process.stdout.write("DRIVER_OUTPUT_ONLY");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("DRIVER_OUTPUT_ONLY");
      expect(result.stdout).not.toContain("secret-result");
    });

    // T-API-16: Non-zero script exit causes run() to throw.
    it("T-API-16: non-zero script exit causes run() generator to throw", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `exit 1`);

      const driverCode = `
import { run } from "loopx";
let threw = false;
try {
  for await (const _ of run("ralph", { cwd: ${JSON.stringify(project.dir)} })) {}
} catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-17: Invalid goto target causes run() to throw.
    it("T-API-17: invalid goto target causes run() generator to throw", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"goto":"nonexistent-workflow:missing"}'`);

      const driverCode = `
import { run } from "loopx";
let threw = false, errorMsg = "";
try {
  for await (const _ of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5 })) {}
} catch (e) { threw = true; errorMsg = e.message || String(e); }
console.log(JSON.stringify({ threw, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(true);
      expect(parsed.errorMsg).toMatch(/nonexistent-workflow|missing/);
    });

    // T-API-18: Script stderr is forwarded.
    it("T-API-18: script stderr is forwarded to calling process stderr", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `echo 'STDERR_API_SENTINEL' >&2
printf '{"result":"ok"}'`,
      );

      const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })) {}
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("STDERR_API_SENTINEL");
    });

    // T-API-19: Partial outputs preserved when run() throws.
    it("T-API-19: previously yielded outputs preserved when run() throws", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
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
let threw = false;
try {
  for await (const output of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 10 })) {
    results.push(output);
  }
} catch { threw = true; }
console.log(JSON.stringify({ threw, results }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(true);
      expect(parsed.results).toHaveLength(2);
      expect(parsed.results[0].result).toBe("iter-1");
      expect(parsed.results[1].result).toBe("iter-2");
    });

    // T-API-20a: run("nonexistent") → generator throws on first next().
    it("T-API-20a: run('nonexistent') throws on first next()", async () => {
      project = await createTempProject();

      const driverCode = `
import { run } from "loopx";
const gen = run("nonexistent", { cwd: ${JSON.stringify(project.dir)} });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-20b: runPromise("nonexistent") rejects.
    it("T-API-20b: runPromise('nonexistent') rejects", async () => {
      project = await createTempProject();

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("nonexistent", { cwd: ${JSON.stringify(project.dir)} }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-20c: run("ralph") with same-base-name collision in `ralph` → throws.
    it("T-API-20c: run('ralph') throws on first next() when name-collision present in target", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);
      await createWorkflowScript(project, "ralph", "check", ".ts", `process.stdout.write('{"stop":true}');`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)} });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-20d: run() with missing envFile → throws on first next().
    it("T-API-20d: run() with missing envFile throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, envFile: "nonexistent.env" });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-20e: runPromise() with missing envFile → rejects.
    it("T-API-20e: runPromise() with missing envFile rejects", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, envFile: "nonexistent.env" }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-20f: run() with cwd pointing to a directory without .loopx → throws.
    it("T-API-20f: run() with cwd lacking .loopx directory throws on first next()", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)} });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-20g: runPromise() with cwd lacking .loopx → rejects.
    it("T-API-20g: runPromise() with cwd lacking .loopx directory rejects", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)} }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-20j: run("ralph") throws when workflow has no index.
    it("T-API-20j: run('ralph') throws on first next() when workflow has no index", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)} });
let threw = false, errorMsg = "";
try { await gen.next(); } catch (e) { threw = true; errorMsg = e.message || String(e); }
console.log(JSON.stringify({ threw, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-20j2: run("ralph:index") throws when explicit :index is missing.
    it("T-API-20j2: run('ralph:index') throws when workflow has no index script", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph:index", { cwd: ${JSON.stringify(project.dir)} });
let threw = false, errorMsg = "";
try { await gen.next(); } catch (e) { threw = true; errorMsg = e.message || String(e); }
console.log(JSON.stringify({ threw, errorMsg }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-20k: run("ralph:missing") throws on first next().
    it("T-API-20k: run('ralph:missing') throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph:missing", { cwd: ${JSON.stringify(project.dir)} });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-20l: run("good") throws when sibling has invalid script name (normal execution).
    it("T-API-20l: run('good') throws in normal execution on sibling invalid script name", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "good", "index", `printf '{"stop":true}'`);
      await createBashWorkflowScript(project, "broken", "-bad", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("good", { cwd: ${JSON.stringify(project.dir)} });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-20m: run("good") throws when sibling has invalid workflow name (normal execution).
    it("T-API-20m: run('good') throws in normal execution on sibling invalid workflow name", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "good", "index", `printf '{"stop":true}'`);
      await createBashWorkflowScript(project, "-bad-workflow", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("good", { cwd: ${JSON.stringify(project.dir)} });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-20n: runPromise("good") rejects when sibling has invalid script name.
    it("T-API-20n: runPromise('good') rejects in normal execution on sibling invalid script name", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "good", "index", `printf '{"stop":true}'`);
      await createBashWorkflowScript(project, "broken", "-bad", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("good", { cwd: ${JSON.stringify(project.dir)} }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-20o: runPromise("good") rejects when sibling has invalid workflow name.
    it("T-API-20o: runPromise('good') rejects in normal execution on sibling invalid workflow name", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "good", "index", `printf '{"stop":true}'`);
      await createBashWorkflowScript(project, "-bad-workflow", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("good", { cwd: ${JSON.stringify(project.dir)} }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-20p: run() — missing default entry point wins over version check.
    it("T-API-20p: run() — missing default entry point precedes version check", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-20p2: runPromise() — missing default entry precedes version check (unsatisfied).
    it("T-API-20p2: runPromise() — missing default entry precedes version check", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-20p3: runPromise() — missing default entry precedes package.json reading (broken JSON).
    it("T-API-20p3: runPromise() — missing default entry precedes package.json reading (broken JSON)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "check", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", "{{{INVALID");

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-20q: runPromise() — goto missing script precedes package.json reading (broken JSON).
    it("T-API-20q: runPromise() — goto missing script precedes package.json reading (broken JSON)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "start", "index", `printf '{"goto":"other:missing"}'`);
      await createBashWorkflowScript(project, "other", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "other", "{{{INVALID");

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("start", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
      expect(hasAnyPackageJsonWarning(result.stderr, "other")).toBe(false);
    });

    // T-API-20q2: runPromise() — goto missing script precedes version check (unsatisfied).
    it("T-API-20q2: runPromise() — goto missing script precedes version check (unsatisfied)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "start", "index", `printf '{"goto":"other:missing"}'`);
      await createBashWorkflowScript(project, "other", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "other", {
        name: "other",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("start", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
      expect(hasVersionMismatchWarning(result.stderr, "other")).toBe(false);
    });

    // T-API-20r: run() — explicit workflow:script missing precedes version check.
    it("T-API-20r: run('ralph:missing') — missing script precedes version check", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", {
        name: "ralph",
        version: "1.0.0",
        dependencies: { loopx: UNSATISFIED_RANGE },
      });

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph:missing", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
    });

    // T-API-20s: runPromise() — explicit workflow:script missing precedes package.json reading (broken JSON).
    it("T-API-20s: runPromise('ralph:missing') — missing script precedes package.json reading (broken JSON)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      await createWorkflowPackageJson(project, "ralph", "{{{INVALID");

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("ralph:missing", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9.11 — envFile Option
// ═════════════════════════════════════════════════════════════

describe("SPEC: envFile Option", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-21: envFile loads vars into script environment.
    it("T-API-21: envFile loads vars into script environment", async () => {
      project = await createTempProject();
      const envFilePath = join(project.dir, "test.env");
      const markerPath = join(project.dir, "env-marker.txt");
      await createEnvFile(envFilePath, { LOOPX_TEST_VAR: "hello-env" });
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_TEST_VAR" > "${markerPath}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, envFile: ${JSON.stringify(envFilePath)} })) {}
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf-8")).toBe("hello-env");
    });

    // T-API-21a: Relative envFile resolved against provided cwd.
    it("T-API-21a: relative envFile resolved against provided cwd", async () => {
      project = await createTempProject();
      const subEnvPath = join(project.dir, "subdir", "test.env");
      const markerPath = join(project.dir, "env-marker.txt");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(project.dir, "subdir"), { recursive: true });
      await createEnvFile(subEnvPath, { LOOPX_REL_VAR: "relative-env" });
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_REL_VAR" > "${markerPath}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, envFile: "subdir/test.env" })) {}
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(markerPath, "utf-8")).toBe("relative-env");
    });

    // T-API-21b: Relative envFile resolved against process.cwd() when no cwd option.
    it("T-API-21b: relative envFile resolved against process.cwd() when no cwd option", async () => {
      project = await createTempProject();
      const envFilePath = join(project.dir, "my.env");
      const markerPath = join(project.dir, "env-marker.txt");
      await createEnvFile(envFilePath, { LOOPX_NOCWD_VAR: "nocwd-env" });
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_NOCWD_VAR" > "${markerPath}"
printf '{"stop":true}'`,
      );

      // The driver's process.cwd() is set to project.dir via runAPIDriver's cwd option.
      const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", { maxIterations: 1, envFile: "my.env" })) {}
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode, { cwd: project.dir });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(markerPath, "utf-8")).toBe("nocwd-env");
    });

    // T-API-21c: Env file parse warnings forwarded to stderr.
    it("T-API-21c: local env file parse warning forwarded to stderr", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);
      const localEnvPath = join(project.dir, "local.env");
      await writeEnvFileRaw(localEnvPath, "justtext\n");

      const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, envFile: "local.env" })) {}
console.log("done");
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/warning/i);
    });

    // T-API-21d: Global env file parse warnings forwarded to stderr.
    it("T-API-21d: global env file parse warning forwarded to stderr", async () => {
      await withGlobalEnv({}, async () => {
        const globalEnvPath = join(process.env.XDG_CONFIG_HOME!, "loopx", "env");
        await writeEnvFileRaw(globalEnvPath, "1BAD=val\n");

        project = await createTempProject();
        await createBashWorkflowScript(project!, "ralph", "index", `printf '{"stop":true}'`);

        const driverCode = `
import { run } from "loopx";
for await (const _ of run("ralph", { cwd: ${JSON.stringify(project!.dir)}, maxIterations: 1 })) {}
console.log("done");
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME! },
        });
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/warning/i);
      });
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9.12 — maxIterations Validation
// ═════════════════════════════════════════════════════════════

describe("SPEC: maxIterations Validation", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-22: run() with maxIterations: -1 → throws.
    it("T-API-22: run() with maxIterations:-1 throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: -1 });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-23: run() with maxIterations: 1.5 → throws.
    it("T-API-23: run() with maxIterations:1.5 throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1.5 });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-23a: run() with maxIterations: NaN → throws.
    it("T-API-23a: run() with maxIterations:NaN throws on first next()", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: NaN });
let threw = false;
try { await gen.next(); } catch { threw = true; }
console.log(JSON.stringify({ threw }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threw).toBe(true);
    });

    // T-API-24: runPromise() with maxIterations: NaN → rejects.
    it("T-API-24: runPromise() with maxIterations:NaN rejects", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: NaN }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-24a: runPromise() with maxIterations: -1 → rejects.
    it("T-API-24a: runPromise() with maxIterations:-1 rejects", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: -1 }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-24b: runPromise() with maxIterations: 1.5 → rejects.
    it("T-API-24b: runPromise() with maxIterations:1.5 rejects", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"stop":true}'`);

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false;
try { await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1.5 }); }
catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9.13 — runPromise() with AbortSignal
// ═════════════════════════════════════════════════════════════

describe("SPEC: runPromise() with AbortSignal", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-25: abort rejects runPromise.
    it("T-API-25: abort signal rejects runPromise", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        counter(counterFile).replace(/^#!\/bin\/bash\n/, ""),
      );

      const driverCode = `
import { runPromise } from "loopx";
const ac = new AbortController();
setTimeout(() => ac.abort(), 200);
let rejected = false;
try {
  await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 10000, signal: ac.signal });
} catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });

    // T-API-25a: pre-aborted signal rejects immediately, no child spawned.
    it("T-API-25a: pre-aborted signal rejects immediately, no child spawned", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        counter(counterFile).replace(/^#!\/bin\/bash\n/, ""),
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync } from "node:fs";
const ac = new AbortController();
ac.abort();
let rejected = false;
try {
  await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5, signal: ac.signal });
} catch { rejected = true; }
await new Promise(r => setTimeout(r, 500));
const counterExists = existsSync(${JSON.stringify(counterFile)});
console.log(JSON.stringify({ rejected, counterExists }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.counterExists).toBe(false);
    });

    // T-API-25b: abort between iterations rejects.
    it("T-API-25b: abort between iterations rejects runPromise", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `printf '{"result":"fast"}'`);

      const driverCode = `
import { runPromise } from "loopx";
const ac = new AbortController();
setTimeout(() => ac.abort(), 200);
let rejected = false;
try {
  await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 100, signal: ac.signal });
} catch { rejected = true; }
console.log(JSON.stringify({ rejected }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9 — Inherited Env Snapshot Timing (SPEC §9.1 / §9.2 / §8.1)
// ═════════════════════════════════════════════════════════════
//
// Under run(), the inherited process.env snapshot is LAZY — captured on the
// first next() call alongside the rest of the pre-iteration sequence.
// Mutations between run() returning and first next() ARE observed; later
// mutations between iterations are not (the snapshot is reused once taken).
//
// Under runPromise(), the inherited process.env snapshot is EAGER — captured
// synchronously at the runPromise() call site. Mutations to process.env
// after runPromise() returns are NOT observed. The same eager schedule
// applies to global env file path resolution (XDG_CONFIG_HOME / HOME).

describe("SPEC: Inherited Env Snapshot Timing", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-API-71: run() inherited-env snapshot is lazy (captured at first next()).
    it("T-API-71: run() inherited-env snapshot is lazy — mutation between run() and first next() observed", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
process.env.MYVAR = "A";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
process.env.MYVAR = "B";
const results = [];
for await (const o of gen) { results.push(o); }
console.log(JSON.stringify({ count: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      // Lazy snapshot taken on first next() — the post-call mutation ("B") is
      // observed because the snapshot had not yet been taken when the mutation
      // happened.
      expect(readFileSync(marker, "utf-8")).toBe("B");
    });

    // T-API-71a: run() inherited-env snapshot is frozen at first next().
    it("T-API-71a: run() inherited-env snapshot is frozen at first next() — mutation between iterations not observed", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      const markerDir = project.dir;
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
COUNTER_FILE="${counterFile}"
if [ -f "$COUNTER_FILE" ]; then
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
else
  N=1
fi
printf '%s' "$N" > "$COUNTER_FILE"
printf '%s' "\${MYVAR:-UNSET}" > "${markerDir}/iter\${N}.txt"
if [ "$N" -ge 2 ]; then
  printf '{"stop":true}'
else
  printf '{}'
fi`,
      );

      const driverCode = `
import { run } from "loopx";
process.env.MYVAR = "A";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
const r1 = await gen.next();
// Mutation between gen.next() calls: must NOT propagate to iteration 2 because
// the inherited-env snapshot is frozen at first next().
process.env.MYVAR = "B";
const r2 = await gen.next();
const r3 = await gen.next();
console.log(JSON.stringify({ done3: r3.done, count: [r1, r2].filter(x => !x.done).length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.done3).toBe(true);
      expect(parsed.count).toBe(2);
      // Both iterations observe the snapshot taken at first next() — "A".
      expect(readFileSync(join(markerDir, "iter1.txt"), "utf-8")).toBe("A");
      expect(readFileSync(join(markerDir, "iter2.txt"), "utf-8")).toBe("A");
    });

    // T-API-72: runPromise() inherited-env snapshot is eager (captured at call site).
    it("T-API-72: runPromise() inherited-env snapshot is eager — mutation after return not observed", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
process.env.MYVAR = "A";
const p = runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
// Eager snapshot taken at runPromise() call site — this mutation is too late.
process.env.MYVAR = "B";
const outputs = await p;
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(marker, "utf-8")).toBe("A");
    });

    // T-API-72a: runPromise() inherited-env snapshot is reused across iterations.
    // Uses a release-sentinel barrier to synchronize a mid-run mutation between
    // iter 1 and iter 2 — the eager snapshot taken at call time must be reused
    // for every iteration of the run.
    it("T-API-72a: runPromise() inherited-env snapshot reused across iterations — mid-run mutation not observed", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      const releasePath = join(project.dir, "release.sentinel");
      const markerDir = project.dir;
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
COUNTER_FILE="${counterFile}"
RELEASE="${releasePath}"
if [ -f "$COUNTER_FILE" ]; then
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
else
  N=1
fi
printf '%s' "$N" > "$COUNTER_FILE"
printf '%s' "\${MYVAR:-UNSET}" > "${markerDir}/iter\${N}.txt"
if [ "$N" -eq 1 ]; then
  # Iter 1 waits for release before exiting so the driver can mutate MYVAR
  # between iter-1 capture and iter-2 spawn.
  while [ ! -f "$RELEASE" ]; do sleep 0.02; done
fi
if [ "$N" -ge 2 ]; then
  printf '{"stop":true}'
else
  printf '{}'
fi`,
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, writeFileSync } from "node:fs";
process.env.MYVAR = "A";
const p = runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 2 });
// Wait for iter-1 marker to confirm iter 1 has captured MYVAR before mutating.
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  if (existsSync(${JSON.stringify(join(markerDir, "iter1.txt"))})) break;
  await new Promise(r => setTimeout(r, 25));
}
// Mutate MYVAR mid-run, then release iter 1 so iter 2 can spawn.
process.env.MYVAR = "B";
writeFileSync(${JSON.stringify(releasePath)}, "");
const outputs = await p;
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode, { timeout: 30_000 });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(2);
      // Both iterations observe the eager snapshot ("A") — the mid-run
      // mutation to "B" must not propagate to iter 2 because the inherited
      // env snapshot is reused for the entire run.
      expect(readFileSync(join(markerDir, "iter1.txt"), "utf-8")).toBe("A");
      expect(readFileSync(join(markerDir, "iter2.txt"), "utf-8")).toBe("A");
    });

    // T-API-72b: runPromise() global env file path resolution is eager.
    // SPEC §9.2: "Global env file path resolution (XDG_CONFIG_HOME / HOME)
    // also uses this schedule."
    it("T-API-72b: runPromise() XDG_CONFIG_HOME mutation after return does not redirect global env file lookup", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myglobal.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MY_GLOBAL:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      // Two XDG_CONFIG_HOME directories with different env file contents.
      const xdgA = await mkdtemp(join(osTmpdir(), "loopx-xdg-a-"));
      await mkdir(join(xdgA, "loopx"), { recursive: true });
      await writeFile(join(xdgA, "loopx", "env"), "MY_GLOBAL=valueA\n", "utf-8");

      const xdgB = await mkdtemp(join(osTmpdir(), "loopx-xdg-b-"));
      await mkdir(join(xdgB, "loopx"), { recursive: true });
      await writeFile(join(xdgB, "loopx", "env"), "MY_GLOBAL=valueB\n", "utf-8");

      try {
        const driverCode = `
import { runPromise } from "loopx";
process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgA)};
const p = runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
// Eager path resolution at call site pinned the global env file to xdgA.
// A post-return mutation must not redirect the lookup to xdgB.
process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgB)};
const outputs = await p;
console.log(JSON.stringify({ count: outputs.length }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).count).toBe(1);
        expect(readFileSync(marker, "utf-8")).toBe("valueA");
      } finally {
        await Promise.all([
          rm(xdgA, { recursive: true, force: true }),
          rm(xdgB, { recursive: true, force: true }),
        ]);
      }
    });

    // T-API-71b: run() global env file path resolution is lazy (counterpart to 72b).
    it("T-API-71b: run() XDG_CONFIG_HOME mutation between run() and first next() redirects global env file lookup", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myglobal.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MY_GLOBAL:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const xdgA = await mkdtemp(join(osTmpdir(), "loopx-xdg-a-"));
      await mkdir(join(xdgA, "loopx"), { recursive: true });
      await writeFile(join(xdgA, "loopx", "env"), "MY_GLOBAL=valueA\n", "utf-8");

      const xdgB = await mkdtemp(join(osTmpdir(), "loopx-xdg-b-"));
      await mkdir(join(xdgB, "loopx"), { recursive: true });
      await writeFile(join(xdgB, "loopx", "env"), "MY_GLOBAL=valueB\n", "utf-8");

      try {
        const driverCode = `
import { run } from "loopx";
process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgA)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
// Lazy path resolution — mutation before first next() redirects the lookup.
process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdgB)};
const results = [];
for await (const o of gen) { results.push(o); }
console.log(JSON.stringify({ count: results.length }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).count).toBe(1);
        expect(readFileSync(marker, "utf-8")).toBe("valueB");
      } finally {
        await Promise.all([
          rm(xdgA, { recursive: true, force: true }),
          rm(xdgB, { recursive: true, force: true }),
        ]);
      }
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9 — Abort After Final Yield (SPEC §9.3 / §9.1)
// ═════════════════════════════════════════════════════════════
//
// Per SPEC §9.3: "Abort observed after the final yield but before the
// generator settles produces the abort error on the next generator
// interaction — `g.next()`, `.return()`, or `.throw()`."
//
// The "final yield" can be triggered by either `maxIterations`-reached or by
// a script-emitted `stop: true`. The abort-after-final-yield rule applies
// symmetrically across both triggers and across all three settle-triggering
// interactions.
//
// For `.throw()`, the abort error displaces the consumer-supplied error per
// SPEC §9.3 (signal wins).
//
// These tests pin the OUTCOME axis of the contract (error identity and
// rejection rather than silent settlement). The CLEANUP-ORDERING axis (tmpdir
// removed before the abort error surfaces) is pinned by the T-TMP-23/24a/24c/
// 24d/24e/24f/24g family in tmpdir.test.ts.

describe("SPEC: Abort After Final Yield", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-66: Abort after maxIterations-driven final yield + .next() →
    // abort error (not silent { done: true }). SPEC §9.3.
    // ------------------------------------------------------------------------
    it("T-API-66: abort after final yield (maxIter) + .next() → abort error", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '{"result":"ok"}'
`,
      );

      const driverCode = `
import { run } from "loopx";
const c = new AbortController();
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, signal: c.signal });
const first = await gen.next();
c.abort();
let result;
try {
  await gen.next();
  result = { kind: "resolved" };
} catch (e) {
  result = { kind: "rejected", name: e instanceof Error ? (e.name || "") : "", msg: e instanceof Error ? e.message : String(e) };
}
console.log(JSON.stringify({
  firstDone: first.done,
  firstHasValue: first.value !== undefined,
  result,
}));
`;
      const apiResult = await runAPIDriver(runtime, driverCode);
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.firstHasValue).toBe(true);
      expect(data.result.kind).toBe("rejected");
      expect(data.result.name === "AbortError" || /abort/i.test(data.result.msg)).toBe(true);
    });

    // ------------------------------------------------------------------------
    // T-API-66a: Abort after maxIterations-driven final yield + .return() →
    // abort error (not silent settlement). SPEC §9.3 / §9.1.
    // ------------------------------------------------------------------------
    it("T-API-66a: abort after final yield (maxIter) + .return() → abort error", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '{"result":"ok"}'
`,
      );

      const driverCode = `
import { run } from "loopx";
const c = new AbortController();
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, signal: c.signal });
const first = await gen.next();
c.abort();
let result;
try {
  await gen.return(undefined);
  result = { kind: "resolved" };
} catch (e) {
  result = { kind: "rejected", name: e instanceof Error ? (e.name || "") : "", msg: e instanceof Error ? e.message : String(e) };
}
console.log(JSON.stringify({
  firstDone: first.done,
  result,
}));
`;
      const apiResult = await runAPIDriver(runtime, driverCode);
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.result.kind).toBe("rejected");
      expect(data.result.name === "AbortError" || /abort/i.test(data.result.msg)).toBe(true);
    });

    // ------------------------------------------------------------------------
    // T-API-66b: Abort after maxIterations-driven final yield + .throw() →
    // abort error displaces consumer-supplied error. SPEC §9.3 / §9.1.
    // ------------------------------------------------------------------------
    it("T-API-66b: abort after final yield (maxIter) + .throw() → abort displaces consumer error", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '{"result":"ok"}'
`,
      );

      const driverCode = `
import { run } from "loopx";
const c = new AbortController();
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, signal: c.signal });
const first = await gen.next();
c.abort();
let result;
try {
  await gen.throw(new Error("consumer-err"));
  result = { kind: "resolved" };
} catch (e) {
  result = { kind: "rejected", name: e instanceof Error ? (e.name || "") : "", msg: e instanceof Error ? e.message : String(e) };
}
console.log(JSON.stringify({
  firstDone: first.done,
  result,
}));
`;
      const apiResult = await runAPIDriver(runtime, driverCode);
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.result.kind).toBe("rejected");
      // Abort error displaces consumer-supplied "consumer-err".
      expect(data.result.msg).not.toBe("consumer-err");
      expect(data.result.name === "AbortError" || /abort/i.test(data.result.msg)).toBe(true);
    });

    // ------------------------------------------------------------------------
    // T-API-66c: Abort after stop:true-driven final yield + .next() → abort
    // error (not silent settlement). SPEC §9.3 / §9.1.
    // ------------------------------------------------------------------------
    it("T-API-66c: abort after stop:true final yield + .next() → abort error", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { run } from "loopx";
const c = new AbortController();
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5, signal: c.signal });
const first = await gen.next();
c.abort();
let result;
try {
  await gen.next();
  result = { kind: "resolved" };
} catch (e) {
  result = { kind: "rejected", name: e instanceof Error ? (e.name || "") : "", msg: e instanceof Error ? e.message : String(e) };
}
console.log(JSON.stringify({
  firstDone: first.done,
  firstStop: first.value && first.value.stop === true,
  result,
}));
`;
      const apiResult = await runAPIDriver(runtime, driverCode);
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.firstStop).toBe(true);
      expect(data.result.kind).toBe("rejected");
      expect(data.result.name === "AbortError" || /abort/i.test(data.result.msg)).toBe(true);
    });

    // ------------------------------------------------------------------------
    // T-API-66d: Abort after stop:true-driven final yield + .return() →
    // abort error (not silent settlement). SPEC §9.3 / §9.1.
    // ------------------------------------------------------------------------
    it("T-API-66d: abort after stop:true final yield + .return() → abort error", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { run } from "loopx";
const c = new AbortController();
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5, signal: c.signal });
const first = await gen.next();
c.abort();
let result;
try {
  await gen.return(undefined);
  result = { kind: "resolved" };
} catch (e) {
  result = { kind: "rejected", name: e instanceof Error ? (e.name || "") : "", msg: e instanceof Error ? e.message : String(e) };
}
console.log(JSON.stringify({
  firstStop: first.value && first.value.stop === true,
  result,
}));
`;
      const apiResult = await runAPIDriver(runtime, driverCode);
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.firstStop).toBe(true);
      expect(data.result.kind).toBe("rejected");
      expect(data.result.name === "AbortError" || /abort/i.test(data.result.msg)).toBe(true);
    });

    // ------------------------------------------------------------------------
    // T-API-66e: Abort after stop:true-driven final yield + .throw() →
    // abort error displaces consumer-supplied error. SPEC §9.3 / §9.1.
    // ------------------------------------------------------------------------
    it("T-API-66e: abort after stop:true final yield + .throw() → abort displaces consumer error", async () => {
      project = await createTempProject();
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { run } from "loopx";
const c = new AbortController();
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5, signal: c.signal });
const first = await gen.next();
c.abort();
let result;
try {
  await gen.throw(new Error("consumer-err"));
  result = { kind: "resolved" };
} catch (e) {
  result = { kind: "rejected", name: e instanceof Error ? (e.name || "") : "", msg: e instanceof Error ? e.message : String(e) };
}
console.log(JSON.stringify({
  firstStop: first.value && first.value.stop === true,
  result,
}));
`;
      const apiResult = await runAPIDriver(runtime, driverCode);
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.firstStop).toBe(true);
      expect(data.result.kind).toBe("rejected");
      // Abort error displaces consumer-supplied "consumer-err".
      expect(data.result.msg).not.toBe("consumer-err");
      expect(data.result.name === "AbortError" || /abort/i.test(data.result.msg)).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9 — RunOptions.env Basic Injection (SPEC §9.5 / §8.3)
// ═════════════════════════════════════════════════════════════
//
// Per SPEC §9.5: RunOptions.env entries are injected into every spawned
// script's environment. Entries merge into the child environment after global
// and local env-file loading and before loopx-injected protocol variables (see
// §8.3 precedence list). The entries apply to every script in the run —
// starting target, intra- and cross-workflow goto destinations, and loop
// resets all receive the same env additions.

describe("SPEC: RunOptions.env Basic Injection", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-50: RunOptions.env injects a variable into the spawned script.
    // SPEC §9.5 / §8.3.
    // ------------------------------------------------------------------------
    it("T-API-50: runPromise() RunOptions.env injects MYVAR into the spawned script", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `if [ -n "\${MYVAR+x}" ]; then
  printf 'present\\t%s' "$MYVAR" > "${marker}"
else
  printf 'absent' > "${marker}"
fi
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MYVAR: "hello" },
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(marker, "utf-8")).toBe("present\thello");
    });

    // ------------------------------------------------------------------------
    // T-API-50a: RunOptions.env applies across iterations (every iteration's
    // spawned child observes MYVAR). SPEC §9.5 / §8.3.
    // ------------------------------------------------------------------------
    it("T-API-50a: RunOptions.env applies across multiple iterations", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      const markerDir = project.dir;
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
COUNTER_FILE="${counterFile}"
if [ -f "$COUNTER_FILE" ]; then
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
else
  N=1
fi
printf '%s' "$N" > "$COUNTER_FILE"
printf '%s' "\${MYVAR:-UNSET}" > "${markerDir}/iter\${N}.txt"
if [ "$N" -ge 2 ]; then
  printf '{"stop":true}'
else
  printf '{}'
fi`,
      );

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const o of run("ralph", { cwd: ${JSON.stringify(project.dir)}, env: { MYVAR: "shared" }, maxIterations: 3 })) {
  results.push(o);
}
console.log(JSON.stringify({ count: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(2);
      expect(readFileSync(join(markerDir, "iter1.txt"), "utf-8")).toBe("shared");
      expect(readFileSync(join(markerDir, "iter2.txt"), "utf-8")).toBe("shared");
    });

    // ------------------------------------------------------------------------
    // T-API-50b: RunOptions.env applies across intra-workflow goto.
    // ralph:index → ralph:check; both observe MYVAR. SPEC §9.5 / §8.3.
    // ------------------------------------------------------------------------
    it("T-API-50b: RunOptions.env applies across intra-workflow goto", async () => {
      project = await createTempProject();
      const markerDir = project.dir;
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${markerDir}/index.txt"
printf '{"goto":"ralph:check"}'`,
      );
      await createBashWorkflowScript(
        project,
        "ralph",
        "check",
        `printf '%s' "\${MYVAR:-UNSET}" > "${markerDir}/check.txt"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const o of run("ralph", { cwd: ${JSON.stringify(project.dir)}, env: { MYVAR: "intra" } })) {
  results.push(o);
}
console.log(JSON.stringify({ count: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(2);
      expect(readFileSync(join(markerDir, "index.txt"), "utf-8")).toBe("intra");
      expect(readFileSync(join(markerDir, "check.txt"), "utf-8")).toBe("intra");
    });

    // ------------------------------------------------------------------------
    // T-API-50c: RunOptions.env applies across cross-workflow goto.
    // alpha:index → beta:step; both observe MYVAR. SPEC §9.5 / §8.3.
    // ------------------------------------------------------------------------
    it("T-API-50c: RunOptions.env applies across cross-workflow goto", async () => {
      project = await createTempProject();
      const markerDir = project.dir;
      await createBashWorkflowScript(
        project,
        "alpha",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${markerDir}/alpha.txt"
printf '{"goto":"beta:step"}'`,
      );
      await createBashWorkflowScript(
        project,
        "beta",
        "step",
        `printf '%s' "\${MYVAR:-UNSET}" > "${markerDir}/beta.txt"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const o of run("alpha", { cwd: ${JSON.stringify(project.dir)}, env: { MYVAR: "cross" } })) {
  results.push(o);
}
console.log(JSON.stringify({ count: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(2);
      expect(readFileSync(join(markerDir, "alpha.txt"), "utf-8")).toBe("cross");
      expect(readFileSync(join(markerDir, "beta.txt"), "utf-8")).toBe("cross");
    });

    // ------------------------------------------------------------------------
    // T-API-50d: RunOptions.env applies on loop reset. ralph:index returns to
    // ralph:index after a chain completes without stop:true. Both runs of
    // ralph:index observe MYVAR. SPEC §9.5 / §8.3.
    // ------------------------------------------------------------------------
    it("T-API-50d: RunOptions.env applies on loop reset", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      const markerDir = project.dir;
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
COUNTER_FILE="${counterFile}"
if [ -f "$COUNTER_FILE" ]; then
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
else
  N=1
fi
printf '%s' "$N" > "$COUNTER_FILE"
printf '%s' "\${MYVAR:-UNSET}" > "${markerDir}/run\${N}.txt"
if [ "$N" -ge 2 ]; then
  printf '{"stop":true}'
fi`,
      );

      const driverCode = `
import { run } from "loopx";
const results = [];
for await (const o of run("ralph", { cwd: ${JSON.stringify(project.dir)}, env: { MYVAR: "reset" } })) {
  results.push(o);
}
console.log(JSON.stringify({ count: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(2);
      expect(readFileSync(join(markerDir, "run1.txt"), "utf-8")).toBe("reset");
      expect(readFileSync(join(markerDir, "run2.txt"), "utf-8")).toBe("reset");
    });

    // ------------------------------------------------------------------------
    // T-API-50e: Empty-string entry value reaches the spawned script as the
    // empty string (distinguishable from `undefined`). SPEC §8.3 / §9.5.
    // ------------------------------------------------------------------------
    it("T-API-50e: empty-string entry value reaches script as empty string (present, not unset)", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `if [ -n "\${MYVAR+x}" ]; then
  printf 'present\\t%s' "$MYVAR" > "${marker}"
else
  printf 'absent' > "${marker}"
fi
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MYVAR: "" },
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      // present\t<empty> — the variable IS set in the env (distinguishable
      // from "absent", which would mean MYVAR was not set at all).
      expect(readFileSync(marker, "utf-8")).toBe("present\t");
    });

    // ------------------------------------------------------------------------
    // T-API-50h: Tricky non-NUL string values (whitespace, embedded `=`, `#`,
    // quotes, backslash, UTF-8, `\n`, `\r\n`, `\t`, whitespace-only) reach the
    // spawned script byte-for-byte unchanged across both API surfaces.
    // SPEC §9.5 / §8.3 — RunOptions.env is NOT subject to env-file parser
    // normalization.
    // ------------------------------------------------------------------------
    it("T-API-50h: tricky non-NUL string values reach script byte-for-byte unchanged (runPromise + run)", async () => {
      project = await createTempProject();
      const markerDir = project.dir;
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `# Dump every observed entry verbatim into per-key marker files.
# Use bash indirect expansion (\${!key}) — eval "val=\\"\\$\\$key\\"" would
# expand \\$\\$ as the shell PID rather than escaped-dollar then key-expansion.
for key in V_SPACES V_EQ V_HASH V_DQ V_SQ V_BS V_UTF V_LF V_CRLF V_TAB V_WSONLY; do
  printf '%s' "\${!key}" > "${markerDir}/\${key}.txt"
done
printf '{"stop":true}'`,
      );

      // Construct a payload of tricky values (NO embedded NUL — those would
      // surface as runtime spawn failures per T-API-57).
      const payload = {
        V_SPACES: "  leading and trailing  ",
        V_EQ: "a=b=c",
        V_HASH: "value # not a comment",
        V_DQ: 'has "double" quotes',
        V_SQ: "has 'single' quotes",
        V_BS: "back\\slash\\path",
        V_UTF: "UTF-8 ✅ é 日本語",
        V_LF: "line1\nline2",
        V_CRLF: "win1\r\nwin2",
        V_TAB: "col1\tcol2",
        V_WSONLY: "   ",
      };

      // Surface 1: runPromise().
      const driverCode1 = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: ${JSON.stringify(payload)},
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result1 = await runAPIDriver(runtime, driverCode1);
      expect(result1.exitCode).toBe(0);
      expect(JSON.parse(result1.stdout).count).toBe(1);
      for (const [key, expected] of Object.entries(payload)) {
        expect(readFileSync(join(markerDir, `${key}.txt`), "utf-8")).toBe(expected);
      }

      // Reset markers between surfaces (each surface writes the same files).
      for (const key of Object.keys(payload)) {
        await rm(join(markerDir, `${key}.txt`), { force: true });
      }

      // Surface 2: run().
      const driverCode2 = `
import { run } from "loopx";
let count = 0;
for await (const _ of run("ralph", { cwd: ${JSON.stringify(project.dir)}, env: ${JSON.stringify(payload)}, maxIterations: 1 })) {
  count++;
}
console.log(JSON.stringify({ count }));
`;
      const result2 = await runAPIDriver(runtime, driverCode2);
      expect(result2.exitCode).toBe(0);
      expect(JSON.parse(result2.stdout).count).toBe(1);
      for (const [key, expected] of Object.entries(payload)) {
        expect(readFileSync(join(markerDir, `${key}.txt`), "utf-8")).toBe(expected);
      }
    });

    // ------------------------------------------------------------------------
    // T-API-50f: Concurrent runPromise() calls receive isolated RunOptions.env
    // values. Pins ADR-0004's core motivation: per-run env values reach scripts
    // without racy global process.env mutation. Two distinct workflows in the
    // same project (alpha, beta), each observing MYVAR into a caller-supplied
    // marker, each waiting on a caller-supplied release file before emitting
    // stop:true. The release-file barrier guarantees the two scripts overlap
    // on the RunOptions.env snapshot / spawn boundary — when one script blocks
    // waiting for its release file, the other is already past runPromise()-call
    // and has spawned. A buggy implementation that mutated process.env to
    // apply per-run values would observably leak across concurrent runs.
    // SPEC §9.5 / §9.2 / §8.3.
    // ------------------------------------------------------------------------
    it("T-API-50f: concurrent runPromise() calls receive isolated RunOptions.env values", async () => {
      project = await createTempProject();
      const alphaMarker = join(project.dir, "alpha-marker.txt");
      const betaMarker = join(project.dir, "beta-marker.txt");
      const releaseAlpha = join(project.dir, "release-alpha");
      const releaseBeta = join(project.dir, "release-beta");

      await createBashWorkflowScript(
        project,
        "alpha",
        "index",
        `printf '%s' "$MYVAR" > "$ALPHA_MARKER"
while [ ! -f "$ALPHA_RELEASE" ]; do sleep 0.05; done
printf '{"stop":true}'`,
      );
      await createBashWorkflowScript(
        project,
        "beta",
        "index",
        `printf '%s' "$MYVAR" > "$BETA_MARKER"
while [ ! -f "$BETA_RELEASE" ]; do sleep 0.05; done
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, writeFileSync } from "node:fs";
const cwd = ${JSON.stringify(project.dir)};
const releaseAlpha = ${JSON.stringify(releaseAlpha)};
const releaseBeta = ${JSON.stringify(releaseBeta)};
const alphaMarker = ${JSON.stringify(alphaMarker)};
const betaMarker = ${JSON.stringify(betaMarker)};
const pAlpha = runPromise("alpha", {
  cwd,
  maxIterations: 1,
  env: { MYVAR: "alpha-value", ALPHA_MARKER: alphaMarker, ALPHA_RELEASE: releaseAlpha },
});
const pBeta = runPromise("beta", {
  cwd,
  maxIterations: 1,
  env: { MYVAR: "beta-value", BETA_MARKER: betaMarker, BETA_RELEASE: releaseBeta },
});
// Wait for both markers — proves both scripts have spawned and observed
// MYVAR before either completes. The two runs genuinely overlap.
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  if (existsSync(alphaMarker) && existsSync(betaMarker)) break;
  await new Promise((r) => setTimeout(r, 50));
}
writeFileSync(releaseAlpha, "");
writeFileSync(releaseBeta, "");
const [outA, outB] = await Promise.all([pAlpha, pBeta]);
console.log(JSON.stringify({ alphaCount: outA.length, betaCount: outB.length }));
`;
      const result = await runAPIDriver(runtime, driverCode, { timeout: 25_000 });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.alphaCount).toBe(1);
      expect(data.betaCount).toBe(1);
      // (a) alpha saw only its own value.
      expect(readFileSync(alphaMarker, "utf-8")).toBe("alpha-value");
      // (b) beta saw only its own value.
      expect(readFileSync(betaMarker, "utf-8")).toBe("beta-value");
      // (c) no cross-contamination either way.
      expect(readFileSync(alphaMarker, "utf-8")).not.toBe("beta-value");
      expect(readFileSync(betaMarker, "utf-8")).not.toBe("alpha-value");
    });

    // ------------------------------------------------------------------------
    // T-API-50g: Concurrent run() generator calls receive isolated
    // RunOptions.env values. Generator-surface counterpart to T-API-50f.
    // SPEC §9.1 lazy-process.env-snapshot timing differs from §9.2 eager-
    // snapshot; an implementation that wired RunOptions.env correctly on the
    // eager runPromise() path while losing isolation on the lazy run() path —
    // for example, by re-reading shared mutable state at first next() rather
    // than from a captured snapshot — would pass T-API-50f and fail this test.
    // Same fixture; both next() calls are issued WITHOUT awaiting so both
    // generators advance past their RunOptions.env snapshot and into their
    // first child spawn before either fixture script can yield (both block
    // on the release file). SPEC §9.5 / §9.1 / §8.3.
    // ------------------------------------------------------------------------
    it("T-API-50g: concurrent run() generator calls receive isolated RunOptions.env values", async () => {
      project = await createTempProject();
      const alphaMarker = join(project.dir, "alpha-marker.txt");
      const betaMarker = join(project.dir, "beta-marker.txt");
      const releaseAlpha = join(project.dir, "release-alpha");
      const releaseBeta = join(project.dir, "release-beta");

      await createBashWorkflowScript(
        project,
        "alpha",
        "index",
        `printf '%s' "$MYVAR" > "$ALPHA_MARKER"
while [ ! -f "$ALPHA_RELEASE" ]; do sleep 0.05; done
printf '{"stop":true}'`,
      );
      await createBashWorkflowScript(
        project,
        "beta",
        "index",
        `printf '%s' "$MYVAR" > "$BETA_MARKER"
while [ ! -f "$BETA_RELEASE" ]; do sleep 0.05; done
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, writeFileSync } from "node:fs";
const cwd = ${JSON.stringify(project.dir)};
const releaseAlpha = ${JSON.stringify(releaseAlpha)};
const releaseBeta = ${JSON.stringify(releaseBeta)};
const alphaMarker = ${JSON.stringify(alphaMarker)};
const betaMarker = ${JSON.stringify(betaMarker)};
const ga = run("alpha", {
  cwd,
  maxIterations: 1,
  env: { MYVAR: "alpha-value", ALPHA_MARKER: alphaMarker, ALPHA_RELEASE: releaseAlpha },
});
const gb = run("beta", {
  cwd,
  maxIterations: 1,
  env: { MYVAR: "beta-value", BETA_MARKER: betaMarker, BETA_RELEASE: releaseBeta },
});
// Drive both generators to their first yield concurrently. Awaiting
// Promise.all([ga.next(), gb.next()]) directly would deadlock — both fixtures
// block at the release-file barrier before yielding the first Output.
// Issuing the next() promises without immediately awaiting lets the harness
// advance both generators past their first spawn while retaining control.
const aNextP = ga.next();
const bNextP = gb.next();
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  if (existsSync(alphaMarker) && existsSync(betaMarker)) break;
  await new Promise((r) => setTimeout(r, 50));
}
writeFileSync(releaseAlpha, "");
writeFileSync(releaseBeta, "");
const [aFirst, bFirst] = await Promise.all([aNextP, bNextP]);
// Drain to settlement.
let aCount = aFirst.done ? 0 : 1;
let bCount = bFirst.done ? 0 : 1;
while (true) {
  const r = await ga.next();
  if (r.done) break;
  aCount++;
}
while (true) {
  const r = await gb.next();
  if (r.done) break;
  bCount++;
}
console.log(JSON.stringify({ alphaCount: aCount, betaCount: bCount }));
`;
      const result = await runAPIDriver(runtime, driverCode, { timeout: 25_000 });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.alphaCount).toBe(1);
      expect(data.betaCount).toBe(1);
      // (a) alpha saw only its own value.
      expect(readFileSync(alphaMarker, "utf-8")).toBe("alpha-value");
      // (b) beta saw only its own value.
      expect(readFileSync(betaMarker, "utf-8")).toBe("beta-value");
      // (c) no cross-contamination either way.
      expect(readFileSync(alphaMarker, "utf-8")).not.toBe("beta-value");
      expect(readFileSync(betaMarker, "utf-8")).not.toBe("alpha-value");
    });
  });
});

// ---------------------------------------------------------------------------
// TEST-SPEC §4.9 — Programmatic API › RunOptions.env › Precedence
//
// SPEC §8.3 / §9.5 precedence chain (highest wins):
//   1. protocol vars (LOOPX_BIN / LOOPX_PROJECT_ROOT / LOOPX_WORKFLOW /
//      LOOPX_WORKFLOW_DIR / LOOPX_TMPDIR) — applied in execution.ts
//   2. RunOptions.env
//   3. local env file (-e / RunOptions.envFile)
//   4. global loopx env ($XDG_CONFIG_HOME/loopx/env)
//   5. inherited process.env
// ---------------------------------------------------------------------------

describe("SPEC: RunOptions.env Precedence", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-51a: tier-1 protocol vars override tier-2 RunOptions.env for all
    // five script-protocol-protected names. Override is silent (no stderr
    // warning / notice). LOOPX_TMPDIR observation is during-run (via
    // in-script stat) so a real loopx-created tmpdir can be distinguished
    // from a string substitution; the cleanup at SPEC §7.4 would erase a
    // post-run stat. SPEC §9.5 / §8.3 / §13 / §7.4.
    // ------------------------------------------------------------------------
    it("T-API-51a: runPromise() — protocol vars silently override RunOptions.env LOOPX_* keys", async () => {
      project = await createTempProject();
      const projectRoot = realpathSync(project.dir);
      const markerDir = project.dir;
      const binMarker = join(markerDir, "loopx_bin.txt");
      const rootMarker = join(markerDir, "loopx_project_root.txt");
      const wfMarker = join(markerDir, "loopx_workflow.txt");
      const wfDirMarker = join(markerDir, "loopx_workflow_dir.txt");
      const tmpdirMarker = join(markerDir, "loopx_tmpdir.txt");
      const tmpdirStatMarker = join(markerDir, "loopx_tmpdir_stat.txt");

      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_BIN" > "${binMarker}"
printf '%s' "$LOOPX_PROJECT_ROOT" > "${rootMarker}"
printf '%s' "$LOOPX_WORKFLOW" > "${wfMarker}"
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfDirMarker}"
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
if [ -d "$LOOPX_TMPDIR" ]; then
  printf 'is-dir' > "${tmpdirStatMarker}"
else
  printf 'not-dir' > "${tmpdirStatMarker}"
fi
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: {
    LOOPX_WORKFLOW: "fake",
    LOOPX_PROJECT_ROOT: "/tmp/fake",
    LOOPX_WORKFLOW_DIR: "/tmp/fake-dir",
    LOOPX_TMPDIR: "/tmp/fake-tmp",
    LOOPX_BIN: "/tmp/fake-bin",
  },
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);

      // (a) Each marker records the real tier-1 protocol value, not the
      //     tier-2 RunOptions.env value.
      const observedBin = readFileSync(binMarker, "utf-8");
      expect(observedBin).not.toBe("/tmp/fake-bin");
      expect(existsSync(observedBin)).toBe(true);

      const observedRoot = readFileSync(rootMarker, "utf-8");
      expect(observedRoot).not.toBe("/tmp/fake");
      expect(observedRoot).toBe(projectRoot);

      const observedWorkflow = readFileSync(wfMarker, "utf-8");
      expect(observedWorkflow).not.toBe("fake");
      expect(observedWorkflow).toBe("ralph");

      const observedWorkflowDir = readFileSync(wfDirMarker, "utf-8");
      expect(observedWorkflowDir).not.toBe("/tmp/fake-dir");
      expect(observedWorkflowDir).toBe(join(projectRoot, ".loopx", "ralph"));

      const observedTmpdir = readFileSync(tmpdirMarker, "utf-8");
      expect(observedTmpdir).not.toBe("/tmp/fake-tmp");
      // Real loopx-created tmpdir under the test runtime's os.tmpdir() (or
      // the test-isolated parent), matching the `loopx-*` naming pattern.
      expect(observedTmpdir).toMatch(/\/loopx-[^/]+$/);

      // (b) During-run stat: the path that LOOPX_TMPDIR pointed to existed
      //     as a directory while the script was running. Proves the value
      //     is the real loopx-created tmpdir, not merely a substituted
      //     string. SPEC §7.4 cleanup runs after the script, so a post-run
      //     stat would observe absence — the in-script stat is what
      //     distinguishes real from substituted.
      expect(readFileSync(tmpdirStatMarker, "utf-8")).toBe("is-dir");

      // (c) Stderr contains no override warning / error / notice for any
      //     of the five script-protocol-protected names (silent override
      //     contract — SPEC §8.3 / §13).
      const stderrLower = result.stderr.toLowerCase();
      for (const name of [
        "loopx_bin",
        "loopx_project_root",
        "loopx_workflow",
        "loopx_workflow_dir",
        "loopx_tmpdir",
      ]) {
        const re = new RegExp(
          `${name}.*(override|overrid|ignored|warning|notice)`,
          "i",
        );
        expect(stderrLower).not.toMatch(re);
      }
    });

    // ------------------------------------------------------------------------
    // T-API-51a2: generator-surface counterpart to T-API-51a — all five
    // LOOPX_* keys silently overridden on the run() surface. SPEC §9.5 /
    // §9.1 / §8.3 / §13 / §7.4.
    // ------------------------------------------------------------------------
    it("T-API-51a2: run() — protocol vars silently override RunOptions.env LOOPX_* keys", async () => {
      project = await createTempProject();
      const projectRoot = realpathSync(project.dir);
      const markerDir = project.dir;
      const binMarker = join(markerDir, "loopx_bin.txt");
      const rootMarker = join(markerDir, "loopx_project_root.txt");
      const wfMarker = join(markerDir, "loopx_workflow.txt");
      const wfDirMarker = join(markerDir, "loopx_workflow_dir.txt");
      const tmpdirMarker = join(markerDir, "loopx_tmpdir.txt");
      const tmpdirStatMarker = join(markerDir, "loopx_tmpdir_stat.txt");

      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_BIN" > "${binMarker}"
printf '%s' "$LOOPX_PROJECT_ROOT" > "${rootMarker}"
printf '%s' "$LOOPX_WORKFLOW" > "${wfMarker}"
printf '%s' "$LOOPX_WORKFLOW_DIR" > "${wfDirMarker}"
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
if [ -d "$LOOPX_TMPDIR" ]; then
  printf 'is-dir' > "${tmpdirStatMarker}"
else
  printf 'not-dir' > "${tmpdirStatMarker}"
fi
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
let count = 0;
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: {
    LOOPX_WORKFLOW: "fake",
    LOOPX_PROJECT_ROOT: "/tmp/fake",
    LOOPX_WORKFLOW_DIR: "/tmp/fake-dir",
    LOOPX_TMPDIR: "/tmp/fake-tmp",
    LOOPX_BIN: "/tmp/fake-bin",
  },
  maxIterations: 1,
})) {
  count++;
}
console.log(JSON.stringify({ count }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      // (g) generator settled cleanly with one yield.
      expect(JSON.parse(result.stdout).count).toBe(1);

      // (a) LOOPX_BIN overridden to real path.
      const observedBin = readFileSync(binMarker, "utf-8");
      expect(observedBin).not.toBe("/tmp/fake-bin");
      expect(existsSync(observedBin)).toBe(true);
      // (b) LOOPX_PROJECT_ROOT overridden.
      const observedRoot = readFileSync(rootMarker, "utf-8");
      expect(observedRoot).not.toBe("/tmp/fake");
      expect(observedRoot).toBe(projectRoot);
      // (c) LOOPX_WORKFLOW overridden.
      const observedWorkflow = readFileSync(wfMarker, "utf-8");
      expect(observedWorkflow).not.toBe("fake");
      expect(observedWorkflow).toBe("ralph");
      // (d) LOOPX_WORKFLOW_DIR overridden.
      const observedWorkflowDir = readFileSync(wfDirMarker, "utf-8");
      expect(observedWorkflowDir).not.toBe("/tmp/fake-dir");
      expect(observedWorkflowDir).toBe(join(projectRoot, ".loopx", "ralph"));
      // (e) LOOPX_TMPDIR overridden.
      const observedTmpdir = readFileSync(tmpdirMarker, "utf-8");
      expect(observedTmpdir).not.toBe("/tmp/fake-tmp");
      expect(observedTmpdir).toMatch(/\/loopx-[^/]+$/);
      // (f) During-run stat marker confirms real loopx-created tmpdir.
      expect(readFileSync(tmpdirStatMarker, "utf-8")).toBe("is-dir");
      // (h) No override warning on stderr for any of the five names.
      const stderrLower = result.stderr.toLowerCase();
      for (const name of [
        "loopx_bin",
        "loopx_project_root",
        "loopx_workflow",
        "loopx_workflow_dir",
        "loopx_tmpdir",
      ]) {
        const re = new RegExp(
          `${name}.*(override|overrid|ignored|warning|notice)`,
          "i",
        );
        expect(stderrLower).not.toMatch(re);
      }
    });

    // ------------------------------------------------------------------------
    // T-API-51b: RunOptions.env (tier 2) overrides local env-file values
    // (tier 3). SPEC §9.5 / §8.3.
    // ------------------------------------------------------------------------
    it("T-API-51b: runPromise() — RunOptions.env overrides local env-file value", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      const localEnv = join(project.dir, ".env");
      await createEnvFile(localEnv, { MYVAR: "from-file" });
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: ".env",
  env: { MYVAR: "from-options" },
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(marker, "utf-8")).toBe("from-options");
    });

    // ------------------------------------------------------------------------
    // T-API-51c: RunOptions.env (tier 2) overrides global env-file values
    // (tier 4). SPEC §9.5 / §8.3.
    // ------------------------------------------------------------------------
    it("T-API-51c: runPromise() — RunOptions.env overrides global env-file value", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const xdg = await mkdtemp(join(osTmpdir(), "loopx-xdg-51c-"));
      await mkdir(join(xdg, "loopx"), { recursive: true });
      await writeFile(join(xdg, "loopx", "env"), "MYVAR=from-global\n", "utf-8");

      try {
        const driverCode = `
import { runPromise } from "loopx";
process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdg)};
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MYVAR: "from-options" },
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).count).toBe(1);
        expect(readFileSync(marker, "utf-8")).toBe("from-options");
      } finally {
        await rm(xdg, { recursive: true, force: true });
      }
    });

    // ------------------------------------------------------------------------
    // T-API-51d: RunOptions.env (tier 2) overrides inherited process.env
    // values (tier 5). SPEC §9.5 / §8.3.
    // ------------------------------------------------------------------------
    it("T-API-51d: runPromise() — RunOptions.env overrides inherited process.env value", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
process.env.MYVAR = "inherited";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MYVAR: "from-options" },
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(marker, "utf-8")).toBe("from-options");
    });

    // ------------------------------------------------------------------------
    // T-API-51e: full precedence chain on the runPromise() surface.
    // Inherited process.env MYVAR=1 (tier 5), global env file MYVAR=2
    // (tier 4), local env file MYVAR=3 (tier 3), RunOptions.env MYVAR=4
    // (tier 2). MYVAR is not a protocol name, so RunOptions.env is the
    // effective winner. SPEC §9.5 / §8.3.
    // ------------------------------------------------------------------------
    it("T-API-51e: runPromise() — full precedence chain (RunOptions.env wins over local, global, inherited)", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      const localEnv = join(project.dir, ".env");
      await createEnvFile(localEnv, { MYVAR: "3" });
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const xdg = await mkdtemp(join(osTmpdir(), "loopx-xdg-51e-"));
      await mkdir(join(xdg, "loopx"), { recursive: true });
      await writeFile(join(xdg, "loopx", "env"), "MYVAR=2\n", "utf-8");

      try {
        const driverCode = `
import { runPromise } from "loopx";
process.env.MYVAR = "1";
process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdg)};
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: ".env",
  env: { MYVAR: "4" },
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).count).toBe(1);
        expect(readFileSync(marker, "utf-8")).toBe("4");
      } finally {
        await rm(xdg, { recursive: true, force: true });
      }
    });

    // ------------------------------------------------------------------------
    // T-API-51f: full precedence chain on the run() generator surface
    // (counterpart to T-API-51e). SPEC §9.5 / §9.1 / §8.3.
    // ------------------------------------------------------------------------
    it("T-API-51f: run() — full precedence chain (RunOptions.env wins over local, global, inherited)", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      const localEnv = join(project.dir, ".env");
      await createEnvFile(localEnv, { MYVAR: "3" });
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const xdg = await mkdtemp(join(osTmpdir(), "loopx-xdg-51f-"));
      await mkdir(join(xdg, "loopx"), { recursive: true });
      await writeFile(join(xdg, "loopx", "env"), "MYVAR=2\n", "utf-8");

      try {
        const driverCode = `
import { run } from "loopx";
process.env.MYVAR = "1";
process.env.XDG_CONFIG_HOME = ${JSON.stringify(xdg)};
let count = 0;
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: ".env",
  env: { MYVAR: "4" },
  maxIterations: 1,
})) {
  count++;
}
console.log(JSON.stringify({ count }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).count).toBe(1);
        expect(readFileSync(marker, "utf-8")).toBe("4");
      } finally {
        await rm(xdg, { recursive: true, force: true });
      }
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9 — RunOptions.env Snapshot Semantics (SPEC §9.5 / §9.1 / §9.2)
// ═════════════════════════════════════════════════════════════
//
// Per SPEC §9.5: "Entries are captured synchronously at call time as a shallow
// copy — loopx reads the supplied object's own enumerable string-keyed
// properties once. The capture runs at the run() / runPromise() call site …".
// These tests pin the eager-shallow-copy semantics across both API surfaces:
//   - value mutation after call → not observed (T-API-52, T-API-52b)
//   - key-set mutation after call → not observed (T-API-52a, T-API-52f)
//   - per-entry accessor getter invoked exactly once at call site, not per
//     spawn (T-API-52c, T-API-52d)
//   - proxy `ownKeys` and `get` traps invoked exactly once per included key
//     at call site, not per spawn (T-API-52e, T-API-52e2)

describe("SPEC: RunOptions.env Snapshot Semantics", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-52: runPromise() — RunOptions.env is snapshotted at call time;
    // mutating the original object's value after runPromise() returns has no
    // effect on the running loop. SPEC §9.5.
    // ------------------------------------------------------------------------
    it("T-API-52: runPromise() — value mutation after call is not observed", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const e = { MYVAR: "initial" };
const p = runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
e.MYVAR = "mutated";
const outputs = await p;
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(marker, "utf-8")).toBe("initial");
    });

    // ------------------------------------------------------------------------
    // T-API-52a: run() — RunOptions.env snapshot is shallow on the key-set
    // axis; a key added to the original object after run() is not observed
    // by the spawned script. SPEC §9.5 / §9.1.
    // ------------------------------------------------------------------------
    it("T-API-52a: run() — added key after call is not observed (shallow snapshot)", async () => {
      project = await createTempProject();
      const myvarMarker = join(project.dir, "myvar.txt");
      const newvarMarker = join(project.dir, "newvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `if [ -n "\${MYVAR+x}" ]; then
  printf 'present\\t%s' "$MYVAR" > "${myvarMarker}"
else
  printf 'absent' > "${myvarMarker}"
fi
if [ -n "\${NEWVAR+x}" ]; then
  printf 'present\\t%s' "$NEWVAR" > "${newvarMarker}"
else
  printf 'absent' > "${newvarMarker}"
fi
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
const e = { MYVAR: "initial" };
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
e.NEWVAR = "added";
const results = [];
for await (const o of gen) {
  results.push(o);
}
console.log(JSON.stringify({ count: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(myvarMarker, "utf-8")).toBe("present\tinitial");
      expect(readFileSync(newvarMarker, "utf-8")).toBe("absent");
    });

    // ------------------------------------------------------------------------
    // T-API-52b: run() — RunOptions.env snapshot is taken eagerly at call
    // time, not lazily at first next(). SPEC §9.5 / §9.1.
    // ------------------------------------------------------------------------
    it("T-API-52b: run() — value mutation between call and first next() is not observed (eager snapshot)", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
const e = { MYVAR: "A" };
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
e.MYVAR = "B";
const results = [];
for await (const o of gen) {
  results.push(o);
}
console.log(JSON.stringify({ count: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(marker, "utf-8")).toBe("A");
    });

    // ------------------------------------------------------------------------
    // T-API-52c: run() — RunOptions.env per-entry accessor getter is invoked
    // exactly once at call time (eager-capture clause), not at first next()
    // and not re-invoked per spawn. SPEC §9.5 / §9.1.
    // ------------------------------------------------------------------------
    it("T-API-52c: run() — accessor getter invoked exactly once at call time, not per spawn", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
let count = 0;
let backing = "initial";
const env = {};
Object.defineProperty(env, "MYVAR", {
  enumerable: true,
  configurable: true,
  get() { count += 1; return backing; },
});
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 1,
});
const countAfterRun = count;
backing = "mutated";
const countAfterMutate = count;
const results = [];
for await (const o of gen) {
  results.push(o);
}
const countAfterSettle = count;
console.log(JSON.stringify({ countAfterRun, countAfterMutate, countAfterSettle, outputs: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.countAfterRun).toBe(1);
      expect(parsed.countAfterMutate).toBe(1);
      expect(parsed.countAfterSettle).toBe(1);
      expect(parsed.outputs).toBe(1);
      expect(readFileSync(marker, "utf-8")).toBe("initial");
    });

    // ------------------------------------------------------------------------
    // T-API-52d: runPromise() — RunOptions.env per-entry accessor getter is
    // invoked exactly once synchronously before runPromise() returns, and
    // the captured value is observed by every script across multiple
    // iterations even after the backing state mutates. SPEC §9.5 / §9.2.
    // ------------------------------------------------------------------------
    it("T-API-52d: runPromise() — accessor getter invoked exactly once at call time, snapshot reused across iterations", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      const markerDir = project.dir;
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
COUNTER_FILE="${counterFile}"
if [ -f "$COUNTER_FILE" ]; then
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
else
  N=1
fi
printf '%s' "$N" > "$COUNTER_FILE"
printf '%s' "\${MYVAR:-UNSET}" > "${markerDir}/iter\${N}.txt"
if [ "$N" -ge 3 ]; then
  printf '{"stop":true}'
else
  printf '{}'
fi`,
      );

      const driverCode = `
import { runPromise } from "loopx";
let count = 0;
let backing = "initial";
const env = {};
Object.defineProperty(env, "MYVAR", {
  enumerable: true,
  configurable: true,
  get() { count += 1; return backing; },
});
const p = runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 3,
});
const countAfterCall = count;
backing = "mutated";
const countAfterMutate = count;
const outputs = await p;
const countAfterResolve = count;
console.log(JSON.stringify({ countAfterCall, countAfterMutate, countAfterResolve, outputCount: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.countAfterCall).toBe(1);
      expect(parsed.countAfterMutate).toBe(1);
      expect(parsed.countAfterResolve).toBe(1);
      expect(parsed.outputCount).toBe(3);
      expect(readFileSync(join(markerDir, "iter1.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "iter2.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "iter3.txt"), "utf-8")).toBe("initial");
    });

    // ------------------------------------------------------------------------
    // T-API-52e (variant a — run): proxy ownKeys + get traps. SPEC §9.5.
    //   - ownKeys invoked exactly once at call time
    //   - get invoked exactly once per included string key at call time
    //   - neither re-invoked across iterations / spawns
    // ------------------------------------------------------------------------
    it("T-API-52e: run() — proxy ownKeys/get traps invoked exactly once at call time, not per spawn", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      const markerDir = project.dir;
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
COUNTER_FILE="${counterFile}"
if [ -f "$COUNTER_FILE" ]; then
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
else
  N=1
fi
printf '%s' "$N" > "$COUNTER_FILE"
printf '%s' "\${MYVAR:-UNSET}" > "${markerDir}/myvar\${N}.txt"
printf '%s' "\${OTHERVAR:-UNSET}" > "${markerDir}/othervar\${N}.txt"
if [ "$N" -ge 3 ]; then
  printf '{"stop":true}'
else
  printf '{}'
fi`,
      );

      const driverCode = `
import { run } from "loopx";
let ownKeysCount = 0;
let getCount = 0;
const valueGetCounts = new Map();
const target = { MYVAR: "initial", OTHERVAR: "second" };
const env = new Proxy(target, {
  ownKeys(t) { ownKeysCount += 1; return Reflect.ownKeys(t); },
  getOwnPropertyDescriptor(t, key) { return Reflect.getOwnPropertyDescriptor(t, key); },
  get(t, key) {
    if (typeof key === "string") {
      getCount += 1;
      valueGetCounts.set(key, (valueGetCounts.get(key) ?? 0) + 1);
    }
    return Reflect.get(t, key);
  },
});
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 3,
});
const ownKeysAfterCall = ownKeysCount;
const getAfterCall = getCount;
const valueGetSnapshot = Object.fromEntries(valueGetCounts);
const outputs = [];
for await (const o of gen) {
  outputs.push(o);
}
const ownKeysAfterDone = ownKeysCount;
const getAfterDone = getCount;
const valueGetAfterDone = Object.fromEntries(valueGetCounts);
console.log(JSON.stringify({
  ownKeysAfterCall, ownKeysAfterDone,
  getAfterCall, getAfterDone,
  valueGetSnapshot, valueGetAfterDone,
  outputs: outputs.length,
}));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ownKeysAfterCall).toBe(1);
      expect(parsed.ownKeysAfterDone).toBe(parsed.ownKeysAfterCall);
      expect(parsed.getAfterCall).toBe(2);
      expect(parsed.valueGetSnapshot.MYVAR).toBe(1);
      expect(parsed.valueGetSnapshot.OTHERVAR).toBe(1);
      expect(parsed.getAfterDone).toBe(parsed.getAfterCall);
      expect(parsed.valueGetAfterDone.MYVAR).toBe(parsed.valueGetSnapshot.MYVAR);
      expect(parsed.valueGetAfterDone.OTHERVAR).toBe(parsed.valueGetSnapshot.OTHERVAR);
      expect(parsed.outputs).toBe(3);
      expect(readFileSync(join(markerDir, "myvar1.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "myvar2.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "myvar3.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "othervar1.txt"), "utf-8")).toBe("second");
      expect(readFileSync(join(markerDir, "othervar2.txt"), "utf-8")).toBe("second");
      expect(readFileSync(join(markerDir, "othervar3.txt"), "utf-8")).toBe("second");
    });

    // ------------------------------------------------------------------------
    // T-API-52e (variant b — runPromise): same trap-call invariants on the
    // eager-snapshot surface. SPEC §9.5 / §9.2.
    // ------------------------------------------------------------------------
    it("T-API-52e: runPromise() — proxy ownKeys/get traps invoked exactly once at call time, not per spawn", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      const markerDir = project.dir;
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
COUNTER_FILE="${counterFile}"
if [ -f "$COUNTER_FILE" ]; then
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
else
  N=1
fi
printf '%s' "$N" > "$COUNTER_FILE"
printf '%s' "\${MYVAR:-UNSET}" > "${markerDir}/myvar\${N}.txt"
printf '%s' "\${OTHERVAR:-UNSET}" > "${markerDir}/othervar\${N}.txt"
if [ "$N" -ge 3 ]; then
  printf '{"stop":true}'
else
  printf '{}'
fi`,
      );

      const driverCode = `
import { runPromise } from "loopx";
let ownKeysCount = 0;
let getCount = 0;
const valueGetCounts = new Map();
const target = { MYVAR: "initial", OTHERVAR: "second" };
const env = new Proxy(target, {
  ownKeys(t) { ownKeysCount += 1; return Reflect.ownKeys(t); },
  getOwnPropertyDescriptor(t, key) { return Reflect.getOwnPropertyDescriptor(t, key); },
  get(t, key) {
    if (typeof key === "string") {
      getCount += 1;
      valueGetCounts.set(key, (valueGetCounts.get(key) ?? 0) + 1);
    }
    return Reflect.get(t, key);
  },
});
const p = runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 3,
});
const ownKeysAfterCall = ownKeysCount;
const getAfterCall = getCount;
const valueGetSnapshot = Object.fromEntries(valueGetCounts);
const outputs = await p;
const ownKeysAfterDone = ownKeysCount;
const getAfterDone = getCount;
const valueGetAfterDone = Object.fromEntries(valueGetCounts);
console.log(JSON.stringify({
  ownKeysAfterCall, ownKeysAfterDone,
  getAfterCall, getAfterDone,
  valueGetSnapshot, valueGetAfterDone,
  outputs: outputs.length,
}));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ownKeysAfterCall).toBe(1);
      expect(parsed.ownKeysAfterDone).toBe(parsed.ownKeysAfterCall);
      expect(parsed.getAfterCall).toBe(2);
      expect(parsed.valueGetSnapshot.MYVAR).toBe(1);
      expect(parsed.valueGetSnapshot.OTHERVAR).toBe(1);
      expect(parsed.getAfterDone).toBe(parsed.getAfterCall);
      expect(parsed.valueGetAfterDone.MYVAR).toBe(parsed.valueGetSnapshot.MYVAR);
      expect(parsed.valueGetAfterDone.OTHERVAR).toBe(parsed.valueGetSnapshot.OTHERVAR);
      expect(parsed.outputs).toBe(3);
      expect(readFileSync(join(markerDir, "myvar1.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "myvar2.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "myvar3.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "othervar1.txt"), "utf-8")).toBe("second");
      expect(readFileSync(join(markerDir, "othervar2.txt"), "utf-8")).toBe("second");
      expect(readFileSync(join(markerDir, "othervar3.txt"), "utf-8")).toBe("second");
    });

    // ------------------------------------------------------------------------
    // T-API-52e2 (variant a): only `getOwnPropertyDescriptor` is custom-
    // trapped. SPEC §9.5 leaves the per-call descriptor count
    // implementation-defined; we assert no per-spawn re-invocation. The
    // snapshot values still reach every spawn. SPEC §9.5 / §9.1 / §9.2.
    // ------------------------------------------------------------------------
    it("T-API-52e2: runPromise() — descriptor-only proxy is not re-invoked per spawn", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      const markerDir = project.dir;
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
COUNTER_FILE="${counterFile}"
if [ -f "$COUNTER_FILE" ]; then
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
else
  N=1
fi
printf '%s' "$N" > "$COUNTER_FILE"
printf '%s' "\${MYVAR:-UNSET}" > "${markerDir}/myvar\${N}.txt"
printf '%s' "\${OTHERVAR:-UNSET}" > "${markerDir}/othervar\${N}.txt"
if [ "$N" -ge 3 ]; then
  printf '{"stop":true}'
else
  printf '{}'
fi`,
      );

      const driverCode = `
import { runPromise } from "loopx";
let descCount = 0;
const target = { MYVAR: "initial", OTHERVAR: "second" };
const env = new Proxy(target, {
  getOwnPropertyDescriptor(t, key) {
    descCount += 1;
    return Reflect.getOwnPropertyDescriptor(t, key);
  },
});
const p = runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 3,
});
const descAfterCall = descCount;
const outputs = await p;
const descAfterDone = descCount;
console.log(JSON.stringify({ descAfterCall, descAfterDone, outputs: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // SPEC §9.5 leaves the per-call descriptor count implementation-defined,
      // so only assert no per-spawn re-invocation across the multi-iteration run.
      expect(parsed.descAfterDone).toBe(parsed.descAfterCall);
      expect(parsed.outputs).toBe(3);
      expect(readFileSync(join(markerDir, "myvar1.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "myvar2.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "myvar3.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "othervar1.txt"), "utf-8")).toBe("second");
      expect(readFileSync(join(markerDir, "othervar2.txt"), "utf-8")).toBe("second");
      expect(readFileSync(join(markerDir, "othervar3.txt"), "utf-8")).toBe("second");
    });

    // ------------------------------------------------------------------------
    // T-API-52e2 (variant b): only `get` is custom-trapped. SPEC §9.5
    // [[Get]]-semantics-exactly-once contract on the value-read axis. Per
    // SPEC §9.5 / §9.2.
    // ------------------------------------------------------------------------
    it("T-API-52e2: runPromise() — get-only proxy fires exactly once per included key, not per spawn", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      const markerDir = project.dir;
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
COUNTER_FILE="${counterFile}"
if [ -f "$COUNTER_FILE" ]; then
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
else
  N=1
fi
printf '%s' "$N" > "$COUNTER_FILE"
printf '%s' "\${MYVAR:-UNSET}" > "${markerDir}/myvar\${N}.txt"
printf '%s' "\${OTHERVAR:-UNSET}" > "${markerDir}/othervar\${N}.txt"
if [ "$N" -ge 3 ]; then
  printf '{"stop":true}'
else
  printf '{}'
fi`,
      );

      const driverCode = `
import { runPromise } from "loopx";
let getCount = 0;
const valueGetCounts = new Map();
const target = { MYVAR: "initial", OTHERVAR: "second" };
const env = new Proxy(target, {
  get(t, key) {
    if (typeof key === "string") {
      getCount += 1;
      valueGetCounts.set(key, (valueGetCounts.get(key) ?? 0) + 1);
    }
    return Reflect.get(t, key);
  },
});
const p = runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 3,
});
const getAfterCall = getCount;
const valueGetSnapshot = Object.fromEntries(valueGetCounts);
const outputs = await p;
const getAfterDone = getCount;
const valueGetAfterDone = Object.fromEntries(valueGetCounts);
console.log(JSON.stringify({
  getAfterCall, getAfterDone,
  valueGetSnapshot, valueGetAfterDone,
  outputs: outputs.length,
}));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.getAfterCall).toBe(2);
      expect(parsed.valueGetSnapshot.MYVAR).toBe(1);
      expect(parsed.valueGetSnapshot.OTHERVAR).toBe(1);
      expect(parsed.getAfterDone).toBe(parsed.getAfterCall);
      expect(parsed.valueGetAfterDone.MYVAR).toBe(parsed.valueGetSnapshot.MYVAR);
      expect(parsed.valueGetAfterDone.OTHERVAR).toBe(parsed.valueGetSnapshot.OTHERVAR);
      expect(parsed.outputs).toBe(3);
      expect(readFileSync(join(markerDir, "myvar1.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "myvar2.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "myvar3.txt"), "utf-8")).toBe("initial");
      expect(readFileSync(join(markerDir, "othervar1.txt"), "utf-8")).toBe("second");
      expect(readFileSync(join(markerDir, "othervar2.txt"), "utf-8")).toBe("second");
      expect(readFileSync(join(markerDir, "othervar3.txt"), "utf-8")).toBe("second");
    });

    // ------------------------------------------------------------------------
    // T-API-52f: runPromise() — RunOptions.env snapshot is shallow on the
    // key-set axis; a key added to the original object after runPromise()
    // returns is not observed. SPEC §9.5 / §9.2.
    // ------------------------------------------------------------------------
    it("T-API-52f: runPromise() — added key after call is not observed (shallow snapshot)", async () => {
      project = await createTempProject();
      const myvarMarker = join(project.dir, "myvar.txt");
      const newvarMarker = join(project.dir, "newvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `if [ -n "\${MYVAR+x}" ]; then
  printf 'present\\t%s' "$MYVAR" > "${myvarMarker}"
else
  printf 'absent' > "${myvarMarker}"
fi
if [ -n "\${NEWVAR+x}" ]; then
  printf 'present\\t%s' "$NEWVAR" > "${newvarMarker}"
else
  printf 'absent' > "${newvarMarker}"
fi
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const e = { MYVAR: "initial" };
const p = runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
e.NEWVAR = "added";
const outputs = await p;
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(myvarMarker, "utf-8")).toBe("present\tinitial");
      expect(readFileSync(newvarMarker, "utf-8")).toBe("absent");
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9 — RunOptions.env Filtering (SPEC §9.5)
// ═════════════════════════════════════════════════════════════
//
// SPEC §9.5: loopx reads only the supplied object's own enumerable string-keyed
// properties. The filtering is a hard predicate, applied BEFORE value-shape
// validation:
//   - inherited (prototype-chain) properties: filtered (T-API-56, 56f, 56j)
//   - symbol-keyed properties: filtered (T-API-56a, 56d)
//   - non-enumerable string-keyed properties: filtered (T-API-56b, 56e)
//
// The structural-not-nominal env-shape contract: SPEC §9.5 rejects only null,
// arrays, and functions; any other non-null object qualifies as a valid env
// shape, regardless of prototype:
//   - null-prototype object: accepted, own entries reach child (T-API-56c)
//   - class instance: accepted, class fields reach child (T-API-56g)
//   - Map: accepted as a shape but contributes no entries (T-API-56h)
//
// T-API-56i is the run()-surface parity counterpart, parameterizing the
// runPromise() matrix across the eight sub-rules to verify the generator
// surface routes env through the same filtering predicate.

describe("SPEC: RunOptions.env Filtering", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  // Bash fixture template that observes a list of environment variables into
  // a marker file each. Each marker contains `present\t<value>` if the
  // variable is set (including empty string), or `absent` if unset.
  function makeObserveBashFixture(varToMarker: Record<string, string>): string {
    const lines: string[] = [];
    for (const [varname, marker] of Object.entries(varToMarker)) {
      lines.push(
        `if [ -n "\${${varname}+x}" ]; then\n  printf 'present\\t%s' "\${${varname}}" > "${marker}"\nelse\n  printf 'absent' > "${marker}"\nfi`
      );
    }
    lines.push(`printf '{"stop":true}'`);
    return lines.join("\n");
  }

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-56: Inherited keys on options.env are ignored (runPromise).
    // SPEC §9.5: own enumerable string-keyed properties only.
    // ------------------------------------------------------------------------
    it("T-API-56: runPromise() — inherited prototype keys are filtered out", async () => {
      project = await createTempProject();
      const ownMarker = join(project.dir, "own.txt");
      const inheritedMarker = join(project.dir, "inherited.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({
          OWN: ownMarker,
          INHERITED: inheritedMarker,
        })
      );

      const driverCode = `
import { runPromise } from "loopx";
const proto = { INHERITED: "proto-val" };
const e = Object.create(proto);
e.OWN = "own-val";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(ownMarker, "utf-8")).toBe("present\town-val");
      // Inherited slot is filtered before value-read; absent in child env.
      expect(readFileSync(inheritedMarker, "utf-8")).toBe("absent");
    });

    // ------------------------------------------------------------------------
    // T-API-56a: Symbol-keyed entries are ignored (runPromise).
    // SPEC §9.5: own enumerable STRING-keyed entries only — symbol keys are
    // excluded by predicate. The Symbol value never appears in the child env
    // under any stringification (Symbol(SYM), description "SYM", etc.).
    // ------------------------------------------------------------------------
    it("T-API-56a: runPromise() — symbol-keyed entries are filtered out", async () => {
      project = await createTempProject();
      const ownMarker = join(project.dir, "own.txt");
      const allEnvMarker = join(project.dir, "all-env.txt");
      // Bash fixture: observe OWN normally, then dump every env var name (one
      // per line) to a marker so the test can assert no symbol-derived stringification leaked.
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `if [ -n "\${OWN+x}" ]; then
  printf 'present\\t%s' "$OWN" > "${ownMarker}"
else
  printf 'absent' > "${ownMarker}"
fi
# Dump all env var names (one per line) to a marker.
env | cut -d= -f1 | sort > "${allEnvMarker}"
printf '{"stop":true}'`
      );

      const driverCode = `
import { runPromise } from "loopx";
const sym = Symbol("SYM");
const e = { OWN: "own-val", [sym]: "sym-val" };
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(ownMarker, "utf-8")).toBe("present\town-val");
      // Verify no symbol-derived stringified key leaked into the child env.
      // Common buggy stringifications would produce keys like:
      //   "Symbol(SYM)", "SYM", "@@SYM", or similar.
      const envNames = readFileSync(allEnvMarker, "utf-8").split("\n");
      for (const name of envNames) {
        if (!name) continue;
        // No env var name should contain the Symbol description "SYM" as a
        // standalone token (excluding cases like "OWN" or system vars).
        // The buggy stringification "Symbol(SYM)" would produce a name
        // containing "Symbol(" — check for that.
        expect(name).not.toMatch(/^Symbol\(/);
        expect(name).not.toBe("SYM");
      }
    });

    // ------------------------------------------------------------------------
    // T-API-56b: Non-enumerable string-keyed entries are ignored (runPromise).
    // SPEC §9.5: own ENUMERABLE string-keyed entries only — non-enumerable
    // are excluded by predicate.
    // ------------------------------------------------------------------------
    it("T-API-56b: runPromise() — non-enumerable string-keyed entries are filtered out", async () => {
      project = await createTempProject();
      const visibleMarker = join(project.dir, "visible.txt");
      const hiddenMarker = join(project.dir, "hidden.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({
          VISIBLE: visibleMarker,
          HIDDEN: hiddenMarker,
        })
      );

      const driverCode = `
import { runPromise } from "loopx";
const e = {};
Object.defineProperty(e, "HIDDEN", { value: "hidden-val", enumerable: false });
e.VISIBLE = "visible-val";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(visibleMarker, "utf-8")).toBe("present\tvisible-val");
      expect(readFileSync(hiddenMarker, "utf-8")).toBe("absent");
    });

    // ------------------------------------------------------------------------
    // T-API-56c: Null-prototype options.env (Object.create(null)) is accepted.
    // SPEC §9.5: env shape is structural-not-nominal; the absence of
    // Object.prototype is fine. A buggy implementation that uses
    // `instanceof Object` (false for null-prototype) or
    // `env.hasOwnProperty(...)` (TypeError on null-prototype) would fail.
    // ------------------------------------------------------------------------
    it("T-API-56c: runPromise() — null-prototype env is accepted, own entries reach child", async () => {
      project = await createTempProject();
      const myvarMarker = join(project.dir, "myvar.txt");
      const othervarMarker = join(project.dir, "othervar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({
          MYVAR: myvarMarker,
          OTHERVAR: othervarMarker,
        })
      );

      const driverCode = `
import { runPromise } from "loopx";
const e = Object.create(null);
e.MYVAR = "from-options";
e.OTHERVAR = "second-value";
let rejected = false, message = "";
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: e,
    maxIterations: 1,
  });
  console.log(JSON.stringify({ count: outputs.length, rejected: false }));
} catch (err) {
  rejected = true;
  message = err && err.message ? err.message : String(err);
  console.log(JSON.stringify({ rejected, message }));
}
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(false);
      expect(parsed.count).toBe(1);
      expect(readFileSync(myvarMarker, "utf-8")).toBe("present\tfrom-options");
      expect(readFileSync(othervarMarker, "utf-8")).toBe("present\tsecond-value");
    });

    // ------------------------------------------------------------------------
    // T-API-56d: Symbol-keyed property with a THROWING getter does not fire.
    // SPEC §9.5: symbol-keyed slots are filtered by predicate before any
    // [[Get]] runs. The getter's throw must not surface as a snapshot error.
    // ------------------------------------------------------------------------
    it("T-API-56d: runPromise() — symbol-keyed throwing getter never fires", async () => {
      project = await createTempProject();
      const ownMarker = join(project.dir, "own.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({ OWN: ownMarker })
      );

      const driverCode = `
import { runPromise } from "loopx";
const sym = Symbol("SYM-throw");
const e = { OWN: "own-val" };
Object.defineProperty(e, sym, {
  enumerable: true,
  get() { throw new Error("symbol-getter-should-never-fire"); },
});
let rejected = false, message = "";
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: e,
    maxIterations: 1,
  });
  console.log(JSON.stringify({ count: outputs.length, rejected: false }));
} catch (err) {
  rejected = true;
  message = err && err.message ? err.message : String(err);
  console.log(JSON.stringify({ rejected, message }));
}
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // Symbol getter never invoked → no rejection.
      expect(parsed.rejected).toBe(false);
      expect(parsed.count).toBe(1);
      expect(readFileSync(ownMarker, "utf-8")).toBe("present\town-val");
      // The getter's distinctive throw message must NOT appear in stderr.
      expect(result.stderr).not.toMatch(/symbol-getter-should-never-fire/);
    });

    // ------------------------------------------------------------------------
    // T-API-56e: Non-enumerable string-keyed THROWING getter does not fire.
    // Companion to T-API-56d for the non-enumerable-ignore axis.
    // ------------------------------------------------------------------------
    it("T-API-56e: runPromise() — non-enumerable throwing getter never fires", async () => {
      project = await createTempProject();
      const visibleMarker = join(project.dir, "visible.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({ VISIBLE: visibleMarker })
      );

      const driverCode = `
import { runPromise } from "loopx";
const e = { VISIBLE: "visible-val" };
Object.defineProperty(e, "HIDDEN", {
  enumerable: false,
  get() { throw new Error("non-enumerable-getter-should-never-fire"); },
});
let rejected = false, message = "";
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: e,
    maxIterations: 1,
  });
  console.log(JSON.stringify({ count: outputs.length, rejected: false }));
} catch (err) {
  rejected = true;
  message = err && err.message ? err.message : String(err);
  console.log(JSON.stringify({ rejected, message }));
}
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(false);
      expect(parsed.count).toBe(1);
      expect(readFileSync(visibleMarker, "utf-8")).toBe("present\tvisible-val");
      expect(result.stderr).not.toMatch(/non-enumerable-getter-should-never-fire/);
    });

    // ------------------------------------------------------------------------
    // T-API-56f: Inherited property with a NON-STRING value is ignored.
    // SPEC §9.5: inherited slots are filtered BEFORE value-shape validation.
    // A buggy implementation enumerating via `for ... in` would surface the
    // inherited number as a value-shape error and reject.
    // ------------------------------------------------------------------------
    it("T-API-56f: runPromise() — inherited non-string-value property never reaches value validation", async () => {
      project = await createTempProject();
      const ownMarker = join(project.dir, "own.txt");
      const inheritedMarker = join(project.dir, "inherited-number.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({
          OWN: ownMarker,
          INHERITED_NUMBER: inheritedMarker,
        })
      );

      const driverCode = `
import { runPromise } from "loopx";
const proto = { INHERITED_NUMBER: 42 };
const e = Object.create(proto);
e.OWN = "own-val";
let rejected = false, message = "";
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: e,
    maxIterations: 1,
  });
  console.log(JSON.stringify({ count: outputs.length, rejected: false }));
} catch (err) {
  rejected = true;
  message = err && err.message ? err.message : String(err);
  console.log(JSON.stringify({ rejected, message }));
}
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(false);
      expect(parsed.count).toBe(1);
      expect(readFileSync(ownMarker, "utf-8")).toBe("present\town-val");
      // Inherited slot filtered out — never reached value validation.
      expect(readFileSync(inheritedMarker, "utf-8")).toBe("absent");
    });

    // ------------------------------------------------------------------------
    // T-API-56g: Class-instance options.env is accepted. Class fields are
    // own enumerable string-keyed properties on the instance (ES2022) and
    // reach the spawned child. SPEC §9.5: structural-not-nominal contract.
    // ------------------------------------------------------------------------
    it("T-API-56g: runPromise() — class-instance env is accepted, class fields reach child", async () => {
      project = await createTempProject();
      const myvarMarker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({ MYVAR: myvarMarker })
      );

      const driverCode = `
import { runPromise } from "loopx";
class Env {
  MYVAR = "from-class";
}
let rejected = false, message = "";
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: new Env(),
    maxIterations: 1,
  });
  console.log(JSON.stringify({ count: outputs.length, rejected: false }));
} catch (err) {
  rejected = true;
  message = err && err.message ? err.message : String(err);
  console.log(JSON.stringify({ rejected, message }));
}
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(false);
      expect(parsed.count).toBe(1);
      expect(readFileSync(myvarMarker, "utf-8")).toBe("present\tfrom-class");
    });

    // ------------------------------------------------------------------------
    // T-API-56h: Map passed as options.env is accepted as a shape but
    // contributes ZERO entries — Map data lives in [[MapData]], not as own
    // enumerable string-keyed properties. SPEC §9.5: structural-not-nominal,
    // strict own-enumerable-string-key predicate.
    // ------------------------------------------------------------------------
    it("T-API-56h: runPromise() — Map env accepted but contributes no entries", async () => {
      project = await createTempProject();
      const myvarMarker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({ MYVAR: myvarMarker })
      );

      // Scrub MYVAR from inherited env so any observed value can only come
      // from the env option (not from the surrounding test process).
      const driverCode = `
import { runPromise } from "loopx";
delete process.env.MYVAR;
const e = new Map([["MYVAR", "x"]]);
let rejected = false, message = "";
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: e,
    maxIterations: 1,
  });
  console.log(JSON.stringify({ count: outputs.length, rejected: false }));
} catch (err) {
  rejected = true;
  message = err && err.message ? err.message : String(err);
  console.log(JSON.stringify({ rejected, message }));
}
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // Map is a non-null, non-array, non-function object — accepted as a shape.
      expect(parsed.rejected).toBe(false);
      expect(parsed.count).toBe(1);
      // Map's "MYVAR" → "x" entry lives in [[MapData]], not as an own
      // enumerable string-keyed property — filtered out by SPEC §9.5.
      expect(readFileSync(myvarMarker, "utf-8")).toBe("absent");
    });

    // ------------------------------------------------------------------------
    // T-API-56j: Inherited THROWING getter never fires. SPEC §9.5: inherited
    // slots are filtered by predicate. Parameterized over both runPromise
    // and run() per TEST-SPEC.
    // ------------------------------------------------------------------------
    it("T-API-56j: runPromise() — inherited throwing getter never fires", async () => {
      project = await createTempProject();
      const ownMarker = join(project.dir, "own.txt");
      const inheritedMarker = join(project.dir, "inherited.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({
          OWN: ownMarker,
          INHERITED_THROW: inheritedMarker,
        })
      );

      const driverCode = `
import { runPromise } from "loopx";
const proto = {};
Object.defineProperty(proto, "INHERITED_THROW", {
  enumerable: true,
  get() { throw new Error("inherited-getter-should-never-fire"); },
});
const e = Object.create(proto);
e.OWN = "ok";
let rejected = false, message = "";
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: e,
    maxIterations: 1,
  });
  console.log(JSON.stringify({ count: outputs.length, rejected: false }));
} catch (err) {
  rejected = true;
  message = err && err.message ? err.message : String(err);
  console.log(JSON.stringify({ rejected, message }));
}
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(false);
      expect(parsed.count).toBe(1);
      expect(readFileSync(ownMarker, "utf-8")).toBe("present\tok");
      expect(readFileSync(inheritedMarker, "utf-8")).toBe("absent");
      expect(result.stderr).not.toMatch(/inherited-getter-should-never-fire/);
    });

    it("T-API-56j: run() — inherited throwing getter never fires", async () => {
      project = await createTempProject();
      const ownMarker = join(project.dir, "own.txt");
      const inheritedMarker = join(project.dir, "inherited.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({
          OWN: ownMarker,
          INHERITED_THROW: inheritedMarker,
        })
      );

      const driverCode = `
import { run } from "loopx";
const proto = {};
Object.defineProperty(proto, "INHERITED_THROW", {
  enumerable: true,
  get() { throw new Error("inherited-getter-should-never-fire-run"); },
});
const e = Object.create(proto);
e.OWN = "ok";
let threw = false, message = "";
try {
  const gen = run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: e,
    maxIterations: 1,
  });
  let count = 0;
  for await (const _ of gen) {
    count += 1;
  }
  console.log(JSON.stringify({ count, threw: false }));
} catch (err) {
  threw = true;
  message = err && err.message ? err.message : String(err);
  console.log(JSON.stringify({ threw, message }));
}
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(false);
      expect(parsed.count).toBe(1);
      expect(readFileSync(ownMarker, "utf-8")).toBe("present\tok");
      expect(readFileSync(inheritedMarker, "utf-8")).toBe("absent");
      expect(result.stderr).not.toMatch(/inherited-getter-should-never-fire-run/);
    });

    // ------------------------------------------------------------------------
    // T-API-56i: run()-surface parity for the SPEC §9.5 filtering matrix.
    // Eight sub-variants matching the runPromise() coverage:
    //   (a) inherited keys ignored
    //   (b) symbol-keyed entries ignored
    //   (c) non-enumerable string-keyed entries ignored
    //   (d) null-prototype env accepted, own entries reach child
    //   (e1) class-instance env accepted, fields reach child
    //   (e2) Map env accepted, no entries reach child
    //   (f) symbol-keyed throwing getter never fires
    //   (g) non-enumerable throwing getter never fires
    //   (h) inherited non-string-value never reaches value validation
    // SPEC §9.5 / §9.1.
    // ------------------------------------------------------------------------
    it("T-API-56i (a): run() — inherited keys filtered out", async () => {
      project = await createTempProject();
      const ownMarker = join(project.dir, "own.txt");
      const inheritedMarker = join(project.dir, "inherited.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({
          OWN: ownMarker,
          INHERITED: inheritedMarker,
        })
      );

      const driverCode = `
import { run } from "loopx";
const proto = { INHERITED: "proto-val" };
const e = Object.create(proto);
e.OWN = "own-val";
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
let count = 0;
for await (const _ of gen) { count += 1; }
console.log(JSON.stringify({ count }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(ownMarker, "utf-8")).toBe("present\town-val");
      expect(readFileSync(inheritedMarker, "utf-8")).toBe("absent");
    });

    it("T-API-56i (b): run() — symbol-keyed entries filtered out", async () => {
      project = await createTempProject();
      const ownMarker = join(project.dir, "own.txt");
      const allEnvMarker = join(project.dir, "all-env.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `if [ -n "\${OWN+x}" ]; then
  printf 'present\\t%s' "$OWN" > "${ownMarker}"
else
  printf 'absent' > "${ownMarker}"
fi
env | cut -d= -f1 | sort > "${allEnvMarker}"
printf '{"stop":true}'`
      );

      const driverCode = `
import { run } from "loopx";
const sym = Symbol("SYM");
const e = { OWN: "own-val", [sym]: "sym-val" };
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
let count = 0;
for await (const _ of gen) { count += 1; }
console.log(JSON.stringify({ count }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(ownMarker, "utf-8")).toBe("present\town-val");
      const envNames = readFileSync(allEnvMarker, "utf-8").split("\n");
      for (const name of envNames) {
        if (!name) continue;
        expect(name).not.toMatch(/^Symbol\(/);
        expect(name).not.toBe("SYM");
      }
    });

    it("T-API-56i (c): run() — non-enumerable string-keyed entries filtered out", async () => {
      project = await createTempProject();
      const visibleMarker = join(project.dir, "visible.txt");
      const hiddenMarker = join(project.dir, "hidden.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({
          VISIBLE: visibleMarker,
          HIDDEN: hiddenMarker,
        })
      );

      const driverCode = `
import { run } from "loopx";
const e = {};
Object.defineProperty(e, "HIDDEN", { value: "hidden-val", enumerable: false });
e.VISIBLE = "visible-val";
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
let count = 0;
for await (const _ of gen) { count += 1; }
console.log(JSON.stringify({ count }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(visibleMarker, "utf-8")).toBe("present\tvisible-val");
      expect(readFileSync(hiddenMarker, "utf-8")).toBe("absent");
    });

    it("T-API-56i (d): run() — null-prototype env accepted, own entries reach child", async () => {
      project = await createTempProject();
      const myvarMarker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({ MYVAR: myvarMarker })
      );

      const driverCode = `
import { run } from "loopx";
const e = Object.create(null);
e.MYVAR = "from-options";
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
let count = 0, threw = false, message = "";
try {
  for await (const _ of gen) { count += 1; }
} catch (err) {
  threw = true;
  message = err && err.message ? err.message : String(err);
}
console.log(JSON.stringify({ count, threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(false);
      expect(parsed.count).toBe(1);
      expect(readFileSync(myvarMarker, "utf-8")).toBe("present\tfrom-options");
    });

    it("T-API-56i (e1): run() — class-instance env accepted, fields reach child", async () => {
      project = await createTempProject();
      const myvarMarker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({ MYVAR: myvarMarker })
      );

      const driverCode = `
import { run } from "loopx";
class Env { MYVAR = "from-class"; }
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: new Env(),
  maxIterations: 1,
});
let count = 0, threw = false, message = "";
try {
  for await (const _ of gen) { count += 1; }
} catch (err) {
  threw = true;
  message = err && err.message ? err.message : String(err);
}
console.log(JSON.stringify({ count, threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(false);
      expect(parsed.count).toBe(1);
      expect(readFileSync(myvarMarker, "utf-8")).toBe("present\tfrom-class");
    });

    it("T-API-56i (e2): run() — Map env accepted but contributes no entries", async () => {
      project = await createTempProject();
      const myvarMarker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({ MYVAR: myvarMarker })
      );

      const driverCode = `
import { run } from "loopx";
delete process.env.MYVAR;
const e = new Map([["MYVAR", "x"]]);
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
let count = 0, threw = false, message = "";
try {
  for await (const _ of gen) { count += 1; }
} catch (err) {
  threw = true;
  message = err && err.message ? err.message : String(err);
}
console.log(JSON.stringify({ count, threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(false);
      expect(parsed.count).toBe(1);
      expect(readFileSync(myvarMarker, "utf-8")).toBe("absent");
    });

    it("T-API-56i (f): run() — symbol-keyed throwing getter never fires", async () => {
      project = await createTempProject();
      const ownMarker = join(project.dir, "own.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({ OWN: ownMarker })
      );

      const driverCode = `
import { run } from "loopx";
const sym = Symbol("SYM-throw");
const e = { OWN: "own-val" };
Object.defineProperty(e, sym, {
  enumerable: true,
  get() { throw new Error("symbol-getter-should-never-fire-run"); },
});
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
let count = 0, threw = false, message = "";
try {
  for await (const _ of gen) { count += 1; }
} catch (err) {
  threw = true;
  message = err && err.message ? err.message : String(err);
}
console.log(JSON.stringify({ count, threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(false);
      expect(parsed.count).toBe(1);
      expect(readFileSync(ownMarker, "utf-8")).toBe("present\town-val");
      expect(result.stderr).not.toMatch(/symbol-getter-should-never-fire-run/);
    });

    it("T-API-56i (g): run() — non-enumerable throwing getter never fires", async () => {
      project = await createTempProject();
      const visibleMarker = join(project.dir, "visible.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({ VISIBLE: visibleMarker })
      );

      const driverCode = `
import { run } from "loopx";
const e = { VISIBLE: "visible-val" };
Object.defineProperty(e, "HIDDEN", {
  enumerable: false,
  get() { throw new Error("non-enumerable-getter-should-never-fire-run"); },
});
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
let count = 0, threw = false, message = "";
try {
  for await (const _ of gen) { count += 1; }
} catch (err) {
  threw = true;
  message = err && err.message ? err.message : String(err);
}
console.log(JSON.stringify({ count, threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(false);
      expect(parsed.count).toBe(1);
      expect(readFileSync(visibleMarker, "utf-8")).toBe("present\tvisible-val");
      expect(result.stderr).not.toMatch(/non-enumerable-getter-should-never-fire-run/);
    });

    it("T-API-56i (h): run() — inherited non-string-value never reaches value validation", async () => {
      project = await createTempProject();
      const ownMarker = join(project.dir, "own.txt");
      const inheritedMarker = join(project.dir, "inherited-number.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        makeObserveBashFixture({
          OWN: ownMarker,
          INHERITED_NUMBER: inheritedMarker,
        })
      );

      const driverCode = `
import { run } from "loopx";
const proto = { INHERITED_NUMBER: 42 };
const e = Object.create(proto);
e.OWN = "own-val";
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: e,
  maxIterations: 1,
});
let count = 0, threw = false, message = "";
try {
  for await (const _ of gen) { count += 1; }
} catch (err) {
  threw = true;
  message = err && err.message ? err.message : String(err);
}
console.log(JSON.stringify({ count, threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(false);
      expect(parsed.count).toBe(1);
      expect(readFileSync(ownMarker, "utf-8")).toBe("present\town-val");
      expect(readFileSync(inheritedMarker, "utf-8")).toBe("absent");
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9 — RunOptions.env Invalid Shape (SPEC §9.5)
// ═════════════════════════════════════════════════════════════
//
// SPEC §9.5 specifies RunOptions.env must be a non-null, non-array,
// non-function object whose own enumerable string-keyed entries all have
// string values. Any of: invalid object types, non-string entry values,
// snapshot-time throws — surface as option-snapshot errors via the standard
// pre-iteration error path: throwing on the first generator next() under
// run(), or rejecting the returned promise under runPromise().
//
// T-API-53 series — whole-`env` primitive variants (run() surface):
//   - 53: env: null
//   - 53a: env: [] (array)
//   - 53b: env: () => {} (function)
//   - 53c: env: "string"
//   - 53d: env: 42 (number)
//   - 53e: env: true (boolean)
//   - 53f: env: Symbol("x")
//   - 53g: env: 1n (bigint)
//
// T-API-54 series — entry-value variants (run() surface):
//   - 54: { MYVAR: 42 } (number)
//   - 54a: { MYVAR: undefined }
//   - 54b: { MYVAR: null }
//   - 54c: { MYVAR: { nested: "value" } } (object)
//   - 54d: accessor returning non-string (Object.defineProperty)
//   - 54e: 54d's runPromise() counterpart
//   - 54f: { MYVAR: true } (boolean)
//   - 54g: { MYVAR: Symbol("x") }
//   - 54h: { MYVAR: 1n } (bigint)
//
// T-API-55 — runPromise() equivalents — parameterized across all
// whole-`env` and entry-value invalid shapes; each variant rejects the
// promise with an option-snapshot error.

describe("SPEC: RunOptions.env Invalid Shape", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-53 series — whole-`env` primitive variants on run() surface.
    // SPEC §9.5: invalid `env` shape surfaces as a generator throw on
    // first next().
    // ------------------------------------------------------------------------
    interface WholeEnvVariant {
      id: string;
      label: string;
      // Inline literal (since values like Symbol(...) and BigInt cannot be
      // serialized through JSON.stringify); spliced into the driver code.
      envExpr: string;
    }

    const wholeEnvVariants: WholeEnvVariant[] = [
      { id: "T-API-53", label: "null", envExpr: "null" },
      { id: "T-API-53a", label: "array", envExpr: "[]" },
      { id: "T-API-53b", label: "function", envExpr: "(() => {})" },
      { id: "T-API-53c", label: "string", envExpr: '"string"' },
      { id: "T-API-53d", label: "number", envExpr: "42" },
      { id: "T-API-53e", label: "boolean", envExpr: "true" },
      { id: "T-API-53f", label: "symbol", envExpr: 'Symbol("x")' },
      { id: "T-API-53g", label: "bigint", envExpr: "1n" },
    ];

    for (const v of wholeEnvVariants) {
      it(`${v.id}: run() with env: ${v.label} throws on first next()`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );

        const driverCode = `
import { run } from "loopx";
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: ${v.envExpr},
  maxIterations: 1,
});
let threw = false, message = "", name = "";
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = e.message || String(e);
  name = e.name || "";
}
console.log(JSON.stringify({ threw, message, name }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.threw).toBe(true);
        // Error message must reference the env / RunOptions context
        // (load-bearing — proves the failure surfaces from env-shape
        // validation, not some unrelated downstream error).
        expect(parsed.message).toMatch(/env|RunOptions/i);
        // Script must NOT have been spawned (shape error fires
        // pre-iteration, before any spawn).
        expect(existsSync(marker)).toBe(false);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-54 series — entry-value variants on run() surface. SPEC §9.5:
    // all entries must have string values; non-string values reject with
    // an option-snapshot error.
    // ------------------------------------------------------------------------
    interface EntryValueVariant {
      id: string;
      label: string;
      envExpr: string;
    }

    const entryValueVariants: EntryValueVariant[] = [
      { id: "T-API-54", label: "number", envExpr: "{ MYVAR: 42 }" },
      { id: "T-API-54a", label: "undefined", envExpr: "{ MYVAR: undefined }" },
      { id: "T-API-54b", label: "null", envExpr: "{ MYVAR: null }" },
      {
        id: "T-API-54c",
        label: "object",
        envExpr: '{ MYVAR: { nested: "value" } }',
      },
      { id: "T-API-54f", label: "boolean", envExpr: "{ MYVAR: true }" },
      { id: "T-API-54g", label: "symbol", envExpr: '{ MYVAR: Symbol("x") }' },
      { id: "T-API-54h", label: "bigint", envExpr: "{ MYVAR: 1n }" },
    ];

    for (const v of entryValueVariants) {
      it(`${v.id}: run() with env entry value ${v.label} throws on first next()`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );

        const driverCode = `
import { run } from "loopx";
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: ${v.envExpr},
  maxIterations: 1,
});
let threw = false, message = "", name = "";
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = e.message || String(e);
  name = e.name || "";
}
console.log(JSON.stringify({ threw, message, name }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.threw).toBe(true);
        // Error message must reference env / MYVAR / string-shape context.
        expect(parsed.message).toMatch(/env|MYVAR|string/i);
        // No child was spawned.
        expect(existsSync(marker)).toBe(false);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-54d: run() — accessor-returning-non-string entry value throws on
    // first next(). SPEC §9.5: the [[Get]]-semantics value-read on each
    // included key must yield a string; an accessor that returns a non-string
    // value is invalid for the same reason as a data-property non-string
    // value (T-API-54). Test-construction: build env directly via
    // Object.defineProperty on the same object passed as options.env — NEVER
    // via object spread (which would invoke the getter in the test harness
    // before run() is called).
    // ------------------------------------------------------------------------
    it("T-API-54d: run() — accessor returning non-string value throws on first next()", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "spawn-marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
const env = {};
Object.defineProperty(env, "KEY", {
  enumerable: true,
  configurable: true,
  get() { return 42; },
});
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 1,
});
let threw = false, message = "", name = "";
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = e.message || String(e);
  name = e.name || "";
}
console.log(JSON.stringify({ threw, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(true);
      // Error must reference the entry name KEY or string-shape context —
      // a buggy implementation using descriptor-based extraction
      // (descriptor.value === undefined on accessor properties) would
      // surface a different error or skip validation.
      expect(parsed.message).toMatch(/env|KEY|string/i);
      expect(existsSync(marker)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-API-54e: runPromise() — accessor-returning-non-string entry value
    // rejects the promise. Companion to T-API-54d.
    // ------------------------------------------------------------------------
    it("T-API-54e: runPromise() — accessor returning non-string value rejects", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "spawn-marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const env = {};
Object.defineProperty(env, "KEY", {
  enumerable: true,
  configurable: true,
  get() { return 42; },
});
let rejected = false, message = "", name = "";
try {
  await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env,
    maxIterations: 1,
  });
} catch (e) {
  rejected = true;
  message = e.message || String(e);
  name = e.name || "";
}
console.log(JSON.stringify({ rejected, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.message).toMatch(/env|KEY|string/i);
      expect(existsSync(marker)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-API-55: runPromise() equivalents for all invalid env shapes.
    // SPEC §9.5 / §9.2: all invalid RunOptions.env shapes reject the
    // promise. Parameterized across the same whole-`env` primitive variants
    // (T-API-53–53g) and entry-value variants (T-API-54–54c, 54f–54h) on
    // the runPromise() surface.
    // ------------------------------------------------------------------------
    interface RunPromiseVariant {
      label: string;
      envExpr: string;
    }

    const runPromiseVariants: RunPromiseVariant[] = [
      // Whole-env primitives (mirrors T-API-53–53g).
      { label: "null", envExpr: "null" },
      { label: "array", envExpr: "[]" },
      { label: "function", envExpr: "(() => {})" },
      { label: "string", envExpr: '"string"' },
      { label: "number", envExpr: "42" },
      { label: "boolean", envExpr: "true" },
      { label: "symbol", envExpr: 'Symbol("x")' },
      { label: "bigint", envExpr: "1n" },
      // Entry-value primitives (mirrors T-API-54–54c, 54f–54h).
      { label: "entry-number", envExpr: "{ MYVAR: 42 }" },
      { label: "entry-undefined", envExpr: "{ MYVAR: undefined }" },
      { label: "entry-null", envExpr: "{ MYVAR: null }" },
      { label: "entry-object", envExpr: '{ MYVAR: { nested: "value" } }' },
      { label: "entry-boolean", envExpr: "{ MYVAR: true }" },
      { label: "entry-symbol", envExpr: '{ MYVAR: Symbol("x") }' },
      { label: "entry-bigint", envExpr: "{ MYVAR: 1n }" },
    ];

    for (const v of runPromiseVariants) {
      it(`T-API-55: runPromise() rejects on env: ${v.label}`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );

        const driverCode = `
import { runPromise } from "loopx";
let rejected = false, message = "", name = "";
try {
  await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: ${v.envExpr},
    maxIterations: 1,
  });
} catch (e) {
  rejected = true;
  message = e.message || String(e);
  name = e.name || "";
}
console.log(JSON.stringify({ rejected, message, name }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.rejected).toBe(true);
        expect(parsed.message).toMatch(/env|MYVAR|RunOptions|string/i);
        expect(existsSync(marker)).toBe(false);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// SPEC: RunOptions.env — Runtime-Rejected Names/Values (T-API-57 series)
//
// SPEC §9.5 "No name validation beyond string-to-string": loopx accepts any
// shape-conforming entries (own-enumerable string-keyed string-to-string
// pairs) and does not pre-validate names beyond shape. Runtime-level
// rejections — most reliably an embedded NUL byte in name or value — surface
// as child launch / spawn failures at spawn time per SPEC §7.2 / §9.3.
//
// SPEC §7.4 cleanup trigger list ("Child launch / spawn failure after tmpdir
// creation") + SPEC §9.3 ("Cleanup ordering is observable. When LOOPX_TMPDIR
// cleanup runs as part of an error path … it runs before the generator
// throws or the promise rejects") together require that no `loopx-*`
// directory remains under the test-isolated TMPDIR parent after the spawn
// failure surfaces.
//
// Coverage matrix (this block):
//   T-API-57    runPromise + NUL in value, maxIterations: 1
//   T-API-57a   runPromise + NUL in key,   maxIterations: 1
//   T-API-57b   runPromise + "=" in key,   maxIterations: 1 (impl-defined)
//   T-API-57c   runPromise + empty key,    maxIterations: 1 (impl-defined)
//   T-API-57d   runPromise + NUL in value, maxIterations: 0 → resolves []
//   T-API-57e   runPromise + NUL in key,   maxIterations: 0 → resolves []
//   T-API-57f   run        + NUL in value, maxIterations: 0 → done immediately
//   T-API-57f2  run        + NUL in key,   maxIterations: 0 → done immediately
//   T-API-57g   runPromise + non-POSIX names → success, byte-exact propagation
//   T-API-57g2  run        + non-POSIX names → success, byte-exact propagation
//   T-API-57h   run        + NUL in value, maxIterations: 1 → throws + cleanup
//   T-API-57i   run        + NUL in key,   maxIterations: 1 → throws + cleanup
// ---------------------------------------------------------------------------

describe("SPEC: RunOptions.env Runtime Rejection", () => {
  let project: TempProject | null = null;
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
    for (const cleanup of cleanups.splice(0)) {
      await cleanup().catch(() => {});
    }
  });

  // Creates a writable test-isolated TMPDIR parent under the system tmpdir.
  // Per TEST-SPEC §4.7 isolation guidance — concurrent test workers must not
  // race on `/tmp` for `loopx-*` entries. Returns the parent path; cleanup
  // is registered for afterEach.
  async function makeIsolatedTmpdirParent(label: string): Promise<string> {
    const dir = await mkdtemp(join(osTmpdir(), `loopx-test-${label}-`));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    });
    return dir;
  }

  // List `loopx-*` entries directly under `parent`, filtering implementation-
  // internal helpers (per AGENT.md / SPEC §7.4: nodepath-shim, bun-jsx, and
  // install staging are NOT LOOPX_TMPDIR).
  function listLoopxEntries(parent: string): string[] {
    try {
      return readdirSync(parent)
        .filter((e) => e.startsWith("loopx-"))
        .filter(
          (e) =>
            !e.startsWith("loopx-nodepath-shim-") &&
            !e.startsWith("loopx-bun-jsx-") &&
            !e.startsWith("loopx-install-") &&
            !e.startsWith("loopx-test-"),
        );
    } catch {
      return [];
    }
  }

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-57: runPromise() + NUL byte in entry value at maxIterations: 1
    //   surfaces as a spawn-failure rejection AND LOOPX_TMPDIR is cleaned up
    //   before the rejection. Load-bearing: a buggy implementation that
    //   surfaced spawn failure without running cleanup would leave a
    //   `loopx-*` directory under the isolated parent and fail (c).
    // SPEC §7.2 / §7.4 / §9.3 / §9.5.
    // ------------------------------------------------------------------------
    it("T-API-57: runPromise() — NUL byte in env value rejects with spawn failure and cleans tmpdir", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api57v");
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { runPromise } from "loopx";
let rejected = false, message = "", name = "";
try {
  await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: { MYVAR: "bad\\u0000val" },
    maxIterations: 1,
  });
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ rejected, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Promise rejected with a spawn-failure error — NOT a shape-
      //     validation error (the shape is valid: own-enumerable string key
      //     mapped to a string value).
      expect(parsed.rejected).toBe(true);
      // The error message must NOT match the shape-validation surface
      // (which would say `env|RunOptions|string`-shape). Spawn-failure
      // messages mention argument validation, ENOENT-like, NUL, or
      // similar runtime failures.
      expect(parsed.message).not.toMatch(/RunOptions\.env\[.*\] must be a string/);
      // (b) Workflow script did not run.
      expect(existsSync(marker)).toBe(false);
      // (c) Cleanup ran before rejection — no loopx-* residue under parent.
      const after = listLoopxEntries(tmpdirParent);
      const newEntries = after.filter((e) => !before.includes(e));
      expect(newEntries).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-57a: NUL-in-key counterpart to T-API-57. Same cleanup contract.
    // ------------------------------------------------------------------------
    it("T-API-57a: runPromise() — NUL byte in env key rejects with spawn failure and cleans tmpdir", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api57a");
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { runPromise } from "loopx";
const env = {};
env["BAD\\u0000KEY"] = "val";
let rejected = false, message = "", name = "";
try {
  await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env,
    maxIterations: 1,
  });
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ rejected, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Spawn-failure rejection (not shape-validation).
      expect(parsed.rejected).toBe(true);
      expect(parsed.message).not.toMatch(/RunOptions\.env\[.*\] must be a string/);
      // (b) Workflow script did not run.
      expect(existsSync(marker)).toBe(false);
      // (c) Cleanup ran before rejection.
      const after = listLoopxEntries(tmpdirParent);
      const newEntries = after.filter((e) => !before.includes(e));
      expect(newEntries).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-57b: "=" in key — runtime behavior is impl-defined. Outcome must
    //   be EITHER (a) spawn-failure rejection OR (b) clean resolution; loopx
    //   must NEVER surface this as a shape/options-validation error.
    // ------------------------------------------------------------------------
    it("T-API-57b: runPromise() — '=' in env key surfaces per runtime behavior, never as shape error", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api57b");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false, message = "", name = "";
let resolved = false, count = 0;
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: { "BAD=KEY": "val" },
    maxIterations: 1,
  });
  resolved = true;
  count = outputs.length;
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ rejected, message, name, resolved, count }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // Outcome is either rejection OR resolution — never a shape error.
      expect(parsed.rejected || parsed.resolved).toBe(true);
      if (parsed.rejected) {
        // Failure surface must NOT be shape-validation.
        expect(parsed.message).not.toMatch(/RunOptions\.env\[.*\] must be a string/);
      }
    });

    // ------------------------------------------------------------------------
    // T-API-57c: Empty-string key — shape-valid (own-enumerable string-keyed
    //   property with string value); runtime behavior impl-defined. Same
    //   "never a shape error" assertion.
    // ------------------------------------------------------------------------
    it("T-API-57c: runPromise() — empty-string env key not rejected at shape level", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api57c");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false, message = "", name = "";
let resolved = false, count = 0;
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: { "": "empty-key-value" },
    maxIterations: 1,
  });
  resolved = true;
  count = outputs.length;
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ rejected, message, name, resolved, count }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // Outcome is rejection OR resolution — never a shape error.
      expect(parsed.rejected || parsed.resolved).toBe(true);
      if (parsed.rejected) {
        expect(parsed.message).not.toMatch(/RunOptions\.env\[.*\] must be a string/);
      }
    });

    // ------------------------------------------------------------------------
    // T-API-57d: maxIterations: 0 + NUL in value — no spawn step runs, so
    //   the runtime-rejection path cannot fire. SPEC §9.5 / §4.2 / §7.1:
    //   "executes zero iterations". SPEC §7.4: tmpdir is not created under
    //   maxIterations: 0. Promise resolves with [].
    // ------------------------------------------------------------------------
    it("T-API-57d: runPromise() — maxIterations:0 + NUL in value resolves [] (no spawn, no tmpdir)", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api57d");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { runPromise } from "loopx";
let rejected = false, message = "", isArray = false, length = 0;
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: { MYVAR: "bad\\u0000val" },
    maxIterations: 0,
  });
  isArray = Array.isArray(outputs);
  length = outputs.length;
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
}
console.log(JSON.stringify({ rejected, message, isArray, length }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Promise resolves.
      expect(parsed.rejected).toBe(false);
      // (b) Resolved value is [] (empty array).
      expect(parsed.isArray).toBe(true);
      expect(parsed.length).toBe(0);
      // (c) No spawn-failure error on stderr.
      expect(result.stderr).not.toMatch(/spawn|ENOENT|EINVAL|ERR_INVALID/i);
      // (d) No LOOPX_TMPDIR was created.
      const after = listLoopxEntries(tmpdirParent);
      const newEntries = after.filter((e) => !before.includes(e));
      expect(newEntries).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-57e: maxIterations: 0 + NUL in key — same contract as 57d.
    // ------------------------------------------------------------------------
    it("T-API-57e: runPromise() — maxIterations:0 + NUL in key resolves [] (no spawn, no tmpdir)", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api57e");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { runPromise } from "loopx";
const env = {};
env["BAD\\u0000KEY"] = "val";
let rejected = false, message = "", isArray = false, length = 0;
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env,
    maxIterations: 0,
  });
  isArray = Array.isArray(outputs);
  length = outputs.length;
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
}
console.log(JSON.stringify({ rejected, message, isArray, length }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(false);
      expect(parsed.isArray).toBe(true);
      expect(parsed.length).toBe(0);
      expect(result.stderr).not.toMatch(/spawn|ENOENT|EINVAL|ERR_INVALID/i);
      const after = listLoopxEntries(tmpdirParent);
      const newEntries = after.filter((e) => !before.includes(e));
      expect(newEntries).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-57f: run() + maxIterations: 0 + NUL in value — first next()
    //   returns { done: true, value: undefined }; no spawn, no tmpdir.
    // ------------------------------------------------------------------------
    it("T-API-57f: run() — maxIterations:0 + NUL in value completes immediately (no spawn, no tmpdir)", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api57f");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MYVAR: "bad\\u0000val" },
  maxIterations: 0,
});
let threw = false, message = "", firstDone = null, firstValue = "<not-set>";
try {
  const first = await gen.next();
  firstDone = first.done;
  firstValue = first.value === undefined ? "undefined" : JSON.stringify(first.value);
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
}
console.log(JSON.stringify({ threw, message, firstDone, firstValue }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) First next() returned { done: true, value: undefined }.
      expect(parsed.threw).toBe(false);
      expect(parsed.firstDone).toBe(true);
      expect(parsed.firstValue).toBe("undefined");
      // (b) No spawn-failure error.
      expect(result.stderr).not.toMatch(/spawn|ENOENT|EINVAL|ERR_INVALID/i);
      // (c) No LOOPX_TMPDIR was created.
      const after = listLoopxEntries(tmpdirParent);
      const newEntries = after.filter((e) => !before.includes(e));
      expect(newEntries).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-57f2: run() + maxIterations: 0 + NUL in key — same as 57f.
    // ------------------------------------------------------------------------
    it("T-API-57f2: run() — maxIterations:0 + NUL in key completes immediately (no spawn, no tmpdir)", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api57f2");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { run } from "loopx";
const env = {};
env["BAD\\u0000KEY"] = "val";
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 0,
});
let threw = false, message = "", firstDone = null, firstValue = "<not-set>";
try {
  const first = await gen.next();
  firstDone = first.done;
  firstValue = first.value === undefined ? "undefined" : JSON.stringify(first.value);
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
}
console.log(JSON.stringify({ threw, message, firstDone, firstValue }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(false);
      expect(parsed.firstDone).toBe(true);
      expect(parsed.firstValue).toBe("undefined");
      expect(result.stderr).not.toMatch(/spawn|ENOENT|EINVAL|ERR_INVALID/i);
      const after = listLoopxEntries(tmpdirParent);
      const newEntries = after.filter((e) => !before.includes(e));
      expect(newEntries).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-57g: Positive coverage — non-POSIX names ("1BAD", "FOO-BAR")
    //   reach the spawned script unchanged. SPEC §9.5: "loopx does not
    //   enforce the POSIX [A-Za-z_][A-Za-z0-9_]* name pattern". Catches an
    //   implementation that wrongly applied the SPEC §8.1 env-file POSIX
    //   key validator to RunOptions.env.
    // ------------------------------------------------------------------------
    it("T-API-57g: runPromise() — non-POSIX names propagate unchanged to child env", async () => {
      project = await createTempProject();
      const digitMarker = join(project.dir, "digit.txt");
      const dashMarker = join(project.dir, "dash.txt");
      // TS fixture reads each name explicitly via process.env[<name>] (bash
      // would mangle digit-prefix and dash-interior names through identifier
      // parsing). Marker file holds JSON-encoded values for round-trip
      // fidelity (distinguish empty string from undefined).
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
const digit = process.env["1BAD"];
const dash = process.env["FOO-BAR"];
writeFileSync(${JSON.stringify(digitMarker)}, JSON.stringify({ present: digit !== undefined, value: digit }));
writeFileSync(${JSON.stringify(dashMarker)}, JSON.stringify({ present: dash !== undefined, value: dash }));
process.stdout.write('{"stop":true}');
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const env = {};
env["1BAD"] = "ok-digit-prefix";
env["FOO-BAR"] = "ok-dash-interior";
let rejected = false, message = "", count = 0;
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env,
    maxIterations: 1,
  });
  count = outputs.length;
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
}
console.log(JSON.stringify({ rejected, message, count }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Promise resolved (non-POSIX names are not validated by loopx).
      expect(parsed.rejected).toBe(false);
      expect(parsed.count).toBe(1);
      // (b) Both names reached the child env unchanged.
      const digitObserved = JSON.parse(readFileSync(digitMarker, "utf-8"));
      expect(digitObserved.present).toBe(true);
      expect(digitObserved.value).toBe("ok-digit-prefix");
      const dashObserved = JSON.parse(readFileSync(dashMarker, "utf-8"));
      expect(dashObserved.present).toBe(true);
      expect(dashObserved.value).toBe("ok-dash-interior");
    });

    // ------------------------------------------------------------------------
    // T-API-57g2: run() — non-POSIX names propagate. Surface-parity counter
    //   to T-API-57g; catches implementations that drop non-POSIX names
    //   on the lazy-snapshot generator path.
    // ------------------------------------------------------------------------
    it("T-API-57g2: run() — non-POSIX names propagate unchanged to child env", async () => {
      project = await createTempProject();
      const digitMarker = join(project.dir, "digit.txt");
      const dashMarker = join(project.dir, "dash.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
const digit = process.env["1BAD"];
const dash = process.env["FOO-BAR"];
writeFileSync(${JSON.stringify(digitMarker)}, JSON.stringify({ present: digit !== undefined, value: digit }));
writeFileSync(${JSON.stringify(dashMarker)}, JSON.stringify({ present: dash !== undefined, value: dash }));
process.stdout.write('{"stop":true}');
`,
      );

      const driverCode = `
import { run } from "loopx";
const env = {};
env["1BAD"] = "ok-digit-prefix";
env["FOO-BAR"] = "ok-dash-interior";
let threw = false, message = "", count = 0;
try {
  for await (const _ of run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env,
    maxIterations: 1,
  })) {
    count++;
  }
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
}
console.log(JSON.stringify({ threw, message, count }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(false);
      expect(parsed.count).toBe(1);
      const digitObserved = JSON.parse(readFileSync(digitMarker, "utf-8"));
      expect(digitObserved.present).toBe(true);
      expect(digitObserved.value).toBe("ok-digit-prefix");
      const dashObserved = JSON.parse(readFileSync(dashMarker, "utf-8"));
      expect(dashObserved.present).toBe(true);
      expect(dashObserved.value).toBe("ok-dash-interior");
    });

    // ------------------------------------------------------------------------
    // T-API-57h: run() + NUL in value at maxIterations: 1 — first next()
    //   throws spawn-failure AND tmpdir is cleaned up before the throw.
    //   Generator-surface counterpart to T-API-57.
    // ------------------------------------------------------------------------
    it("T-API-57h: run() — NUL in env value throws spawn failure on first next() and cleans tmpdir", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api57h");
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { MYVAR: "bad\\u0000val" },
  maxIterations: 1,
});
let threw = false, message = "", name = "";
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ threw, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) First next() rejected with spawn-failure (not shape-validation).
      expect(parsed.threw).toBe(true);
      expect(parsed.message).not.toMatch(/RunOptions\.env\[.*\] must be a string/);
      // (b) Workflow script did not run.
      expect(existsSync(marker)).toBe(false);
      // (c) Cleanup ran before throw.
      const after = listLoopxEntries(tmpdirParent);
      const newEntries = after.filter((e) => !before.includes(e));
      expect(newEntries).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-57i: run() + NUL in key at maxIterations: 1 — counterpart to
    //   T-API-57h on the NUL-in-key axis.
    // ------------------------------------------------------------------------
    it("T-API-57i: run() — NUL in env key throws spawn failure on first next() and cleans tmpdir", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api57i");
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { run } from "loopx";
const env = {};
env["BAD\\u0000KEY"] = "val";
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env,
  maxIterations: 1,
});
let threw = false, message = "", name = "";
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ threw, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) First next() rejected with spawn-failure (not shape-validation).
      expect(parsed.threw).toBe(true);
      expect(parsed.message).not.toMatch(/RunOptions\.env\[.*\] must be a string/);
      // (b) Workflow script did not run.
      expect(existsSync(marker)).toBe(false);
      // (c) Cleanup ran before throw.
      const after = listLoopxEntries(tmpdirParent);
      const newEntries = after.filter((e) => !before.includes(e));
      expect(newEntries).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: RunOptions.env / envFile — LOOPX_* Silent-Override Contract
//   (T-API-58 series)
//
// SPEC §8.3 / §9.5 / §13: The five script-protocol-protected names
// (LOOPX_BIN, LOOPX_PROJECT_ROOT, LOOPX_WORKFLOW, LOOPX_WORKFLOW_DIR,
// LOOPX_TMPDIR) are silently overridden by protocol injection when supplied
// via RunOptions.env. Non-protocol LOOPX_* names (e.g., LOOPX_DELEGATED) are
// NOT script-protocol-protected and reach the spawned child unchanged from
// every env-supply tier (inherited env, global env file, CLI `-e`,
// programmatic `RunOptions.envFile`, and `RunOptions.env`).
//
// T-API-51a/51a2 cover all five protocol names with arbitrary fake values
// silently overridden, but they don't isolate the per-name override behavior
// against a non-protocol same-prefix name. T-API-58 series adds:
//   T-API-58    runPromise + LOOPX_WORKFLOW (fake) + CUSTOM (user-val)
//   T-API-58a   runPromise + RunOptions.env LOOPX_DELEGATED reaches script
//   T-API-58a2  run        + RunOptions.env LOOPX_DELEGATED reaches script
//   T-API-58a3  runPromise + RunOptions.envFile LOOPX_DELEGATED reaches script
//   T-API-58a4  run        + RunOptions.envFile LOOPX_DELEGATED reaches script
// ---------------------------------------------------------------------------

describe("SPEC: RunOptions.env LOOPX_* Silent Override", () => {
  let project: TempProject | null = null;
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
    for (const cleanup of cleanups.splice(0)) {
      await cleanup().catch(() => {});
    }
  });

  // Test-isolated TMPDIR parent under the system tmpdir for the NUL × protocol
  // merge-order tests below — concurrent test workers must not race on `/tmp`
  // for `loopx-*` entries (TEST-SPEC §4.7). Cleanup registered for afterEach.
  async function makeIsolatedTmpdirParent(label: string): Promise<string> {
    const dir = await mkdtemp(join(osTmpdir(), `loopx-test-${label}-`));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    });
    return dir;
  }

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-58: runPromise() — supplying a LOOPX_* protocol name is silently
    //   overridden by protocol injection while non-protocol entries reach
    //   the child. Stderr contains no override warning. Mirrors T-API-51a's
    //   silent-override but isolates one protocol name + one non-protocol
    //   peer entry to confirm the override is per-name (not env-wide).
    // ------------------------------------------------------------------------
    it("T-API-58: runPromise() — LOOPX_* protocol name silently overridden, peer entry reaches child", async () => {
      project = await createTempProject();
      const wfMarker = join(project.dir, "workflow.txt");
      const customMarker = join(project.dir, "custom.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_WORKFLOW" > "${wfMarker}"
printf '%s' "\${CUSTOM:-UNSET}" > "${customMarker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { LOOPX_WORKFLOW: "user-fake", CUSTOM: "user-val" },
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      // (a) LOOPX_WORKFLOW silently overridden — script observes "ralph"
      //     (real workflow name), NOT "user-fake".
      expect(readFileSync(wfMarker, "utf-8")).toBe("ralph");
      // (b) CUSTOM (non-protocol peer) reached the child unchanged —
      //     confirms the override is per-name, not env-wide.
      expect(readFileSync(customMarker, "utf-8")).toBe("user-val");
      // (c) Stderr contains no warning/notice/error about LOOPX_WORKFLOW
      //     being overridden — silent-override contract per SPEC §13 / §8.3.
      const re = /loopx_workflow.*(override|overrid|ignored|warning|notice)/i;
      expect(result.stderr).not.toMatch(re);
    });

    // ------------------------------------------------------------------------
    // T-API-58a: runPromise() — LOOPX_DELEGATED is startup-reserved only,
    //   NOT script-protocol-protected. RunOptions.env.LOOPX_DELEGATED reaches
    //   the spawned script unchanged. Distinguishes the five script-protocol
    //   names from the startup-only LOOPX_DELEGATED.
    // ------------------------------------------------------------------------
    it("T-API-58a: runPromise() — LOOPX_DELEGATED (non-script-protocol) reaches child unchanged", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "delegated.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${LOOPX_DELEGATED:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { LOOPX_DELEGATED: "user-supplied" },
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      // (a) LOOPX_DELEGATED reached the spawned script unchanged.
      expect(readFileSync(marker, "utf-8")).toBe("user-supplied");
    });

    // ------------------------------------------------------------------------
    // T-API-58a2: run() — generator-surface counterpart to T-API-58a.
    //   Surface-parity for LOOPX_DELEGATED's startup-reserved-only contract.
    // ------------------------------------------------------------------------
    it("T-API-58a2: run() — LOOPX_DELEGATED reaches child unchanged on generator surface", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "delegated.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${LOOPX_DELEGATED:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
let count = 0;
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { LOOPX_DELEGATED: "user-supplied" },
  maxIterations: 1,
})) {
  count++;
}
console.log(JSON.stringify({ count }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(marker, "utf-8")).toBe("user-supplied");
    });

    // ------------------------------------------------------------------------
    // T-API-58a3: runPromise() — RunOptions.envFile (programmatic local
    //   env-file) supplying LOOPX_DELEGATED reaches the spawned script
    //   unchanged. Closes the per-tier supply matrix for LOOPX_DELEGATED on
    //   the programmatic surface alongside T-API-58a (RunOptions.env tier),
    //   T-ENV-24a (inherited env), T-ENV-24a2 (global env file), and
    //   T-ENV-24a3 (CLI -e). Confirms that the no-protection contract for
    //   LOOPX_DELEGATED holds on the §8.3 tier-3 RunOptions.envFile path,
    //   not just on tier-2 RunOptions.env.
    // ------------------------------------------------------------------------
    it("T-API-58a3: runPromise() — RunOptions.envFile LOOPX_DELEGATED reaches child unchanged", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "delegated.txt");
      const envFilePath = join(project.dir, "local.env");
      await createEnvFile(envFilePath, { LOOPX_DELEGATED: "from-envfile" });
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${LOOPX_DELEGATED:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      // Per TEST-SPEC §1.4: harness must scrub LOOPX_DELEGATED from inherited
      // env so the only tier supplying the value is RunOptions.envFile,
      // mirroring T-ENV-24a3's discipline for the CLI local env-file tier.
      const driverCode = `
import { runPromise } from "loopx";
delete process.env.LOOPX_DELEGATED;
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: ${JSON.stringify(envFilePath)},
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      // LOOPX_DELEGATED from the programmatic-envFile tier reached the child
      // unchanged. Distinguishes LOOPX_DELEGATED from script-protocol-protected
      // LOOPX_* names whose lower-tier values are silently overridden by
      // protocol injection.
      expect(readFileSync(marker, "utf-8")).toBe("from-envfile");
    });

    // ------------------------------------------------------------------------
    // T-API-58a4: run() — generator-surface counterpart to T-API-58a3.
    //   Surface-parity for LOOPX_DELEGATED's startup-reserved-only contract on
    //   the §8.3 tier-3 RunOptions.envFile path, mirroring the runPromise/run
    //   surface-parity already pinned for the RunOptions.env tier by
    //   T-API-58a / T-API-58a2.
    // ------------------------------------------------------------------------
    it("T-API-58a4: run() — RunOptions.envFile LOOPX_DELEGATED reaches child unchanged on generator surface", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "delegated.txt");
      const envFilePath = join(project.dir, "local.env");
      await createEnvFile(envFilePath, { LOOPX_DELEGATED: "from-envfile" });
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${LOOPX_DELEGATED:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
delete process.env.LOOPX_DELEGATED;
let count = 0;
for await (const _ of run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: ${JSON.stringify(envFilePath)},
  maxIterations: 1,
})) {
  count++;
}
console.log(JSON.stringify({ count }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      expect(readFileSync(marker, "utf-8")).toBe("from-envfile");
    });

    // ------------------------------------------------------------------------
    // T-API-58b: runPromise() — RunOptions.env supplying a NUL-containing value
    //   for a protocol-variable name (LOOPX_WORKFLOW) is silently overridden by
    //   protocol injection. The promise resolves; the script observes the real
    //   workflow name; no spawn-failure error / override-warning surfaces.
    //
    //   Per SPEC §8.3 / §9.5 / §13: protocol-tier overlay (tier 1) replaces
    //   user-supplied LOOPX_* values from RunOptions.env (tier 2) BEFORE the
    //   merged env reaches child_process.spawn — so the runtime never observes
    //   the NUL-containing value. A buggy implementation that merged
    //   RunOptions.env into the child env BEFORE protocol injection would
    //   surface a spawn-failure on the NUL byte and fail (a)/(c)/(e).
    //   SPEC §7.2 / §8.3 / §9.2 / §9.5 / §13.
    // ------------------------------------------------------------------------
    it("T-API-58b: runPromise() — NUL in RunOptions.env LOOPX_WORKFLOW silently overridden by protocol injection", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api58b");
      const wfMarker = join(project.dir, "workflow.txt");
      const ranMarker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_WORKFLOW" > "${wfMarker}"
printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false, message = "";
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: { LOOPX_WORKFLOW: "bad\\u0000value" },
    maxIterations: 1,
  });
  console.log(JSON.stringify({ count: outputs.length, rejected, message }));
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  console.log(JSON.stringify({ count: 0, rejected, message }));
}
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Promise resolved (no rejection — protocol-tier overlay replaced
      //     the NUL value before the runtime saw it).
      expect(parsed.rejected).toBe(false);
      expect(parsed.count).toBe(1);
      // (b) Marker records the real workflow name from protocol injection,
      //     NOT the user-supplied "bad value".
      expect(readFileSync(wfMarker, "utf-8")).toBe("ralph");
      // (c) No spawn-failure error on stderr.
      expect(result.stderr).not.toMatch(/exited with code/);
      expect(result.stderr).not.toMatch(/spawn/i);
      // (d) No override-warning on stderr (silent-override per SPEC §13 / §8.3).
      expect(result.stderr).not.toMatch(
        /loopx_workflow.*(override|overrid|ignored|warning|notice)/i,
      );
      // (e) Workflow script ran exactly once (distinguishes from the spawn-
      //     failure-no-script-ran outcome of T-API-57).
      expect(existsSync(ranMarker)).toBe(true);
      expect(readFileSync(ranMarker, "utf-8")).toBe("spawned");
    });

    // ------------------------------------------------------------------------
    // T-API-58c: run() generator counterpart to T-API-58b. Same merge-order
    //   contract on the lazy-snapshot run() surface (SPEC §9.1) — verifies
    //   that both API surfaces share the protocol-tier overlay code path.
    //   SPEC §7.2 / §8.3 / §9.1 / §9.5 / §13.
    // ------------------------------------------------------------------------
    it("T-API-58c: run() — NUL in RunOptions.env LOOPX_WORKFLOW silently overridden by protocol injection", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api58c");
      const wfMarker = join(project.dir, "workflow.txt");
      const ranMarker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_WORKFLOW" > "${wfMarker}"
printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
let count = 0, threw = false, message = "";
try {
  for await (const _ of run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: { LOOPX_WORKFLOW: "bad\\u0000value" },
    maxIterations: 1,
  })) {
    count++;
  }
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
}
console.log(JSON.stringify({ count, threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Generator settled cleanly (no throw — protocol-tier overlay
      //     replaced the NUL value before the runtime saw it).
      expect(parsed.threw).toBe(false);
      expect(parsed.count).toBe(1);
      // (b) Marker records "ralph", NOT "bad value".
      expect(readFileSync(wfMarker, "utf-8")).toBe("ralph");
      // (c) No spawn-failure error on stderr.
      expect(result.stderr).not.toMatch(/exited with code/);
      expect(result.stderr).not.toMatch(/spawn/i);
      // (d) No override-warning on stderr.
      expect(result.stderr).not.toMatch(
        /loopx_workflow.*(override|overrid|ignored|warning|notice)/i,
      );
      // (e) Workflow script ran exactly once.
      expect(existsSync(ranMarker)).toBe(true);
      expect(readFileSync(ranMarker, "utf-8")).toBe("spawned");
    });

    // ------------------------------------------------------------------------
    // T-API-58d: runPromise() — same merge-order contract on LOOPX_TMPDIR (the
    //   dynamically-computed protocol-injection axis per SPEC §7.4 — value is
    //   computed during pre-iteration, not derived from a static call-time
    //   identifier). T-API-58b/c cover LOOPX_WORKFLOW (call-time-identifier-
    //   derived); a buggy implementation could plausibly route static-identifier
    //   protocol injection through one merge code path and dynamic-tmpdir
    //   injection through another — pinning both axes catches that.
    //
    //   The during-run stat (matching T-API-51a's rigor) is essential: cleanup
    //   removes the tmpdir on run completion, so a post-run stat would observe
    //   absence even if the value were a real path. The in-script stat proves
    //   the value points to a real loopx-created directory.
    //   SPEC §7.2 / §7.4 / §8.3 / §9.2 / §9.5 / §13.
    // ------------------------------------------------------------------------
    it("T-API-58d: runPromise() — NUL in RunOptions.env LOOPX_TMPDIR silently overridden by protocol injection", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api58d");
      const tmpdirMarker = join(project.dir, "loopx_tmpdir.txt");
      const tmpdirStatMarker = join(project.dir, "loopx_tmpdir_stat.txt");
      const ranMarker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
if [ -d "$LOOPX_TMPDIR" ]; then
  printf 'is-dir' > "${tmpdirStatMarker}"
else
  printf 'not-dir' > "${tmpdirStatMarker}"
fi
printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
let rejected = false, message = "";
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: { LOOPX_TMPDIR: "bad\\u0000value" },
    maxIterations: 1,
  });
  console.log(JSON.stringify({ count: outputs.length, rejected, message }));
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  console.log(JSON.stringify({ count: 0, rejected, message }));
}
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Promise resolved.
      expect(parsed.rejected).toBe(false);
      expect(parsed.count).toBe(1);
      // (b) Marker records a real absolute path under the test-isolated parent
      //     matching the loopx-* naming convention from SPEC §7.4 mkdtemp.
      const observedTmpdir = readFileSync(tmpdirMarker, "utf-8");
      expect(observedTmpdir).not.toBe("bad value");
      expect(observedTmpdir).toMatch(/\/loopx-[^/]+$/);
      const realTmpdirParent = realpathSync(tmpdirParent);
      expect(observedTmpdir.startsWith(realTmpdirParent)).toBe(true);
      // (c) During-run stat marker proves the path was a real directory while
      //     the script ran (not a substituted string). SPEC §7.4 cleanup
      //     removes the dir AFTER the script exits.
      expect(readFileSync(tmpdirStatMarker, "utf-8")).toBe("is-dir");
      // (d) No spawn-failure error on stderr.
      expect(result.stderr).not.toMatch(/exited with code/);
      expect(result.stderr).not.toMatch(/spawn/i);
      // (e) No override-warning on stderr.
      expect(result.stderr).not.toMatch(
        /loopx_tmpdir.*(override|overrid|ignored|warning|notice)/i,
      );
      // (f) Workflow script ran.
      expect(existsSync(ranMarker)).toBe(true);
    });

    // ------------------------------------------------------------------------
    // T-API-58d2: run() generator counterpart to T-API-58d — NUL-merge-order on
    //   the dynamically-computed LOOPX_TMPDIR protocol injection on the lazy-
    //   snapshot run() surface. Distinct snapshot timing from runPromise() per
    //   SPEC §9.1 vs §9.2 — a buggy implementation that wired the dynamically-
    //   computed protocol injection correctly under the eager schedule but
    //   incorrectly under the lazy schedule would pass T-API-58d and fail this.
    //   SPEC §7.2 / §7.4 / §8.3 / §9.1 / §9.5 / §13.
    // ------------------------------------------------------------------------
    it("T-API-58d2: run() — NUL in RunOptions.env LOOPX_TMPDIR silently overridden by protocol injection", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api58d2");
      const tmpdirMarker = join(project.dir, "loopx_tmpdir.txt");
      const tmpdirStatMarker = join(project.dir, "loopx_tmpdir_stat.txt");
      const ranMarker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
if [ -d "$LOOPX_TMPDIR" ]; then
  printf 'is-dir' > "${tmpdirStatMarker}"
else
  printf 'not-dir' > "${tmpdirStatMarker}"
fi
printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
let count = 0, threw = false, message = "";
try {
  for await (const _ of run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: { LOOPX_TMPDIR: "bad\\u0000value" },
    maxIterations: 1,
  })) {
    count++;
  }
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
}
console.log(JSON.stringify({ count, threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Generator settled cleanly.
      expect(parsed.threw).toBe(false);
      expect(parsed.count).toBe(1);
      // (b) Marker records a real absolute path under the test-isolated parent.
      const observedTmpdir = readFileSync(tmpdirMarker, "utf-8");
      expect(observedTmpdir).not.toBe("bad value");
      expect(observedTmpdir).toMatch(/\/loopx-[^/]+$/);
      const realTmpdirParent = realpathSync(tmpdirParent);
      expect(observedTmpdir.startsWith(realTmpdirParent)).toBe(true);
      // (c) During-run stat proves the path was a real directory.
      expect(readFileSync(tmpdirStatMarker, "utf-8")).toBe("is-dir");
      // (d) No spawn-failure error on stderr.
      expect(result.stderr).not.toMatch(/exited with code/);
      expect(result.stderr).not.toMatch(/spawn/i);
      // (e) No override-warning on stderr.
      expect(result.stderr).not.toMatch(
        /loopx_tmpdir.*(override|overrid|ignored|warning|notice)/i,
      );
      // (f) Workflow script ran.
      expect(existsSync(ranMarker)).toBe(true);
    });

    // ------------------------------------------------------------------------
    // T-API-58e (i)–(iii): runPromise() — parameterized hardening over the
    //   remaining three script-protocol-protected names (LOOPX_BIN,
    //   LOOPX_PROJECT_ROOT, LOOPX_WORKFLOW_DIR). T-API-58b/c/d cover the two
    //   structurally distinct axes (call-time-derived LOOPX_WORKFLOW + pre-
    //   iteration-computed LOOPX_TMPDIR). The remaining three are call-time-
    //   derived but not workflow-identity-derived — this catches a buggy
    //   implementation that special-cased the two pinned names into one merge-
    //   order-correct path while routing the other three through a separate,
    //   merge-order-broken path. SPEC §7.2 / §8.3 / §9.2 / §9.5 / §13.
    // ------------------------------------------------------------------------
    for (const variant of [
      { name: "LOOPX_BIN", id: "i", marker: "loopx_bin" },
      { name: "LOOPX_PROJECT_ROOT", id: "ii", marker: "loopx_project_root" },
      { name: "LOOPX_WORKFLOW_DIR", id: "iii", marker: "loopx_workflow_dir" },
    ]) {
      it(`T-API-58e (${variant.id} ${variant.name}): runPromise() — NUL in RunOptions.env ${variant.name} silently overridden by protocol injection`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api58e-${variant.id}`);
        const projectRoot = realpathSync(project.dir);
        const obsMarker = join(project.dir, `${variant.marker}.txt`);
        const ranMarker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' "\$${variant.name}" > "${obsMarker}"
printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
        );

        const driverCode = `
import { runPromise } from "loopx";
let rejected = false, message = "";
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: { ${variant.name}: "bad\\u0000value" },
    maxIterations: 1,
  });
  console.log(JSON.stringify({ count: outputs.length, rejected, message }));
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  console.log(JSON.stringify({ count: 0, rejected, message }));
}
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) Promise resolved.
        expect(parsed.rejected).toBe(false);
        expect(parsed.count).toBe(1);
        // (b) Marker records the real protocol value, not the NUL string.
        const observed = readFileSync(obsMarker, "utf-8");
        expect(observed).not.toBe("bad value");
        if (variant.name === "LOOPX_BIN") {
          // LOOPX_BIN is the resolved realpath of the loopx binary — must
          // exist on disk.
          expect(existsSync(observed)).toBe(true);
        } else if (variant.name === "LOOPX_PROJECT_ROOT") {
          expect(observed).toBe(projectRoot);
        } else if (variant.name === "LOOPX_WORKFLOW_DIR") {
          expect(observed).toBe(join(projectRoot, ".loopx", "ralph"));
        }
        // (c) No spawn-failure error on stderr.
        expect(result.stderr).not.toMatch(/exited with code/);
        expect(result.stderr).not.toMatch(/spawn/i);
        // (d) No override-warning on stderr.
        const re = new RegExp(
          `${variant.name.toLowerCase()}.*(override|overrid|ignored|warning|notice)`,
          "i",
        );
        expect(result.stderr).not.toMatch(re);
        // (e) Workflow script ran exactly once.
        expect(existsSync(ranMarker)).toBe(true);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-58e2 (i)–(iii): run() generator counterpart to T-API-58e —
    //   parameterized hardening over the remaining three names on the lazy-
    //   snapshot surface. SPEC §7.2 / §8.3 / §9.1 / §9.5 / §13.
    // ------------------------------------------------------------------------
    for (const variant of [
      { name: "LOOPX_BIN", id: "i", marker: "loopx_bin" },
      { name: "LOOPX_PROJECT_ROOT", id: "ii", marker: "loopx_project_root" },
      { name: "LOOPX_WORKFLOW_DIR", id: "iii", marker: "loopx_workflow_dir" },
    ]) {
      it(`T-API-58e2 (${variant.id} ${variant.name}): run() — NUL in RunOptions.env ${variant.name} silently overridden by protocol injection`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api58e2-${variant.id}`);
        const projectRoot = realpathSync(project.dir);
        const obsMarker = join(project.dir, `${variant.marker}.txt`);
        const ranMarker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' "\$${variant.name}" > "${obsMarker}"
printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
        );

        const driverCode = `
import { run } from "loopx";
let count = 0, threw = false, message = "";
try {
  for await (const _ of run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    env: { ${variant.name}: "bad\\u0000value" },
    maxIterations: 1,
  })) {
    count++;
  }
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
}
console.log(JSON.stringify({ count, threw, message }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) Generator settled cleanly.
        expect(parsed.threw).toBe(false);
        expect(parsed.count).toBe(1);
        // (b) Marker records the real protocol value.
        const observed = readFileSync(obsMarker, "utf-8");
        expect(observed).not.toBe("bad value");
        if (variant.name === "LOOPX_BIN") {
          expect(existsSync(observed)).toBe(true);
        } else if (variant.name === "LOOPX_PROJECT_ROOT") {
          expect(observed).toBe(projectRoot);
        } else if (variant.name === "LOOPX_WORKFLOW_DIR") {
          expect(observed).toBe(join(projectRoot, ".loopx", "ralph"));
        }
        // (c) No spawn-failure error on stderr.
        expect(result.stderr).not.toMatch(/exited with code/);
        expect(result.stderr).not.toMatch(/spawn/i);
        // (d) No override-warning on stderr.
        const re = new RegExp(
          `${variant.name.toLowerCase()}.*(override|overrid|ignored|warning|notice)`,
          "i",
        );
        expect(result.stderr).not.toMatch(re);
        // (e) Workflow script ran exactly once.
        expect(existsSync(ranMarker)).toBe(true);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-58f (i)–(v): runPromise() — RunOptions.envFile (programmatic local
    //   env file, §8.3 tier 3) supplying a NUL-containing value for any of the
    //   five script-protocol-protected names (LOOPX_BIN, LOOPX_PROJECT_ROOT,
    //   LOOPX_WORKFLOW, LOOPX_WORKFLOW_DIR, LOOPX_TMPDIR) is silently
    //   overridden by protocol injection (tier 1). Programmatic counterpart to
    //   CLI tests T-ENV-28/T-ENV-28a (CLI -e local env file). Closes the
    //   programmatic-`envFile` tier merge-order matrix; T-API-58b/c/d/d2/e/e2
    //   pin the contract on the RunOptions.env (tier 2) merge-order. Same
    //   five-variant parameterization for parity.
    //
    //   Per SPEC §8.1: env-file values may contain embedded NUL bytes — the
    //   parser splits content on '\n' and reads from after the first '=' to
    //   end of line, with no NUL-byte filtering. The NUL byte therefore
    //   reaches mergeEnv unchanged from the envFile-loaded localEnv. The
    //   protocol-tier overlay in execution.ts (lines 179-185) applies AFTER
    //   the merged env is computed in run.ts (lines 661-664), so for the five
    //   script-protocol-protected names the user-supplied NUL value is
    //   replaced before the merged env reaches child_process.spawn — no spawn
    //   failure surfaces.
    //
    //   A buggy implementation that wired the protocol-tier-overlay-after-
    //   merge contract correctly on the RunOptions.env tier (T-API-58b..e2)
    //   but merged the programmatic envFile tier AFTER protocol injection (or
    //   used a separate merge code path that omitted the protocol-tier
    //   overlay) would surface a spawn-failure on the NUL byte and fail (a),
    //   (c), and (e). SPEC §7.2 / §7.4 / §8.1 / §8.3 / §9.2 / §9.5 / §13.
    // ------------------------------------------------------------------------
    for (const variant of [
      { name: "LOOPX_WORKFLOW", id: "i", marker: "loopx_workflow" },
      { name: "LOOPX_TMPDIR", id: "ii", marker: "loopx_tmpdir" },
      { name: "LOOPX_BIN", id: "iii", marker: "loopx_bin" },
      { name: "LOOPX_PROJECT_ROOT", id: "iv", marker: "loopx_project_root" },
      { name: "LOOPX_WORKFLOW_DIR", id: "v", marker: "loopx_workflow_dir" },
    ]) {
      it(`T-API-58f (${variant.id} ${variant.name}): runPromise() — NUL in RunOptions.envFile ${variant.name} silently overridden by protocol injection`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api58f-${variant.id}`);
        const projectRoot = realpathSync(project.dir);
        const obsMarker = join(project.dir, `${variant.marker}.txt`);
        const tmpdirStatMarker = join(project.dir, "loopx_tmpdir_stat.txt");
        const ranMarker = join(project.dir, "child-ran.txt");
        const envFilePath = join(project.dir, "local.env");
        // SPEC §8.1: env-file parser splits on '\n' and reads value from
        // after the first '=' to end of line — NUL bytes within the value
        // are preserved verbatim and reach mergeEnv unchanged.
        await writeEnvFileRaw(
          envFilePath,
          `${variant.name}=bad\x00value\n`,
        );
        const tmpdirStatBlock =
          variant.name === "LOOPX_TMPDIR"
            ? `if [ -d "$LOOPX_TMPDIR" ]; then
  printf 'is-dir' > "${tmpdirStatMarker}"
else
  printf 'not-dir' > "${tmpdirStatMarker}"
fi
`
            : "";
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' "\$${variant.name}" > "${obsMarker}"
${tmpdirStatBlock}printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
        );

        const driverCode = `
import { runPromise } from "loopx";
let rejected = false, message = "";
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    envFile: ${JSON.stringify(envFilePath)},
    maxIterations: 1,
  });
  console.log(JSON.stringify({ count: outputs.length, rejected, message }));
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  console.log(JSON.stringify({ count: 0, rejected, message }));
}
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) Promise resolved (no rejection — protocol-tier overlay replaced
        //     the NUL value before the runtime saw it).
        expect(parsed.rejected).toBe(false);
        expect(parsed.count).toBe(1);
        // (b) Marker records the real protocol value, not the NUL string.
        const observed = readFileSync(obsMarker, "utf-8");
        expect(observed).not.toBe("bad value");
        if (variant.name === "LOOPX_WORKFLOW") {
          expect(observed).toBe("ralph");
        } else if (variant.name === "LOOPX_TMPDIR") {
          // Real loopx-created tmpdir per SPEC §7.4 mkdtemp naming convention.
          expect(observed).toMatch(/\/loopx-[^/]+$/);
          const realTmpdirParent = realpathSync(tmpdirParent);
          expect(observed.startsWith(realTmpdirParent)).toBe(true);
          // (c) During-run stat marker proves real loopx-created directory
          //     (not a substituted string). SPEC §7.4 cleanup removes the
          //     dir AFTER the script exits, so a post-run stat would
          //     observe absence even if the value were a real path.
          expect(readFileSync(tmpdirStatMarker, "utf-8")).toBe("is-dir");
        } else if (variant.name === "LOOPX_BIN") {
          // LOOPX_BIN is the resolved realpath of the loopx binary.
          expect(existsSync(observed)).toBe(true);
        } else if (variant.name === "LOOPX_PROJECT_ROOT") {
          expect(observed).toBe(projectRoot);
        } else if (variant.name === "LOOPX_WORKFLOW_DIR") {
          expect(observed).toBe(join(projectRoot, ".loopx", "ralph"));
        }
        // (d) No spawn-failure error on stderr.
        expect(result.stderr).not.toMatch(/exited with code/);
        expect(result.stderr).not.toMatch(/spawn/i);
        // (e) No override-warning on stderr (silent-override per §13 / §8.3).
        const re = new RegExp(
          `${variant.name.toLowerCase()}.*(override|overrid|ignored|warning|notice)`,
          "i",
        );
        expect(result.stderr).not.toMatch(re);
        // (f) Workflow script ran exactly once.
        expect(existsSync(ranMarker)).toBe(true);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-58f2 (i)–(v): run() generator counterpart to T-API-58f. Same NUL-
    //   merge-order contract on the programmatic envFile tier on the lazy-
    //   snapshot run() surface (SPEC §9.1). A buggy implementation that wired
    //   the protocol-tier overlay correctly on the eager-snapshot runPromise()
    //   programmatic-envFile path while routing the lazy-snapshot run()
    //   programmatic-envFile path through a separate, merge-order-broken code
    //   path would pass T-API-58f and fail T-API-58f2.
    //   SPEC §7.2 / §7.4 / §8.1 / §8.3 / §9.1 / §9.5 / §13.
    // ------------------------------------------------------------------------
    for (const variant of [
      { name: "LOOPX_WORKFLOW", id: "i", marker: "loopx_workflow" },
      { name: "LOOPX_TMPDIR", id: "ii", marker: "loopx_tmpdir" },
      { name: "LOOPX_BIN", id: "iii", marker: "loopx_bin" },
      { name: "LOOPX_PROJECT_ROOT", id: "iv", marker: "loopx_project_root" },
      { name: "LOOPX_WORKFLOW_DIR", id: "v", marker: "loopx_workflow_dir" },
    ]) {
      it(`T-API-58f2 (${variant.id} ${variant.name}): run() — NUL in RunOptions.envFile ${variant.name} silently overridden by protocol injection`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api58f2-${variant.id}`);
        const projectRoot = realpathSync(project.dir);
        const obsMarker = join(project.dir, `${variant.marker}.txt`);
        const tmpdirStatMarker = join(project.dir, "loopx_tmpdir_stat.txt");
        const ranMarker = join(project.dir, "child-ran.txt");
        const envFilePath = join(project.dir, "local.env");
        await writeEnvFileRaw(
          envFilePath,
          `${variant.name}=bad\x00value\n`,
        );
        const tmpdirStatBlock =
          variant.name === "LOOPX_TMPDIR"
            ? `if [ -d "$LOOPX_TMPDIR" ]; then
  printf 'is-dir' > "${tmpdirStatMarker}"
else
  printf 'not-dir' > "${tmpdirStatMarker}"
fi
`
            : "";
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' "\$${variant.name}" > "${obsMarker}"
${tmpdirStatBlock}printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
        );

        const driverCode = `
import { run } from "loopx";
let count = 0, threw = false, message = "";
try {
  for await (const _ of run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    envFile: ${JSON.stringify(envFilePath)},
    maxIterations: 1,
  })) {
    count++;
  }
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
}
console.log(JSON.stringify({ count, threw, message }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) Generator settled cleanly.
        expect(parsed.threw).toBe(false);
        expect(parsed.count).toBe(1);
        // (b) Marker records the real protocol value.
        const observed = readFileSync(obsMarker, "utf-8");
        expect(observed).not.toBe("bad value");
        if (variant.name === "LOOPX_WORKFLOW") {
          expect(observed).toBe("ralph");
        } else if (variant.name === "LOOPX_TMPDIR") {
          expect(observed).toMatch(/\/loopx-[^/]+$/);
          const realTmpdirParent = realpathSync(tmpdirParent);
          expect(observed.startsWith(realTmpdirParent)).toBe(true);
          // During-run stat proves real loopx-created directory.
          expect(readFileSync(tmpdirStatMarker, "utf-8")).toBe("is-dir");
        } else if (variant.name === "LOOPX_BIN") {
          expect(existsSync(observed)).toBe(true);
        } else if (variant.name === "LOOPX_PROJECT_ROOT") {
          expect(observed).toBe(projectRoot);
        } else if (variant.name === "LOOPX_WORKFLOW_DIR") {
          expect(observed).toBe(join(projectRoot, ".loopx", "ralph"));
        }
        // (c) No spawn-failure error on stderr.
        expect(result.stderr).not.toMatch(/exited with code/);
        expect(result.stderr).not.toMatch(/spawn/i);
        // (d) No override-warning on stderr.
        const re = new RegExp(
          `${variant.name.toLowerCase()}.*(override|overrid|ignored|warning|notice)`,
          "i",
        );
        expect(result.stderr).not.toMatch(re);
        // (e) Workflow script ran exactly once.
        expect(existsSync(ranMarker)).toBe(true);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-58g (i)–(v): runPromise() — global env file (§8.3 tier 4) supplying
    //   a NUL-containing value for any of the five script-protocol-protected
    //   names is silently overridden by protocol injection (tier 1).
    //   Programmatic counterpart to CLI tests T-ENV-29 / T-ENV-29a (CLI global
    //   env file); closes the global-env-file tier merge-order matrix on the
    //   eager-snapshot programmatic surface. T-API-58b/c/d/d2/e/e2 pin the
    //   contract on RunOptions.env (tier 2); T-API-58f / T-API-58f2 pin it on
    //   the programmatic local-env-file (tier 3 via RunOptions.envFile). This
    //   is the last uncovered tier on the programmatic surface.
    //
    //   A buggy implementation that wired the protocol-tier-overlay-after-
    //   merge contract correctly on the CLI's global-env-file code path while
    //   routing the programmatic global-env-file load through a separate,
    //   merge-order-broken path would pass T-ENV-29 / T-ENV-29a (and T-API-58f
    //   / T-API-58f2 for the local env-file tier) yet fail this test.
    //
    //   No `envFile` is supplied so the global env file is the highest-
    //   precedence env-file tier — a buggy implementation cannot mask its
    //   load by routing through the local-tier path.
    //   SPEC §7.2 / §7.4 / §8.1 / §8.3 / §9.2 / §9.5 / §13.
    // ------------------------------------------------------------------------
    for (const variant of [
      { name: "LOOPX_WORKFLOW", id: "i", marker: "loopx_workflow" },
      { name: "LOOPX_TMPDIR", id: "ii", marker: "loopx_tmpdir" },
      { name: "LOOPX_BIN", id: "iii", marker: "loopx_bin" },
      { name: "LOOPX_PROJECT_ROOT", id: "iv", marker: "loopx_project_root" },
      { name: "LOOPX_WORKFLOW_DIR", id: "v", marker: "loopx_workflow_dir" },
    ]) {
      it(`T-API-58g (${variant.id} ${variant.name}): runPromise() — NUL in global env file ${variant.name} silently overridden by protocol injection`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api58g-${variant.id}`);
        const projectRoot = realpathSync(project.dir);
        const obsMarker = join(project.dir, `${variant.marker}.txt`);
        const tmpdirStatMarker = join(project.dir, "loopx_tmpdir_stat.txt");
        const ranMarker = join(project.dir, "child-ran.txt");
        // Provision a writable XDG_CONFIG_HOME with a global env file under
        // <xdg>/loopx/env containing the NUL-bearing protocol-name line.
        const xdgDir = await mkdtemp(join(osTmpdir(), `loopx-test-xdg-${variant.id}-`));
        cleanups.push(async () => {
          await rm(xdgDir, { recursive: true, force: true }).catch(() => {});
        });
        const loopxConfigDir = join(xdgDir, "loopx");
        await mkdir(loopxConfigDir, { recursive: true });
        const globalEnvFilePath = join(loopxConfigDir, "env");
        // SPEC §8.1: env-file parser splits on '\n' and reads value from
        // after the first '=' to end of line — NUL bytes within the value
        // are preserved verbatim and reach mergeEnv unchanged.
        await writeEnvFileRaw(
          globalEnvFilePath,
          `${variant.name}=bad\x00value\n`,
        );
        const tmpdirStatBlock =
          variant.name === "LOOPX_TMPDIR"
            ? `if [ -d "$LOOPX_TMPDIR" ]; then
  printf 'is-dir' > "${tmpdirStatMarker}"
else
  printf 'not-dir' > "${tmpdirStatMarker}"
fi
`
            : "";
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' "\$${variant.name}" > "${obsMarker}"
${tmpdirStatBlock}printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
        );

        const driverCode = `
import { runPromise } from "loopx";
let rejected = false, message = "";
try {
  const outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    maxIterations: 1,
  });
  console.log(JSON.stringify({ count: outputs.length, rejected, message }));
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  console.log(JSON.stringify({ count: 0, rejected, message }));
}
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent, XDG_CONFIG_HOME: xdgDir },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) Promise resolved (no rejection — protocol-tier overlay replaced
        //     the NUL value before the runtime saw it).
        expect(parsed.rejected).toBe(false);
        expect(parsed.count).toBe(1);
        // (b) Marker records the real protocol value, not the NUL string.
        const observed = readFileSync(obsMarker, "utf-8");
        expect(observed).not.toBe("bad value");
        if (variant.name === "LOOPX_WORKFLOW") {
          expect(observed).toBe("ralph");
        } else if (variant.name === "LOOPX_TMPDIR") {
          // Real loopx-created tmpdir per SPEC §7.4 mkdtemp naming convention.
          expect(observed).toMatch(/\/loopx-[^/]+$/);
          const realTmpdirParent = realpathSync(tmpdirParent);
          expect(observed.startsWith(realTmpdirParent)).toBe(true);
          // (c) During-run stat marker proves real loopx-created directory
          //     (not a substituted string). SPEC §7.4 cleanup removes the
          //     dir AFTER the script exits, so a post-run stat would
          //     observe absence even if the value were a real path.
          expect(readFileSync(tmpdirStatMarker, "utf-8")).toBe("is-dir");
        } else if (variant.name === "LOOPX_BIN") {
          // LOOPX_BIN is the resolved realpath of the loopx binary.
          expect(existsSync(observed)).toBe(true);
        } else if (variant.name === "LOOPX_PROJECT_ROOT") {
          expect(observed).toBe(projectRoot);
        } else if (variant.name === "LOOPX_WORKFLOW_DIR") {
          expect(observed).toBe(join(projectRoot, ".loopx", "ralph"));
        }
        // (d) No spawn-failure error on stderr and no parser warning about NUL.
        expect(result.stderr).not.toMatch(/exited with code/);
        expect(result.stderr).not.toMatch(/spawn/i);
        expect(result.stderr).not.toMatch(/nul|\\x00/i);
        // (e) No override-warning on stderr (silent-override per §13 / §8.3).
        const re = new RegExp(
          `${variant.name.toLowerCase()}.*(override|overrid|ignored|warning|notice)`,
          "i",
        );
        expect(result.stderr).not.toMatch(re);
        // (f) Workflow script ran exactly once.
        expect(existsSync(ranMarker)).toBe(true);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-58g2 (i)–(v): run() generator counterpart to T-API-58g. Same NUL-
    //   merge-order contract on the global env-file tier on the lazy-snapshot
    //   run() surface (SPEC §9.1). A buggy implementation that wired the
    //   protocol-tier overlay correctly on the eager-snapshot runPromise()
    //   global-env-file path while routing the lazy-snapshot run() global-env-
    //   file path through a separate, merge-order-broken code path would pass
    //   T-API-58g and fail T-API-58g2.
    //   SPEC §7.2 / §7.4 / §8.1 / §8.3 / §9.1 / §9.5 / §13.
    // ------------------------------------------------------------------------
    for (const variant of [
      { name: "LOOPX_WORKFLOW", id: "i", marker: "loopx_workflow" },
      { name: "LOOPX_TMPDIR", id: "ii", marker: "loopx_tmpdir" },
      { name: "LOOPX_BIN", id: "iii", marker: "loopx_bin" },
      { name: "LOOPX_PROJECT_ROOT", id: "iv", marker: "loopx_project_root" },
      { name: "LOOPX_WORKFLOW_DIR", id: "v", marker: "loopx_workflow_dir" },
    ]) {
      it(`T-API-58g2 (${variant.id} ${variant.name}): run() — NUL in global env file ${variant.name} silently overridden by protocol injection`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api58g2-${variant.id}`);
        const projectRoot = realpathSync(project.dir);
        const obsMarker = join(project.dir, `${variant.marker}.txt`);
        const tmpdirStatMarker = join(project.dir, "loopx_tmpdir_stat.txt");
        const ranMarker = join(project.dir, "child-ran.txt");
        const xdgDir = await mkdtemp(join(osTmpdir(), `loopx-test-xdg-${variant.id}-`));
        cleanups.push(async () => {
          await rm(xdgDir, { recursive: true, force: true }).catch(() => {});
        });
        const loopxConfigDir = join(xdgDir, "loopx");
        await mkdir(loopxConfigDir, { recursive: true });
        const globalEnvFilePath = join(loopxConfigDir, "env");
        await writeEnvFileRaw(
          globalEnvFilePath,
          `${variant.name}=bad\x00value\n`,
        );
        const tmpdirStatBlock =
          variant.name === "LOOPX_TMPDIR"
            ? `if [ -d "$LOOPX_TMPDIR" ]; then
  printf 'is-dir' > "${tmpdirStatMarker}"
else
  printf 'not-dir' > "${tmpdirStatMarker}"
fi
`
            : "";
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' "\$${variant.name}" > "${obsMarker}"
${tmpdirStatBlock}printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
        );

        const driverCode = `
import { run } from "loopx";
let count = 0, threw = false, message = "";
try {
  for await (const _ of run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    maxIterations: 1,
  })) {
    count++;
  }
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
}
console.log(JSON.stringify({ count, threw, message }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent, XDG_CONFIG_HOME: xdgDir },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) Generator settled cleanly.
        expect(parsed.threw).toBe(false);
        expect(parsed.count).toBe(1);
        // (b) Marker records the real protocol value.
        const observed = readFileSync(obsMarker, "utf-8");
        expect(observed).not.toBe("bad value");
        if (variant.name === "LOOPX_WORKFLOW") {
          expect(observed).toBe("ralph");
        } else if (variant.name === "LOOPX_TMPDIR") {
          expect(observed).toMatch(/\/loopx-[^/]+$/);
          const realTmpdirParent = realpathSync(tmpdirParent);
          expect(observed.startsWith(realTmpdirParent)).toBe(true);
          // During-run stat proves real loopx-created directory.
          expect(readFileSync(tmpdirStatMarker, "utf-8")).toBe("is-dir");
        } else if (variant.name === "LOOPX_BIN") {
          expect(existsSync(observed)).toBe(true);
        } else if (variant.name === "LOOPX_PROJECT_ROOT") {
          expect(observed).toBe(projectRoot);
        } else if (variant.name === "LOOPX_WORKFLOW_DIR") {
          expect(observed).toBe(join(projectRoot, ".loopx", "ralph"));
        }
        // (c) No spawn-failure error on stderr and no parser warning about NUL.
        expect(result.stderr).not.toMatch(/exited with code/);
        expect(result.stderr).not.toMatch(/spawn/i);
        expect(result.stderr).not.toMatch(/nul|\\x00/i);
        // (d) No override-warning on stderr.
        const re = new RegExp(
          `${variant.name.toLowerCase()}.*(override|overrid|ignored|warning|notice)`,
          "i",
        );
        expect(result.stderr).not.toMatch(re);
        // (e) Workflow script ran exactly once.
        expect(existsSync(ranMarker)).toBe(true);
      });
    }
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9 — RunOptions.env / RunOptions.envFile do NOT redirect loopx's own
//        global env-file path resolution (SPEC §8.1 / §8.3 / §9.1 / §9.5)
//
// SPEC §8.1: "Global env file path resolution ($XDG_CONFIG_HOME/loopx/env,
// with the documented HOME-based fallback) reads XDG_CONFIG_HOME / HOME
// from the inherited environment on the same schedule." User-supplied
// XDG_CONFIG_HOME / HOME values via RunOptions.env (tier 2) or env files
// (tiers 3/4) reach the spawned child but do not redirect WHERE loopx looks
// for its own global env file.
// ═════════════════════════════════════════════════════════════

describe("SPEC: RunOptions.env Does Not Affect Loopx's Own Lookups", () => {
  let project: TempProject | null = null;
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
    for (const cleanup of cleanups.splice(0)) {
      await cleanup().catch(() => {});
    }
  });

  // mkdtemp two distinct config homes: one for "real" inherited env,
  // one for "fake" RunOptions.env / env-file value. Both are registered
  // for cleanup. Each receives a loopx/env file with MARKER set distinctly.
  async function setupRealAndFakeXdg(label: string): Promise<{
    realXdg: string;
    fakeXdg: string;
  }> {
    const realXdg = await mkdtemp(join(osTmpdir(), `loopx-test-real-xdg-${label}-`));
    cleanups.push(async () => {
      await rm(realXdg, { recursive: true, force: true }).catch(() => {});
    });
    await mkdir(join(realXdg, "loopx"), { recursive: true });
    await writeFile(join(realXdg, "loopx", "env"), "MARKER=real\n", "utf-8");

    const fakeXdg = await mkdtemp(join(osTmpdir(), `loopx-test-fake-xdg-${label}-`));
    cleanups.push(async () => {
      await rm(fakeXdg, { recursive: true, force: true }).catch(() => {});
    });
    await mkdir(join(fakeXdg, "loopx"), { recursive: true });
    await writeFile(join(fakeXdg, "loopx", "env"), "MARKER=fake\n", "utf-8");

    return { realXdg, fakeXdg };
  }

  // For HOME-fallback tests: the global env file lives at
  // <HOME>/.config/loopx/env (when XDG_CONFIG_HOME is unset).
  async function setupRealAndFakeHome(label: string): Promise<{
    realHome: string;
    fakeHome: string;
  }> {
    const realHome = await mkdtemp(join(osTmpdir(), `loopx-test-real-home-${label}-`));
    cleanups.push(async () => {
      await rm(realHome, { recursive: true, force: true }).catch(() => {});
    });
    await mkdir(join(realHome, ".config", "loopx"), { recursive: true });
    await writeFile(
      join(realHome, ".config", "loopx", "env"),
      "MARKER=real\n",
      "utf-8",
    );

    const fakeHome = await mkdtemp(join(osTmpdir(), `loopx-test-fake-home-${label}-`));
    cleanups.push(async () => {
      await rm(fakeHome, { recursive: true, force: true }).catch(() => {});
    });
    await mkdir(join(fakeHome, ".config", "loopx"), { recursive: true });
    await writeFile(
      join(fakeHome, ".config", "loopx", "env"),
      "MARKER=fake\n",
      "utf-8",
    );

    return { realHome, fakeHome };
  }

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-59: runPromise() — RunOptions.env does not redirect global env-
    //   file lookup via XDG_CONFIG_HOME. Inherited XDG_CONFIG_HOME points at
    //   real config dir (containing MARKER=real). RunOptions.env supplies a
    //   fake XDG_CONFIG_HOME value (with a decoy global env file containing
    //   MARKER=fake). The script observes both XDG_CONFIG_HOME (which should
    //   reflect the user-supplied fake value, proving the merge into the
    //   child env happened) AND MARKER (which should reflect the real value,
    //   proving loopx loaded the global env file from the inherited env, not
    //   from RunOptions.env). SPEC §8.1, §8.3, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-59: runPromise() — RunOptions.env does NOT redirect global env-file lookup via XDG_CONFIG_HOME", async () => {
      project = await createTempProject();
      const xdgMarker = join(project.dir, "xdg.txt");
      const markerMarker = join(project.dir, "marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${XDG_CONFIG_HOME:-UNSET}" > "${xdgMarker}"
printf '%s' "\${MARKER:-UNSET}" > "${markerMarker}"
printf '{"stop":true}'`,
      );

      const { realXdg, fakeXdg } = await setupRealAndFakeXdg("api59");

      const driverCode = `
import { runPromise } from "loopx";
process.env.XDG_CONFIG_HOME = ${JSON.stringify(realXdg)};
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { XDG_CONFIG_HOME: ${JSON.stringify(fakeXdg)} },
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      // (a) Child observed XDG_CONFIG_HOME from RunOptions.env (the fake path).
      expect(readFileSync(xdgMarker, "utf-8")).toBe(fakeXdg);
      // (b) But loopx loaded the global env file using its OWN inherited
      //     process.env.XDG_CONFIG_HOME (the real path) — so MARKER=real.
      expect(readFileSync(markerMarker, "utf-8")).toBe("real");
    });

    // ------------------------------------------------------------------------
    // T-API-59a: runPromise() — RunOptions.env does not redirect global env-
    //   file lookup via HOME (the fallback when XDG_CONFIG_HOME is unset).
    //   SPEC §8.1, §8.3, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-59a: runPromise() — RunOptions.env does NOT redirect global env-file lookup via HOME", async () => {
      project = await createTempProject();
      const homeMarker = join(project.dir, "home.txt");
      const markerMarker = join(project.dir, "marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${HOME:-UNSET}" > "${homeMarker}"
printf '%s' "\${MARKER:-UNSET}" > "${markerMarker}"
printf '{"stop":true}'`,
      );

      const { realHome, fakeHome } = await setupRealAndFakeHome("api59a");

      // Unset XDG_CONFIG_HOME so HOME fallback applies, then set HOME=realHome.
      const driverCode = `
import { runPromise } from "loopx";
delete process.env.XDG_CONFIG_HOME;
process.env.HOME = ${JSON.stringify(realHome)};
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { HOME: ${JSON.stringify(fakeHome)} },
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      // (a) Child observed HOME from RunOptions.env (the fake path).
      expect(readFileSync(homeMarker, "utf-8")).toBe(fakeHome);
      // (b) But loopx loaded the global env file using its OWN inherited
      //     process.env.HOME (the real path) — so MARKER=real.
      expect(readFileSync(markerMarker, "utf-8")).toBe("real");
    });

    // ------------------------------------------------------------------------
    // T-API-59b: run() generator — RunOptions.env does not redirect global
    //   env-file lookup via XDG_CONFIG_HOME. Generator-surface counterpart to
    //   T-API-59. The two run surfaces have different snapshot timing for
    //   inherited process.env (lazy under run() per SPEC §9.1; eager under
    //   runPromise() per SPEC §9.2) but both must apply SPEC §8.1's rule.
    //   A buggy implementation that re-read RunOptions.env at first next()
    //   and merged it into the lazy process.env snapshot before resolving
    //   the global env-file path on the run() path — but performed eager
    //   resolution correctly under runPromise() — would pass T-API-59 but
    //   fail this test. SPEC §8.1, §8.3, §9.1, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-59b: run() — RunOptions.env does NOT redirect global env-file lookup via XDG_CONFIG_HOME", async () => {
      project = await createTempProject();
      const xdgMarker = join(project.dir, "xdg.txt");
      const markerMarker = join(project.dir, "marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${XDG_CONFIG_HOME:-UNSET}" > "${xdgMarker}"
printf '%s' "\${MARKER:-UNSET}" > "${markerMarker}"
printf '{"stop":true}'`,
      );

      const { realXdg, fakeXdg } = await setupRealAndFakeXdg("api59b");

      const driverCode = `
import { run } from "loopx";
process.env.XDG_CONFIG_HOME = ${JSON.stringify(realXdg)};
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { XDG_CONFIG_HOME: ${JSON.stringify(fakeXdg)} },
  maxIterations: 1,
});
const results = [];
for await (const o of gen) { results.push(o); }
console.log(JSON.stringify({ count: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      // (a) Child observed XDG_CONFIG_HOME from RunOptions.env (fake path).
      expect(readFileSync(xdgMarker, "utf-8")).toBe(fakeXdg);
      // (b) loopx loaded global env file using inherited process.env (real).
      expect(readFileSync(markerMarker, "utf-8")).toBe("real");
    });

    // ------------------------------------------------------------------------
    // T-API-59c: run() generator — RunOptions.env does not redirect global
    //   env-file lookup via HOME. SPEC §8.1, §8.3, §9.1, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-59c: run() — RunOptions.env does NOT redirect global env-file lookup via HOME", async () => {
      project = await createTempProject();
      const homeMarker = join(project.dir, "home.txt");
      const markerMarker = join(project.dir, "marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${HOME:-UNSET}" > "${homeMarker}"
printf '%s' "\${MARKER:-UNSET}" > "${markerMarker}"
printf '{"stop":true}'`,
      );

      const { realHome, fakeHome } = await setupRealAndFakeHome("api59c");

      const driverCode = `
import { run } from "loopx";
delete process.env.XDG_CONFIG_HOME;
process.env.HOME = ${JSON.stringify(realHome)};
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { HOME: ${JSON.stringify(fakeHome)} },
  maxIterations: 1,
});
const results = [];
for await (const o of gen) { results.push(o); }
console.log(JSON.stringify({ count: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      // (a) Child observed HOME from RunOptions.env (fake path).
      expect(readFileSync(homeMarker, "utf-8")).toBe(fakeHome);
      // (b) loopx loaded global env file using inherited HOME (real path).
      expect(readFileSync(markerMarker, "utf-8")).toBe("real");
    });

    // ------------------------------------------------------------------------
    // T-API-59d: runPromise() — Local envFile (RunOptions.envFile, tier 3)
    //   does not redirect global env-file lookup via XDG_CONFIG_HOME.
    //   The local env file containing XDG_CONFIG_HOME=fakePath is loaded
    //   AFTER loopx has already located the global env file using the
    //   inherited environment. The child sees the fake XDG_CONFIG_HOME
    //   (proving the local env file values reach the spawned script) but
    //   loopx loaded the real global env file. SPEC §8.1, §8.2, §8.3, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-59d: runPromise() — Local envFile does NOT redirect global env-file lookup via XDG_CONFIG_HOME", async () => {
      project = await createTempProject();
      const xdgMarker = join(project.dir, "xdg.txt");
      const markerMarker = join(project.dir, "marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${XDG_CONFIG_HOME:-UNSET}" > "${xdgMarker}"
printf '%s' "\${MARKER:-UNSET}" > "${markerMarker}"
printf '{"stop":true}'`,
      );

      const { realXdg, fakeXdg } = await setupRealAndFakeXdg("api59d");

      // Local env file containing XDG_CONFIG_HOME=<fakeXdg>.
      const localEnvFile = join(project.dir, "local.env");
      await writeFile(localEnvFile, `XDG_CONFIG_HOME=${fakeXdg}\n`, "utf-8");

      const driverCode = `
import { runPromise } from "loopx";
process.env.XDG_CONFIG_HOME = ${JSON.stringify(realXdg)};
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: ${JSON.stringify(localEnvFile)},
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      // (a) Child observed XDG_CONFIG_HOME from local env file (fake).
      expect(readFileSync(xdgMarker, "utf-8")).toBe(fakeXdg);
      // (b) loopx loaded global env file using inherited XDG_CONFIG_HOME (real).
      expect(readFileSync(markerMarker, "utf-8")).toBe("real");
    });

    // ------------------------------------------------------------------------
    // T-API-59e: runPromise() — Local envFile does not redirect global env-
    //   file lookup via HOME. SPEC §8.1, §8.2, §8.3, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-59e: runPromise() — Local envFile does NOT redirect global env-file lookup via HOME", async () => {
      project = await createTempProject();
      const homeMarker = join(project.dir, "home.txt");
      const markerMarker = join(project.dir, "marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${HOME:-UNSET}" > "${homeMarker}"
printf '%s' "\${MARKER:-UNSET}" > "${markerMarker}"
printf '{"stop":true}'`,
      );

      const { realHome, fakeHome } = await setupRealAndFakeHome("api59e");

      const localEnvFile = join(project.dir, "local.env");
      await writeFile(localEnvFile, `HOME=${fakeHome}\n`, "utf-8");

      const driverCode = `
import { runPromise } from "loopx";
delete process.env.XDG_CONFIG_HOME;
process.env.HOME = ${JSON.stringify(realHome)};
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: ${JSON.stringify(localEnvFile)},
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      // (a) Child observed HOME from local env file (fake).
      expect(readFileSync(homeMarker, "utf-8")).toBe(fakeHome);
      // (b) loopx loaded global env file using inherited HOME (real path).
      expect(readFileSync(markerMarker, "utf-8")).toBe("real");
    });

    // ------------------------------------------------------------------------
    // T-API-59h: run() generator — Local envFile does not redirect global
    //   env-file lookup via XDG_CONFIG_HOME. Generator-surface counterpart to
    //   T-API-59d; exercises the lazy pre-iteration timing per SPEC §9.1.
    //   SPEC §8.1, §8.2, §8.3, §9.1, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-59h: run() — Local envFile does NOT redirect global env-file lookup via XDG_CONFIG_HOME", async () => {
      project = await createTempProject();
      const xdgMarker = join(project.dir, "xdg.txt");
      const markerMarker = join(project.dir, "marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${XDG_CONFIG_HOME:-UNSET}" > "${xdgMarker}"
printf '%s' "\${MARKER:-UNSET}" > "${markerMarker}"
printf '{"stop":true}'`,
      );

      const { realXdg, fakeXdg } = await setupRealAndFakeXdg("api59h");

      const localEnvFile = join(project.dir, "local.env");
      await writeFile(localEnvFile, `XDG_CONFIG_HOME=${fakeXdg}\n`, "utf-8");

      const driverCode = `
import { run } from "loopx";
process.env.XDG_CONFIG_HOME = ${JSON.stringify(realXdg)};
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: ${JSON.stringify(localEnvFile)},
  maxIterations: 1,
});
const results = [];
for await (const o of gen) { results.push(o); }
console.log(JSON.stringify({ count: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      // (a) Child observed XDG_CONFIG_HOME from local env file (fake).
      expect(readFileSync(xdgMarker, "utf-8")).toBe(fakeXdg);
      // (b) loopx loaded global env file using inherited XDG_CONFIG_HOME (real).
      expect(readFileSync(markerMarker, "utf-8")).toBe("real");
    });

    // ------------------------------------------------------------------------
    // T-API-59i: run() generator — Local envFile does not redirect global
    //   env-file lookup via HOME. SPEC §8.1, §8.2, §8.3, §9.1, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-59i: run() — Local envFile does NOT redirect global env-file lookup via HOME", async () => {
      project = await createTempProject();
      const homeMarker = join(project.dir, "home.txt");
      const markerMarker = join(project.dir, "marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${HOME:-UNSET}" > "${homeMarker}"
printf '%s' "\${MARKER:-UNSET}" > "${markerMarker}"
printf '{"stop":true}'`,
      );

      const { realHome, fakeHome } = await setupRealAndFakeHome("api59i");

      const localEnvFile = join(project.dir, "local.env");
      await writeFile(localEnvFile, `HOME=${fakeHome}\n`, "utf-8");

      const driverCode = `
import { run } from "loopx";
delete process.env.XDG_CONFIG_HOME;
process.env.HOME = ${JSON.stringify(realHome)};
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  envFile: ${JSON.stringify(localEnvFile)},
  maxIterations: 1,
});
const results = [];
for await (const o of gen) { results.push(o); }
console.log(JSON.stringify({ count: results.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).count).toBe(1);
      // (a) Child observed HOME from local env file (fake).
      expect(readFileSync(homeMarker, "utf-8")).toBe(fakeHome);
      // (b) loopx loaded global env file using inherited HOME (real).
      expect(readFileSync(markerMarker, "utf-8")).toBe("real");
    });
  });
});

// ═════════════════════════════════════════════════════════════
// SPEC: RunOptions.env Does Not Affect Loopx's Tmpdir Parent
//
// SPEC §7.4: loopx selects its tmpdir parent from `os.tmpdir()`, which
// itself reads `TMPDIR` / `TEMP` / `TMP` from the inherited environment
// (timing per SPEC §9.1 / §9.2). User-supplied values for those names via
// `RunOptions.env` (tier 2) reach the spawned child but do not redirect
// the parent loopx selects for its own `mkdtemp(<parent>/loopx-)` call.
//
// T-API-60 / 60a / 60b / 60c close the contract on both API surfaces ×
// {TMPDIR, TEMP, TMP}. For TEMP / TMP, the contract is runtime-aware: on
// POSIX runtimes only TMPDIR redirects `os.tmpdir()`, so the test pins
// the parent against `os.tmpdir()` evaluated in an identically-configured
// child process via getRuntimeOsTmpdir. The complementary T-TMP-29 / 29b /
// 29c family (in tmpdir.test.ts) covers the `runPromise()` surface; this
// block adds the `run()` generator surface plus a redundant `runPromise()`
// pin in the API test file for symmetry with T-API-59.
// ═════════════════════════════════════════════════════════════

/**
 * Returns the value of `os.tmpdir()` inside an `envOverrides`-configured
 * child process of the given runtime. POSIX runtimes only consult TMPDIR;
 * Windows runtimes additionally consult TEMP / TMP. Mirrors the helper
 * used in tmpdir.test.ts for T-TMP-25/29 runtime-aware assertions.
 */
function getRuntimeOsTmpdir(
  runtime: "node" | "bun",
  envOverrides: Record<string, string | undefined>,
): string {
  const effectiveEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) effectiveEnv[key] = value;
  }
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete effectiveEnv[key];
    } else {
      effectiveEnv[key] = value;
    }
  }
  const command = runtime === "bun" ? "bun" : "node";
  const result = spawnSync(
    command,
    ["-e", "process.stdout.write(require('os').tmpdir())"],
    { env: effectiveEnv, encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `getRuntimeOsTmpdir(${runtime}) probe failed: status=${result.status} stderr=${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

describe("SPEC: RunOptions.env Does Not Affect Loopx's Tmpdir Parent", () => {
  let project: TempProject | null = null;
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
    for (const cleanup of cleanups.splice(0)) {
      await cleanup().catch(() => {});
    }
  });

  /**
   * Allocate a writable test-isolated parent directory under the system
   * tmpdir, registered for cleanup. Per TEST-SPEC §4.7, parallel CI workers
   * must not race on a shared `/tmp/<name>` literal.
   */
  async function makeIsolatedTmpdirParent(label: string): Promise<string> {
    const dir = await mkdtemp(
      join(osTmpdir(), `loopx-test-${label}-parent-`),
    );
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    });
    return dir;
  }

  /**
   * A unique nonexistent path under the system tmpdir. Used as the wrong-
   * parent value passed via `RunOptions.env` — loopx must not consult it,
   * so it need not exist on disk.
   */
  function makeNonexistentParent(label: string): string {
    return join(osTmpdir(), `loopx-test-${label}-fake-${randomUUID()}`);
  }

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-60: runPromise() — RunOptions.env does NOT redirect tmpdir parent
    //   selection (TMPDIR axis). Inherited TMPDIR points at realParent (a
    //   writable mkdtemp directory loopx uses as its tmpdir parent).
    //   RunOptions.env supplies a unique nonexistent fakeParent value. The
    //   script observes both TMPDIR and LOOPX_TMPDIR. Assert (a) child's
    //   TMPDIR == fakeParent (the RunOptions.env value reaches the child
    //   per SPEC §8.3 tier-2 injection), (b) LOOPX_TMPDIR lives under
    //   realParent (loopx's own tmpdir parent was captured from loopx's
    //   own process.env, NOT from RunOptions.env). SPEC §7.4, §8.3, §9.5.
    //
    //   Companion to T-TMP-29 (runPromise + TMPDIR — same contract pinned in
    //   tmpdir.test.ts). T-API-60 redundantly pins the same case in
    //   programmatic-api.test.ts for symmetry with T-API-60a/60b/60c on the
    //   run() surface, and to surface a regression as a programmatic-api
    //   suite failure rather than only a tmpdir-suite failure.
    // ------------------------------------------------------------------------
    it("T-API-60: runPromise() — RunOptions.env TMPDIR does NOT redirect tmpdir parent", async () => {
      project = await createTempProject();
      const realParent = await makeIsolatedTmpdirParent("api60");
      const fakeParent = makeNonexistentParent("api60");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpdirMarker = join(project.dir, "tmpdir-env.txt");

      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$TMPDIR" > "${observedTmpdirMarker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, env: { TMPDIR: ${JSON.stringify(fakeParent)} } });
console.log("done");
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: realParent },
      });
      expect(apiResult.exitCode).toBe(0);
      // (a) Child observed TMPDIR from RunOptions.env (the fake nonexistent path).
      const observedTmpdir = readFileSync(observedTmpdirMarker, "utf-8");
      expect(observedTmpdir).toBe(fakeParent);
      // (b) loopx selected its own tmpdir parent from inherited process.env
      //     (the real path) — LOOPX_TMPDIR is rooted under realParent.
      const observedLoopxTmpdir = readFileSync(tmpdirMarker, "utf-8");
      expect(dirname(observedLoopxTmpdir)).toBe(realParent);
    });

    // ------------------------------------------------------------------------
    // T-API-60a: run() — generator-surface counterpart to T-API-60. The two
    //   run surfaces have different snapshot timing for inherited env /
    //   tmpdir parent (lazy on run() per SPEC §9.1 / §7.4; eager on
    //   runPromise() per SPEC §9.2 / §7.4) but identical timing for
    //   RunOptions.env (eager / call-site capture on both surfaces per
    //   SPEC §9.5). A buggy implementation that special-cased the
    //   tmpdir-parent / RunOptions.env interaction on the lazy-snapshot
    //   run() surface — perhaps by re-reading RunOptions.env at first
    //   next() and merging it into the lazy process.env snapshot before
    //   computing os.tmpdir() — would pass T-API-60 / T-TMP-29 but fail
    //   this test. SPEC §7.4, §8.3, §9.1, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-60a: run() — RunOptions.env TMPDIR does NOT redirect tmpdir parent", async () => {
      project = await createTempProject();
      const realParent = await makeIsolatedTmpdirParent("api60a");
      const fakeParent = makeNonexistentParent("api60a");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpdirMarker = join(project.dir, "tmpdir-env.txt");

      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$TMPDIR" > "${observedTmpdirMarker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, env: { TMPDIR: ${JSON.stringify(fakeParent)} } });
for await (const _ of gen) {}
console.log("done");
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: realParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const observedTmpdir = readFileSync(observedTmpdirMarker, "utf-8");
      expect(observedTmpdir).toBe(fakeParent);
      const observedLoopxTmpdir = readFileSync(tmpdirMarker, "utf-8");
      expect(dirname(observedLoopxTmpdir)).toBe(realParent);
    });

    // ------------------------------------------------------------------------
    // T-API-60b: run() — RunOptions.env does NOT redirect tmpdir parent
    //   selection via TEMP. SPEC §7.4 / §9.5 apply the rule symmetrically
    //   across TMPDIR / TEMP / TMP. T-API-60a covers TMPDIR on the run()
    //   surface; T-TMP-29b covers TEMP on the runPromise() surface; this
    //   test parameterizes the run() generator surface over TEMP. A buggy
    //   implementation that special-cased the TEMP branch of os.tmpdir()
    //   resolution on the lazy-snapshot run() surface would pass
    //   T-API-60a / T-TMP-29b yet fail this test.
    //
    //   Apply T-TMP-25a's runtime-aware expected-parent logic: assert
    //   LOOPX_TMPDIR lives under rightParent iff the active runtime's
    //   os.tmpdir() consults TEMP in this configuration; otherwise assert
    //   the parent matches os.tmpdir() evaluated in an identically-
    //   configured child process. SPEC §7.4, §8.3, §9.1, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-60b: run() — RunOptions.env TEMP does NOT redirect tmpdir parent (runtime-aware)", async () => {
      project = await createTempProject();
      const rightParent = await makeIsolatedTmpdirParent("api60b-right");
      const wrongParent = makeNonexistentParent("api60b-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTempMarker = join(project.dir, "temp-env.txt");

      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$TEMP" > "${observedTempMarker}"
printf '{"stop":true}'`,
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TMP: undefined,
        TEMP: rightParent,
      });

      const driverCode = `
import { run } from "loopx";
delete process.env.TMPDIR;
delete process.env.TMP;
process.env.TEMP = ${JSON.stringify(rightParent)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, env: { TEMP: ${JSON.stringify(wrongParent)} } });
for await (const _ of gen) {}
console.log("done");
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TEMP: rightParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const observedTemp = readFileSync(observedTempMarker, "utf-8");
      expect(observedTemp).toBe(wrongParent);
      const observedLoopxTmpdir = readFileSync(tmpdirMarker, "utf-8");
      expect(dirname(observedLoopxTmpdir)).toBe(expectedParent);
    });

    // ------------------------------------------------------------------------
    // T-API-60c: run() — RunOptions.env does NOT redirect tmpdir parent
    //   selection via TMP. Same runtime-aware pattern as T-API-60b for the
    //   TMP branch; together with T-API-60a (run() × TMPDIR), T-API-60b
    //   (run() × TEMP), T-API-60 (runPromise() × TMPDIR), and T-TMP-29 /
    //   29b / 29c (runPromise() × TMPDIR / TEMP / TMP), this closes the
    //   RunOptions.env × tmpdir-parent contract across both run surfaces ×
    //   all three variables. SPEC §7.4, §8.3, §9.1, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-60c: run() — RunOptions.env TMP does NOT redirect tmpdir parent (runtime-aware)", async () => {
      project = await createTempProject();
      const rightParent = await makeIsolatedTmpdirParent("api60c-right");
      const wrongParent = makeNonexistentParent("api60c-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpMarker = join(project.dir, "tmp-env.txt");

      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$TMP" > "${observedTmpMarker}"
printf '{"stop":true}'`,
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TEMP: undefined,
        TMP: rightParent,
      });

      const driverCode = `
import { run } from "loopx";
delete process.env.TMPDIR;
delete process.env.TEMP;
process.env.TMP = ${JSON.stringify(rightParent)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, env: { TMP: ${JSON.stringify(wrongParent)} } });
for await (const _ of gen) {}
console.log("done");
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMP: rightParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const observedTmp = readFileSync(observedTmpMarker, "utf-8");
      expect(observedTmp).toBe(wrongParent);
      const observedLoopxTmpdir = readFileSync(tmpdirMarker, "utf-8");
      expect(dirname(observedLoopxTmpdir)).toBe(expectedParent);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9 — Outer Options Shape Validation (SPEC §9.5)
// ═════════════════════════════════════════════════════════════
//
// SPEC §9.5: `options` must be omitted, `undefined`, or a non-null,
// non-array, non-function object. T-API-61 series pins the primitive
// matrix on both API surfaces:
//   - run() rejects null / array / function / string / number / boolean /
//     symbol / bigint (T-API-61, 61a, 61b, 61c, 61c2)
//   - runPromise() rejects null / array / function / string / number /
//     boolean / symbol / bigint (T-API-61d, 61e, 61e2)
//   - run() / runPromise() accept explicit `undefined` outer options
//     (T-API-61f / 61g)
//   - runPromise() / run() accept explicit-`undefined` field values
//     for cwd / envFile / maxIterations / signal / env (T-API-61h /
//     61h2)
//
// All invalid-shape rejections surface lazily on first generator
// next() under run(), or as promise rejection under runPromise(),
// per SPEC §9.1 / §9.2 — never as a synchronous throw at the call
// site.

describe("SPEC: Outer Options Shape Validation", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-61, T-API-61a, T-API-61b, T-API-61c, T-API-61c2 —
    // run() rejects null / array / function / string / number / boolean /
    // symbol / bigint outer options. SPEC §9.5: options must be a
    // non-null, non-array, non-function object. The contract is the union
    // of three rejection rules — the symbol and bigint variants pin the
    // structurally-distinct branches (typeof === "symbol", "bigint")
    // that a buggy `typeof !== "object"`-only validator would already
    // reject correctly, while string/number/boolean variants exercise
    // primitives that ARE not "object" via typeof but a buggy validator
    // gating on a different discriminator could miss.
    // ------------------------------------------------------------------------
    interface OuterShapeVariant {
      id: string;
      label: string;
      // Inline literal spliced into the driver code. Symbols and BigInts
      // cannot round-trip through JSON.
      optionsExpr: string;
    }

    const runOuterShapeVariants: OuterShapeVariant[] = [
      { id: "T-API-61", label: "null", optionsExpr: "null" },
      { id: "T-API-61a", label: "array", optionsExpr: "[]" },
      { id: "T-API-61b", label: "function", optionsExpr: "(() => {})" },
      { id: "T-API-61c", label: "string", optionsExpr: '"string"' },
      { id: "T-API-61c2 (number)", label: "number", optionsExpr: "42" },
      { id: "T-API-61c2 (boolean true)", label: "boolean true", optionsExpr: "true" },
      { id: "T-API-61c2 (boolean false)", label: "boolean false", optionsExpr: "false" },
      { id: "T-API-61c2 (symbol)", label: "symbol", optionsExpr: 'Symbol("x")' },
      { id: "T-API-61c2 (bigint)", label: "bigint", optionsExpr: "1n" },
    ];

    for (const v of runOuterShapeVariants) {
      it(`${v.id}: run() with options: ${v.label} throws on first next() with no spawn`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );

        const driverCode = `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let synchronousThrew = false, callTimeMessage = "";
let gen;
try {
  gen = run("ralph", ${v.optionsExpr});
} catch (e) {
  synchronousThrew = true;
  callTimeMessage = e.message || String(e);
}
let threw = false, message = "", name = "";
if (!synchronousThrew) {
  try {
    await gen.next();
  } catch (e) {
    threw = true;
    message = e.message || String(e);
    name = e.name || "";
  }
}
console.log(JSON.stringify({ synchronousThrew, callTimeMessage, threw, message, name }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // SPEC §9.1: option-shape errors do not throw at the call site;
        // they surface lazily on first next().
        expect(parsed.synchronousThrew).toBe(false);
        expect(parsed.threw).toBe(true);
        // Error must reference the options context.
        expect(parsed.message).toMatch(/options|RunOptions/i);
        // No child was spawned (shape error fires pre-iteration).
        expect(existsSync(marker)).toBe(false);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-61d, T-API-61e, T-API-61e2 — runPromise() counterpart.
    // Closes the matrix on the eager-snapshot surface so a buggy
    // implementation that wired up shape validation correctly on run()
    // but used a different code path on runPromise() is caught.
    // SPEC §9.2: runPromise() always returns a promise; option-shape
    // errors surface as promise rejections, not synchronous throws.
    // ------------------------------------------------------------------------
    const runPromiseOuterShapeVariants: OuterShapeVariant[] = [
      { id: "T-API-61d", label: "null", optionsExpr: "null" },
      { id: "T-API-61e", label: "array", optionsExpr: "[]" },
      { id: "T-API-61e2 (function)", label: "function", optionsExpr: "(() => {})" },
      { id: "T-API-61e2 (string)", label: "string", optionsExpr: '"string"' },
      { id: "T-API-61e2 (number)", label: "number", optionsExpr: "42" },
      { id: "T-API-61e2 (boolean true)", label: "boolean true", optionsExpr: "true" },
      { id: "T-API-61e2 (boolean false)", label: "boolean false", optionsExpr: "false" },
      { id: "T-API-61e2 (symbol)", label: "symbol", optionsExpr: 'Symbol("x")' },
      { id: "T-API-61e2 (bigint)", label: "bigint", optionsExpr: "1n" },
    ];

    for (const v of runPromiseOuterShapeVariants) {
      it(`${v.id}: runPromise() with options: ${v.label} rejects with no spawn`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );

        const driverCode = `
import { runPromise } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let synchronousThrew = false, callTimeMessage = "";
let p;
try {
  p = runPromise("ralph", ${v.optionsExpr});
} catch (e) {
  synchronousThrew = true;
  callTimeMessage = e.message || String(e);
}
let rejected = false, message = "", name = "";
if (!synchronousThrew) {
  try {
    await p;
  } catch (e) {
    rejected = true;
    message = e.message || String(e);
    name = e.name || "";
  }
}
console.log(JSON.stringify({ synchronousThrew, callTimeMessage, rejected, message, name }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // SPEC §9.2: runPromise() always returns a promise; option-shape
        // errors surface as promise rejections, never synchronous throws.
        expect(parsed.synchronousThrew).toBe(false);
        expect(parsed.rejected).toBe(true);
        expect(parsed.message).toMatch(/options|RunOptions/i);
        expect(existsSync(marker)).toBe(false);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-61f: run("ralph", undefined) is equivalent to run("ralph") —
    // explicit undefined is accepted as "no options supplied" per SPEC §9.5
    // ("options must be omitted or undefined, or a non-null non-array
    // non-function object"). Pins down the explicit-undefined positive
    // case so a buggy validator cannot silently tighten acceptance to
    // "omitted only".
    // ------------------------------------------------------------------------
    it("T-API-61f: run() with options: undefined is equivalent to options omitted", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'ran' > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let threw = false, message = "";
const outputs = [];
try {
  const gen = run("ralph", undefined);
  for await (const out of gen) { outputs.push(out); }
} catch (e) {
  threw = true;
  message = e.message || String(e);
}
console.log(JSON.stringify({ threw, message, outputCount: outputs.length, lastStop: outputs[outputs.length - 1]?.stop ?? null }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(false);
      expect(parsed.outputCount).toBe(1);
      expect(parsed.lastStop).toBe(true);
      // Script ran exactly once.
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("ran");
    });

    // ------------------------------------------------------------------------
    // T-API-61g: runPromise("ralph", undefined) is equivalent to
    // runPromise("ralph"). Companion to T-API-61f.
    // ------------------------------------------------------------------------
    it("T-API-61g: runPromise() with options: undefined is equivalent to options omitted", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'ran' > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let rejected = false, message = "";
let outputs = [];
try {
  outputs = await runPromise("ralph", undefined);
} catch (e) {
  rejected = true;
  message = e.message || String(e);
}
console.log(JSON.stringify({ rejected, message, outputCount: outputs.length, lastStop: outputs[outputs.length - 1]?.stop ?? null }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(false);
      expect(parsed.outputCount).toBe(1);
      expect(parsed.lastStop).toBe(true);
      expect(existsSync(marker)).toBe(true);
    });

    // ------------------------------------------------------------------------
    // T-API-61h: runPromise() — every recognized option field explicitly
    // `undefined` is treated as absent. SPEC §9.5: each option field's
    // type is `T | undefined`; explicit undefined is equivalent to the
    // field being omitted. Catches a buggy validator that rejected
    // explicit-undefined fields as "not provided but defined", or a
    // precedence layer that treated `undefined` as a distinct value in
    // the spawn-environment builder.
    // ------------------------------------------------------------------------
    it("T-API-61h: runPromise() — every option field explicit undefined treated as absent", async () => {
      project = await createTempProject();
      const ranMarker = join(project.dir, "ran.txt");
      const cwdMarker = join(project.dir, "cwd.txt");
      const myvarMarker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'ran' > "${ranMarker}"
/bin/pwd -P > "${cwdMarker}"
if [ -z "\${MYVAR+x}" ]; then printf 'absent' > "${myvarMarker}"; else printf 'present\\t%s' "$MYVAR" > "${myvarMarker}"; fi
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
delete process.env.MYVAR;
let rejected = false, message = "";
let outputs = [];
try {
  outputs = await runPromise("ralph", { cwd: undefined, envFile: undefined, maxIterations: undefined, signal: undefined, env: undefined });
} catch (e) {
  rejected = true;
  message = e.message || String(e);
}
console.log(JSON.stringify({ rejected, message, outputCount: outputs.length, lastStop: outputs[outputs.length - 1]?.stop ?? null }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // SPEC §9.5: explicit undefined is valid for every option field.
      expect(parsed.rejected).toBe(false);
      expect(parsed.outputCount).toBe(1);
      expect(parsed.lastStop).toBe(true);
      // Script ran in the project dir (cwd: undefined → defaults to process.cwd()).
      expect(existsSync(cwdMarker)).toBe(true);
      const observedCwd = readFileSync(cwdMarker, "utf-8").trim();
      expect(observedCwd).toBe(realpathSync(project.dir));
      // env: undefined contributed no entries; envFile: undefined skipped
      // local-env-file load. MYVAR was explicitly deleted from the
      // spawned driver's process.env, so a buggy implementation that
      // injected an `undefined`-valued MYVAR would surface "present" or
      // a runtime-rejection failure.
      expect(existsSync(myvarMarker)).toBe(true);
      expect(readFileSync(myvarMarker, "utf-8")).toBe("absent");
    });

    // ------------------------------------------------------------------------
    // T-API-61h2: run() — every recognized option field explicitly
    // `undefined` is treated as absent. Generator-surface counterpart to
    // T-API-61h. Pins the same explicit-undefined acceptance contract on
    // run()'s lazy first-next() snapshot path.
    // ------------------------------------------------------------------------
    it("T-API-61h2: run() — every option field explicit undefined treated as absent", async () => {
      project = await createTempProject();
      const ranMarker = join(project.dir, "ran.txt");
      const cwdMarker = join(project.dir, "cwd.txt");
      const myvarMarker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'ran' > "${ranMarker}"
/bin/pwd -P > "${cwdMarker}"
if [ -z "\${MYVAR+x}" ]; then printf 'absent' > "${myvarMarker}"; else printf 'present\\t%s' "$MYVAR" > "${myvarMarker}"; fi
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
delete process.env.MYVAR;
let threw = false, message = "";
const outputs = [];
try {
  const gen = run("ralph", { cwd: undefined, envFile: undefined, maxIterations: undefined, signal: undefined, env: undefined });
  for await (const out of gen) { outputs.push(out); }
} catch (e) {
  threw = true;
  message = e.message || String(e);
}
console.log(JSON.stringify({ threw, message, outputCount: outputs.length, lastStop: outputs[outputs.length - 1]?.stop ?? null }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(false);
      expect(parsed.outputCount).toBe(1);
      expect(parsed.lastStop).toBe(true);
      expect(existsSync(cwdMarker)).toBe(true);
      const observedCwd = readFileSync(cwdMarker, "utf-8").trim();
      expect(observedCwd).toBe(realpathSync(project.dir));
      expect(existsSync(myvarMarker)).toBe(true);
      expect(readFileSync(myvarMarker, "utf-8")).toBe("absent");
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.10 — Throwing Option-Field Getters (SPEC §9.1 / §9.5)
// ═════════════════════════════════════════════════════════════
//
// SPEC §9.1: "Any exception raised during the snapshot — a throwing
// option-field getter, throwing entry getter, throwing proxy ownKeys /
// get trap, or throwing addEventListener — is captured and surfaced via
// the standard pre-iteration error path on the first next(), not at
// the call site." SPEC §9.2: "Identical to run() (section 9.1)" —
// errors surface as promise rejection.
//
// T-API-62 series pins the captured-not-escape contract on every option
// field that the snapshot reads via [[Get]] semantics, plus the
// throwing-trap branches inside options.env (Proxy ownKeys / get traps,
// own enumerable getter on an entry).

describe("SPEC: Throwing Option-Field Getters", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-62 / T-API-62a / T-API-62b / T-API-62c / T-API-62d:
    // Throwing getter on a single options field — generator throws on first
    // next() with the captured exception. The call site does NOT throw
    // synchronously. No child is spawned. SPEC §9.1 / §9.5.
    //
    // Each variant installs a throwing getter on a different option field
    // via Object.defineProperty (per the §1.1 getter-construction rule —
    // never via object spread, since spreading invokes the getter at the
    // spread expression in the test harness BEFORE run() / runPromise() is
    // called, which would surface the throw at the test call site rather
    // than letting the implementation observe it).
    // ------------------------------------------------------------------------
    interface ThrowingFieldVariant {
      id: string;
      field: "env" | "signal" | "cwd" | "envFile" | "maxIterations";
      message: string;
    }

    const throwingFieldVariants: ThrowingFieldVariant[] = [
      { id: "T-API-62", field: "env", message: "env-getter-boom" },
      { id: "T-API-62a", field: "signal", message: "signal-getter-boom" },
      { id: "T-API-62b", field: "cwd", message: "cwd-getter-boom" },
      { id: "T-API-62c", field: "envFile", message: "envFile-getter-boom" },
      {
        id: "T-API-62d",
        field: "maxIterations",
        message: "maxIterations-getter-boom",
      },
    ];

    for (const v of throwingFieldVariants) {
      it(`${v.id}: run() with throwing options.${v.field} getter — captured at call site, surfaced on first next()`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );

        const driverCode = `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
const opts = {};
Object.defineProperty(opts, ${JSON.stringify(v.field)}, {
  enumerable: true,
  configurable: true,
  get() { throw new Error(${JSON.stringify(v.message)}); },
});
let synchronousThrew = false, callTimeMessage = "";
let gen;
try {
  gen = run("ralph", opts);
} catch (e) {
  synchronousThrew = true;
  callTimeMessage = e.message || String(e);
}
let threw = false, message = "";
let isObject = false, hasNext = false, hasReturn = false, hasThrow = false;
if (!synchronousThrew) {
  isObject = gen !== null && typeof gen === "object";
  hasNext = typeof gen.next === "function";
  hasReturn = typeof gen.return === "function";
  hasThrow = typeof gen.throw === "function";
  try {
    await gen.next();
  } catch (e) {
    threw = true;
    message = e.message || String(e);
  }
}
console.log(JSON.stringify({ synchronousThrew, callTimeMessage, threw, message, isObject, hasNext, hasReturn, hasThrow }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // SPEC §9.1: never throws at the call site; captured into snapshot.
        expect(parsed.synchronousThrew).toBe(false);
        // run() returns a generator-shaped object even under invalid options.
        expect(parsed.isObject).toBe(true);
        expect(parsed.hasNext).toBe(true);
        expect(parsed.hasReturn).toBe(true);
        expect(parsed.hasThrow).toBe(true);
        // Captured throw surfaces on first next().
        expect(parsed.threw).toBe(true);
        expect(parsed.message).toContain(v.message);
        // No child spawned (pre-iteration error fires before any spawn).
        expect(existsSync(marker)).toBe(false);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-62e: Throwing enumerable getter on a NAMED ENTRY inside
    // options.env — captured during snapshotEnv's value-read pass and
    // surfaced as a snapshot error on first next().
    //
    // Distinct from T-API-62 (throwing getter on options.env itself) — this
    // test exercises the per-entry value-read path inside snapshotEnv.
    // ------------------------------------------------------------------------
    it("T-API-62e: run() — throwing enumerable getter on options.env entry surfaces on first next()", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "spawn-marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
const env = { A: "a" };
Object.defineProperty(env, "B", {
  enumerable: true,
  configurable: true,
  get() { throw new Error("entry-getter-boom"); },
});
let synchronousThrew = false, callTimeMessage = "";
let gen;
try {
  gen = run("ralph", { env });
} catch (e) {
  synchronousThrew = true;
  callTimeMessage = e.message || String(e);
}
let threw = false, message = "";
if (!synchronousThrew) {
  try {
    await gen.next();
  } catch (e) {
    threw = true;
    message = e.message || String(e);
  }
}
console.log(JSON.stringify({ synchronousThrew, callTimeMessage, threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.synchronousThrew).toBe(false);
      expect(parsed.threw).toBe(true);
      expect(parsed.message).toContain("entry-getter-boom");
      expect(existsSync(marker)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-API-62f: Proxy ownKeys trap that throws while enumerating
    // options.env — captured during snapshotEnv's Object.keys pass and
    // surfaced on first next().
    // ------------------------------------------------------------------------
    it("T-API-62f: run() — throwing Proxy ownKeys trap on options.env surfaces on first next()", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "spawn-marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
const env = new Proxy({ A: "a" }, {
  ownKeys() { throw new Error("ownKeys-trap-boom"); },
});
let synchronousThrew = false, callTimeMessage = "";
let gen;
try {
  gen = run("ralph", { env });
} catch (e) {
  synchronousThrew = true;
  callTimeMessage = e.message || String(e);
}
let threw = false, message = "";
if (!synchronousThrew) {
  try {
    await gen.next();
  } catch (e) {
    threw = true;
    message = e.message || String(e);
  }
}
console.log(JSON.stringify({ synchronousThrew, callTimeMessage, threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.synchronousThrew).toBe(false);
      expect(parsed.threw).toBe(true);
      expect(parsed.message).toContain("ownKeys-trap-boom");
      expect(existsSync(marker)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-API-62f3: Throwing Proxy `get` trap on an INCLUDED options.env key
    // — SPEC §9.5 normatively requires `[[Get]]` semantics for value reads,
    // so a throwing get trap is captured during the per-key value-read pass
    // and surfaced on first next(). This pins the value-read axis (vs
    // T-API-62f's enumeration axis).
    // ------------------------------------------------------------------------
    it("T-API-62f3: run() — throwing Proxy get trap on included options.env key surfaces on first next()", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "spawn-marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
const env = new Proxy({ A: "a", B: "b" }, {
  ownKeys() { return ["A", "B"]; },
  getOwnPropertyDescriptor(_t, _key) {
    return { enumerable: true, configurable: true, value: undefined, writable: true };
  },
  get(_t, _key) { throw new Error("get-trap-boom"); },
});
let synchronousThrew = false, callTimeMessage = "";
let gen;
try {
  gen = run("ralph", { env });
} catch (e) {
  synchronousThrew = true;
  callTimeMessage = e.message || String(e);
}
let threw = false, message = "";
if (!synchronousThrew) {
  try {
    await gen.next();
  } catch (e) {
    threw = true;
    message = e.message || String(e);
  }
}
console.log(JSON.stringify({ synchronousThrew, callTimeMessage, threw, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.synchronousThrew).toBe(false);
      expect(parsed.threw).toBe(true);
      expect(parsed.message).toContain("get-trap-boom");
      expect(existsSync(marker)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-API-62g: Throwing getter under runPromise — promise rejects, no
    // synchronous throw at the call site. SPEC §9.2: "the call itself
    // always returns a promise."
    //
    // Uses a Proxy whose `get` trap throws on the `env` key (per the
    // TEST-SPEC fixture), exercising the runPromise() surface counterpart
    // of T-API-62.
    // ------------------------------------------------------------------------
    it("T-API-62g: runPromise() with throwing options.env getter — promise rejects, no synchronous throw", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "spawn-marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const driverCode = `
import { runPromise } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
const opts = new Proxy({}, {
  get(_t, k) { if (k === "env") throw new Error("proxy-get-boom"); return undefined; },
});
let synchronousThrew = false, callTimeMessage = "";
let p;
try {
  p = runPromise("ralph", opts);
} catch (e) {
  synchronousThrew = true;
  callTimeMessage = e.message || String(e);
}
let isPromise = false;
if (!synchronousThrew) {
  isPromise = p !== null && typeof p === "object" && typeof p.then === "function";
}
let rejected = false, message = "";
if (!synchronousThrew) {
  try {
    await p;
  } catch (e) {
    rejected = true;
    message = e.message || String(e);
  }
}
console.log(JSON.stringify({ synchronousThrew, callTimeMessage, isPromise, rejected, message }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // SPEC §9.2: call always returns a promise; never throws synchronously.
      expect(parsed.synchronousThrew).toBe(false);
      expect(parsed.isPromise).toBe(true);
      expect(parsed.rejected).toBe(true);
      expect(parsed.message).toContain("proxy-get-boom");
      expect(existsSync(marker)).toBe(false);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// §4.11 — Option-Field Single-Read Contract (SPEC §9.1 / §9.2 / §9.5)
// ═════════════════════════════════════════════════════════════
//
// SPEC §9.1 / §9.2: "Each option field is read at most once per call,
// and a throwing getter or proxy trap is not re-invoked to retry."
// T-API-62h series pins the single-read contract on the success path
// (each non-throwing getter fires exactly once) and the no-retry
// contract on the throwing path (a throwing getter / trap fires
// exactly once and is not re-invoked during error surfacing).

describe("SPEC: Option-Field Single-Read Contract", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-62h: run() reads each option field at most once per call.
    // Counter-based getters on every pinned field. After settlement,
    // each counter must be exactly 1.
    // ------------------------------------------------------------------------
    it("T-API-62h: run() reads each option field at most once per call", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );
      const envFilePath = join(project.dir, "valid.env");
      await writeFile(envFilePath, "OTHER=other-val\n");

      const driverCode = `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let signalCount = 0, cwdCount = 0, envFileCount = 0, maxIterCount = 0, envCount = 0;
const opts = {};
const ac = new AbortController();
Object.defineProperty(opts, "signal", { enumerable: true, configurable: true, get() { signalCount++; return ac.signal; } });
Object.defineProperty(opts, "cwd", { enumerable: true, configurable: true, get() { cwdCount++; return ${JSON.stringify(project.dir)}; } });
Object.defineProperty(opts, "envFile", { enumerable: true, configurable: true, get() { envFileCount++; return ${JSON.stringify(envFilePath)}; } });
Object.defineProperty(opts, "maxIterations", { enumerable: true, configurable: true, get() { maxIterCount++; return 2; } });
Object.defineProperty(opts, "env", { enumerable: true, configurable: true, get() { envCount++; return { MYVAR: "value" }; } });
const gen = run("ralph", opts);
const outputs = [];
for await (const o of gen) { outputs.push(o); }
console.log(JSON.stringify({ signalCount, cwdCount, envFileCount, maxIterCount, envCount, outputs: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.signalCount).toBe(1);
      expect(parsed.cwdCount).toBe(1);
      expect(parsed.envFileCount).toBe(1);
      expect(parsed.maxIterCount).toBe(1);
      expect(parsed.envCount).toBe(1);
      expect(parsed.outputs).toBe(1);
      expect(readFileSync(marker, "utf-8")).toBe("value");
    });

    // ------------------------------------------------------------------------
    // T-API-62h2: runPromise() reads each option field at most once per call.
    // ------------------------------------------------------------------------
    it("T-API-62h2: runPromise() reads each option field at most once per call", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );
      const envFilePath = join(project.dir, "valid.env");
      await writeFile(envFilePath, "OTHER=other-val\n");

      const driverCode = `
import { runPromise } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let signalCount = 0, cwdCount = 0, envFileCount = 0, maxIterCount = 0, envCount = 0;
const opts = {};
const ac = new AbortController();
Object.defineProperty(opts, "signal", { enumerable: true, configurable: true, get() { signalCount++; return ac.signal; } });
Object.defineProperty(opts, "cwd", { enumerable: true, configurable: true, get() { cwdCount++; return ${JSON.stringify(project.dir)}; } });
Object.defineProperty(opts, "envFile", { enumerable: true, configurable: true, get() { envFileCount++; return ${JSON.stringify(envFilePath)}; } });
Object.defineProperty(opts, "maxIterations", { enumerable: true, configurable: true, get() { maxIterCount++; return 2; } });
Object.defineProperty(opts, "env", { enumerable: true, configurable: true, get() { envCount++; return { MYVAR: "value" }; } });
const outputs = await runPromise("ralph", opts);
console.log(JSON.stringify({ signalCount, cwdCount, envFileCount, maxIterCount, envCount, outputs: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.signalCount).toBe(1);
      expect(parsed.cwdCount).toBe(1);
      expect(parsed.envFileCount).toBe(1);
      expect(parsed.maxIterCount).toBe(1);
      expect(parsed.envCount).toBe(1);
      expect(parsed.outputs).toBe(1);
      expect(readFileSync(marker, "utf-8")).toBe("value");
    });

    // ------------------------------------------------------------------------
    // T-API-62h3 / T-API-62h4: throwing options.env getter — invoked once,
    // not retried during error surfacing.
    // ------------------------------------------------------------------------
    interface NoRetryFieldVariant {
      id: string;
      surface: "run" | "runPromise";
      field: "env" | "signal";
      message: string;
    }

    const noRetryFieldVariants: NoRetryFieldVariant[] = [
      { id: "T-API-62h3", surface: "run", field: "env", message: "env-getter-boom" },
      { id: "T-API-62h4", surface: "runPromise", field: "env", message: "env-getter-boom" },
      { id: "T-API-62h7", surface: "run", field: "signal", message: "signal-getter-boom" },
      { id: "T-API-62h8", surface: "runPromise", field: "signal", message: "signal-getter-boom" },
    ];

    for (const v of noRetryFieldVariants) {
      it(`${v.id}: ${v.surface}() throwing options.${v.field} getter is invoked exactly once (no retry)`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );

        const driver =
          v.surface === "run"
            ? `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let count = 0;
const opts = {};
Object.defineProperty(opts, ${JSON.stringify(v.field)}, {
  enumerable: true,
  configurable: true,
  get() { count++; throw new Error(${JSON.stringify(v.message)}); },
});
let threw = false, message = "";
try {
  const gen = run("ralph", opts);
  await gen.next();
} catch (e) {
  threw = true;
  message = e.message || String(e);
}
console.log(JSON.stringify({ count, threw, message }));
`
            : `
import { runPromise } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let count = 0;
const opts = {};
Object.defineProperty(opts, ${JSON.stringify(v.field)}, {
  enumerable: true,
  configurable: true,
  get() { count++; throw new Error(${JSON.stringify(v.message)}); },
});
let rejected = false, message = "";
try {
  await runPromise("ralph", opts);
} catch (e) {
  rejected = true;
  message = e.message || String(e);
}
console.log(JSON.stringify({ count, threw: rejected, message }));
`;
        const result = await runAPIDriver(runtime, driver);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.threw).toBe(true);
        expect(parsed.message).toContain(v.message);
        // Load-bearing: getter invoked exactly once (no retry).
        expect(parsed.count).toBe(1);
        // No spawn occurred.
        expect(existsSync(marker)).toBe(false);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-62h5 / T-API-62h6: throwing Proxy ownKeys trap inside options.env
    // — invoked once, not retried.
    // ------------------------------------------------------------------------
    interface NoRetryProxyVariant {
      id: string;
      surface: "run" | "runPromise";
    }

    const noRetryOwnKeysVariants: NoRetryProxyVariant[] = [
      { id: "T-API-62h5", surface: "run" },
      { id: "T-API-62h6", surface: "runPromise" },
    ];

    for (const v of noRetryOwnKeysVariants) {
      it(`${v.id}: ${v.surface}() throwing Proxy ownKeys trap on options.env invoked exactly once (no retry)`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );

        const driver =
          v.surface === "run"
            ? `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let count = 0;
const env = new Proxy({ A: "a" }, {
  ownKeys() { count++; throw new Error("ownKeys-boom"); },
});
let threw = false, message = "";
try {
  const gen = run("ralph", { env });
  await gen.next();
} catch (e) {
  threw = true;
  message = e.message || String(e);
}
console.log(JSON.stringify({ count, threw, message }));
`
            : `
import { runPromise } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let count = 0;
const env = new Proxy({ A: "a" }, {
  ownKeys() { count++; throw new Error("ownKeys-boom"); },
});
let rejected = false, message = "";
try {
  await runPromise("ralph", { env });
} catch (e) {
  rejected = true;
  message = e.message || String(e);
}
console.log(JSON.stringify({ count, threw: rejected, message }));
`;
        const result = await runAPIDriver(runtime, driver);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.threw).toBe(true);
        expect(parsed.message).toContain("ownKeys-boom");
        expect(parsed.count).toBe(1);
        expect(existsSync(marker)).toBe(false);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-62h9: throwing Proxy `get` trap on included options.env key —
    // invoked once on the first included key, not retried. Pins the
    // [[Get]]-semantics no-retry axis on both run surfaces.
    // ------------------------------------------------------------------------
    interface NoRetryGetVariant {
      id: string;
      surface: "run" | "runPromise";
    }

    const noRetryGetVariants: NoRetryGetVariant[] = [
      { id: "T-API-62h9 (run)", surface: "run" },
      { id: "T-API-62h9 (runPromise)", surface: "runPromise" },
    ];

    for (const v of noRetryGetVariants) {
      it(`${v.id}: ${v.surface}() throwing Proxy get trap on options.env included key invoked exactly once (no retry)`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );

        const driver =
          v.surface === "run"
            ? `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let count = 0;
const env = new Proxy({ A: "a", B: "b" }, {
  ownKeys() { return ["A", "B"]; },
  getOwnPropertyDescriptor() { return { enumerable: true, configurable: true, value: undefined, writable: true }; },
  get() { count++; throw new Error("get-trap-boom"); },
});
let threw = false, message = "";
try {
  const gen = run("ralph", { env });
  await gen.next();
} catch (e) {
  threw = true;
  message = e.message || String(e);
}
console.log(JSON.stringify({ count, threw, message }));
`
            : `
import { runPromise } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let count = 0;
const env = new Proxy({ A: "a", B: "b" }, {
  ownKeys() { return ["A", "B"]; },
  getOwnPropertyDescriptor() { return { enumerable: true, configurable: true, value: undefined, writable: true }; },
  get() { count++; throw new Error("get-trap-boom"); },
});
let rejected = false, message = "";
try {
  await runPromise("ralph", { env });
} catch (e) {
  rejected = true;
  message = e.message || String(e);
}
console.log(JSON.stringify({ count, threw: rejected, message }));
`;
        const result = await runAPIDriver(runtime, driver);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.threw).toBe(true);
        expect(parsed.message).toContain("get-trap-boom");
        // Load-bearing: get trap invoked exactly once on the first included
        // key, then captured. A buggy implementation that retried would
        // report count > 1; a buggy descriptor-extraction implementation
        // (count === 0) would never observe the throw and fail on `threw`.
        expect(parsed.count).toBe(1);
        expect(existsSync(marker)).toBe(false);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-62h10 / T-API-62h11: throwing own enumerable getter on a NAMED
    // ENTRY inside options.env — invoked once, not retried. Structurally
    // distinct from the env-on-options-object getter (T-API-62h3/h4) and
    // the proxy variants (T-API-62h5/h6/h9).
    // ------------------------------------------------------------------------
    interface NoRetryEntryVariant {
      id: string;
      surface: "run" | "runPromise";
    }

    const noRetryEntryVariants: NoRetryEntryVariant[] = [
      { id: "T-API-62h10", surface: "run" },
      { id: "T-API-62h11", surface: "runPromise" },
    ];

    for (const v of noRetryEntryVariants) {
      it(`${v.id}: ${v.surface}() throwing own enumerable getter on options.env entry invoked exactly once (no retry)`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );

        const driver =
          v.surface === "run"
            ? `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let count = 0;
const env = { A: "a" };
Object.defineProperty(env, "B", {
  enumerable: true,
  configurable: true,
  get() { count++; throw new Error("env-entry-getter-boom"); },
});
let threw = false, message = "";
try {
  const gen = run("ralph", { env });
  await gen.next();
} catch (e) {
  threw = true;
  message = e.message || String(e);
}
console.log(JSON.stringify({ count, threw, message }));
`
            : `
import { runPromise } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let count = 0;
const env = { A: "a" };
Object.defineProperty(env, "B", {
  enumerable: true,
  configurable: true,
  get() { count++; throw new Error("env-entry-getter-boom"); },
});
let rejected = false, message = "";
try {
  await runPromise("ralph", { env });
} catch (e) {
  rejected = true;
  message = e.message || String(e);
}
console.log(JSON.stringify({ count, threw: rejected, message }));
`;
        const result = await runAPIDriver(runtime, driver);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.threw).toBe(true);
        expect(parsed.message).toContain("env-entry-getter-boom");
        expect(parsed.count).toBe(1);
        expect(existsSync(marker)).toBe(false);
      });
    }
  });
});

describe("SPEC: Option-Field Call-Site Read Timing", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-62i: run() reads cwd, envFile, maxIterations, env getters
    // synchronously at the call site, before returning the generator.
    // SPEC §9.1: "run() reads its options argument at the call site as a
    // synchronous snapshot ... Each option field is read at most once per
    // call." T-API-62h pins the at-most-once contract via a post-settlement
    // observation; this test pins call-site invocation timing for all four
    // non-signal fields with a pre-next() observation point. (Signal
    // call-site timing is covered separately by T-API-64k.) A buggy
    // implementation that deferred non-signal option reads to first next()
    // would observe all four counters at 0 immediately after run() returned
    // and fail this test. Each getter returns a value the implementation
    // must consume (project dir for cwd, valid env-file path for envFile,
    // 1 for maxIterations, { MYVAR: "value" } for env), so the
    // "must have been read at call site" claim is load-bearing rather than
    // satisfied by short-circuiting on undefined.
    // ------------------------------------------------------------------------
    it("T-API-62i: run() reads cwd, envFile, maxIterations, env getters synchronously at call site", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );
      const envFilePath = join(project.dir, "valid.env");
      await writeFile(envFilePath, "OTHER=other-val\n");

      const driverCode = `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let cwdCount = 0, envFileCount = 0, maxIterCount = 0, envCount = 0;
const opts = {};
Object.defineProperty(opts, "cwd", { enumerable: true, configurable: true, get() { cwdCount++; return ${JSON.stringify(project.dir)}; } });
Object.defineProperty(opts, "envFile", { enumerable: true, configurable: true, get() { envFileCount++; return ${JSON.stringify(envFilePath)}; } });
Object.defineProperty(opts, "maxIterations", { enumerable: true, configurable: true, get() { maxIterCount++; return 1; } });
Object.defineProperty(opts, "env", { enumerable: true, configurable: true, get() { envCount++; return { MYVAR: "value" }; } });
const gen = run("ralph", opts);
const callTimeCounts = { cwdCount, envFileCount, maxIterCount, envCount };
const outputs = [];
for await (const o of gen) { outputs.push(o); }
const finalCounts = { cwdCount, envFileCount, maxIterCount, envCount };
console.log(JSON.stringify({ callTimeCounts, finalCounts, outputs: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Each non-signal field read exactly once at call site, BEFORE
      // first next() drove the generator. A buggy lazy implementation
      // would observe all four counters at 0 here.
      expect(parsed.callTimeCounts.cwdCount).toBe(1);
      expect(parsed.callTimeCounts.envFileCount).toBe(1);
      expect(parsed.callTimeCounts.maxIterCount).toBe(1);
      expect(parsed.callTimeCounts.envCount).toBe(1);
      // (b) Counts unchanged after generator settles — no re-read on
      // iteration. Complements T-API-62h's at-most-once assertion at the
      // post-settlement observation point with a stronger pre-next()
      // observation point.
      expect(parsed.finalCounts.cwdCount).toBe(1);
      expect(parsed.finalCounts.envFileCount).toBe(1);
      expect(parsed.finalCounts.maxIterCount).toBe(1);
      expect(parsed.finalCounts.envCount).toBe(1);
      // (c) Run completed normally with the getter return values consumed
      // (env actually reached the spawned script, maxIterations bounded
      // the loop, cwd controlled the spawn cwd, envFile loaded successfully).
      expect(parsed.outputs).toBe(1);
      expect(readFileSync(marker, "utf-8")).toBe("value");
    });

    // ------------------------------------------------------------------------
    // T-API-62i2: runPromise() reads cwd, envFile, maxIterations, env
    // getters synchronously at the call site, before returning the promise.
    // SPEC §9.2 inherits §9.1's option-snapshot timing contract verbatim.
    // The async function body runs synchronously up to its first `await`;
    // runWithInternal is called BEFORE the first `await Promise.resolve()`,
    // so the option-snapshot pass fires at the call site even on the
    // promise-returning surface.
    // ------------------------------------------------------------------------
    it("T-API-62i2: runPromise() reads cwd, envFile, maxIterations, env getters synchronously at call site", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "myvar.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${MYVAR:-UNSET}" > "${marker}"
printf '{"stop":true}'`,
      );
      const envFilePath = join(project.dir, "valid.env");
      await writeFile(envFilePath, "OTHER=other-val\n");

      const driverCode = `
import { runPromise } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let cwdCount = 0, envFileCount = 0, maxIterCount = 0, envCount = 0;
const opts = {};
Object.defineProperty(opts, "cwd", { enumerable: true, configurable: true, get() { cwdCount++; return ${JSON.stringify(project.dir)}; } });
Object.defineProperty(opts, "envFile", { enumerable: true, configurable: true, get() { envFileCount++; return ${JSON.stringify(envFilePath)}; } });
Object.defineProperty(opts, "maxIterations", { enumerable: true, configurable: true, get() { maxIterCount++; return 1; } });
Object.defineProperty(opts, "env", { enumerable: true, configurable: true, get() { envCount++; return { MYVAR: "value" }; } });
const p = runPromise("ralph", opts);
const callTimeCounts = { cwdCount, envFileCount, maxIterCount, envCount };
const outputs = await p;
const finalCounts = { cwdCount, envFileCount, maxIterCount, envCount };
console.log(JSON.stringify({ callTimeCounts, finalCounts, outputs: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.callTimeCounts.cwdCount).toBe(1);
      expect(parsed.callTimeCounts.envFileCount).toBe(1);
      expect(parsed.callTimeCounts.maxIterCount).toBe(1);
      expect(parsed.callTimeCounts.envCount).toBe(1);
      expect(parsed.finalCounts.cwdCount).toBe(1);
      expect(parsed.finalCounts.envFileCount).toBe(1);
      expect(parsed.finalCounts.maxIterCount).toBe(1);
      expect(parsed.finalCounts.envCount).toBe(1);
      expect(parsed.outputs).toBe(1);
      expect(readFileSync(marker, "utf-8")).toBe("value");
    });

    // ------------------------------------------------------------------------
    // T-API-62i3: run() — throwing non-signal option-field getter is
    // invoked exactly once at the call site without escaping synchronously,
    // and the captured error is surfaced lazily on first next(). SPEC §9.1:
    // "Any exception raised during the snapshot ... is captured and
    // surfaced via the standard pre-iteration error path on the first
    // next(), not at the call site." Parameterized over each non-signal
    // field {cwd, envFile, maxIterations, env}. The combined
    // assertion (b) throwCount===1 immediately after run() returns +
    // (d) throwCount===1 post-next() pins the captured-exactly-once-at-
    // call-site contract — the new surface this test pins beyond
    // T-API-62 (error surfaces) and T-API-62h3/h4 (no retry post-next).
    // ------------------------------------------------------------------------
    interface ThrowingFieldVariant {
      field: "cwd" | "envFile" | "maxIterations" | "env";
      siblingField: "cwd" | "envFile" | "maxIterations" | "env";
      siblingValueLiteral: "PROJECT_DIR" | "1";
    }

    const throwingFieldVariantsRun: ThrowingFieldVariant[] = [
      { field: "cwd", siblingField: "maxIterations", siblingValueLiteral: "1" },
      { field: "envFile", siblingField: "maxIterations", siblingValueLiteral: "1" },
      { field: "maxIterations", siblingField: "cwd", siblingValueLiteral: "PROJECT_DIR" },
      { field: "env", siblingField: "maxIterations", siblingValueLiteral: "1" },
    ];

    for (const v of throwingFieldVariantsRun) {
      it(`T-API-62i3: run() throwing options.${v.field} getter invoked exactly once at call site (no synchronous throw, no retry)`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const siblingValueExpr =
          v.siblingValueLiteral === "PROJECT_DIR"
            ? JSON.stringify(project.dir)
            : v.siblingValueLiteral;
        const driverCode = `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let throwCount = 0, siblingCount = 0;
const opts = {};
Object.defineProperty(opts, ${JSON.stringify(v.field)}, { enumerable: true, configurable: true, get() { throwCount++; throw new Error(${JSON.stringify(v.field + "-getter-boom")}); } });
Object.defineProperty(opts, ${JSON.stringify(v.siblingField)}, { enumerable: true, configurable: true, get() { siblingCount++; return ${siblingValueExpr}; } });
let synchronousThrew = false, callTimeMessage = "";
let gen;
try {
  gen = run("ralph", opts);
} catch (e) {
  synchronousThrew = true;
  callTimeMessage = e.message || String(e);
}
const callTimeCounts = { throwCount, siblingCount, synchronousThrew };
let nextThrew = false, nextMessage = "";
if (!synchronousThrew) {
  try {
    await gen.next();
  } catch (e) {
    nextThrew = true;
    nextMessage = e.message || String(e);
  }
}
const finalCounts = { throwCount, siblingCount };
console.log(JSON.stringify({ callTimeCounts, callTimeMessage, finalCounts, nextThrew, nextMessage }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) NO synchronous throw at call site — the call returned a
        // generator, matching SPEC §9.1 "never throws at the call site".
        expect(parsed.callTimeCounts.synchronousThrew).toBe(false);
        expect(parsed.callTimeMessage).toBe("");
        // (b) throwCount === 1 immediately after run() returns: the
        // throwing getter was invoked once at call time, captured rather
        // than escaping. A buggy lazy implementation that deferred the
        // read to first next() would observe throwCount === 0 here.
        expect(parsed.callTimeCounts.throwCount).toBe(1);
        // (c) The captured exception surfaces on first next().
        expect(parsed.nextThrew).toBe(true);
        expect(parsed.nextMessage).toContain(`${v.field}-getter-boom`);
        // (d) throwCount === 1 post-next() — the captured error was not
        // re-derived by re-invoking the getter (no-retry contract).
        expect(parsed.finalCounts.throwCount).toBe(1);
        // No child spawn (snapshot error fires pre-iteration before any
        // spawn — sibling read order is implementation-defined, but
        // marker MUST NOT exist).
        expect(existsSync(marker)).toBe(false);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-62i4: runPromise() — throwing non-signal option-field getter
    // is invoked exactly once at the call site without escaping
    // synchronously, and the captured error is surfaced via promise
    // rejection. runPromise() counterpart to T-API-62i3. SPEC §9.2
    // "Option-snapshot timing. Identical to run() (section 9.1)" — the
    // same call-site invocation contract holds; the captured error
    // surfaces via promise rejection rather than first-next() throw.
    // The async-function-body-runs-synchronously-up-to-first-await
    // semantics combined with runWithInternal being called BEFORE the
    // first `await Promise.resolve()` mean the option-snapshot pass
    // (and any throwing getter) fires before runPromise() returns the
    // promise.
    // ------------------------------------------------------------------------
    const throwingFieldVariantsRunPromise: ThrowingFieldVariant[] = [
      { field: "cwd", siblingField: "maxIterations", siblingValueLiteral: "1" },
      { field: "envFile", siblingField: "maxIterations", siblingValueLiteral: "1" },
      { field: "maxIterations", siblingField: "cwd", siblingValueLiteral: "PROJECT_DIR" },
      { field: "env", siblingField: "maxIterations", siblingValueLiteral: "1" },
    ];

    for (const v of throwingFieldVariantsRunPromise) {
      it(`T-API-62i4: runPromise() throwing options.${v.field} getter invoked exactly once at call site (no synchronous throw, no retry)`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const siblingValueExpr =
          v.siblingValueLiteral === "PROJECT_DIR"
            ? JSON.stringify(project.dir)
            : v.siblingValueLiteral;
        const driverCode = `
import { runPromise } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
let throwCount = 0, siblingCount = 0;
const opts = {};
Object.defineProperty(opts, ${JSON.stringify(v.field)}, { enumerable: true, configurable: true, get() { throwCount++; throw new Error(${JSON.stringify(v.field + "-getter-boom")}); } });
Object.defineProperty(opts, ${JSON.stringify(v.siblingField)}, { enumerable: true, configurable: true, get() { siblingCount++; return ${siblingValueExpr}; } });
let synchronousThrew = false, callTimeMessage = "";
let p;
try {
  p = runPromise("ralph", opts);
} catch (e) {
  synchronousThrew = true;
  callTimeMessage = e.message || String(e);
}
const isPromise = p !== undefined && p !== null && typeof p.then === "function";
const callTimeCounts = { throwCount, siblingCount, synchronousThrew, isPromise };
let rejected = false, rejMessage = "";
if (!synchronousThrew && isPromise) {
  try {
    await p;
  } catch (e) {
    rejected = true;
    rejMessage = e.message || String(e);
  }
}
const finalCounts = { throwCount, siblingCount };
console.log(JSON.stringify({ callTimeCounts, callTimeMessage, finalCounts, rejected, rejMessage }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) NO synchronous throw at call site — runPromise() always
        // returns a promise per SPEC §9.2.
        expect(parsed.callTimeCounts.synchronousThrew).toBe(false);
        expect(parsed.callTimeMessage).toBe("");
        expect(parsed.callTimeCounts.isPromise).toBe(true);
        // (b) throwCount === 1 immediately after runPromise() returns:
        // the throwing getter was invoked once at call time, captured
        // rather than escaping. A buggy implementation that deferred
        // option reads to its internal pre-iteration sequence (run after
        // promise creation) would observe throwCount === 0 here.
        expect(parsed.callTimeCounts.throwCount).toBe(1);
        // (c) Promise rejects with the captured exception.
        expect(parsed.rejected).toBe(true);
        expect(parsed.rejMessage).toContain(`${v.field}-getter-boom`);
        // (d) throwCount === 1 post-rejection — no retry.
        expect(parsed.finalCounts.throwCount).toBe(1);
        // No child spawn.
        expect(existsSync(marker)).toBe(false);
      });
    }
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9 — Generator-Returns-Without-Throwing Invariants
// ═════════════════════════════════════════════════════════════
//
// SPEC §9.1 / §9.2: run() always returns a generator and runPromise() always
// returns a promise — neither call site ever throws synchronously. Errors
// surface lazily on first next() (run) or as promise rejections (runPromise).
// This contract is critical for consumer composition: any call-site throw
// would break try/catch-around-iteration patterns and Promise.all-style
// orchestration. T-API-63 and T-API-63a pin the "always-returns" contract
// across the full enumeration of invalid inputs the SPEC defines, including
// the throwing-getter pathway and the abort-precedence pathway.

describe("SPEC: Generator-Returns-Without-Throwing Invariants", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  // Each variant exercises a distinct invalid-input branch in
  // snapshotOptions / runInternal. The errorPattern matches the message
  // surfaced on first next() / promise rejection. The variants are chosen
  // so each one routes through a structurally different code path:
  //   - invalid-target: target validation in runInternal
  //   - invalid-options-shape: snapshotOptions outer shape gate
  //   - throwing-option-getter: snapshotOptions per-field try/catch
  //   - already-aborted-signal: SPEC §9.3 abort-precedence pathway
  //   - invalid-cwd / invalid-envFile / invalid-env: per-field type gates
  //   - invalid-maxIterations: integer-range gate
  // A buggy implementation that broke the call-site contract on any single
  // branch (e.g., letting a throwing getter escape, or doing eager target
  // validation that threw at the call site) would fail the corresponding
  // variant.
  interface ApiInvalidVariant {
    id: string;
    desc: string;
    setup: string;
    argsExpr: string;
    errorPattern: RegExp;
  }

  const apiInvalidVariants: ApiInvalidVariant[] = [
    {
      id: "invalid-target",
      desc: "non-string target (null)",
      setup: "",
      argsExpr: "null, { maxIterations: 1 }",
      errorPattern: /target/i,
    },
    {
      id: "invalid-options-shape",
      desc: "null options",
      setup: "",
      argsExpr: '"ralph", null',
      errorPattern: /(options|RunOptions)/i,
    },
    {
      id: "throwing-option-getter",
      desc: "throwing options.cwd getter",
      setup:
        'const opts = {}; Object.defineProperty(opts, "cwd", { enumerable: true, configurable: true, get() { throw new Error("cwd-getter-boom"); } });',
      argsExpr: '"ralph", opts',
      errorPattern: /cwd-getter-boom/,
    },
    {
      id: "already-aborted-signal",
      desc: "pre-aborted AbortController",
      setup: "const c = new AbortController(); c.abort();",
      argsExpr: '"ralph", { signal: c.signal, maxIterations: 1 }',
      errorPattern: /abort/i,
    },
    {
      id: "invalid-cwd",
      desc: "non-string cwd (number)",
      setup: "",
      argsExpr: '"ralph", { cwd: 42, maxIterations: 1 }',
      errorPattern: /(cwd.*string|RunOptions\.cwd)/i,
    },
    {
      id: "invalid-envFile",
      desc: "non-string envFile (number)",
      setup: "",
      argsExpr: '"ralph", { envFile: 42, maxIterations: 1 }',
      errorPattern: /(envFile.*string|RunOptions\.envFile)/i,
    },
    {
      id: "invalid-maxIterations",
      desc: "negative maxIterations (-1)",
      setup: "",
      argsExpr: '"ralph", { maxIterations: -1 }',
      errorPattern: /(maxIterations.*integer|Invalid maxIterations)/i,
    },
    {
      id: "invalid-env",
      desc: "non-object env (string)",
      setup: "",
      argsExpr: '"ralph", { env: "not-an-object", maxIterations: 1 }',
      errorPattern: /(env.*object|RunOptions\.env)/i,
    },
  ];

  forEachRuntime((runtime) => {
    // ----------------------------------------------------------------------
    // T-API-63: run() returns a generator without throwing, even under
    // every invalid-options scenario. Per SPEC §9.1: "run() ... still
    // returns a generator without throwing" — errors surface on first
    // next(). For each parameterized invalid input, assert (a) NO
    // synchronous throw at the call site, (b) returned object honors the
    // AsyncGenerator interface contract (.next, .return, .throw methods —
    // critical because consumers may register cleanup via these methods
    // before driving the generator), (c) the error surfaces on first
    // next() with a message matching the variant-specific pattern, and
    // (d) no child is spawned (pre-iteration failures fire before any
    // spawn, and an abort displaces other pre-iteration failures).
    //
    // This is the gateway invariant for the entire T-API-63..69u block:
    // every subsequent abort-precedence / generator-lifecycle test
    // depends on this "always-returns-a-generator" contract holding.
    // ----------------------------------------------------------------------
    for (const v of apiInvalidVariants) {
      it(`T-API-63: run() returns a generator without throwing — ${v.desc}`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const driverCode = `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
${v.setup}
let synchronousThrew = false, callSiteMessage = "";
let returned;
try {
  returned = run(${v.argsExpr});
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e.message || String(e);
}
const isObject = returned !== null && returned !== undefined && (typeof returned === "object" || typeof returned === "function");
const hasNext = isObject && typeof returned.next === "function";
const hasReturn = isObject && typeof returned.return === "function";
const hasThrow = isObject && typeof returned.throw === "function";
let nextThrew = false, nextMessage = "", nextErrName = "";
if (!synchronousThrew && hasNext) {
  try {
    await returned.next();
  } catch (e) {
    nextThrew = true;
    nextMessage = e.message || String(e);
    nextErrName = (e && e.name) ? e.name : "";
  }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, isObject, hasNext, hasReturn, hasThrow, nextThrew, nextMessage, nextErrName }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) NO synchronous throw at call site (SPEC §9.1).
        expect(parsed.synchronousThrew).toBe(false);
        expect(parsed.callSiteMessage).toBe("");
        // (b) Returned object honors the AsyncGenerator interface contract.
        expect(parsed.isObject).toBe(true);
        expect(parsed.hasNext).toBe(true);
        expect(parsed.hasReturn).toBe(true);
        expect(parsed.hasThrow).toBe(true);
        // (c) Error surfaces on first next() with the expected pattern.
        expect(parsed.nextThrew).toBe(true);
        expect(parsed.nextMessage).toMatch(v.errorPattern);
        // (d) No child spawned — pre-iteration failure fires before spawn
        // (and SPEC §9.3 abort-precedence displaces other pre-iteration
        // failures including target validation, env-file load, discovery).
        expect(existsSync(marker)).toBe(false);
      });
    }

    // ----------------------------------------------------------------------
    // T-API-63a: runPromise() returns a promise (not a thrown error) for
    // every invalid input. Per SPEC §9.2: "the call itself always returns
    // a promise" — even under invalid input the call must not throw
    // synchronously. For each parameterized invalid input, assert (a) NO
    // synchronous throw at the call site, (b) returned value is a thenable
    // (typeof p.then === "function") — pinning the SPEC §9.2
    // always-returns-promise contract on the surface, (c) the promise
    // rejects with a message matching the variant-specific pattern, and
    // (d) no child is spawned.
    //
    // The async-function-body-runs-synchronously-up-to-first-await
    // semantics combined with runWithInternal being called BEFORE the
    // first `await Promise.resolve()` (run.ts:761/776) mean the
    // option-snapshot pass + signal capture fire before runPromise()
    // returns the promise — but the surface contract requires the call
    // not to throw, regardless of whether the snapshot itself records an
    // error. A buggy implementation that let an option-shape exception
    // escape past the async-function boundary would fail this test on
    // the synchronousThrew assertion.
    // ----------------------------------------------------------------------
    for (const v of apiInvalidVariants) {
      it(`T-API-63a: runPromise() returns a promise without throwing — ${v.desc}`, async () => {
        project = await createTempProject();
        const marker = join(project.dir, "spawn-marker.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const driverCode = `
import { runPromise } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
${v.setup}
let synchronousThrew = false, callSiteMessage = "";
let returned;
try {
  returned = runPromise(${v.argsExpr});
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e.message || String(e);
}
const isObject = returned !== null && returned !== undefined && (typeof returned === "object" || typeof returned === "function");
const isThenable = isObject && typeof returned.then === "function";
let rejected = false, rejMessage = "", rejErrName = "";
if (!synchronousThrew && isThenable) {
  try {
    await returned;
  } catch (e) {
    rejected = true;
    rejMessage = e.message || String(e);
    rejErrName = (e && e.name) ? e.name : "";
  }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, isObject, isThenable, rejected, rejMessage, rejErrName }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) NO synchronous throw at call site (SPEC §9.2).
        expect(parsed.synchronousThrew).toBe(false);
        expect(parsed.callSiteMessage).toBe("");
        // (b) Returned value is a thenable — SPEC §9.2 always-returns-promise.
        expect(parsed.isObject).toBe(true);
        expect(parsed.isThenable).toBe(true);
        // (c) Promise rejects with the expected pattern.
        expect(parsed.rejected).toBe(true);
        expect(parsed.rejMessage).toMatch(v.errorPattern);
        // (d) No child spawned.
        expect(existsSync(marker)).toBe(false);
      });
    }
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9 — Signal Semantics — Duck-Typed / Reentrant (SPEC §9.1 / §9.2 / §9.3 / §9.5)
// ═════════════════════════════════════════════════════════════
//
// SPEC §9.5 defines AbortSignal-compatibility as a duck-typed contract:
// any object with a readable boolean `aborted` property AND a callable
// `addEventListener('abort', listener)` method qualifies as a usable
// signal. SPEC §9.5 also specifies reentrancy semantics: if
// `addEventListener` synchronously invokes the registered listener during
// registration, OR if `aborted` is observed as `true` at any point during
// call-time capture, loopx treats the signal as aborted. SPEC §9.3
// further specifies that an invalid `options.signal` (one that fails the
// SPEC §9.5 contract) is an option-snapshot error, NOT an abort error,
// and does NOT enter the abort-precedence pathway. The T-API-64 series
// pins down all of these contract pieces across the {run() / runPromise()}
// surface matrix.

describe("SPEC: Duck-Typed Signal — Acceptance and Contract Violations", () => {
  let project: TempProject | null = null;
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
    while (cleanups.length > 0) {
      const c = cleanups.pop();
      if (c) await c().catch(() => {});
    }
  });

  // Per TEST-SPEC §4.7 isolation guidance — concurrent test workers must
  // not race on `/tmp` for `loopx-*` entries. Returns the parent path;
  // cleanup is registered for afterEach.
  async function makeIsolatedTmpdirParent(label: string): Promise<string> {
    const dir = await mkdtemp(join(osTmpdir(), `loopx-test-${label}-`));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    });
    return dir;
  }

  // List `loopx-*` entries directly under `parent`, filtering implementation-
  // internal helpers that are NOT LOOPX_TMPDIR per AGENT.md / SPEC §7.4.
  function listLoopxEntries(parent: string): string[] {
    try {
      return readdirSync(parent)
        .filter((e) => e.startsWith("loopx-"))
        .filter(
          (e) =>
            !e.startsWith("loopx-nodepath-shim-") &&
            !e.startsWith("loopx-bun-jsx-") &&
            !e.startsWith("loopx-install-") &&
            !e.startsWith("loopx-test-"),
        );
    } catch {
      return [];
    }
  }

  forEachRuntime((runtime) => {
    // ----------------------------------------------------------------------
    // T-API-64: Invalid `options.signal` shape (a string) is an option
    // error, not an abort. Per SPEC §9.3: "An invalid `options` value or
    // non-`AbortSignal`-compatible `options.signal` captures no signal and
    // does not enter this pathway" — i.e., the abort-precedence pathway.
    // ----------------------------------------------------------------------
    it("T-API-64: invalid options.signal (string) is an option error, not an abort", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );
      const driverCode = `
import { run } from "loopx";
process.chdir(${JSON.stringify(project.dir)});
const gen = run("ralph", { signal: "not-a-signal", maxIterations: 1 });
let nextThrew = false, nextMessage = "", looksLikeAbort = false;
try {
  await gen.next();
} catch (e) {
  nextThrew = true;
  nextMessage = e?.message || String(e);
  looksLikeAbort = (e?.name === "AbortError") || /aborted|abortError/i.test(nextMessage);
}
console.log(JSON.stringify({ nextThrew, nextMessage, looksLikeAbort }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) First next() throws.
      expect(parsed.nextThrew).toBe(true);
      // (b) The error references the invalid signal shape (option error),
      //     NOT an abort error.
      expect(parsed.nextMessage).toMatch(/(signal|AbortSignal)/i);
      expect(parsed.looksLikeAbort).toBe(false);
      // (c) No child spawned.
      expect(existsSync(marker)).toBe(false);
    });

    // ----------------------------------------------------------------------
    // T-API-64a: Duck-typed signal compatibility — runPromise() surface.
    // SPEC §9.5: "A non-AbortSignal object that exposes `aborted: boolean`
    // and `addEventListener('abort', fn)` is accepted as a signal."
    // ----------------------------------------------------------------------
    it("T-API-64a: runPromise() accepts duck-typed signal; abort fires correctly", async () => {
      project = await createTempProject();
      const ready = join(project.dir, "ready.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `touch "${ready}"
while true; do sleep 1; done`,
      );
      const driverCode = `
import { runPromise } from "loopx";
import { existsSync } from "node:fs";
const duck = {
  aborted: false,
  addEventListener(type, fn) { if (type === "abort") this._listener = fn; },
  _fire() { this.aborted = true; this._listener?.(); }
};
const p = runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  signal: duck,
  maxIterations: 1,
});
// Wait for the child to write the ready marker.
while (!existsSync(${JSON.stringify(ready)})) {
  await new Promise(r => setTimeout(r, 25));
}
duck._fire();
let rejected = false, message = "", looksLikeAbort = false;
try { await p; }
catch (e) {
  rejected = true;
  message = e?.message || String(e);
  looksLikeAbort = (e?.name === "AbortError") || /abort/i.test(message);
}
console.log(JSON.stringify({ rejected, message, looksLikeAbort }));
`;
      const result = await runAPIDriver(runtime, driverCode, { timeout: 60_000 });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.looksLikeAbort).toBe(true);
    });

    // ----------------------------------------------------------------------
    // T-API-64a2: Duck-typed signal compatibility — run() generator surface.
    // SPEC §9.5's contract applies symmetrically to both surfaces.
    // ----------------------------------------------------------------------
    it("T-API-64a2: run() accepts duck-typed signal; abort fires correctly", async () => {
      project = await createTempProject();
      const ready = join(project.dir, "ready.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `touch "${ready}"
while true; do sleep 1; done`,
      );
      const driverCode = `
import { run } from "loopx";
import { existsSync } from "node:fs";
const duck = {
  aborted: false,
  addEventListener(type, fn) { if (type === "abort") this._listener = fn; },
  _fire() { this.aborted = true; this._listener?.(); }
};
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  signal: duck,
  maxIterations: 1,
});
const nextP = gen.next();
// Swallow rejection now to avoid an unhandled rejection during the wait.
nextP.catch(() => {});
// Wait for the child to write the ready marker.
while (!existsSync(${JSON.stringify(ready)})) {
  await new Promise(r => setTimeout(r, 25));
}
duck._fire();
let threw = false, message = "", looksLikeAbort = false;
try { await nextP; }
catch (e) {
  threw = true;
  message = e?.message || String(e);
  looksLikeAbort = (e?.name === "AbortError") || /abort/i.test(message);
}
console.log(JSON.stringify({ threw, message, looksLikeAbort }));
`;
      const result = await runAPIDriver(runtime, driverCode, { timeout: 60_000 });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.threw).toBe(true);
      expect(parsed.looksLikeAbort).toBe(true);
    });

    // ----------------------------------------------------------------------
    // T-API-64b: Reentrant addEventListener — duck signal's listener fires
    // synchronously during registration AND aborted transitions to true.
    // Conjunction case: SPEC §9.5 reentrancy — loopx treats as aborted.
    // Parameterized over both surfaces.
    // ----------------------------------------------------------------------
    for (const surface of ["runPromise", "run"] as const) {
      it(`T-API-64b: ${surface}() — reentrant addEventListener (conjunction) treated as aborted`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent("api64b");
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { run, runPromise } from "loopx";
const duck = {
  aborted: false,
  addEventListener(type, fn) {
    if (type === "abort") { this.aborted = true; fn(); }
  }
};
let observed = false, message = "", looksLikeAbort = false;
${surface === "runPromise"
  ? `try {
       await runPromise("ralph", {
         cwd: ${JSON.stringify(project.dir)},
         signal: duck,
         maxIterations: 1,
       });
     } catch (e) {
       observed = true;
       message = e?.message || String(e);
       looksLikeAbort = (e?.name === "AbortError") || /abort/i.test(message);
     }`
  : `try {
       const gen = run("ralph", {
         cwd: ${JSON.stringify(project.dir)},
         signal: duck,
         maxIterations: 1,
       });
       await gen.next();
     } catch (e) {
       observed = true;
       message = e?.message || String(e);
       looksLikeAbort = (e?.name === "AbortError") || /abort/i.test(message);
     }`}
console.log(JSON.stringify({ observed, message, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) Abort surfaced.
        expect(parsed.observed).toBe(true);
        expect(parsed.looksLikeAbort).toBe(true);
        // (b) No child spawned.
        expect(existsSync(marker)).toBe(false);
        // (c) No loopx-* tmpdir created under the isolated parent.
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
      });
    }

    // ----------------------------------------------------------------------
    // T-API-64b2: Isolated reentrant addEventListener — listener fires
    // synchronously during registration BUT aborted remains false.
    // Isolates the FIRST disjunct of SPEC §9.5 reentrancy. A buggy
    // implementation that gated abort treatment on a post-registration
    // re-read of `aborted` would fail this test.
    // ----------------------------------------------------------------------
    for (const surface of ["runPromise", "run"] as const) {
      it(`T-API-64b2: ${surface}() — isolated reentrant addEventListener (aborted stays false) treated as aborted`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent("api64b2");
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { run, runPromise } from "loopx";
const duck = {
  aborted: false,
  addEventListener(type, fn) {
    if (type === "abort") fn();
    /* deliberately do NOT mutate this.aborted */
  }
};
let observed = false, message = "", looksLikeAbort = false;
${surface === "runPromise"
  ? `try {
       await runPromise("ralph", {
         cwd: ${JSON.stringify(project.dir)},
         signal: duck,
         maxIterations: 1,
       });
     } catch (e) {
       observed = true;
       message = e?.message || String(e);
       looksLikeAbort = (e?.name === "AbortError") || /abort/i.test(message);
     }`
  : `try {
       const gen = run("ralph", {
         cwd: ${JSON.stringify(project.dir)},
         signal: duck,
         maxIterations: 1,
       });
       await gen.next();
     } catch (e) {
       observed = true;
       message = e?.message || String(e);
       looksLikeAbort = (e?.name === "AbortError") || /abort/i.test(message);
     }`}
console.log(JSON.stringify({ observed, message, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.observed).toBe(true);
        expect(parsed.looksLikeAbort).toBe(true);
        expect(existsSync(marker)).toBe(false);
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
      });
    }

    // ----------------------------------------------------------------------
    // T-API-64c: Duck-typed signal with `aborted: true` at capture time —
    // loopx treats as aborted, no child spawned. Second disjunct of SPEC
    // §9.5 reentrancy isolated.
    // ----------------------------------------------------------------------
    for (const surface of ["runPromise", "run"] as const) {
      it(`T-API-64c: ${surface}() — duck signal with aborted:true at capture treated as aborted`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent("api64c");
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { run, runPromise } from "loopx";
const duck = {
  aborted: true,
  addEventListener(type, fn) { if (type === "abort") this._listener = fn; }
};
let observed = false, message = "", looksLikeAbort = false;
${surface === "runPromise"
  ? `try {
       await runPromise("ralph", {
         cwd: ${JSON.stringify(project.dir)},
         signal: duck,
         maxIterations: 1,
       });
     } catch (e) {
       observed = true;
       message = e?.message || String(e);
       looksLikeAbort = (e?.name === "AbortError") || /abort/i.test(message);
     }`
  : `try {
       const gen = run("ralph", {
         cwd: ${JSON.stringify(project.dir)},
         signal: duck,
         maxIterations: 1,
       });
       await gen.next();
     } catch (e) {
       observed = true;
       message = e?.message || String(e);
       looksLikeAbort = (e?.name === "AbortError") || /abort/i.test(message);
     }`}
console.log(JSON.stringify({ observed, message, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.observed).toBe(true);
        expect(parsed.looksLikeAbort).toBe(true);
        expect(existsSync(marker)).toBe(false);
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
      });
    }

    // ----------------------------------------------------------------------
    // T-API-64d: Real pre-aborted AbortSignal. SPEC §9.5 — real
    // AbortSignal instances passed already-aborted must always be
    // observed as aborted.
    // ----------------------------------------------------------------------
    it("T-API-64d: runPromise() — real pre-aborted AbortSignal rejects with abort error, no child spawned", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api64d");
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );
      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { runPromise } from "loopx";
const c = new AbortController();
c.abort();
let rejected = false, message = "", looksLikeAbort = false;
try {
  await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: c.signal,
    maxIterations: 1,
  });
} catch (e) {
  rejected = true;
  message = e?.message || String(e);
  looksLikeAbort = (e?.name === "AbortError") || /abort/i.test(message);
}
console.log(JSON.stringify({ rejected, message, looksLikeAbort }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.rejected).toBe(true);
      expect(parsed.looksLikeAbort).toBe(true);
      expect(existsSync(marker)).toBe(false);
      const after = listLoopxEntries(tmpdirParent);
      expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
    });

    // ----------------------------------------------------------------------
    // T-API-64e: Signal getter is read first. Per SPEC §9.1 / §9.2, signal
    // is read BEFORE other recognized RunOptions fields.
    // ----------------------------------------------------------------------
    it("T-API-64e: run() reads options.signal before options.env", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      const driverCode = `
import { run } from "loopx";
const order = [];
const opts = {};
Object.defineProperty(opts, "signal", {
  enumerable: true,
  get() { order.push("signal"); return undefined; }
});
Object.defineProperty(opts, "env", {
  enumerable: true,
  get() { order.push("env"); return undefined; }
});
opts.maxIterations = 1;
process.chdir(${JSON.stringify(project.dir)});
const gen = run("ralph", opts);
try { for await (const _ of gen) {} } catch {}
console.log(JSON.stringify({ order }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.order[0]).toBe("signal");
    });

    // ----------------------------------------------------------------------
    // T-API-64f / T-API-64g / T-API-64i / T-API-64i2 / T-API-64i3 /
    // T-API-64i4: addEventListener-half contract violations on the duck
    // signal. Three violation modes: throws-on-call (f/g), non-callable
    // (i/i2), missing (i3/i4) — each on both run surfaces. All must
    // surface as option-snapshot errors, NOT abort errors.
    // ----------------------------------------------------------------------
    interface ContractViolationVariant {
      id: string;
      desc: string;
      duckExpr: string;
    }
    const aeContractViolations: ContractViolationVariant[] = [
      {
        id: "throwing-addEventListener",
        desc: "addEventListener throws on call",
        duckExpr: `{ aborted: false, addEventListener() { throw new Error("listener-register-failed"); } }`,
      },
      {
        id: "non-callable-addEventListener",
        desc: "addEventListener is non-callable (string)",
        duckExpr: `{ aborted: false, addEventListener: "not-a-function" }`,
      },
      {
        id: "missing-addEventListener",
        desc: "addEventListener property missing entirely",
        duckExpr: `{ aborted: false }`,
      },
    ];

    for (const v of aeContractViolations) {
      const runId =
        v.id === "throwing-addEventListener" ? "T-API-64f"
        : v.id === "non-callable-addEventListener" ? "T-API-64i"
        : "T-API-64i3";
      it(`${runId}: run() — ${v.desc} surfaces as option-snapshot error, not abort`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api64-${v.id}-run`);
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { run } from "loopx";
const duck = ${v.duckExpr};
let synchronousThrew = false, callSiteMessage = "";
let returned;
try {
  returned = run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 1,
  });
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
let nextThrew = false, nextMessage = "", nextErrName = "", looksLikeAbort = false;
if (!synchronousThrew && returned && typeof returned.next === "function") {
  try {
    await returned.next();
  } catch (e) {
    nextThrew = true;
    nextMessage = e?.message || String(e);
    nextErrName = e?.name || "";
    looksLikeAbort = (nextErrName === "AbortError") || /^abort(ed)?$/i.test(nextMessage);
  }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, nextThrew, nextMessage, nextErrName, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) NO synchronous throw at call site.
        expect(parsed.synchronousThrew).toBe(false);
        // (b) First next() throws.
        expect(parsed.nextThrew).toBe(true);
        // (c) The error references the invalid signal (option error).
        expect(parsed.nextMessage).toMatch(/(signal|listener-register-failed|AbortSignal)/i);
        // (d) NOT an abort error.
        expect(parsed.looksLikeAbort).toBe(false);
        // (e) No child spawned.
        expect(existsSync(marker)).toBe(false);
        // (f) No tmpdir created.
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
      });

      const promiseId =
        v.id === "throwing-addEventListener" ? "T-API-64g"
        : v.id === "non-callable-addEventListener" ? "T-API-64i2"
        : "T-API-64i4";
      it(`${promiseId}: runPromise() — ${v.desc} rejects with option-snapshot error, not abort`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api64-${v.id}-promise`);
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { runPromise } from "loopx";
const duck = ${v.duckExpr};
let synchronousThrew = false, callSiteMessage = "";
let returned;
try {
  returned = runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 1,
  });
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
let rejected = false, rejMessage = "", rejErrName = "", looksLikeAbort = false;
if (!synchronousThrew && returned && typeof returned.then === "function") {
  try {
    await returned;
  } catch (e) {
    rejected = true;
    rejMessage = e?.message || String(e);
    rejErrName = e?.name || "";
    looksLikeAbort = (rejErrName === "AbortError") || /^abort(ed)?$/i.test(rejMessage);
  }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, rejected, rejMessage, rejErrName, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.synchronousThrew).toBe(false);
        expect(parsed.rejected).toBe(true);
        expect(parsed.rejMessage).toMatch(/(signal|listener-register-failed|AbortSignal)/i);
        expect(parsed.looksLikeAbort).toBe(false);
        expect(existsSync(marker)).toBe(false);
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
      });
    }

    // ----------------------------------------------------------------------
    // T-API-64h / T-API-64h2: Throwing aborted getter — duck signal whose
    // aborted getter throws on read surfaces as an option-snapshot error.
    // ----------------------------------------------------------------------
    for (const surface of ["run", "runPromise"] as const) {
      const id = surface === "run" ? "T-API-64h" : "T-API-64h2";
      it(`${id}: ${surface}() — throwing aborted getter surfaces as option-snapshot error`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api64h-${surface}`);
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { run, runPromise } from "loopx";
const duck = { addEventListener() {} };
Object.defineProperty(duck, "aborted", {
  enumerable: true,
  get() { throw new Error("aborted-getter-failed"); }
});
let synchronousThrew = false, callSiteMessage = "";
let observed = false, message = "", errName = "", looksLikeAbort = false;
try {
${surface === "run"
  ? `  const gen = run("ralph", {
       cwd: ${JSON.stringify(project.dir)},
       signal: duck,
       maxIterations: 1,
     });
     try { await gen.next(); }
     catch (e) {
       observed = true;
       message = e?.message || String(e);
       errName = e?.name || "";
       looksLikeAbort = (errName === "AbortError") || /^abort(ed)?$/i.test(message);
     }`
  : `  const p = runPromise("ralph", {
       cwd: ${JSON.stringify(project.dir)},
       signal: duck,
       maxIterations: 1,
     });
     try { await p; }
     catch (e) {
       observed = true;
       message = e?.message || String(e);
       errName = e?.name || "";
       looksLikeAbort = (errName === "AbortError") || /^abort(ed)?$/i.test(message);
     }`}
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, observed, message, errName, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.synchronousThrew).toBe(false);
        expect(parsed.observed).toBe(true);
        // The error references either the invalid signal or wraps the
        // getter exception.
        expect(parsed.message).toMatch(/(signal|aborted-getter-failed|AbortSignal)/i);
        expect(parsed.looksLikeAbort).toBe(false);
        expect(existsSync(marker)).toBe(false);
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
      });
    }

    // ----------------------------------------------------------------------
    // T-API-64j / T-API-64j2: Missing or non-boolean `aborted` —
    // parameterized over (a) missing, (b) undefined, (c) "false" string,
    // (d) 0 number, (e) null, (f) 1 truthy number, (g) {} object.
    // Each must surface as option-snapshot error (NO coercion, NO abort).
    // ----------------------------------------------------------------------
    interface AbortedShapeVariant {
      label: string;
      duckExpr: string;
    }
    const abortedVariants: AbortedShapeVariant[] = [
      { label: "missing", duckExpr: `{ addEventListener() {} }` },
      { label: "undefined", duckExpr: `{ aborted: undefined, addEventListener() {} }` },
      { label: "string-false", duckExpr: `{ aborted: "false", addEventListener() {} }` },
      { label: "zero", duckExpr: `{ aborted: 0, addEventListener() {} }` },
      { label: "null", duckExpr: `{ aborted: null, addEventListener() {} }` },
      { label: "one", duckExpr: `{ aborted: 1, addEventListener() {} }` },
      { label: "object", duckExpr: `{ aborted: {}, addEventListener() {} }` },
    ];

    for (const v of abortedVariants) {
      it(`T-API-64j (${v.label}): run() — non-boolean aborted (${v.label}) surfaces as option-snapshot error, not abort`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api64j-${v.label}`);
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { run } from "loopx";
const duck = ${v.duckExpr};
let synchronousThrew = false, callSiteMessage = "";
let returned;
try {
  returned = run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 1,
  });
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
let nextThrew = false, nextMessage = "", nextErrName = "", looksLikeAbort = false;
if (!synchronousThrew && returned && typeof returned.next === "function") {
  try {
    await returned.next();
  } catch (e) {
    nextThrew = true;
    nextMessage = e?.message || String(e);
    nextErrName = e?.name || "";
    looksLikeAbort = (nextErrName === "AbortError") || /^abort(ed)?$/i.test(nextMessage);
  }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, nextThrew, nextMessage, nextErrName, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.synchronousThrew).toBe(false);
        expect(parsed.nextThrew).toBe(true);
        expect(parsed.nextMessage).toMatch(/(signal|AbortSignal)/i);
        expect(parsed.looksLikeAbort).toBe(false);
        expect(existsSync(marker)).toBe(false);
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
      });

      it(`T-API-64j2 (${v.label}): runPromise() — non-boolean aborted (${v.label}) rejects with option-snapshot error, not abort`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api64j2-${v.label}`);
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { runPromise } from "loopx";
const duck = ${v.duckExpr};
let synchronousThrew = false, callSiteMessage = "";
let returned;
try {
  returned = runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 1,
  });
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
let rejected = false, rejMessage = "", rejErrName = "", looksLikeAbort = false;
if (!synchronousThrew && returned && typeof returned.then === "function") {
  try {
    await returned;
  } catch (e) {
    rejected = true;
    rejMessage = e?.message || String(e);
    rejErrName = e?.name || "";
    looksLikeAbort = (rejErrName === "AbortError") || /^abort(ed)?$/i.test(rejMessage);
  }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, rejected, rejMessage, rejErrName, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.synchronousThrew).toBe(false);
        expect(parsed.rejected).toBe(true);
        expect(parsed.rejMessage).toMatch(/(signal|AbortSignal)/i);
        expect(parsed.looksLikeAbort).toBe(false);
        expect(existsSync(marker)).toBe(false);
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
      });
    }

    // ----------------------------------------------------------------------
    // T-API-64k / T-API-64k2 / T-API-64k3 — Call-Site Capture Timing.
    // SPEC §9.1 / §9.2 / §9.5: options.signal is read at the call site as a
    // synchronous snapshot; both run surfaces capture before returning. The
    // duck-typed-signal pathway provides a clean observation surface — a real
    // AbortSignal.addEventListener is not directly observable as a counter
    // without monkey-patching the prototype. A buggy implementation that
    // deferred the signal read (and addEventListener registration) until the
    // first next() / iteration would still pass abort-during-iteration tests
    // (the listener would register lazily but in time to observe a same-tick
    // abort), yet would break the call-site snapshot contract — observable
    // here via the synchronous post-call counter / order-array assertion.
    // ----------------------------------------------------------------------

    // T-API-64k: run() registers signal.addEventListener('abort', …) at the
    // call site, observable synchronously after run() returns and before any
    // consumer interaction with the generator.
    it("T-API-64k: run() registers addEventListener at call site (synchronous snapshot)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      const driverCode = `
import { run } from "loopx";
let count = 0;
const duck = {
  aborted: false,
  addEventListener(type, fn) {
    if (type === "abort") { count++; this._listener = fn; }
  }
};
let synchronousThrew = false, callSiteMessage = "";
let gen;
try {
  gen = run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 1,
  });
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
const countAfterCall = count;
let drainErr = "";
if (gen) {
  try { for await (const _ of gen) {} } catch (e) { drainErr = e?.message || String(e); }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, countAfterCall, drainErr }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) NO synchronous throw at the call site.
      expect(parsed.synchronousThrew).toBe(false);
      expect(parsed.callSiteMessage).toBe("");
      // (b) addEventListener was invoked synchronously during run() — count
      //     observable === 1 BEFORE any generator interaction.
      expect(parsed.countAfterCall).toBe(1);
    });

    // T-API-64k2: runPromise() registers signal.addEventListener('abort', …)
    // at the call site, observable synchronously after runPromise() returns
    // and before the promise is awaited. SPEC §9.2 specifies eager snapshot
    // timing for runPromise — the synchronous body of runPromise runs before
    // its first `await Promise.resolve()` microtask boundary, so the listener
    // registration is observable to the caller before the returned promise
    // suspends.
    it("T-API-64k2: runPromise() registers addEventListener at call site (synchronous snapshot)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      const driverCode = `
import { runPromise } from "loopx";
let count = 0;
const duck = {
  aborted: false,
  addEventListener(type, fn) {
    if (type === "abort") { count++; this._listener = fn; }
  }
};
let synchronousThrew = false, callSiteMessage = "";
let p;
try {
  p = runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 1,
  });
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
const countAfterCall = count;
let awaitErr = "";
if (p) {
  try { await p; } catch (e) { awaitErr = e?.message || String(e); }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, countAfterCall, awaitErr }));
`;
      const result = await runAPIDriver(runtime, driverCode);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) NO synchronous throw at the call site.
      expect(parsed.synchronousThrew).toBe(false);
      expect(parsed.callSiteMessage).toBe("");
      // (b) addEventListener was invoked synchronously during runPromise() —
      //     count observable === 1 BEFORE awaiting the returned promise.
      expect(parsed.countAfterCall).toBe(1);
    });

    // T-API-64k3: options.signal is READ before every other recognized
    // RunOptions field, on both run surfaces, against every other field
    // independently. 8 cells: {run, runPromise} × {env, cwd, envFile,
    // maxIterations}. The SPEC ordering rule is on the field READ, not on
    // listener-registration completion — we assert order[0] === "signal"
    // only, never "addEventListener fired before <other-field>".
    interface OrderingFieldVariant {
      field: "env" | "cwd" | "envFile" | "maxIterations";
      returnExpr: string;
    }
    const orderingFields: OrderingFieldVariant[] = [
      { field: "env", returnExpr: "undefined" },
      { field: "cwd", returnExpr: "undefined" },
      { field: "envFile", returnExpr: "undefined" },
      { field: "maxIterations", returnExpr: "1" },
    ];

    for (const v of orderingFields) {
      it(`T-API-64k3 (run, ${v.field}): run() reads options.signal before options.${v.field}`, async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        const driverCode = `
import { run } from "loopx";
const order = [];
const duckSignal = { aborted: false, addEventListener() {} };
const opts = {};
Object.defineProperty(opts, "signal", {
  enumerable: true,
  get() { order.push("signal"); return duckSignal; }
});
Object.defineProperty(opts, ${JSON.stringify(v.field)}, {
  enumerable: true,
  get() { order.push(${JSON.stringify(v.field)}); return ${v.returnExpr}; }
});
process.chdir(${JSON.stringify(project.dir)});
let synchronousThrew = false, callSiteMessage = "";
let gen;
try {
  gen = run("ralph", opts);
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
const orderAfterCall = order.slice();
let drainErr = "";
if (gen) {
  try { for await (const _ of gen) {} } catch (e) { drainErr = e?.message || String(e); }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, orderAfterCall, drainErr }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) NO synchronous throw at the call site.
        expect(parsed.synchronousThrew).toBe(false);
        expect(parsed.callSiteMessage).toBe("");
        // (b) signal getter ran first across all recognized outer fields.
        expect(parsed.orderAfterCall[0]).toBe("signal");
        // (c) The other field's getter also ran (sanity — proves the
        //     parameterized field is actually being read by the snapshot).
        expect(parsed.orderAfterCall).toContain(v.field);
      });

      it(`T-API-64k3 (runPromise, ${v.field}): runPromise() reads options.signal before options.${v.field}`, async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        const driverCode = `
import { runPromise } from "loopx";
const order = [];
const duckSignal = { aborted: false, addEventListener() {} };
const opts = {};
Object.defineProperty(opts, "signal", {
  enumerable: true,
  get() { order.push("signal"); return duckSignal; }
});
Object.defineProperty(opts, ${JSON.stringify(v.field)}, {
  enumerable: true,
  get() { order.push(${JSON.stringify(v.field)}); return ${v.returnExpr}; }
});
process.chdir(${JSON.stringify(project.dir)});
let synchronousThrew = false, callSiteMessage = "";
let p;
try {
  p = runPromise("ralph", opts);
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
const orderAfterCall = order.slice();
let awaitErr = "";
if (p) {
  try { await p; } catch (e) { awaitErr = e?.message || String(e); }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, orderAfterCall, awaitErr }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) NO synchronous throw at the call site.
        expect(parsed.synchronousThrew).toBe(false);
        expect(parsed.callSiteMessage).toBe("");
        // (b) signal getter ran first across all recognized outer fields.
        expect(parsed.orderAfterCall[0]).toBe("signal");
        // (c) The other field's getter also ran (sanity — proves the
        //     parameterized field is actually being read by the snapshot).
        expect(parsed.orderAfterCall).toContain(v.field);
      });
    }

    // ----------------------------------------------------------------------
    // T-API-64m / T-API-64m2 — Throwing addEventListener getter on duck
    // signal surfaces as option-snapshot error. SPEC §9.5: addEventListener
    // "must be callable and returns without throwing" — the contract is also
    // violated when the property *read itself* throws, before loopx can
    // attempt to invoke the result. Distinguishes from T-API-64f / T-API-64g
    // (function that throws when called); here loopx never observes any
    // value because the read raises. A buggy implementation that read the
    // property as a separate uncaught expression before wrapping the call
    // site in try/catch would let the getter exception escape past the
    // snapshot-capture boundary.
    // ----------------------------------------------------------------------
    for (const surface of ["run", "runPromise"] as const) {
      const id = surface === "run" ? "T-API-64m" : "T-API-64m2";
      it(`${id}: ${surface}() — throwing addEventListener getter surfaces as option-snapshot error`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api64m-${surface}`);
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { run, runPromise } from "loopx";
const duck = { aborted: false };
Object.defineProperty(duck, "addEventListener", {
  enumerable: true,
  get() { throw new Error("ae-getter-boom"); }
});
let synchronousThrew = false, callSiteMessage = "";
let observed = false, message = "", errName = "", looksLikeAbort = false;
try {
${surface === "run"
  ? `  const gen = run("ralph", {
       cwd: ${JSON.stringify(project.dir)},
       signal: duck,
       maxIterations: 1,
     });
     try { await gen.next(); }
     catch (e) {
       observed = true;
       message = e?.message || String(e);
       errName = e?.name || "";
       looksLikeAbort = (errName === "AbortError") || /^abort(ed)?$/i.test(message);
     }`
  : `  const p = runPromise("ralph", {
       cwd: ${JSON.stringify(project.dir)},
       signal: duck,
       maxIterations: 1,
     });
     try { await p; }
     catch (e) {
       observed = true;
       message = e?.message || String(e);
       errName = e?.name || "";
       looksLikeAbort = (errName === "AbortError") || /^abort(ed)?$/i.test(message);
     }`}
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, observed, message, errName, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) NO synchronous throw at call site.
        expect(parsed.synchronousThrew).toBe(false);
        // (b) Surface observed an option-snapshot error.
        expect(parsed.observed).toBe(true);
        // (c) Error references invalid signal or wraps the getter exception.
        expect(parsed.message).toMatch(/(signal|ae-getter-boom|AbortSignal)/i);
        // (d) NOT an abort error.
        expect(parsed.looksLikeAbort).toBe(false);
        // (e) No child spawned.
        expect(existsSync(marker)).toBe(false);
        // (f) No tmpdir created.
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
      });
    }

    // ----------------------------------------------------------------------
    // T-API-64n / T-API-64n2 — Prototype-inherited duck signal (aborted +
    // addEventListener exposed via the prototype, not own properties) is
    // accepted as AbortSignal-compatible. SPEC §9.5 uses "expose", not
    // "has own"; an implementation that probed via Object.hasOwn(...) would
    // reject this duck despite it satisfying the structural contract.
    // ----------------------------------------------------------------------
    for (const surface of ["run", "runPromise"] as const) {
      const id = surface === "run" ? "T-API-64n" : "T-API-64n2";
      it(`${id}: ${surface}() accepts prototype-inherited duck signal; abort fires correctly`, async () => {
        project = await createTempProject();
        const ready = join(project.dir, "ready.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `touch "${ready}"
while true; do sleep 1; done`,
        );
        const driverCode = `
import { run, runPromise } from "loopx";
import { existsSync } from "node:fs";
class DuckSignal {
  addEventListener(type, fn) { if (type === "abort") this._listener = fn; }
  _fire() { this.aborted = true; this._listener?.(); }
}
DuckSignal.prototype.aborted = false;
const duck = new DuckSignal();
// Sanity: confirm both contract halves are exposed via the prototype only.
const ownHasAborted = Object.prototype.hasOwnProperty.call(duck, "aborted");
const ownHasAEL = Object.prototype.hasOwnProperty.call(duck, "addEventListener");
${surface === "run"
  ? `const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  signal: duck,
  maxIterations: 1,
});
const nextP = gen.next();
nextP.catch(() => {});
while (!existsSync(${JSON.stringify(ready)})) {
  await new Promise(r => setTimeout(r, 25));
}
duck._fire();
let observed = false, message = "", errName = "", looksLikeAbort = false;
try { await nextP; }
catch (e) {
  observed = true;
  message = e?.message || String(e);
  errName = e?.name || "";
  looksLikeAbort = (errName === "AbortError") || /abort/i.test(message);
}`
  : `const p = runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  signal: duck,
  maxIterations: 1,
});
while (!existsSync(${JSON.stringify(ready)})) {
  await new Promise(r => setTimeout(r, 25));
}
duck._fire();
let observed = false, message = "", errName = "", looksLikeAbort = false;
try { await p; }
catch (e) {
  observed = true;
  message = e?.message || String(e);
  errName = e?.name || "";
  looksLikeAbort = (errName === "AbortError") || /abort/i.test(message);
}`}
console.log(JSON.stringify({ ownHasAborted, ownHasAEL, observed, message, errName, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, { timeout: 60_000 });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // Sanity: duck halves resolved through the prototype, not own props.
        expect(parsed.ownHasAborted).toBe(false);
        expect(parsed.ownHasAEL).toBe(false);
        // (a) Abort surfaced via the inherited contract.
        expect(parsed.observed).toBe(true);
        expect(parsed.looksLikeAbort).toBe(true);
        // (b) The error is an abort error, NOT an option-snapshot error
        //     (no RunOptions.signal pre-iteration shape error).
        expect(parsed.message).not.toMatch(/RunOptions\.signal/i);
      });
    }

    // ----------------------------------------------------------------------
    // T-API-64o / T-API-64o2 — Duck signal without `removeEventListener`
    // accepted under normal (stop:true) completion. SPEC §9.5 explicitly
    // states removeEventListener is NOT part of the AbortSignal-compatibility
    // contract. A buggy implementation that called signal.removeEventListener
    // unguarded on settlement would TypeError on a duck lacking it — but
    // only on the normal-completion path (the abort path may early-return
    // before reaching the unconditional remove). T-API-64a covers the
    // abort-path acceptance; this closes the normal-completion-path cell.
    // ----------------------------------------------------------------------
    for (const surface of ["run", "runPromise"] as const) {
      const id = surface === "run" ? "T-API-64o" : "T-API-64o2";
      it(`${id}: ${surface}() accepts duck signal without removeEventListener under normal completion`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api64o-${surface}`);
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const driverCode = `
import { run, runPromise } from "loopx";
const duck = {
  aborted: false,
  addEventListener(type, fn) { if (type === "abort") this._listener = fn; }
};
// Sanity: removeEventListener must be entirely absent (own + prototype).
const hasRemove = "removeEventListener" in duck;
let observed = false, errMessage = "", errName = "";
let outputs = [];
let resolved = false;
${surface === "run"
  ? `try {
  const gen = run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 5,
  });
  for await (const out of gen) { outputs.push(out); }
  resolved = true;
} catch (e) {
  observed = true;
  errMessage = e?.message || String(e);
  errName = e?.name || "";
}`
  : `try {
  outputs = await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 5,
  });
  resolved = true;
} catch (e) {
  observed = true;
  errMessage = e?.message || String(e);
  errName = e?.name || "";
}`}
console.log(JSON.stringify({ hasRemove, observed, errMessage, errName, outputs, resolved }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // Sanity: duck genuinely lacks removeEventListener.
        expect(parsed.hasRemove).toBe(false);
        // (a) Settled cleanly without throwing.
        expect(parsed.observed).toBe(false);
        expect(parsed.errMessage).toBe("");
        expect(parsed.resolved).toBe(true);
        // (b) Script ran exactly once and emitted stop:true (proves the loop
        //     body was entered and reached a normal completion, not a
        //     pre-iteration short-circuit).
        expect(existsSync(marker)).toBe(true);
        expect(parsed.outputs).toHaveLength(1);
        expect(parsed.outputs[0]).toMatchObject({ stop: true });
        // (c) No warning / error mentioning removeEventListener in stderr.
        expect(result.stderr).not.toMatch(/removeEventListener/);
        expect(result.stderr).not.toMatch(/TypeError/);
      });
    }

    // ----------------------------------------------------------------------
    // T-API-64p / T-API-64p2 / T-API-64p3 — `aborted: true` × non-compatible
    // shape. SPEC §9.3: an `options.signal` that fails the SPEC §9.5
    // compatibility contract captures no signal and does NOT enter the
    // abort-precedence pathway, regardless of `aborted`'s value. A buggy
    // implementation that read `aborted` first and routed `aborted: true`
    // through abort precedence without first verifying full signal
    // compatibility would surface an abort error here — instead the result
    // must be an option-snapshot error. T-API-64p3 closes the maxIterations:0
    // diagonal: option-shape validation is independent of iteration count
    // (must NOT be skipped under `maxIterations: 0`, and must NOT route
    // through abort precedence under any iteration count).
    // ----------------------------------------------------------------------
    interface AbortedTrueShapeVariant {
      label: string;
      duckExpr: string;
    }
    const abortedTrueShapeVariants: AbortedTrueShapeVariant[] = [
      { label: "missing-AEL", duckExpr: `{ aborted: true }` },
      {
        label: "non-callable-AEL",
        duckExpr: `{ aborted: true, addEventListener: 123 }`,
      },
      {
        label: "throwing-AEL",
        duckExpr: `{ aborted: true, addEventListener() { throw new Error("listener-register-failed"); } }`,
      },
    ];

    for (const v of abortedTrueShapeVariants) {
      it(`T-API-64p (${v.label}): run() — aborted:true × ${v.label} surfaces as option-snapshot error, not abort`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api64p-${v.label}`);
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { run } from "loopx";
const duck = ${v.duckExpr};
let synchronousThrew = false, callSiteMessage = "";
let returned;
try {
  returned = run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 1,
  });
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
let nextThrew = false, nextMessage = "", nextErrName = "", looksLikeAbort = false;
if (!synchronousThrew && returned && typeof returned.next === "function") {
  try {
    await returned.next();
  } catch (e) {
    nextThrew = true;
    nextMessage = e?.message || String(e);
    nextErrName = e?.name || "";
    looksLikeAbort = (nextErrName === "AbortError") || /^abort(ed)?$/i.test(nextMessage);
  }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, nextThrew, nextMessage, nextErrName, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) NO synchronous throw at call site.
        expect(parsed.synchronousThrew).toBe(false);
        // (b) First next() throws.
        expect(parsed.nextThrew).toBe(true);
        // (c) Error references invalid signal or wraps the per-variant
        //     exception (variant c).
        expect(parsed.nextMessage).toMatch(/(signal|listener-register-failed|AbortSignal)/i);
        // (d) NOT an abort error — even though aborted:true, the shape gate
        //     fires first and routes through option-snapshot path.
        expect(parsed.looksLikeAbort).toBe(false);
        // (e) No child spawned.
        expect(existsSync(marker)).toBe(false);
        // (f) No tmpdir created.
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
      });

      it(`T-API-64p2 (${v.label}): runPromise() — aborted:true × ${v.label} rejects with option-snapshot error, not abort`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api64p2-${v.label}`);
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { runPromise } from "loopx";
const duck = ${v.duckExpr};
let synchronousThrew = false, callSiteMessage = "";
let returned;
try {
  returned = runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 1,
  });
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
let rejected = false, rejMessage = "", rejErrName = "", looksLikeAbort = false;
if (!synchronousThrew && returned && typeof returned.then === "function") {
  try {
    await returned;
  } catch (e) {
    rejected = true;
    rejMessage = e?.message || String(e);
    rejErrName = e?.name || "";
    looksLikeAbort = (rejErrName === "AbortError") || /^abort(ed)?$/i.test(rejMessage);
  }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, rejected, rejMessage, rejErrName, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.synchronousThrew).toBe(false);
        expect(parsed.rejected).toBe(true);
        expect(parsed.rejMessage).toMatch(/(signal|listener-register-failed|AbortSignal)/i);
        expect(parsed.looksLikeAbort).toBe(false);
        expect(existsSync(marker)).toBe(false);
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
      });

      // T-API-64p3 (run-surface variant): same shape variants under
      // maxIterations:0 — option-shape validation is iteration-count-
      // independent.
      it(`T-API-64p3 (${v.label}, run): run() — aborted:true × ${v.label} × maxIterations:0 surfaces as option-snapshot error`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api64p3-${v.label}-run`);
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { run } from "loopx";
const duck = ${v.duckExpr};
let synchronousThrew = false, callSiteMessage = "";
let returned;
try {
  returned = run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 0,
  });
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
let nextThrew = false, doneSilently = false, nextMessage = "", nextErrName = "", looksLikeAbort = false;
if (!synchronousThrew && returned && typeof returned.next === "function") {
  try {
    const r = await returned.next();
    if (r && r.done === true) { doneSilently = true; }
  } catch (e) {
    nextThrew = true;
    nextMessage = e?.message || String(e);
    nextErrName = e?.name || "";
    looksLikeAbort = (nextErrName === "AbortError") || /^abort(ed)?$/i.test(nextMessage);
  }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, nextThrew, doneSilently, nextMessage, nextErrName, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) NO synchronous throw.
        expect(parsed.synchronousThrew).toBe(false);
        // (b) Did NOT silently complete with done:true (would mean
        //     option-shape validation was skipped under maxIterations:0).
        expect(parsed.doneSilently).toBe(false);
        // (c) Threw an option-snapshot error.
        expect(parsed.nextThrew).toBe(true);
        expect(parsed.nextMessage).toMatch(/(signal|listener-register-failed|AbortSignal)/i);
        // (d) NOT an abort error.
        expect(parsed.looksLikeAbort).toBe(false);
        // (e) No child spawned.
        expect(existsSync(marker)).toBe(false);
        // (f) No tmpdir created (option-shape errors fire before tmpdir
        //     creation per SPEC §7.1 step-6 ordering).
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
      });

      // T-API-64p3 (runPromise-surface variant): same shape variants under
      // maxIterations:0 on the eager-promise surface.
      it(`T-API-64p3 (${v.label}, runPromise): runPromise() — aborted:true × ${v.label} × maxIterations:0 rejects with option-snapshot error`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`api64p3-${v.label}-promise`);
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { runPromise } from "loopx";
const duck = ${v.duckExpr};
let synchronousThrew = false, callSiteMessage = "";
let returned;
try {
  returned = runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 0,
  });
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
let rejected = false, resolvedSilently = false, rejMessage = "", rejErrName = "", looksLikeAbort = false;
let resolvedValue;
if (!synchronousThrew && returned && typeof returned.then === "function") {
  try {
    resolvedValue = await returned;
    resolvedSilently = true;
  } catch (e) {
    rejected = true;
    rejMessage = e?.message || String(e);
    rejErrName = e?.name || "";
    looksLikeAbort = (rejErrName === "AbortError") || /^abort(ed)?$/i.test(rejMessage);
  }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, rejected, resolvedSilently, resolvedValue, rejMessage, rejErrName, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.synchronousThrew).toBe(false);
        // Did NOT silently resolve.
        expect(parsed.resolvedSilently).toBe(false);
        expect(parsed.rejected).toBe(true);
        expect(parsed.rejMessage).toMatch(/(signal|listener-register-failed|AbortSignal)/i);
        expect(parsed.looksLikeAbort).toBe(false);
        expect(existsSync(marker)).toBe(false);
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toHaveLength(0);
      });
    }

    // ----------------------------------------------------------------------
    // T-API-64q / T-API-64q2 — `addEventListener` returning a non-undefined
    // value is accepted. SPEC §9.5 requires "callable and returns without
    // throwing"; it does NOT require the return value to be `undefined`. A
    // buggy implementation that asserted `result === undefined` after
    // invoking addEventListener would reject conforming duck signals whose
    // addEventListener happens to return a value (string, number, the
    // listener fn itself, or any other non-undefined result).
    // ----------------------------------------------------------------------
    interface NonUndefinedReturnVariant {
      label: string;
      returnExpr: string;
    }
    const nonUndefinedReturnVariants: NonUndefinedReturnVariant[] = [
      { label: "string", returnExpr: `"registered"` },
      { label: "number", returnExpr: `123` },
      { label: "self-listener", returnExpr: `fn` },
      { label: "object", returnExpr: `{ ok: true }` },
    ];

    for (const v of nonUndefinedReturnVariants) {
      it(`T-API-64q (${v.label}): run() accepts duck signal whose addEventListener returns ${v.label}`, async () => {
        project = await createTempProject();
        const ready = join(project.dir, "ready.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `touch "${ready}"
while true; do sleep 1; done`,
        );
        const driverCode = `
import { run } from "loopx";
import { existsSync } from "node:fs";
const duck = {
  aborted: false,
  addEventListener(type, fn) {
    if (type === "abort") { this._listener = fn; }
    return ${v.returnExpr};
  },
  _fire() { this.aborted = true; this._listener?.(); }
};
let synchronousThrew = false, callSiteMessage = "";
let gen;
try {
  gen = run("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 1,
  });
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
let observed = false, message = "", errName = "", looksLikeAbort = false, scriptReachedReady = false;
if (gen) {
  const nextP = gen.next();
  nextP.catch(() => {});
  while (!existsSync(${JSON.stringify(ready)})) {
    await new Promise(r => setTimeout(r, 25));
  }
  scriptReachedReady = true;
  duck._fire();
  try { await nextP; }
  catch (e) {
    observed = true;
    message = e?.message || String(e);
    errName = e?.name || "";
    looksLikeAbort = (errName === "AbortError") || /abort/i.test(message);
  }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, scriptReachedReady, observed, message, errName, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, { timeout: 60_000 });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) NO synchronous throw — duck signal accepted at call site.
        expect(parsed.synchronousThrew).toBe(false);
        expect(parsed.callSiteMessage).toBe("");
        // (b) Script reached "ready" before the abort fired.
        expect(parsed.scriptReachedReady).toBe(true);
        // (c) Generator threw an abort error (NOT an option-shape /
        //     signal-validation error).
        expect(parsed.observed).toBe(true);
        expect(parsed.looksLikeAbort).toBe(true);
        expect(parsed.message).not.toMatch(/RunOptions\.signal/i);
      });

      it(`T-API-64q2 (${v.label}): runPromise() accepts duck signal whose addEventListener returns ${v.label}`, async () => {
        project = await createTempProject();
        const ready = join(project.dir, "ready.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `touch "${ready}"
while true; do sleep 1; done`,
        );
        const driverCode = `
import { runPromise } from "loopx";
import { existsSync } from "node:fs";
const duck = {
  aborted: false,
  addEventListener(type, fn) {
    if (type === "abort") { this._listener = fn; }
    return ${v.returnExpr};
  },
  _fire() { this.aborted = true; this._listener?.(); }
};
let synchronousThrew = false, callSiteMessage = "";
let p;
try {
  p = runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: duck,
    maxIterations: 1,
  });
} catch (e) {
  synchronousThrew = true;
  callSiteMessage = e?.message || String(e);
}
let rejected = false, message = "", errName = "", looksLikeAbort = false, scriptReachedReady = false;
if (p) {
  while (!existsSync(${JSON.stringify(ready)})) {
    await new Promise(r => setTimeout(r, 25));
  }
  scriptReachedReady = true;
  duck._fire();
  try { await p; }
  catch (e) {
    rejected = true;
    message = e?.message || String(e);
    errName = e?.name || "";
    looksLikeAbort = (errName === "AbortError") || /abort/i.test(message);
  }
}
console.log(JSON.stringify({ synchronousThrew, callSiteMessage, scriptReachedReady, rejected, message, errName, looksLikeAbort }));
`;
        const result = await runAPIDriver(runtime, driverCode, { timeout: 60_000 });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.synchronousThrew).toBe(false);
        expect(parsed.callSiteMessage).toBe("");
        expect(parsed.scriptReachedReady).toBe(true);
        expect(parsed.rejected).toBe(true);
        expect(parsed.looksLikeAbort).toBe(true);
        expect(parsed.message).not.toMatch(/RunOptions\.signal/i);
      });
    }
  });
});

// ═════════════════════════════════════════════════════════════
// §4.9.x — Abort Precedence over Pre-Iteration Failures
// (T-API-65 series; SPEC §9.3 / §9.5 / §9.1 / §9.2)
// ═════════════════════════════════════════════════════════════
//
// SPEC §9.3 "Abort precedence over pre-iteration failures": Once a usable
// AbortSignal has been captured (a real AbortSignal or a duck-typed signal
// that satisfies the §9.5 contract), an already-aborted signal at call time
// (or one that aborts during pre-iteration before the first child spawn)
// displaces all other pre-iteration failure modes on the same call:
// captured option-snapshot errors, target argument / target syntax
// validation, .loopx/ discovery, env-file loading, target resolution, and
// tmpdir creation.
//
// Carve-outs explicitly excluded by SPEC §9.3:
//   - "An invalid options value or non-AbortSignal-compatible options.signal
//     captures no signal and does not enter this pathway."
//
// Coverage in this block (foundational subset of T-API-65 series):
//   T-API-65   runPromise + pre-aborted + missing envFile → abort error
//   T-API-65a  runPromise + pre-aborted + invalid target  → abort error
//   T-API-65b  runPromise + pre-aborted + missing .loopx/ → abort error
//   T-API-65d  runPromise + pre-aborted + tmpdir creation fail → abort error
//   T-API-65e  run        + invalid signal shape + missing envFile → NOT abort
//   T-API-65f  run        + pre-aborted + throwing later-option getter → abort error
//   T-API-65g  runPromise + pre-aborted + throwing later-option getter → abort error
//   T-API-65k  run        + pre-aborted + missing envFile → abort error
//   T-API-65l  run        + pre-aborted + invalid target  → abort error
//   T-API-65m  run        + pre-aborted + missing .loopx/ → abort error
//   T-API-65n  run        + pre-aborted + tmpdir creation fail → abort error
//
// All abort-path tests additionally verify (per SPEC §7.4):
//   (b) no child was spawned (marker file absent)
//   (c) no `loopx-*` tmpdir created under the test-isolated TMPDIR parent
//
// The cleanup-residue assertion is scoped to a per-test-isolated TMPDIR
// parent (mkdtemp-based) per TEST-SPEC §4.7 isolation guidance — concurrent
// test workers must not race on /tmp for `loopx-*` entries.

describe("SPEC: Abort Precedence over Pre-Iteration Failures", () => {
  let project: TempProject | null = null;
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
    for (const cleanup of cleanups.splice(0)) {
      await cleanup().catch(() => {});
    }
  });

  // Creates a writable test-isolated TMPDIR parent under the system tmpdir.
  async function makeIsolatedTmpdirParent(label: string): Promise<string> {
    const dir = await mkdtemp(join(osTmpdir(), `loopx-test-${label}-`));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    });
    return dir;
  }

  // List `loopx-*` entries directly under `parent`, filtering implementation-
  // internal helpers (per AGENT.md / SPEC §7.4).
  function listLoopxEntries(parent: string): string[] {
    try {
      return readdirSync(parent)
        .filter((e) => e.startsWith("loopx-"))
        .filter(
          (e) =>
            !e.startsWith("loopx-nodepath-shim-") &&
            !e.startsWith("loopx-bun-jsx-") &&
            !e.startsWith("loopx-install-") &&
            !e.startsWith("loopx-test-"),
        );
    } catch {
      return [];
    }
  }

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-65: runPromise() — pre-aborted signal beats missing env-file.
    // SPEC §9.3, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-65: runPromise() pre-aborted signal beats missing env-file", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api65v");
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { runPromise } from "loopx";
const c = new AbortController();
c.abort();
let rejected = false, message = "", name = "";
try {
  await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: c.signal,
    envFile: "nonexistent.env",
    maxIterations: 1,
  });
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ rejected, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Promise rejected with the abort error, not the env-file error.
      expect(parsed.rejected).toBe(true);
      expect(
        parsed.name === "AbortError" || /abort/i.test(parsed.message),
      ).toBe(true);
      expect(parsed.message).not.toMatch(/nonexistent\.env|envFile|env file|ENOENT/i);
      // (b) Workflow script did not run.
      expect(existsSync(marker)).toBe(false);
      // (c) No loopx-* tmpdir was created under the isolated parent.
      const after = listLoopxEntries(tmpdirParent);
      expect(after.filter((e) => !before.includes(e))).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-65a: runPromise() — pre-aborted signal beats invalid target.
    // SPEC §9.3, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-65a: runPromise() pre-aborted signal beats invalid target", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api65a");

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { runPromise } from "loopx";
const c = new AbortController();
c.abort();
let rejected = false, message = "", name = "";
try {
  await runPromise(":bad", {
    cwd: ${JSON.stringify(project.dir)},
    signal: c.signal,
    maxIterations: 1,
  });
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ rejected, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Promise rejected with the abort error, not invalid-target.
      expect(parsed.rejected).toBe(true);
      expect(
        parsed.name === "AbortError" || /abort/i.test(parsed.message),
      ).toBe(true);
      expect(parsed.message).not.toMatch(/invalid.*target|target.*syntax|:bad/i);
      // (c) No loopx-* tmpdir was created under the isolated parent.
      const after = listLoopxEntries(tmpdirParent);
      expect(after.filter((e) => !before.includes(e))).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-65b: runPromise() — pre-aborted signal beats missing .loopx/
    // discovery failure. SPEC §9.3, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-65b: runPromise() pre-aborted signal beats missing .loopx/ discovery", async () => {
      project = await createTempProject({ withLoopxDir: false });
      const tmpdirParent = await makeIsolatedTmpdirParent("api65b");

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { runPromise } from "loopx";
const c = new AbortController();
c.abort();
let rejected = false, message = "", name = "";
try {
  await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: c.signal,
    maxIterations: 1,
  });
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ rejected, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Promise rejected with the abort error, not the discovery error.
      expect(parsed.rejected).toBe(true);
      expect(
        parsed.name === "AbortError" || /abort/i.test(parsed.message),
      ).toBe(true);
      expect(parsed.message).not.toMatch(/\.loopx|discover|no.*such.*directory/i);
      // (c) No loopx-* tmpdir was created under the isolated parent.
      const after = listLoopxEntries(tmpdirParent);
      expect(after.filter((e) => !before.includes(e))).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-65d: runPromise() — pre-aborted signal beats tmpdir-creation
    // failure. SPEC §9.3, §9.5, §7.4.
    //
    // Skipped under root: chmod 0500 does not block writes for uid 0.
    // ------------------------------------------------------------------------
    it.skipIf(IS_ROOT)(
      "T-API-65d: runPromise() pre-aborted signal beats tmpdir-creation failure",
      async () => {
        project = await createTempProject();
        const unwritableParent = await mkdtemp(
          join(osTmpdir(), "loopx-test-api65d-unwritable-"),
        );
        const marker = join(project.dir, "child-ran.txt");
        cleanups.push(async () => {
          await chmod(unwritableParent, 0o700).catch(() => {});
          await rm(unwritableParent, { recursive: true, force: true }).catch(
            () => {},
          );
        });
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        await chmod(unwritableParent, 0o500);

        const before = listLoopxEntries(unwritableParent);
        const driverCode = `
import { runPromise } from "loopx";
const c = new AbortController();
c.abort();
let rejected = false, message = "", name = "";
try {
  await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: c.signal,
    maxIterations: 1,
  });
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ rejected, message, name }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: unwritableParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) Promise rejected with abort error, not tmpdir-creation error.
        expect(parsed.rejected).toBe(true);
        expect(
          parsed.name === "AbortError" || /abort/i.test(parsed.message),
        ).toBe(true);
        expect(parsed.message).not.toMatch(/EACCES|mkdtemp|tmpdir.*creat/i);
        // (b) Workflow script did not run.
        expect(existsSync(marker)).toBe(false);
        // (c) No loopx-* tmpdir was created under the unwritable parent.
        const after = listLoopxEntries(unwritableParent);
        expect(after.filter((e) => !before.includes(e))).toEqual([]);
      },
    );

    // ------------------------------------------------------------------------
    // T-API-65e: run() — invalid options.signal shape does NOT enter the
    // abort pathway. The error must reference the invalid signal shape (or
    // the missing env file — impl-defined ordering between those two), but
    // NOT be an abort error. SPEC §9.3, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-65e: run() invalid signal shape does not enter abort pathway", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api65e");
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { run } from "loopx";
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  signal: "not-a-signal",
  envFile: "nonexistent.env",
  maxIterations: 1,
});
let threw = false, message = "", name = "", looksLikeAbort = false;
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
  // Anchored "abort"/"aborted" word match avoids matching the SPEC-mandated
  // shape error message "must be an AbortSignal-compatible object" (which
  // naturally contains the substring "Abort"). The default abort error has
  // name === "AbortError" and message "The operation was aborted." — both
  // captured by this guard.
  looksLikeAbort = (name === "AbortError") || /\\babort(ed)?\\b/i.test(message);
}
console.log(JSON.stringify({ threw, message, name, looksLikeAbort }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) The error surfaces (not the abort path).
      expect(parsed.threw).toBe(true);
      // (b) The surfaced error is NOT an abort error — SPEC §9.3 carve-out
      //     rules out abort precedence for non-AbortSignal-compatible signal.
      expect(parsed.looksLikeAbort).toBe(false);
      // The error message should reference the invalid signal shape OR the
      //   missing env-file path (impl-defined ordering between those two).
      expect(parsed.message).toMatch(
        /signal|RunOptions|nonexistent\.env|envFile|env file|ENOENT/i,
      );
      // (c) No child was spawned.
      expect(existsSync(marker)).toBe(false);
      // (d) No loopx-* tmpdir was created under the isolated parent.
      const after = listLoopxEntries(tmpdirParent);
      expect(after.filter((e) => !before.includes(e))).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-65k: run() — pre-aborted signal beats missing env-file.
    // Generator-surface counterpart to T-API-65. SPEC §9.3, §9.5, §9.1.
    // ------------------------------------------------------------------------
    it("T-API-65k: run() pre-aborted signal beats missing env-file", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api65k");
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { run } from "loopx";
const c = new AbortController();
c.abort();
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  signal: c.signal,
  envFile: "nonexistent.env",
  maxIterations: 1,
});
let threw = false, message = "", name = "";
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ threw, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) First next() throws abort error, not env-file error.
      expect(parsed.threw).toBe(true);
      expect(
        parsed.name === "AbortError" || /abort/i.test(parsed.message),
      ).toBe(true);
      expect(parsed.message).not.toMatch(/nonexistent\.env|envFile|env file|ENOENT/i);
      // (b) Workflow script did not run.
      expect(existsSync(marker)).toBe(false);
      // (c) No loopx-* tmpdir was created.
      const after = listLoopxEntries(tmpdirParent);
      expect(after.filter((e) => !before.includes(e))).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-65l: run() — pre-aborted signal beats invalid target.
    // Generator-surface counterpart to T-API-65a. SPEC §9.3, §9.5, §9.1.
    // ------------------------------------------------------------------------
    it("T-API-65l: run() pre-aborted signal beats invalid target", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api65l");

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { run } from "loopx";
const c = new AbortController();
c.abort();
const gen = run(":bad", {
  cwd: ${JSON.stringify(project.dir)},
  signal: c.signal,
  maxIterations: 1,
});
let threw = false, message = "", name = "";
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ threw, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) First next() throws abort error, not invalid-target error.
      expect(parsed.threw).toBe(true);
      expect(
        parsed.name === "AbortError" || /abort/i.test(parsed.message),
      ).toBe(true);
      expect(parsed.message).not.toMatch(/invalid.*target|target.*syntax|:bad/i);
      // (c) No loopx-* tmpdir was created.
      const after = listLoopxEntries(tmpdirParent);
      expect(after.filter((e) => !before.includes(e))).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-65m: run() — pre-aborted signal beats missing .loopx/ discovery.
    // Generator-surface counterpart to T-API-65b. SPEC §9.3, §9.5, §9.1.
    // ------------------------------------------------------------------------
    it("T-API-65m: run() pre-aborted signal beats missing .loopx/ discovery", async () => {
      project = await createTempProject({ withLoopxDir: false });
      const tmpdirParent = await makeIsolatedTmpdirParent("api65m");

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { run } from "loopx";
const c = new AbortController();
c.abort();
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  signal: c.signal,
  maxIterations: 1,
});
let threw = false, message = "", name = "";
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ threw, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) First next() throws abort error, not discovery error.
      expect(parsed.threw).toBe(true);
      expect(
        parsed.name === "AbortError" || /abort/i.test(parsed.message),
      ).toBe(true);
      expect(parsed.message).not.toMatch(/\.loopx|discover|no.*such.*directory/i);
      // (c) No loopx-* tmpdir was created.
      const after = listLoopxEntries(tmpdirParent);
      expect(after.filter((e) => !before.includes(e))).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-65n: run() — pre-aborted signal beats tmpdir-creation failure.
    // Generator-surface counterpart to T-API-65d. SPEC §9.3, §9.5, §9.1, §7.4.
    // ------------------------------------------------------------------------
    it.skipIf(IS_ROOT)(
      "T-API-65n: run() pre-aborted signal beats tmpdir-creation failure",
      async () => {
        project = await createTempProject();
        const unwritableParent = await mkdtemp(
          join(osTmpdir(), "loopx-test-api65n-unwritable-"),
        );
        const marker = join(project.dir, "child-ran.txt");
        cleanups.push(async () => {
          await chmod(unwritableParent, 0o700).catch(() => {});
          await rm(unwritableParent, { recursive: true, force: true }).catch(
            () => {},
          );
        });
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );
        await chmod(unwritableParent, 0o500);

        const before = listLoopxEntries(unwritableParent);
        const driverCode = `
import { run } from "loopx";
const c = new AbortController();
c.abort();
const gen = run("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  signal: c.signal,
  maxIterations: 1,
});
let threw = false, message = "", name = "";
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ threw, message, name }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: unwritableParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) First next() throws abort error, not tmpdir-creation error.
        expect(parsed.threw).toBe(true);
        expect(
          parsed.name === "AbortError" || /abort/i.test(parsed.message),
        ).toBe(true);
        expect(parsed.message).not.toMatch(/EACCES|mkdtemp|tmpdir.*creat/i);
        // (b) Workflow script did not run.
        expect(existsSync(marker)).toBe(false);
        // (c) No loopx-* tmpdir was created under the unwritable parent.
        const after = listLoopxEntries(unwritableParent);
        expect(after.filter((e) => !before.includes(e))).toEqual([]);
      },
    );

    // ------------------------------------------------------------------------
    // T-API-65f: run() — pre-aborted signal beats a throwing later-option
    // getter. SPEC §9.1 / §9.5 specify that `options.signal` is read FIRST
    // before any other option field, so an already-aborted signal is captured
    // before any subsequent option-field read can produce a snapshot
    // exception. SPEC §9.3 then displaces the captured option-snapshot error
    // (in this case, a throwing `env` getter) with the abort error.
    //
    // A buggy implementation that read `options.env` before `options.signal`
    // would surface the env-getter exception ("env-getter-boom") instead and
    // fail this test. This directly exercises the "signal first" rule rather
    // than merely inferring it from the abort-vs-other-pre-iteration-failure
    // precedence tests (T-API-65 / 65a / 65b / 65d / 65k / 65l / 65m / 65n).
    // SPEC §9.1, §9.3, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-65f: run() pre-aborted signal beats throwing later-option getter", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api65f");
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { run } from "loopx";
const c = new AbortController();
c.abort();
const throwingOpts = {
  cwd: ${JSON.stringify(project.dir)},
  signal: c.signal,
  get env() { throw new Error("env-getter-boom"); },
  maxIterations: 1,
};
const gen = run("ralph", throwingOpts);
let threw = false, message = "", name = "";
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ threw, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) First next() throws abort error, not the env-getter-boom error.
      expect(parsed.threw).toBe(true);
      expect(
        parsed.name === "AbortError" || /abort/i.test(parsed.message),
      ).toBe(true);
      expect(parsed.message).not.toMatch(/env-getter-boom/);
      // (b) Workflow script did not run.
      expect(existsSync(marker)).toBe(false);
      // (c) No loopx-* tmpdir was created.
      const after = listLoopxEntries(tmpdirParent);
      expect(after.filter((e) => !before.includes(e))).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-65g: runPromise() — pre-aborted signal beats a throwing
    // later-option getter. Promise-surface counterpart to T-API-65f.
    // Per SPEC §9.2 "Option-snapshot timing" ("Identical to run(): each
    // option field read at most once, options.signal first"), the same
    // signal-first rule holds under runPromise(). SPEC §9.2, §9.3, §9.5.
    // ------------------------------------------------------------------------
    it("T-API-65g: runPromise() pre-aborted signal beats throwing later-option getter", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api65g");
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { runPromise } from "loopx";
const c = new AbortController();
c.abort();
const throwingOpts = {
  cwd: ${JSON.stringify(project.dir)},
  signal: c.signal,
  get env() { throw new Error("env-getter-boom"); },
  maxIterations: 1,
};
let rejected = false, message = "", name = "";
try {
  await runPromise("ralph", throwingOpts);
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ rejected, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Promise rejected with abort error, not the env-getter-boom error.
      expect(parsed.rejected).toBe(true);
      expect(
        parsed.name === "AbortError" || /abort/i.test(parsed.message),
      ).toBe(true);
      expect(parsed.message).not.toMatch(/env-getter-boom/);
      // (b) Workflow script did not run.
      expect(existsSync(marker)).toBe(false);
      // (c) No loopx-* tmpdir was created.
      const after = listLoopxEntries(tmpdirParent);
      expect(after.filter((e) => !before.includes(e))).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-65a2 (i)–(iii): pre-aborted signal beats NON-STRING target
    // arguments. SPEC §9.3 / §9.5 / §9.1 / §9.2.
    //
    // T-API-65a / T-API-65l cover the target-syntax branch (invalid string
    // ":bad"); this test covers the target-argument branch — non-string
    // target values per SPEC §9.1 ("runtime-invalid `target` values
    // (e.g., `undefined`, `null`, `42`, or any non-string) are rejected
    // lazily"). Together they close both target-argument-validation
    // sub-branches under SPEC §9.3's "target argument / target syntax
    // validation" displacement.
    //
    // Variants: (i) target = undefined, (ii) target = null, (iii) target = 42.
    // Each variant runs on both surfaces — runPromise() (eager-snapshot
    // surface per SPEC §9.2) and run() (lazy-on-first-next() surface per
    // SPEC §9.1) — so a buggy implementation that routed only one surface's
    // non-string-target rejection through the abort-precedence pathway
    // (e.g., honored precedence in run() but not runPromise(), or vice
    // versa) would pass the same-target tests on the conforming surface yet
    // fail on the non-conforming surface.
    //
    // A buggy implementation that routed target-syntax validation
    // (parseTarget on the captured string) through the abort-precedence
    // pathway but rejected non-string targets via a separate eager
    // type-check (e.g., a synchronous `typeof target !== "string"` guard at
    // the call site that escaped the captured-error path) would pass
    // T-API-65a / T-API-65l yet fail this test.
    //
    // The fixture creates a valid `.loopx/ralph/index.sh` workflow that
    // would write a marker if it ever ran — even though `undefined` /
    // `null` / `42` can never resolve to "ralph", the marker check (b) is
    // a belt-and-suspenders sanity net against an impl that somehow
    // routes the call past target validation despite the non-string input.
    // ------------------------------------------------------------------------
    for (const variant of [
      { id: "i", label: "undefined", expr: "undefined" },
      { id: "ii", label: "null", expr: "null" },
      { id: "iii", label: "numeric (42)", expr: "42" },
    ]) {
      it(`T-API-65a2 (${variant.id} ${variant.label}): runPromise() pre-aborted signal beats non-string target ${variant.expr}`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(
          `api65a2-promise-${variant.id}`,
        );
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );

        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { runPromise } from "loopx";
const c = new AbortController();
c.abort();
let rejected = false, message = "", name = "";
try {
  await runPromise(${variant.expr} as any, {
    cwd: ${JSON.stringify(project.dir)},
    signal: c.signal,
    maxIterations: 1,
  });
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ rejected, message, name }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) Promise rejected with abort error, not non-string-target error.
        expect(parsed.rejected).toBe(true);
        expect(
          parsed.name === "AbortError" || /abort/i.test(parsed.message),
        ).toBe(true);
        expect(parsed.message).not.toMatch(
          /target is required|must be a string|invalid.*target|target.*syntax/i,
        );
        // (b) Workflow script did not run.
        expect(existsSync(marker)).toBe(false);
        // (c) No loopx-* tmpdir was created.
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toEqual([]);
      });

      it(`T-API-65a2 (${variant.id} ${variant.label}): run() pre-aborted signal beats non-string target ${variant.expr}`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(
          `api65a2-run-${variant.id}`,
        );
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );

        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { run } from "loopx";
const c = new AbortController();
c.abort();
const gen = run(${variant.expr} as any, {
  cwd: ${JSON.stringify(project.dir)},
  signal: c.signal,
  maxIterations: 1,
});
let threw = false, message = "", name = "";
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ threw, message, name }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) First next() throws abort error, not non-string-target error.
        expect(parsed.threw).toBe(true);
        expect(
          parsed.name === "AbortError" || /abort/i.test(parsed.message),
        ).toBe(true);
        expect(parsed.message).not.toMatch(
          /target is required|must be a string|invalid.*target|target.*syntax/i,
        );
        // (b) Workflow script did not run.
        expect(existsSync(marker)).toBe(false);
        // (c) No loopx-* tmpdir was created.
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toEqual([]);
      });
    }

    // ------------------------------------------------------------------------
    // T-API-65h: runPromise() — pre-aborted signal beats target-resolution
    // failure (missing workflow). SPEC §9.3 / §9.5 / §7.1.
    //
    // SPEC §9.3 enumerates "target resolution" as one of the displaced
    // pre-iteration failure modes. SPEC §7.1 step 3 enumerates target
    // resolution sub-paths: missing workflow, missing script in existing
    // workflow, and missing default entry point. T-API-65 covers env-file
    // failure; T-API-65b covers `.loopx/` discovery failure; this test
    // closes the missing-workflow branch — a distinct failure category per
    // SPEC §7.1 step 3 that existing abort-precedence tests do not exercise
    // directly.
    //
    // Setup: `.loopx/ralph/index.sh` (valid). Target a workflow that does
    // not exist. The error path comes from runInternal's workflow lookup
    // at run.ts:700 (`Workflow 'X' not found in .loopx/`).
    //
    // A buggy implementation that routed pre-aborted-signal precedence
    // through env-file / discovery / target-syntax checks but bypassed
    // abort-precedence on the workflow-lookup path would surface the
    // missing-workflow error instead and fail (a).
    // ------------------------------------------------------------------------
    it("T-API-65h: runPromise() pre-aborted signal beats missing workflow", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api65h");
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { runPromise } from "loopx";
const c = new AbortController();
c.abort();
let rejected = false, message = "", name = "";
try {
  await runPromise("nonexistent-workflow", {
    cwd: ${JSON.stringify(project.dir)},
    signal: c.signal,
    maxIterations: 1,
  });
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ rejected, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Promise rejected with abort error, not missing-workflow error.
      expect(parsed.rejected).toBe(true);
      expect(
        parsed.name === "AbortError" || /abort/i.test(parsed.message),
      ).toBe(true);
      expect(parsed.message).not.toMatch(
        /workflow.*not.*found|not.*found.*workflow|nonexistent-workflow/i,
      );
      // (b) Workflow script did not run.
      expect(existsSync(marker)).toBe(false);
      // (c) No loopx-* tmpdir was created.
      const after = listLoopxEntries(tmpdirParent);
      expect(after.filter((e) => !before.includes(e))).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-65i: runPromise() — pre-aborted signal beats target-resolution
    // failure (missing script in existing workflow). SPEC §9.3 / §9.5 /
    // §7.1 / §4.1.
    //
    // Missing-script counterpart to T-API-65h (missing workflow). SPEC §7.1
    // step 3 enumerates missing workflow and missing script as distinct
    // target-resolution sub-paths, and SPEC §9.3's abort-precedence rule
    // must cover both.
    //
    // Setup: `.loopx/ralph/index.sh` (valid, `index` present) but no
    // `check` script. Target `ralph:check`. The error path comes from
    // runInternal's script lookup at run.ts:719-724 (`Script 'X' not found
    // in workflow 'Y'`).
    // ------------------------------------------------------------------------
    it("T-API-65i: runPromise() pre-aborted signal beats missing script in existing workflow", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api65i");
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { runPromise } from "loopx";
const c = new AbortController();
c.abort();
let rejected = false, message = "", name = "";
try {
  await runPromise("ralph:check", {
    cwd: ${JSON.stringify(project.dir)},
    signal: c.signal,
    maxIterations: 1,
  });
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ rejected, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Promise rejected with abort error, not missing-script error.
      expect(parsed.rejected).toBe(true);
      expect(
        parsed.name === "AbortError" || /abort/i.test(parsed.message),
      ).toBe(true);
      expect(parsed.message).not.toMatch(
        /script.*not.*found|not.*found.*script|'check'/i,
      );
      // (b) Workflow script did not run.
      expect(existsSync(marker)).toBe(false);
      // (c) No loopx-* tmpdir was created.
      const after = listLoopxEntries(tmpdirParent);
      expect(after.filter((e) => !before.includes(e))).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-65j: runPromise() — pre-aborted signal beats target-resolution
    // failure (missing default entry point — workflow has scripts but no
    // `index`). SPEC §9.3 / §9.5 / §7.1 / §4.1 / §2.1.
    //
    // Missing-default-entry-point counterpart to T-API-65h (missing
    // workflow) and T-API-65i (missing script under qualified target).
    // The bare target `"ralph"` resolves to `ralph:index`, which fails
    // with a distinct error path when no `index.*` exists. SPEC §7.1
    // step 3 enumerates this as the third sub-path of target resolution.
    //
    // Setup: `.loopx/ralph/check.sh` only (no `index.*`). Target `"ralph"`.
    // The error path comes from runInternal's index-presence check at
    // run.ts:708-713 (`Workflow 'X' has no default entry point ('index'
    // script)`).
    //
    // Together T-API-65h/65i/65j pin abort-precedence across all three
    // SPEC §7.1 step 3 target-resolution sub-paths on the runPromise()
    // surface.
    // ------------------------------------------------------------------------
    it("T-API-65j: runPromise() pre-aborted signal beats missing default entry point", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("api65j");
      const marker = join(project.dir, "child-ran.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "check",
        `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { runPromise } from "loopx";
const c = new AbortController();
c.abort();
let rejected = false, message = "", name = "";
try {
  await runPromise("ralph", {
    cwd: ${JSON.stringify(project.dir)},
    signal: c.signal,
    maxIterations: 1,
  });
} catch (e) {
  rejected = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ rejected, message, name }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // (a) Promise rejected with abort error, not missing-default-entry error.
      expect(parsed.rejected).toBe(true);
      expect(
        parsed.name === "AbortError" || /abort/i.test(parsed.message),
      ).toBe(true);
      expect(parsed.message).not.toMatch(
        /default entry|no.*index|index.*script/i,
      );
      // (b) Workflow script did not run.
      expect(existsSync(marker)).toBe(false);
      // (c) No loopx-* tmpdir was created.
      const after = listLoopxEntries(tmpdirParent);
      expect(after.filter((e) => !before.includes(e))).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // T-API-65o: run() — pre-aborted signal beats target-resolution
    // failures. Generator-surface counterpart to T-API-65h / 65i / 65j.
    // SPEC §9.3 / §9.5 / §9.1 / §7.1.
    //
    // Parameterized over the three target-resolution sub-paths enumerated
    // in SPEC §7.1 step 3:
    //   (a) missing workflow            (counterpart to T-API-65h)
    //   (b) missing script              (counterpart to T-API-65i)
    //   (c) missing default entry point (counterpart to T-API-65j)
    //
    // For each fixture, assert the first next() throws the abort error,
    // not the target-resolution error.
    // ------------------------------------------------------------------------
    for (const variant of [
      {
        id: "a",
        label: "missing workflow",
        targetExpr: '"nonexistent-workflow"',
        scriptName: "index",
        notMatch: /workflow.*not.*found|not.*found.*workflow|nonexistent-workflow/i,
      },
      {
        id: "b",
        label: "missing script",
        targetExpr: '"ralph:check"',
        scriptName: "index",
        notMatch: /script.*not.*found|not.*found.*script|'check'/i,
      },
      {
        id: "c",
        label: "missing default entry point",
        targetExpr: '"ralph"',
        scriptName: "check",
        notMatch: /default entry|no.*index|index.*script/i,
      },
    ]) {
      it(`T-API-65o (${variant.id} ${variant.label}): run() pre-aborted signal beats target-resolution failure`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(
          `api65o-${variant.id}`,
        );
        const marker = join(project.dir, "child-ran.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          variant.scriptName,
          `printf 'spawned' > "${marker}"
printf '{"stop":true}'`,
        );

        const before = listLoopxEntries(tmpdirParent);
        const driverCode = `
import { run } from "loopx";
const c = new AbortController();
c.abort();
const gen = run(${variant.targetExpr}, {
  cwd: ${JSON.stringify(project.dir)},
  signal: c.signal,
  maxIterations: 1,
});
let threw = false, message = "", name = "";
try {
  await gen.next();
} catch (e) {
  threw = true;
  message = e && e.message ? e.message : String(e);
  name = e && e.name ? e.name : "";
}
console.log(JSON.stringify({ threw, message, name }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent },
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // (a) First next() threw abort error, not target-resolution error.
        expect(parsed.threw).toBe(true);
        expect(
          parsed.name === "AbortError" || /abort/i.test(parsed.message),
        ).toBe(true);
        expect(parsed.message).not.toMatch(variant.notMatch);
        // (b) Workflow script did not run.
        expect(existsSync(marker)).toBe(false);
        // (c) No loopx-* tmpdir was created.
        const after = listLoopxEntries(tmpdirParent);
        expect(after.filter((e) => !before.includes(e))).toEqual([]);
      });
    }
  });
});
