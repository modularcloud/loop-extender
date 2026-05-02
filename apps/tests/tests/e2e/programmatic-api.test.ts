import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir as osTmpdir } from "node:os";
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
