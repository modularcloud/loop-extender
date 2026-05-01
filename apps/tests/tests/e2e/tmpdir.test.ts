import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  createTempProject,
  createWorkflow,
  createWorkflowScript,
  createBashWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { forEachRuntime } from "../helpers/runtime.js";

// ============================================================================
// TEST-SPEC §4.7 — LOOPX_TMPDIR (run-scoped temporary directory)
// Spec refs: 7.1, 7.2, 7.3, 7.4, 8.3, 9.1, 9.2, 9.3, 9.5, 13 (and ADR-0004 §1)
//
// LOOPX_TMPDIR is the absolute path of a per-run temp directory created
// before the first child spawn and removed on every terminal outcome that
// reaches creation. It is a script-protocol-protected variable: silently
// overrides any user-supplied value at every lower §8.3 tier.
// ============================================================================

const extraCleanups: Array<() => Promise<void>> = [];

const IS_ROOT = process.getuid?.() === 0;

/**
 * Programmatic surfaces over which T-TMP-12 sub-cases are parameterized.
 * SPEC §9.1 / §9.2 give different snapshot timing for the two surfaces
 * (lazy first-next() under run(), eager call-site under runPromise()),
 * but the no-tmpdir-creation contract is identical, so each sub-case is
 * exercised on both surfaces with the same fixture and snapshot harness.
 */
const SURFACES = ["runPromise", "run"] as const;
type Surface = (typeof SURFACES)[number];

/**
 * Builds a driver script that snapshots `parent` for `loopx-*` entries
 * before and after invoking `callExpr` on the given programmatic surface,
 * captures any rejection / first-next() throw, and prints a JSON envelope
 * to stdout.
 */
function noTmpdirDriver(args: {
  surface: Surface;
  parent: string;
  preamble?: string;
  callExpr: string;
}): string {
  const callBlock =
    args.surface === "runPromise"
      ? `try { await ${args.callExpr}; } catch (__e) { caught = true; errMsg = __e instanceof Error ? __e.message : String(__e); errName = __e instanceof Error ? (__e.name || "") : ""; }`
      : `try { const __gen = ${args.callExpr}; await __gen.next(); } catch (__e) { caught = true; errMsg = __e instanceof Error ? __e.message : String(__e); errName = __e instanceof Error ? (__e.name || "") : ""; }`;
  return `
import { run, runPromise } from "loopx";
import { readdirSync } from "node:fs";
const parent = ${JSON.stringify(args.parent)};
function snap() {
  try {
    return readdirSync(parent)
      .filter((e) => e.startsWith("loopx-"))
      .filter(
        (e) =>
          !e.startsWith("loopx-nodepath-shim-") &&
          !e.startsWith("loopx-bun-jsx-") &&
          !e.startsWith("loopx-install-"),
      );
  } catch { return []; }
}
${args.preamble ?? ""}
const before = snap();
let caught = false;
let errMsg = "";
let errName = "";
${callBlock}
const after = snap();
console.log(JSON.stringify({ caught, errMsg, errName, before, after }));
`;
}

/**
 * Runs a driver that exercises a pre-iteration failure mode and asserts
 * (a) the call rejected / threw, (b) the optional error-message regex
 * matched, and (c) no new `loopx-*` entry appeared under the test-isolated
 * tmpdir parent during the call.
 */
async function assertNoTmpdirCreated(args: {
  runtime: "node" | "bun";
  surface: Surface;
  parent: string;
  preamble?: string;
  callExpr: string;
  expectErrMatch?: RegExp;
  extraEnv?: Record<string, string>;
}) {
  const driverCode = noTmpdirDriver({
    surface: args.surface,
    parent: args.parent,
    preamble: args.preamble,
    callExpr: args.callExpr,
  });
  const result = await runAPIDriver(args.runtime, driverCode, {
    env: { TMPDIR: args.parent, ...(args.extraEnv ?? {}) },
  });
  expect(result.exitCode).toBe(0);
  const data = JSON.parse(result.stdout) as {
    caught: boolean;
    errMsg: string;
    errName: string;
    before: string[];
    after: string[];
  };
  expect(data.caught).toBe(true);
  if (args.expectErrMatch) {
    expect(data.errMsg).toMatch(args.expectErrMatch);
  }
  expect(data.after.slice().sort()).toEqual(data.before.slice().sort());
}

/**
 * Creates a per-test isolated TMPDIR parent directory and pairs it with a
 * project. Tests must inject the parent as `TMPDIR` on loopx's inherited
 * environment so that `os.tmpdir()` evaluated by loopx resolves to this
 * parent — preventing concurrent test workers from racing on the shared
 * default tmpdir parent (typically `/tmp`).
 */
async function setupTmpdirTest(opts: { withLoopxDir?: boolean } = {}) {
  const project = await createTempProject(opts);
  const tmpdirParent = await mkdtemp(join(tmpdir(), "loopx-test-parent-"));
  const cleanup = async () => {
    await project.cleanup().catch(() => {});
    await rm(tmpdirParent, { recursive: true, force: true }).catch(() => {});
  };
  extraCleanups.push(cleanup);
  return { project, tmpdirParent };
}

/**
 * List `loopx-*` entries directly under `parent`, excluding implementation-
 * internal helpers (`loopx-nodepath-shim-<pid>`, `loopx-bun-jsx-<pid>`,
 * `loopx-install-src-…`, `loopx-install-stage-…`) — none of which are
 * `LOOPX_TMPDIR` per SPEC §7.4.
 */
function listLoopxEntries(parent: string): string[] {
  try {
    return readdirSync(parent)
      .filter((e) => e.startsWith("loopx-"))
      .filter(
        (e) =>
          !e.startsWith("loopx-nodepath-shim-") &&
          !e.startsWith("loopx-bun-jsx-") &&
          !e.startsWith("loopx-install-"),
      );
  } catch {
    return [];
  }
}

describe("TEST-SPEC §4.7 LOOPX_TMPDIR", () => {
  afterEach(async () => {
    for (const cleanup of extraCleanups.splice(0)) {
      await cleanup().catch(() => {});
    }
  });

  // ==========================================================================
  // Creation and Scope (T-TMP-01..09)
  // ==========================================================================

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-TMP-01: Created once per run; injected into every script spawn.
    // ------------------------------------------------------------------------
    it("T-TMP-01: LOOPX_TMPDIR is created once per run and injected into every script", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirLog = join(project.dir, "tmpdir.log");
      const statLog = join(project.dir, "stat.log");
      const iterCounter = join(project.dir, "iter.counter");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
ITER=$(cat "${iterCounter}" 2>/dev/null || echo 0)
ITER=$((ITER + 1))
printf '%s' "$ITER" > "${iterCounter}"
printf '%s\\n' "$LOOPX_TMPDIR" >> "${tmpdirLog}"
if [ -d "$LOOPX_TMPDIR" ]; then
  printf '%s\\n' "exists-as-dir" >> "${statLog}"
else
  printf '%s\\n' "missing" >> "${statLog}"
fi
if [ "$ITER" -ge 2 ]; then
  printf '{"stop":true}'
else
  printf '{"result":"iter-%s"}' "$ITER"
fi
`,
      );

      const result = await runCLI(["run", "-n", "5", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);

      const tmpdirLines = readFileSync(tmpdirLog, "utf-8").split("\n").filter(Boolean);
      const statLines = readFileSync(statLog, "utf-8").split("\n").filter(Boolean);
      expect(tmpdirLines.length).toBe(2);
      expect(statLines.length).toBe(2);
      // (a) Both markers contain the same absolute path.
      expect(tmpdirLines[0]).toBe(tmpdirLines[1]);
      const observedTmpdir = tmpdirLines[0];
      expect(isAbsolute(observedTmpdir)).toBe(true);
      // (b) During-run stats record exists-as-dir.
      expect(statLines[0]).toBe("exists-as-dir");
      expect(statLines[1]).toBe("exists-as-dir");
      // (c) Parented under the test-isolated tmpdir parent.
      expect(dirname(observedTmpdir)).toBe(tmpdirParent);
      // (d) After loopx exits, path has been cleaned up.
      expect(existsSync(observedTmpdir)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-02: LOOPX_TMPDIR is an absolute path.
    // ------------------------------------------------------------------------
    it("T-TMP-02: LOOPX_TMPDIR is an absolute path", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);

      const observed = readFileSync(marker, "utf-8");
      expect(observed.startsWith("/")).toBe(true);
      expect(observed).toBe(resolve(observed));
    });

    // ------------------------------------------------------------------------
    // T-TMP-02a: LOOPX_TMPDIR basename has the `loopx-` prefix directly
    // (not just substring match anywhere in path).
    // ------------------------------------------------------------------------
    it("T-TMP-02a: LOOPX_TMPDIR basename starts with the `loopx-` prefix", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);

      const observed = readFileSync(marker, "utf-8");
      const base = basename(observed);
      // (a) Basename starts with `loopx-` (direct, not a substring elsewhere).
      expect(base.startsWith("loopx-")).toBe(true);
      // (b) At least one additional character beyond the prefix.
      expect(base.length).toBeGreaterThan("loopx-".length);
    });

    // ------------------------------------------------------------------------
    // T-TMP-03: Shared across iterations (-n 3).
    // ------------------------------------------------------------------------
    it("T-TMP-03: LOOPX_TMPDIR is shared across iterations", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const log = join(project.dir, "tmpdir.log");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s\\n' "$LOOPX_TMPDIR" >> "${log}"
printf '{"result":"r"}'
`,
      );

      const result = await runCLI(["run", "-n", "3", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const lines = readFileSync(log, "utf-8").split("\n").filter(Boolean);
      expect(lines.length).toBe(3);
      expect(lines[0]).toBe(lines[1]);
      expect(lines[1]).toBe(lines[2]);
    });

    // ------------------------------------------------------------------------
    // T-TMP-04: Shared across intra-workflow goto.
    // ------------------------------------------------------------------------
    it("T-TMP-04: LOOPX_TMPDIR is shared across intra-workflow goto", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const indexMarker = join(project.dir, "index.txt");
      const checkMarker = join(project.dir, "check.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${indexMarker}"
printf '{"goto":"check"}'
`,
      );
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${checkMarker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "5", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const indexVal = readFileSync(indexMarker, "utf-8");
      const checkVal = readFileSync(checkMarker, "utf-8");
      expect(indexVal).toBe(checkVal);
      // Strengthen: the shared value must be a real LOOPX_TMPDIR (absolute
      // path under the test-isolated parent), so the equality assertion is
      // not satisfied vacuously by both markers being empty.
      expect(indexVal.length).toBeGreaterThan(0);
      expect(dirname(indexVal)).toBe(tmpdirParent);
    });

    // ------------------------------------------------------------------------
    // T-TMP-05: Shared across cross-workflow goto.
    // ------------------------------------------------------------------------
    it("T-TMP-05: LOOPX_TMPDIR is shared across cross-workflow goto", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const alphaMarker = join(project.dir, "alpha.txt");
      const betaMarker = join(project.dir, "beta.txt");

      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${alphaMarker}"
printf '{"goto":"beta:step"}'
`,
      );
      await createWorkflowScript(
        project,
        "beta",
        "step",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${betaMarker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "5", "alpha"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const alphaVal = readFileSync(alphaMarker, "utf-8");
      const betaVal = readFileSync(betaMarker, "utf-8");
      expect(alphaVal).toBe(betaVal);
      // Strengthen: assert non-empty + parented under tmpdirParent so the
      // equality is not satisfied vacuously.
      expect(alphaVal.length).toBeGreaterThan(0);
      expect(dirname(alphaVal)).toBe(tmpdirParent);
    });

    // ------------------------------------------------------------------------
    // T-TMP-06: Preserved across loop reset.
    // ------------------------------------------------------------------------
    it("T-TMP-06: LOOPX_TMPDIR is preserved across loop reset", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const log = join(project.dir, "tmpdir.log");

      await createWorkflowScript(
        project,
        "alpha",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s\\n' "$LOOPX_TMPDIR" >> "${log}"
printf '{"goto":"beta:step"}'
`,
      );
      await createWorkflowScript(
        project,
        "beta",
        "step",
        ".sh",
        `#!/bin/bash
printf '%s\\n' "$LOOPX_TMPDIR" >> "${log}"
printf '{"result":"r"}'
`,
      );

      const result = await runCLI(["run", "-n", "3", "alpha"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const lines = readFileSync(log, "utf-8").split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      // All observations must report the same path.
      const first = lines[0];
      for (const ln of lines) expect(ln).toBe(first);
    });

    // ------------------------------------------------------------------------
    // T-TMP-07: Files persist within a run (across goto).
    // ------------------------------------------------------------------------
    it("T-TMP-07: Files written to LOOPX_TMPDIR persist within a run", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf 'hello' > "$LOOPX_TMPDIR/state.txt"
printf '{"goto":"check"}'
`,
      );
      await createWorkflowScript(
        project,
        "ralph",
        "check",
        ".sh",
        `#!/bin/bash
VAL=$(cat "$LOOPX_TMPDIR/state.txt")
printf '{"result":"%s","stop":true}' "$VAL"
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5 });
console.log(JSON.stringify(outputs));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const outputs = JSON.parse(result.stdout);
      // The 2nd yielded output (from `ralph:check`) reads the file written
      // by `ralph:index`.
      const lastOutput = outputs[outputs.length - 1];
      expect(lastOutput).toMatchObject({ result: "hello", stop: true });
    });

    // ------------------------------------------------------------------------
    // T-TMP-08: Concurrent runs across independent projects get distinct
    //   tmpdirs.
    // ------------------------------------------------------------------------
    it("T-TMP-08: Concurrent runs across independent projects get distinct tmpdirs", async () => {
      const { project: project1, tmpdirParent: parent1 } = await setupTmpdirTest();
      const { project: project2, tmpdirParent: parent2 } = await setupTmpdirTest();
      const marker1 = join(project1.dir, "tmpdir.txt");
      const marker2 = join(project2.dir, "tmpdir.txt");

      const body = (markerPath: string) => `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${markerPath}"
printf '{"stop":true}'
`;
      await createWorkflowScript(project1, "ralph", "index", ".sh", body(marker1));
      await createWorkflowScript(project2, "ralph", "index", ".sh", body(marker2));

      const [r1, r2] = await Promise.all([
        runCLI(["run", "-n", "1", "ralph"], {
          cwd: project1.dir,
          runtime,
          env: { TMPDIR: parent1 },
        }),
        runCLI(["run", "-n", "1", "ralph"], {
          cwd: project2.dir,
          runtime,
          env: { TMPDIR: parent2 },
        }),
      ]);
      expect(r1.exitCode).toBe(0);
      expect(r2.exitCode).toBe(0);
      const t1 = readFileSync(marker1, "utf-8");
      const t2 = readFileSync(marker2, "utf-8");
      expect(t1).not.toBe(t2);
    });

    // ------------------------------------------------------------------------
    // T-TMP-08a: Concurrent runPromise() against the same project get
    //   distinct tmpdirs (release-sentinel barrier proves actual overlap).
    // ------------------------------------------------------------------------
    it("T-TMP-08a: Concurrent runPromise() against the same project get distinct tmpdirs", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const releasePath = join(project.dir, "release.sentinel");
      const marker1 = join(project.dir, "run-1-tmpdir.txt");
      const marker2 = join(project.dir, "run-2-tmpdir.txt");

      // Script reads OBSERVED_TMPDIR_MARKER and RELEASE_SENTINEL from env.
      // Each runPromise() call passes them via RunOptions.env.
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
while [ ! -f "$RELEASE_SENTINEL" ]; do sleep 0.05; done
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
const release = ${JSON.stringify(releasePath)};
const m1 = ${JSON.stringify(marker1)};
const m2 = ${JSON.stringify(marker2)};
const cwd = ${JSON.stringify(project.dir)};
const p1 = runPromise("ralph", { cwd, maxIterations: 1, env: { OBSERVED_TMPDIR_MARKER: m1, RELEASE_SENTINEL: release } });
const p2 = runPromise("ralph", { cwd, maxIterations: 1, env: { OBSERVED_TMPDIR_MARKER: m2, RELEASE_SENTINEL: release } });
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  if (existsSync(m1) && existsSync(m2)) break;
  await new Promise((r) => setTimeout(r, 50));
}
writeFileSync(release, "");
const r1 = await p1;
const r2 = await p2;
const t1 = readFileSync(m1, "utf-8");
const t2 = readFileSync(m2, "utf-8");
console.log(JSON.stringify({ t1, t2, exist1: existsSync(t1), exist2: existsSync(t2), out1: r1, out2: r2 }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
        timeout: 25_000,
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.t1).not.toBe(data.t2);
      // Both tmpdirs cleaned up after settlement.
      expect(data.exist1).toBe(false);
      expect(data.exist2).toBe(false);
      // Both share the same parent.
      expect(dirname(data.t1)).toBe(tmpdirParent);
      expect(dirname(data.t2)).toBe(tmpdirParent);
    });

    // ------------------------------------------------------------------------
    // T-TMP-08b: Concurrent CLI invocations against the same project get
    //   distinct tmpdirs.
    // ------------------------------------------------------------------------
    it("T-TMP-08b: Concurrent CLI invocations against the same project get distinct tmpdirs", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const releasePath = join(project.dir, "release.sentinel");
      const marker1 = join(project.dir, "cli-1-tmpdir.txt");
      const marker2 = join(project.dir, "cli-2-tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
while [ ! -f "$RELEASE_SENTINEL" ]; do sleep 0.05; done
printf '{"stop":true}'
`,
      );

      const c1 = runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: {
          TMPDIR: tmpdirParent,
          OBSERVED_TMPDIR_MARKER: marker1,
          RELEASE_SENTINEL: releasePath,
        },
        timeout: 25_000,
      });
      const c2 = runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: {
          TMPDIR: tmpdirParent,
          OBSERVED_TMPDIR_MARKER: marker2,
          RELEASE_SENTINEL: releasePath,
        },
        timeout: 25_000,
      });

      // Poll for both markers to exist before releasing.
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (existsSync(marker1) && existsSync(marker2)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await writeFile(releasePath, "");
      const [r1, r2] = await Promise.all([c1, c2]);
      expect(r1.exitCode).toBe(0);
      expect(r2.exitCode).toBe(0);
      const t1 = readFileSync(marker1, "utf-8");
      const t2 = readFileSync(marker2, "utf-8");
      expect(t1.length).toBeGreaterThan(0);
      expect(t2.length).toBeGreaterThan(0);
      expect(t1).not.toBe(t2);
      expect(existsSync(t1)).toBe(false);
      expect(existsSync(t2)).toBe(false);
      expect(dirname(t1)).toBe(tmpdirParent);
      expect(dirname(t2)).toBe(tmpdirParent);
    });

    // ------------------------------------------------------------------------
    // T-TMP-08c: Concurrent run() generators against the same project get
    //   distinct tmpdirs.
    // ------------------------------------------------------------------------
    it("T-TMP-08c: Concurrent run() generators against the same project get distinct tmpdirs", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const releasePath = join(project.dir, "release.sentinel");
      const marker1 = join(project.dir, "gen-1-tmpdir.txt");
      const marker2 = join(project.dir, "gen-2-tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "$OBSERVED_TMPDIR_MARKER"
while [ ! -f "$RELEASE_SENTINEL" ]; do sleep 0.05; done
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
const release = ${JSON.stringify(releasePath)};
const m1 = ${JSON.stringify(marker1)};
const m2 = ${JSON.stringify(marker2)};
const cwd = ${JSON.stringify(project.dir)};
const g1 = run("ralph", { cwd, maxIterations: 1, env: { OBSERVED_TMPDIR_MARKER: m1, RELEASE_SENTINEL: release } });
const g2 = run("ralph", { cwd, maxIterations: 1, env: { OBSERVED_TMPDIR_MARKER: m2, RELEASE_SENTINEL: release } });
const drain1 = (async () => { const out = []; for await (const o of g1) out.push(o); return out; })();
const drain2 = (async () => { const out = []; for await (const o of g2) out.push(o); return out; })();
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  if (existsSync(m1) && existsSync(m2)) break;
  await new Promise((r) => setTimeout(r, 50));
}
writeFileSync(release, "");
const out1 = await drain1;
const out2 = await drain2;
const t1 = readFileSync(m1, "utf-8");
const t2 = readFileSync(m2, "utf-8");
console.log(JSON.stringify({ t1, t2, exist1: existsSync(t1), exist2: existsSync(t2) }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
        timeout: 25_000,
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.t1).not.toBe(data.t2);
      expect(data.exist1).toBe(false);
      expect(data.exist2).toBe(false);
      expect(dirname(data.t1)).toBe(tmpdirParent);
      expect(dirname(data.t2)).toBe(tmpdirParent);
    });

    // ------------------------------------------------------------------------
    // T-TMP-09: Mode is 0o700 (owner-only rwx).
    // The fixture writes the path then waits on a release sentinel so the
    // test can stat the directory before cleanup runs.
    // ------------------------------------------------------------------------
    it("T-TMP-09: LOOPX_TMPDIR mode is 0o700", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirMarker = join(project.dir, "tmpdir.txt");
      const releasePath = join(project.dir, "release.sentinel");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
while [ ! -f "${releasePath}" ]; do sleep 0.05; done
printf '{"stop":true}'
`,
      );

      const cliPromise = runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
        timeout: 25_000,
      });

      // Wait for the marker to appear, then stat the tmpdir while it is
      // still alive (cleanup has not run yet because the script is parked
      // on the release sentinel). Capture the live-stat outcome separately
      // so we can guarantee the release happens even if assertions throw.
      let observed = "";
      let liveStatErr: unknown = null;
      try {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if (existsSync(tmpdirMarker)) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        observed = readFileSync(tmpdirMarker, "utf-8");
        expect(observed.length).toBeGreaterThan(0);
        const st = statSync(observed);
        expect(st.isDirectory()).toBe(true);
        // Mode bits — only the low 9 permission bits are relevant.
        expect(st.mode & 0o777).toBe(0o700);
      } catch (e) {
        liveStatErr = e;
      }
      // Always release and await — never leak the CLI process.
      await writeFile(releasePath, "").catch(() => {});
      const result = await cliPromise.catch((e) => ({ exitCode: -1, stdout: "", stderr: String(e), signal: null }));
      if (liveStatErr) throw liveStatErr;
      expect(result.exitCode).toBe(0);
      // Confirm cleanup also removed it.
      expect(existsSync(observed)).toBe(false);
    });

    // ========================================================================
    // Not-Created Cases (T-TMP-10..11b)
    // ========================================================================

    // ------------------------------------------------------------------------
    // T-TMP-10: CLI -n 0 → no tmpdir created.
    // ------------------------------------------------------------------------
    it("T-TMP-10: LOOPX_TMPDIR is not created under CLI -n 0", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();

      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const result = await runCLI(["run", "-n", "0", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const after = listLoopxEntries(tmpdirParent);
      // No new loopx-* entry was created.
      expect(after).toEqual(before);
    });

    // ------------------------------------------------------------------------
    // T-TMP-11: runPromise({ maxIterations: 0 }) → no tmpdir created.
    // ------------------------------------------------------------------------
    it("T-TMP-11: LOOPX_TMPDIR is not created under runPromise({ maxIterations: 0 })", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
console.log(JSON.stringify({ outputs }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.outputs).toEqual([]);
      const after = listLoopxEntries(tmpdirParent);
      expect(after).toEqual(before);
    });

    // ------------------------------------------------------------------------
    // T-TMP-11a: run({ maxIterations: 0 }) generator → no tmpdir created.
    // ------------------------------------------------------------------------
    it("T-TMP-11a: LOOPX_TMPDIR is not created under run() with maxIterations:0", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );

      const before = listLoopxEntries(tmpdirParent);
      const driverCode = `
import { run } from "loopx";
const g = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 0 });
const r = await g.next();
console.log(JSON.stringify({ done: r.done, value: r.value === undefined ? "undef" : r.value }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      // Generator settles immediately on first next() with done:true.
      expect(data.done).toBe(true);
      expect(data.value).toBe("undef");
      const after = listLoopxEntries(tmpdirParent);
      expect(after).toEqual(before);
    });

    // ------------------------------------------------------------------------
    // T-TMP-11b: run() does NOT create tmpdir synchronously at call site —
    //   creation is deferred to first next().
    // ------------------------------------------------------------------------
    it("T-TMP-11b: run() does not create LOOPX_TMPDIR synchronously at call site", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );

      // Drive run() and snapshot the parent directory between the synchronous
      // run() return and the first next() — no microtask yield in between.
      const driverCode = `
import { run } from "loopx";
import { readdirSync } from "node:fs";
const parent = ${JSON.stringify(tmpdirParent)};
function snapshot() {
  return readdirSync(parent)
    .filter((e) => e.startsWith("loopx-"))
    .filter(
      (e) =>
        !e.startsWith("loopx-nodepath-shim-") &&
        !e.startsWith("loopx-bun-jsx-") &&
        !e.startsWith("loopx-install-"),
    );
}
const before = snapshot();
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
const betweenSync = snapshot();
// Settle the generator cleanly via .return() — pre-first-next() consumer
// cancellation carve-out per SPEC 9.1: body is never entered, no tmpdir is
// created on this path either.
await gen.return(undefined);
const after = snapshot();
console.log(JSON.stringify({ before, betweenSync, after }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      // betweenSync set-equal to before — run() did not synchronously create
      // a tmpdir before returning the generator.
      expect(data.betweenSync.sort()).toEqual(data.before.sort());
      // Pre-first-next() consumer cancellation does not create a tmpdir
      // either, so the post-.return() set is also unchanged.
      expect(data.after.sort()).toEqual(data.before.sort());
    });

    // ========================================================================
    // Pre-iteration Failures Must Not Create LOOPX_TMPDIR (T-TMP-12, 26 sub-cases)
    //
    // Each sub-case is parameterized over both `runPromise` and `run` surfaces.
    // SPEC §7.1 step 6 (tmpdir creation) runs after steps 1–5 (discovery, env
    // loading, target resolution, version check, option snapshot in 9.1/9.2),
    // so any pre-iteration failure must surface before the tmpdir is ever
    // created. The fixture is otherwise valid (a complete `.loopx/ralph/index.sh`)
    // except where the sub-case itself is the discovery / target / env-file
    // failure under test.
    // ========================================================================

    for (const surface of SURFACES) {
      // --- env-loading branch ---

      // ----------------------------------------------------------------------
      // T-TMP-12-env-file: env-file load failure (missing file).
      // ----------------------------------------------------------------------
      it(`T-TMP-12-env-file (${surface}): missing env-file does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("ralph", { envFile: "nonexistent.env", maxIterations: 1, cwd: ${JSON.stringify(project.dir)} })`,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-env-file-unreadable: env-file load failure (mode 000).
      // Conditional on non-root: root reads mode-000 files unconditionally.
      // ----------------------------------------------------------------------
      it.skipIf(IS_ROOT)(
        `T-TMP-12-env-file-unreadable (${surface}): unreadable env-file does not create tmpdir`,
        async () => {
          const { project, tmpdirParent } = await setupTmpdirTest();
          await createBashWorkflowScript(
            project,
            "ralph",
            "index",
            `printf '{"stop":true}'`,
          );
          const unreadable = join(project.dir, "unreadable.env");
          await writeFile(unreadable, "FOO=bar\n", "utf-8");
          await chmod(unreadable, 0o000);
          try {
            await assertNoTmpdirCreated({
              runtime,
              surface,
              parent: tmpdirParent,
              callExpr: `${surface}("ralph", { envFile: ${JSON.stringify(unreadable)}, maxIterations: 1, cwd: ${JSON.stringify(project.dir)} })`,
            });
          } finally {
            await chmod(unreadable, 0o644).catch(() => {});
          }
        },
      );

      // ----------------------------------------------------------------------
      // T-TMP-12-global-env-unreadable: unreadable global env file under
      // an isolated XDG_CONFIG_HOME passed via the inherited environment.
      // ----------------------------------------------------------------------
      it.skipIf(IS_ROOT)(
        `T-TMP-12-global-env-unreadable (${surface}): unreadable global env file does not create tmpdir`,
        async () => {
          const { project, tmpdirParent } = await setupTmpdirTest();
          await createBashWorkflowScript(
            project,
            "ralph",
            "index",
            `printf '{"stop":true}'`,
          );
          const xdg = join(project.dir, "xdg-config");
          await mkdir(join(xdg, "loopx"), { recursive: true });
          const globalEnv = join(xdg, "loopx", "env");
          await writeFile(globalEnv, "FOO=bar\n", "utf-8");
          await chmod(globalEnv, 0o000);
          try {
            await assertNoTmpdirCreated({
              runtime,
              surface,
              parent: tmpdirParent,
              callExpr: `${surface}("ralph", { maxIterations: 1, cwd: ${JSON.stringify(project.dir)} })`,
              extraEnv: { XDG_CONFIG_HOME: xdg },
            });
          } finally {
            await chmod(globalEnv, 0o644).catch(() => {});
          }
        },
      );

      // --- target-resolution branch ---

      // ----------------------------------------------------------------------
      // T-TMP-12-missing-workflow: target resolves to a workflow that does
      // not exist under .loopx/.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-missing-workflow (${surface}): missing workflow does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("nonexistent-workflow", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })`,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-missing-script: workflow exists but the qualified script
      // (`ralph:check`) does not — a distinct target-resolution sub-path.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-missing-script (${surface}): missing script in existing workflow does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("ralph:check", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })`,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-missing-default-index: workflow exists but has no `index.*`
      // entry — bare target `"ralph"` resolves to `ralph:index` and fails.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-missing-default-index (${surface}): workflow without index.* does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "check",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })`,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-target-validation: leading-colon target violates SPEC 4.1
      // delimiter syntax.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-target-validation (${surface}): leading-colon target does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}(":script", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })`,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-target-name-invalid: name-pattern violation (`.` is not
      // in the SPEC 4.1 `[a-zA-Z0-9_][a-zA-Z0-9_-]*` workflow-name pattern).
      // ----------------------------------------------------------------------
      it(`T-TMP-12-target-name-invalid (${surface}): name-pattern violation does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("bad.name", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })`,
        });
      });

      // --- option-snapshot value-validation branch ---

      // ----------------------------------------------------------------------
      // T-TMP-12-invalid-maxIterations: negative `maxIterations` invalid
      // per SPEC 9.5.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-invalid-maxIterations (${surface}): negative maxIterations does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("ralph", { maxIterations: -1, cwd: ${JSON.stringify(project.dir)} })`,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-invalid-options-shape: `options = null` — SPEC 9.5 requires
      // omitted, undefined, or a non-null non-array non-function object.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-invalid-options-shape (${surface}): null options does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("ralph", null)`,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-invalid-env-shape: `env = null` violates SPEC 9.5.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-invalid-env-shape (${surface}): null env does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("ralph", { env: null, cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })`,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-invalid-env-value: per-entry value validation — non-string.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-invalid-env-value (${surface}): non-string env value does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("ralph", { env: { KEY: 42 }, cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })`,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-invalid-signal: non-AbortSignal-compatible signal.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-invalid-signal (${surface}): non-AbortSignal signal does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("ralph", { signal: "not-an-AbortSignal", cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })`,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-invalid-target: non-string target argument (undefined).
      // ----------------------------------------------------------------------
      it(`T-TMP-12-invalid-target (${surface}): non-string target does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}(undefined, { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })`,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-invalid-cwd: non-string `cwd` value.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-invalid-cwd (${surface}): non-string cwd does not create tmpdir`, async () => {
        const { project: _project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          _project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("ralph", { cwd: 42, maxIterations: 1 })`,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-invalid-envFile: non-string `envFile` value.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-invalid-envFile (${surface}): non-string envFile does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("ralph", { envFile: 42, cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })`,
        });
      });

      // --- option-snapshot throwing-getter / throwing-trap branch ---
      // Construction: getters / Proxy traps must be defined on the SAME
      // object passed to run() / runPromise() (not invoked at the test
      // call site by an object spread) — see TEST-SPEC §1.3.

      // ----------------------------------------------------------------------
      // T-TMP-12-throwing-options-getter: throwing getter on options.env
      // (recognized field on the outer options object).
      // ----------------------------------------------------------------------
      it(`T-TMP-12-throwing-options-getter (${surface}): throwing options.env getter does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          preamble: `const opts = {};
Object.defineProperty(opts, "env", { enumerable: true, configurable: true, get() { throw new Error("throwing-options-env-getter-boom"); } });
opts.cwd = ${JSON.stringify(project.dir)};
opts.maxIterations = 1;`,
          callExpr: `${surface}("ralph", opts)`,
          expectErrMatch: /throwing-options-env-getter-boom/,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-throwing-signal-getter.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-throwing-signal-getter (${surface}): throwing options.signal getter does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          preamble: `const opts = {};
Object.defineProperty(opts, "signal", { enumerable: true, configurable: true, get() { throw new Error("throwing-signal-getter-boom"); } });
opts.cwd = ${JSON.stringify(project.dir)};
opts.maxIterations = 1;`,
          callExpr: `${surface}("ralph", opts)`,
          expectErrMatch: /throwing-signal-getter-boom/,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-throwing-cwd-getter.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-throwing-cwd-getter (${surface}): throwing options.cwd getter does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          preamble: `const opts = {};
Object.defineProperty(opts, "cwd", { enumerable: true, configurable: true, get() { throw new Error("throwing-cwd-getter-boom"); } });
opts.maxIterations = 1;`,
          callExpr: `${surface}("ralph", opts)`,
          expectErrMatch: /throwing-cwd-getter-boom/,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-throwing-envFile-getter.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-throwing-envFile-getter (${surface}): throwing options.envFile getter does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          preamble: `const opts = {};
Object.defineProperty(opts, "envFile", { enumerable: true, configurable: true, get() { throw new Error("throwing-envFile-getter-boom"); } });
opts.cwd = ${JSON.stringify(project.dir)};
opts.maxIterations = 1;`,
          callExpr: `${surface}("ralph", opts)`,
          expectErrMatch: /throwing-envFile-getter-boom/,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-throwing-maxIterations-getter.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-throwing-maxIterations-getter (${surface}): throwing options.maxIterations getter does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          preamble: `const opts = {};
Object.defineProperty(opts, "maxIterations", { enumerable: true, configurable: true, get() { throw new Error("throwing-maxIterations-getter-boom"); } });
opts.cwd = ${JSON.stringify(project.dir)};`,
          callExpr: `${surface}("ralph", opts)`,
          expectErrMatch: /throwing-maxIterations-getter-boom/,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-throwing-env-entry-getter: throwing enumerable getter on
      // an entry inside `options.env`.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-throwing-env-entry-getter (${surface}): throwing env entry getter does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          preamble: `const env = { A: "a" };
Object.defineProperty(env, "B", { enumerable: true, configurable: true, get() { throw new Error("throwing-env-entry-getter-boom"); } });`,
          callExpr: `${surface}("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, env })`,
          expectErrMatch: /throwing-env-entry-getter-boom/,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-throwing-env-proxy-ownKeys: Proxy `ownKeys` trap throws.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-throwing-env-proxy-ownKeys (${surface}): throwing env Proxy ownKeys does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          preamble: `const env = new Proxy({ A: "a" }, { ownKeys() { throw new Error("throwing-env-proxy-ownKeys-boom"); } });`,
          callExpr: `${surface}("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, env })`,
          expectErrMatch: /throwing-env-proxy-ownKeys-boom/,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-throwing-env-proxy-get: Proxy `get` trap throws on an
      // included string key.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-throwing-env-proxy-get (${surface}): throwing env Proxy get does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          preamble: `const env = new Proxy({ A: "a", B: "b" }, {
  ownKeys() { return ["A", "B"]; },
  getOwnPropertyDescriptor(_t, _k) { return { enumerable: true, configurable: true, value: undefined, writable: true }; },
  get(_t, _k) { throw new Error("throwing-env-proxy-get-boom"); }
});`,
          callExpr: `${surface}("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, env })`,
          expectErrMatch: /throwing-env-proxy-get-boom/,
        });
      });

      // --- discovery branch (programmatic surface) ---

      // ----------------------------------------------------------------------
      // T-TMP-12-programmatic-discovery-missing-loopx: project root with
      // no `.loopx/` directory at all.
      // ----------------------------------------------------------------------
      it(`T-TMP-12-programmatic-discovery-missing-loopx (${surface}): missing .loopx/ does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest({ withLoopxDir: false });
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })`,
        });
      });

      // ----------------------------------------------------------------------
      // T-TMP-12-programmatic-discovery-validation: discovery-time global
      // validation failure (sibling workflow with a name-collision in two
      // extensions).
      // ----------------------------------------------------------------------
      it(`T-TMP-12-programmatic-discovery-validation (${surface}): discovery validation failure does not create tmpdir`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"stop":true}'`,
        );
        // Sibling workflow with a name collision: broken/check.sh + broken/check.ts.
        await createBashWorkflowScript(
          project,
          "broken",
          "check",
          `printf '{"stop":true}'`,
        );
        await createWorkflowScript(
          project,
          "broken",
          "check",
          ".ts",
          `console.log('{"stop":true}');`,
        );
        await assertNoTmpdirCreated({
          runtime,
          surface,
          parent: tmpdirParent,
          callExpr: `${surface}("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 })`,
        });
      });
    }

    // ========================================================================
    // Cleanup on Normal Completion (T-TMP-13..14a)
    // ========================================================================

    // ------------------------------------------------------------------------
    // T-TMP-13: Cleanup on normal completion (stop:true, CLI).
    // ------------------------------------------------------------------------
    it("T-TMP-13: cleanup on normal completion (stop:true) — CLI", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "5", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const observed = readFileSync(marker, "utf-8");
      expect(observed.length).toBeGreaterThan(0);
      expect(existsSync(observed)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-13a: Cleanup on normal completion (stop:true, runPromise).
    // ------------------------------------------------------------------------
    it("T-TMP-13a: runPromise() cleanup on normal completion (stop:true)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5 });
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({ observed, exist: existsSync(observed), outputs }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-13b: Cleanup on natural settlement after stop:true (run()).
    // ------------------------------------------------------------------------
    it("T-TMP-13b: run() generator cleanup on natural settlement after stop:true", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 5 });
for await (const _ of gen) { /* drain */ }
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({ observed, exist: existsSync(observed) }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-14: Cleanup on -n reached (CLI).
    // ------------------------------------------------------------------------
    it("T-TMP-14: cleanup on -n reached (CLI)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"result":"r"}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const observed = readFileSync(marker, "utf-8");
      expect(observed.length).toBeGreaterThan(0);
      expect(existsSync(observed)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-14a: Cleanup on maxIterations reached (runPromise).
    // ------------------------------------------------------------------------
    it("T-TMP-14a: runPromise() cleanup on maxIterations reached", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"result":"r"}'
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({ observed, exist: existsSync(observed), n: outputs.length }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.n).toBe(1);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-15: Cleanup on non-zero script exit (CLI).
    // ------------------------------------------------------------------------
    it("T-TMP-15: cleanup on non-zero script exit (CLI)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
exit 1
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(1);
      const observed = readFileSync(marker, "utf-8");
      expect(observed.length).toBeGreaterThan(0);
      expect(existsSync(observed)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-15a: Cleanup on non-zero script exit (runPromise).
    // ------------------------------------------------------------------------
    it("T-TMP-15a: runPromise() cleanup on non-zero script exit", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
exit 1
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
let rejected = false;
let errMsg = "";
try {
  await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
} catch (e) {
  rejected = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({ rejected, errMsg, observed, exist: existsSync(observed) }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.rejected).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-15b: Cleanup on non-zero script exit (run() generator).
    // ------------------------------------------------------------------------
    it("T-TMP-15b: run() cleanup on non-zero script exit", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
exit 1
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
let thrown = false;
let errMsg = "";
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  for await (const _ of gen) { /* drain */ }
} catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({ thrown, errMsg, observed, exist: existsSync(observed) }));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.thrown).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });
  });
});
