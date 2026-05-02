import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
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
import { runCLI, runCLIWithSignal } from "../helpers/cli.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { forEachRuntime } from "../helpers/runtime.js";
import { createEnvFile, withGlobalEnv } from "../helpers/env.js";

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
 * Runs a CLI invocation in `cwd` and asserts (a) the expected exit code,
 * (b) optional stderr / stdout regex matches, and (c) no new `loopx-*`
 * entry appeared under the test-isolated tmpdir parent during the call.
 *
 * Used by the T-TMP-12-cli and T-TMP-12-cli-usage CLI counterparts to
 * the programmatic T-TMP-12 sub-cases. SPEC §7.4 says tmpdir creation
 * runs only "for each `loopx run` ... that reaches execution", and SPEC
 * §7.1 step 6 (tmpdir creation) sits after steps 1–5; the CLI parser
 * layer (SPEC §4.1) and `-h` / `--help` short-circuit (SPEC §4.2) sit
 * even further upstream of that. None of those failure modes may create
 * a `LOOPX_TMPDIR`.
 */
async function assertCLINoTmpdirCreated(args: {
  runtime: "node" | "bun";
  cwd: string;
  parent: string;
  cliArgs: string[];
  expectExitCode: number;
  expectStderrMatch?: RegExp;
  expectStdoutMatch?: RegExp;
  expectStderrNonEmpty?: boolean;
  extraEnv?: Record<string, string>;
}) {
  const before = listLoopxEntries(args.parent);
  const result = await runCLI(args.cliArgs, {
    cwd: args.cwd,
    runtime: args.runtime,
    env: { TMPDIR: args.parent, ...(args.extraEnv ?? {}) },
  });
  const after = listLoopxEntries(args.parent);
  expect(result.exitCode).toBe(args.expectExitCode);
  if (args.expectStderrNonEmpty) {
    expect(result.stderr.length).toBeGreaterThan(0);
  }
  if (args.expectStderrMatch) {
    expect(result.stderr).toMatch(args.expectStderrMatch);
  }
  if (args.expectStdoutMatch) {
    expect(result.stdout).toMatch(args.expectStdoutMatch);
  }
  expect(after.slice().sort()).toEqual(before.slice().sort());
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
 * Three execution surfaces over which T-TMP-12d / T-TMP-12d2 / T-TMP-12e /
 * T-TMP-12e2 / T-TMP-12e3 are parameterized. Unlike T-TMP-12 (which only
 * exercises the two programmatic surfaces), the sub-step coverage tests
 * exercise the full SPEC §7.4 creation-failure × cleanup-safety surface
 * across all three loopx execution paths.
 */
const TMPDIR_FAULT_SURFACES = ["cli", "run", "runPromise"] as const;
type TmpdirFaultSurface = (typeof TMPDIR_FAULT_SURFACES)[number];

/**
 * Drives one of T-TMP-12d / T-TMP-12d2 / T-TMP-12e / T-TMP-12e2 / T-TMP-12e3
 * across a single execution surface. Encapsulates the shared harness shape:
 *
 *   1. Create a temp project with a valid `.loopx/ralph/index.sh` fixture
 *      that writes a marker file when executed.
 *   2. Create a writable test-isolated TMPDIR parent (so `mkdtemp` itself
 *      succeeds — the seam, not the parent's mode, drives the sub-step
 *      failure under test). `setupTmpdirTest` registers the parent for
 *      `afterEach` removal, so any partial `loopx-*` residue left behind
 *      by T-TMP-12d2 / T-TMP-12e2 / T-TMP-12e3 is cleaned up automatically.
 *   3. Snapshot `loopx-*` entries under the parent before the run.
 *   4. Drive the surface-appropriate invocation with the test-only seam env
 *      vars in `faultEnv` plus `NODE_ENV=test` (required for the seam to
 *      be honored per §1.4 of TEST-SPEC).
 *   5. Snapshot again and assert:
 *        (a) the surface-appropriate terminal failure surfaces (CLI exit 1
 *            / generator throws / promise rejects, all with implementation-
 *            defined non-empty error text);
 *        (b) the marker file does not exist (no child spawned — SPEC §7.1
 *            step 7 not reached because step 6 failed);
 *        (c) residue presence/absence matches `expectResidue` — `false` for
 *            the success-cleanup paths (12d / 12e: rmdir / recursive-remove
 *            succeeded), `true` for the failed-cleanup paths (12d2 / 12e2 /
 *            12e3: rmdir / recursive-remove / lstat failed, leaving the
 *            partial directory in place per SPEC §7.4 "leaves the path in
 *            place" / "no further changes");
 *        (d) the count of `LOOPX_TEST_CLEANUP_WARNING\t…` lines on stderr
 *            matches `expectCleanupWarnings` — `0` for the success-cleanup
 *            paths (no warning is normative when cleanup completes cleanly)
 *            and `1` for the failed-cleanup paths (SPEC §7.4 "single stderr
 *            warning" combined with "Per-cleanup-attempt warning cardinality
 *            is at most one"). The warning text itself is implementation-
 *            defined per SPEC §7.4; the `LOOPX_TEST_CLEANUP_WARNING\t`
 *            prefix is the implementation-neutral detection predicate
 *            documented in TEST-SPEC §1.4 "Cleanup-warning structured
 *            marker".
 */
async function runTmpdirFaultTest(args: {
  runtime: "node" | "bun";
  surface: TmpdirFaultSurface;
  faultEnv: Record<string, string>;
  expectCleanupWarnings: number;
  expectResidue: boolean;
}) {
  const { project, tmpdirParent } = await setupTmpdirTest();
  const marker = join(project.dir, "child-ran.txt");
  await createBashWorkflowScript(
    project,
    "ralph",
    "index",
    `printf 'ran' > "${marker}"\nprintf '{"stop":true}'`,
  );

  const before = listLoopxEntries(tmpdirParent);
  const env: Record<string, string> = {
    TMPDIR: tmpdirParent,
    NODE_ENV: "test",
    ...args.faultEnv,
  };

  let stderr: string;
  let markerExists: boolean;

  if (args.surface === "cli") {
    const result = await runCLI(["run", "-n", "1", "ralph"], {
      cwd: project.dir,
      runtime: args.runtime,
      env,
    });
    // (a) CLI exit 1 with non-empty stderr (implementation-defined error text)
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    stderr = result.stderr;
    markerExists = existsSync(marker);
  } else {
    const callBlock =
      args.surface === "runPromise"
        ? `await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });`
        : `const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  await gen.next();`;
    const driverCode = `
import { ${args.surface} } from "loopx";
import { existsSync, readdirSync } from "node:fs";
const parent = ${JSON.stringify(tmpdirParent)};
const marker = ${JSON.stringify(marker)};
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
const beforeSnap = snap();
let caught = false;
let errMsg = "";
let errName = "";
try {
  ${callBlock}
} catch (e) {
  caught = true;
  errMsg = e instanceof Error ? e.message : String(e);
  errName = e instanceof Error ? (e.name || "") : "";
}
const afterSnap = snap();
console.log(JSON.stringify({ caught, errMsg, errName, beforeSnap, afterSnap, markerExists: existsSync(marker) }));
`;
    const result = await runAPIDriver(args.runtime, driverCode, { env });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as {
      caught: boolean;
      errMsg: string;
      errName: string;
      beforeSnap: string[];
      afterSnap: string[];
      markerExists: boolean;
    };
    // (a) generator throws / promise rejects with non-empty error text
    //     (the original tmpdir-creation-failure error per SPEC §7.4
    //     "does not mask the original creation error" for 12d2 / 12e2 /
    //     12e3; the seam-injected creation error for 12d / 12e).
    expect(data.caught).toBe(true);
    expect(data.errMsg.length).toBeGreaterThan(0);
    stderr = result.stderr;
    markerExists = data.markerExists;
  }

  const after = listLoopxEntries(tmpdirParent);
  const newEntries = after.filter((e) => !before.includes(e));

  // (b) no child spawned (SPEC §7.1 step 7 not reached)
  expect(markerExists).toBe(false);

  // (c) residue presence/absence
  if (args.expectResidue) {
    // SPEC §7.4: failed-cleanup paths "leave the path in place" / "no
    // further changes". Exactly one new partial `loopx-*` directory.
    expect(newEntries.length).toBe(1);
    expect(newEntries[0]?.startsWith("loopx-")).toBe(true);
  } else {
    // SPEC §7.4: success-cleanup paths leave no residue (rmdir or
    // recursive-remove completed cleanly).
    expect(newEntries.length).toBe(0);
  }

  // (d) cleanup-warning marker-line count (TEST-SPEC §1.4 "Cleanup-warning
  // structured marker" — implementation-neutral detection predicate).
  const cleanupWarnings = stderr
    .split("\n")
    .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
  expect(cleanupWarnings.length).toBe(args.expectCleanupWarnings);
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

/**
 * Probes the active runtime's `os.tmpdir()` value when invoked in a child
 * Node/Bun process configured with the given env. Used by T-TMP-25a / 25b /
 * 26-temp / 26-tmp / 27-temp / 27-tmp / 28a / 28b / 28d / 28e / 28g / 28h /
 * 29b / 29c / 29d / 29e / 29g / 29h / 29j / 29k to "anchor on `os.tmpdir()`
 * evaluated in an identically-configured child process" — the runtime-aware
 * expected-parent contract. SPEC §7.4 names `TMPDIR` / `TEMP` / `TMP`
 * collectively as the variables `os.tmpdir()` reads, but on POSIX runtimes
 * (Node, Bun) only `TMPDIR` is consulted, so the assertions for the `TEMP` /
 * `TMP` variants must reduce to the runtime's actual `os.tmpdir()` reading.
 *
 * `env` accepts `undefined` values: a `key: undefined` entry deletes that
 * variable from the child's effective environment (rather than passing the
 * literal string "undefined"), letting tests express "TMPDIR unset" cleanly.
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

/**
 * Snapshots-and-restores `process.env.TMPDIR` / `TEMP` / `TMP` around a
 * test body. Per the snapshot-timing tests' contract, each test must leave
 * the harness's inherited env exactly as it was — concurrent test files run
 * in separate vitest worker forks, but tests within one file share
 * `process.env`, so leaking a `TMPDIR` mutation would silently break
 * subsequent tests in this file.
 */
async function withInheritedTmpdirEnv(
  overrides: Record<"TMPDIR" | "TEMP" | "TMP", string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const originals: Record<string, string | undefined> = {
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  for (const key of ["TMPDIR", "TEMP", "TMP"] as const) {
    const v = overrides[key];
    if (v === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = v;
    }
  }
  try {
    await body();
  } finally {
    for (const key of ["TMPDIR", "TEMP", "TMP"] as const) {
      const orig = originals[key];
      if (orig === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = orig;
      }
    }
  }
}

/**
 * Creates a writable test-isolated parent directory under the system tmpdir,
 * registered for cleanup. Used by the snapshot-timing tests as the value to
 * thread through `TMPDIR` / `TEMP` / `TMP` — concurrent test workers must not
 * race on a fixed `/tmp/loopx-...` parent (per TEST-SPEC §4.7 preface).
 */
async function makeTestParent(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `loopx-test-${label}-parent-`));
  extraCleanups.push(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

/**
 * Builds a bash fixture body that observes `LOOPX_TMPDIR` plus optionally
 * one or more of `TMPDIR` / `TEMP` / `TMP` into separate marker files. Each
 * marker path is supplied via a uniquely-named env var (`OBS_<NAME>_PATH`)
 * to avoid shadowing the variable being observed. Emits `{"stop":true}` to
 * settle the loop after one iteration.
 */
function buildEnvObserveScript(observe: ("TMPDIR" | "TEMP" | "TMP")[]): string {
  const lines = [
    `#!/bin/bash`,
    `printf '%s' "$LOOPX_TMPDIR" > "$OBS_LOOPX_TMPDIR_PATH"`,
  ];
  for (const v of observe) {
    lines.push(`printf '%s' "$${v}" > "$OBS_${v}_PATH"`);
  }
  lines.push(`printf '{"stop":true}'`, ``);
  return lines.join("\n");
}

/**
 * The five SPEC §3.2 normatively-warning `package.json` failure-mode branches
 * over which T-TMP-12f / T-TMP-12f2 / T-TMP-12f3 / T-TMP-12f4 / T-TMP-12f5
 * (CLI surface) and T-TMP-12g / T-TMP-12h (programmatic surfaces) are
 * parameterized:
 *
 *   - "unsatisfied-range": valid JSON, valid semver range, but the running
 *     loopx version does not satisfy it (e.g., `>=999.0.0`).
 *   - "invalid-json":      `package.json` content is not parseable JSON.
 *   - "invalid-semver":    valid JSON, but the `loopx` dependency value is
 *                          not a valid semver range string.
 *   - "unreadable":        valid `package.json` content `chmod 000`'d, so
 *                          the version-check `readFile` returns EACCES.
 *                          (Conditional on non-root: root reads mode-000
 *                          files unconditionally, defeating the setup.)
 *   - "non-regular":       `package.json/` is a directory (the simplest
 *                          non-regular sub-case reachable through ordinary
 *                          fixtures), containing a placeholder file. SPEC
 *                          §3.2 step-5 `lstat` dispatch observes the
 *                          non-regular entry kind and emits the new
 *                          P-0004-03 warning branch.
 *
 * SPEC §3.2 does not require category-distinct warning text per failure
 * class; predicates per `pkgJsonVariantWarningRegex` are intentionally
 * lenient and consistent with the predicates in `e2e/version-check.test.ts`.
 */
const PKG_JSON_VARIANTS = [
  "unsatisfied-range",
  "invalid-json",
  "invalid-semver",
  "unreadable",
  "non-regular",
] as const;
type PkgJsonVariant = (typeof PKG_JSON_VARIANTS)[number];

/**
 * Stable test-ID label per (surface × variant) combination. The CLI surface
 * splits the variants across five sub-IDs (T-TMP-12f / 12f2 / 12f3 / 12f4 /
 * 12f5); the programmatic surfaces use one ID per surface (T-TMP-12g for
 * `run()`, T-TMP-12h for `runPromise()`) parameterized over all five
 * variants.
 */
function pkgJsonVariantTestId(
  surface: TmpdirFaultSurface,
  variant: PkgJsonVariant,
): string {
  if (surface === "cli") {
    switch (variant) {
      case "unsatisfied-range":
        return "T-TMP-12f";
      case "invalid-json":
        return "T-TMP-12f2";
      case "invalid-semver":
        return "T-TMP-12f3";
      case "unreadable":
        return "T-TMP-12f4";
      case "non-regular":
        return "T-TMP-12f5";
    }
  }
  return surface === "run" ? "T-TMP-12g" : "T-TMP-12h";
}

/**
 * Create the variant-specific `.loopx/<workflow>/package.json` fixture in
 * `project`. Returns the on-disk path of the created entry (the regular
 * file for variants i–iv, the directory for variant v). The unwritable-
 * parent TMPDIR setup that wraps this suite already requires non-root for
 * every variant, and the "unreadable" variant additionally requires non-
 * root for the `chmod 000` to be effective; both are subsumed by the
 * caller's `it.skipIf(IS_ROOT)` wrapper.
 */
async function setupPkgJsonVariantFixture(
  project: TempProject,
  workflow: string,
  variant: PkgJsonVariant,
): Promise<string> {
  const wfDir = await createWorkflow(project, workflow);
  const pkgPath = join(wfDir, "package.json");
  switch (variant) {
    case "unsatisfied-range":
      await writeFile(
        pkgPath,
        JSON.stringify({ dependencies: { loopx: ">=999.0.0" } }, null, 2),
        "utf-8",
      );
      break;
    case "invalid-json":
      await writeFile(pkgPath, "{broken", "utf-8");
      break;
    case "invalid-semver":
      await writeFile(
        pkgPath,
        JSON.stringify({ dependencies: { loopx: "not-a-range!!!" } }, null, 2),
        "utf-8",
      );
      break;
    case "unreadable":
      await writeFile(
        pkgPath,
        JSON.stringify({ dependencies: { loopx: "*" } }, null, 2),
        "utf-8",
      );
      await chmod(pkgPath, 0o000);
      break;
    case "non-regular":
      await mkdir(pkgPath, { recursive: true });
      await writeFile(join(pkgPath, "README"), "placeholder", "utf-8");
      break;
  }
  return pkgPath;
}

/**
 * Returns true iff `stderr` contains the variant's expected SPEC §3.2
 * `package.json` warning text, scoped to a stderr line that mentions the
 * starting workflow's name (`ralph` in this suite). SPEC §3.2 leaves
 * warning prose implementation-defined, so predicates are lenient — the
 * same shape used by the version-check warning matchers in
 * `e2e/version-check.test.ts`. The workflow-name scoping prevents
 * spurious matches on unrelated stderr lines (e.g., the pre-ADR-0004
 * `loopx-nodepath-shim-<pid>` `mkdirSync` error under an unwritable
 * `TMPDIR` happens to contain `EACCES` / `permission denied` text but
 * does not mention the workflow name).
 *
 * The `ralph`-scoping mirrors `hasUnreadableWarning(stderr, workflowName)`
 * et al. in `e2e/version-check.test.ts`. The predicate intentionally
 * matches against any line in `stderr` that mentions `ralph` AND matches
 * the variant-specific keyword pattern; SPEC §3.2 does not require
 * category-distinct text, so the per-variant predicates overlap by
 * design (e.g., "invalid-json" and "non-regular" both accept lines
 * mentioning `package.json`).
 */
function stderrHasPkgJsonVariantWarning(
  stderr: string,
  workflowName: string,
  variant: PkgJsonVariant,
): boolean {
  if (!stderr.includes(workflowName)) {
    return false;
  }
  const keywordRegex: RegExp = (() => {
    switch (variant) {
      case "unsatisfied-range":
        return /version|mismatch|range|satisf/i;
      case "invalid-json":
        return /(invalid.*json|parse|parsing|package\.json)/i;
      case "invalid-semver":
        return /(semver|range|invalid)/i;
      case "unreadable":
        return /(unreadable|cannot.*read|read.*fail|package\.json)/i;
      case "non-regular":
        return /(package\.json|directory|EISDIR|ENOTREG|not.*a.*file|non-regular)/i;
    }
  })();
  return keywordRegex.test(stderr);
}

/**
 * Drives one of T-TMP-12f / T-TMP-12f2 / T-TMP-12f3 / T-TMP-12f4 / T-TMP-12f5
 * (CLI surface) or T-TMP-12g / T-TMP-12h (programmatic surfaces) across a
 * single (surface, variant) combination. Encapsulates the shared harness
 * shape:
 *
 *   1. Create a temp project with a valid `.loopx/ralph/index.sh` fixture
 *      that writes a marker file when executed (proves no child spawns).
 *   2. Create the variant-specific `.loopx/ralph/package.json` fixture so
 *      SPEC §7.1 step 5 (starting-workflow version check) emits exactly
 *      one of the SPEC §3.2 warning branches.
 *   3. Create an unwritable parent and chmod it to 0500 so SPEC §7.1
 *      step 6 (`mkdtemp(<parent>/loopx-)`) fails with EACCES.
 *   4. Drive the surface-appropriate invocation with
 *      `TMPDIR=<unwritable-parent>` and `NODE_ENV=test`.
 *   5. Assert:
 *        (a) the surface-appropriate terminal failure surfaces (CLI exit 1
 *            with non-empty stderr / generator throws / promise rejects);
 *        (b) stderr contains the variant's `package.json` warning text —
 *            proving step 5 ran to completion before step 6 failed;
 *        (c) the marker file does not exist (no child spawned — step 7
 *            not reached);
 *        (d) no `loopx-*` directory was created under the unwritable
 *            parent;
 *        (e) for the non-regular variant, the directory at
 *            `.loopx/ralph/package.json/` is preserved unchanged with its
 *            placeholder file intact.
 *
 * Skip semantics: the unwritable-parent setup requires `process.getuid()
 * !== 0` for every variant, and the "unreadable" variant additionally
 * requires non-root for the `chmod 000` setup; both are subsumed by the
 * caller's `it.skipIf(IS_ROOT)` wrapper, so this helper does not consult
 * `IS_ROOT` itself.
 */
async function runPkgJsonVariantBeforeTmpdirTest(args: {
  runtime: "node" | "bun";
  surface: TmpdirFaultSurface;
  variant: PkgJsonVariant;
}) {
  const project = await createTempProject();
  const unwritableParent = await mkdtemp(
    join(tmpdir(), "loopx-test-unwritable-"),
  );
  const marker = join(project.dir, "child-ran.txt");
  const wfDir = join(project.loopxDir, "ralph");
  const wfPkgPath = join(wfDir, "package.json");

  const cleanupTask = async () => {
    // Restore the package.json mode under the "unreadable" variant before
    // recursive removal so the cleanup itself doesn't trip on EACCES.
    if (args.variant === "unreadable") {
      await chmod(wfPkgPath, 0o644).catch(() => {});
    }
    // Restore the parent's writable mode before rm so it can be removed.
    await chmod(unwritableParent, 0o700).catch(() => {});
    await rm(unwritableParent, { recursive: true, force: true }).catch(
      () => {},
    );
    await project.cleanup().catch(() => {});
  };
  extraCleanups.push(cleanupTask);

  await createBashWorkflowScript(
    project,
    "ralph",
    "index",
    `printf 'ran' > "${marker}"\nprintf '{"stop":true}'`,
  );

  await setupPkgJsonVariantFixture(project, "ralph", args.variant);

  // Make the parent unwritable AFTER fixture creation so the fixture tree
  // is writable and only the SPEC §7.1 step 6 `mkdtemp` fails.
  await chmod(unwritableParent, 0o500);

  const before = listLoopxEntries(unwritableParent);

  let stderr: string;
  let markerExists: boolean;

  if (args.surface === "cli") {
    const result = await runCLI(["run", "-n", "1", "ralph"], {
      cwd: project.dir,
      runtime: args.runtime,
      env: { TMPDIR: unwritableParent, NODE_ENV: "test" },
    });
    // (a) exit code 1 — tmpdir creation failure is the terminal error
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    stderr = result.stderr;
    markerExists = existsSync(marker);
  } else {
    const callBlock =
      args.surface === "runPromise"
        ? `await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });`
        : `const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  await gen.next();`;
    const driverCode = `
import { ${args.surface} } from "loopx";
import { existsSync, readdirSync } from "node:fs";
const parent = ${JSON.stringify(unwritableParent)};
const marker = ${JSON.stringify(marker)};
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
const beforeSnap = snap();
let caught = false;
let errMsg = "";
let errName = "";
try {
  ${callBlock}
} catch (e) {
  caught = true;
  errMsg = e instanceof Error ? e.message : String(e);
  errName = e instanceof Error ? (e.name || "") : "";
}
const afterSnap = snap();
console.log(JSON.stringify({ caught, errMsg, errName, beforeSnap, afterSnap, markerExists: existsSync(marker) }));
`;
    const result = await runAPIDriver(args.runtime, driverCode, {
      env: { TMPDIR: unwritableParent, NODE_ENV: "test" },
    });
    // The driver process must complete cleanly to print its JSON envelope.
    // Pre-ADR-0004 implementations with eager TMPDIR-dependent module-load
    // work (e.g., a NODE_PATH shim) crash on import and fail this assertion
    // — the test correctly fails until the implementation decouples shim
    // location from `LOOPX_TMPDIR` parent or makes shim creation lazy /
    // failure-tolerant.
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as {
      caught: boolean;
      errMsg: string;
      errName: string;
      beforeSnap: string[];
      afterSnap: string[];
      markerExists: boolean;
    };
    // (a) the surface-appropriate terminal failure surfaces
    expect(data.caught).toBe(true);
    expect(data.errMsg.length).toBeGreaterThan(0);
    stderr = result.stderr;
    markerExists = data.markerExists;
  }

  const after = listLoopxEntries(unwritableParent);

  // (b) stderr contains the variant's package.json warning — proving
  //     SPEC §7.1 step 5 ran to completion before step 6 failed.
  //     Scoped to a line that mentions the workflow name so the pre-
  //     ADR-0004 nodepath-shim mkdirSync EACCES error (which has
  //     "permission denied" text but no workflow name) does not
  //     spuriously satisfy the predicate.
  expect(
    stderrHasPkgJsonVariantWarning(stderr, "ralph", args.variant),
  ).toBe(true);
  // (c) no child spawned (marker absent — step 7 not reached)
  expect(markerExists).toBe(false);
  // (d) no loopx-* directory created under the unwritable parent
  expect(after.slice().sort()).toEqual(before.slice().sort());
  // (v-only) directory at .loopx/ralph/package.json/ preserved unchanged
  if (args.variant === "non-regular") {
    expect(existsSync(wfPkgPath)).toBe(true);
    expect(statSync(wfPkgPath).isDirectory()).toBe(true);
    expect(existsSync(join(wfPkgPath, "README"))).toBe(true);
  }
}

/**
 * Build the bash fixture body shared across T-TMP-16..16j: ralph workflow's
 * `index.sh` observes `$LOOPX_TMPDIR` into a marker file (path external to
 * the tmpdir, so it survives cleanup) and then emits the given `goto` JSON
 * value. Used by every T-TMP-16* test on every surface.
 */
function buildGotoCleanupScript(marker: string, gotoValue: string): string {
  return `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '${gotoValue.replace(/'/g, "'\\''")}'
`;
}

/**
 * Drive `runPromise("ralph", { cwd: project.dir, maxIterations: 2 })` via
 * `runAPIDriver` and return the captured rejection state plus the marker
 * file's contents and existence of the recorded path.
 *
 * Used by T-TMP-16c / 16d / 16h and the runPromise sub-cases of T-TMP-16b /
 * T-TMP-16j. The driver process always exits 0 regardless of the
 * runPromise() rejection — its job is to print the JSON envelope so the
 * test can parse it.
 */
async function driveRunPromiseGotoCleanup(args: {
  runtime: "node" | "bun";
  projectDir: string;
  tmpdirParent: string;
  marker: string;
}): Promise<{
  rejected: boolean;
  errMsg: string;
  observed: string;
  exist: boolean;
}> {
  const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(args.marker)};
let rejected = false;
let errMsg = "";
try {
  await runPromise("ralph", { cwd: ${JSON.stringify(args.projectDir)}, maxIterations: 2 });
} catch (e) {
  rejected = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
let observed = "";
try { observed = readFileSync(marker, "utf-8"); } catch {}
const exist = observed ? existsSync(observed) : false;
console.log(JSON.stringify({ rejected, errMsg, observed, exist }));
`;
  const result = await runAPIDriver(args.runtime, driverCode, {
    env: { TMPDIR: args.tmpdirParent },
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout);
}

/**
 * Drive `run("ralph", { cwd: project.dir, maxIterations: 2 })` driven via
 * `for await` until the goto-resolution failure surfaces as a thrown error.
 * Returns the captured throw state plus the marker contents and existence
 * of the recorded path.
 *
 * Used by T-TMP-16e / 16f / 16i and the run() sub-cases of T-TMP-16b /
 * T-TMP-16j. The driver process always exits 0 regardless of the generator
 * throw — its job is to print the JSON envelope so the test can parse it.
 */
async function driveRunGotoCleanup(args: {
  runtime: "node" | "bun";
  projectDir: string;
  tmpdirParent: string;
  marker: string;
}): Promise<{
  thrown: boolean;
  errMsg: string;
  observed: string;
  exist: boolean;
}> {
  const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(args.marker)};
let thrown = false;
let errMsg = "";
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(args.projectDir)}, maxIterations: 2 });
  for await (const _ of gen) { /* drain */ }
} catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
let observed = "";
try { observed = readFileSync(marker, "utf-8"); } catch {}
const exist = observed ? existsSync(observed) : false;
console.log(JSON.stringify({ thrown, errMsg, observed, exist }));
`;
  const result = await runAPIDriver(args.runtime, driverCode, {
    env: { TMPDIR: args.tmpdirParent },
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout);
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
    // CLI Pre-iteration Failures Must Not Create LOOPX_TMPDIR
    // (T-TMP-12-cli, 10 sub-cases; T-TMP-12-cli-usage, 6 sub-cases)
    //
    // CLI counterpart to T-TMP-12. SPEC §7.4 says tmpdir creation runs only
    // "for each `loopx run` ... that reaches execution"; SPEC §7.1 step 6
    // (tmpdir creation) follows steps 1–5; SPEC §4.1 / §4.2 parser-layer and
    // help-short-circuit boundaries precede the execution pre-iteration
    // sequence entirely. None of those failure modes may create a tmpdir.
    //
    // Each sub-case follows the same harness shape: snapshot the test-
    // isolated TMPDIR parent for `loopx-*` entries before the run, run the
    // CLI invocation, then snapshot again and assert no new `loopx-*` entry
    // was created. The `loopx-nodepath-shim-<pid>` / `loopx-bun-jsx-<pid>`
    // / `loopx-install-*` prefixes are filtered out by `listLoopxEntries`
    // — see the AGENT.md note on this.
    // ========================================================================

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-env-file: missing -e local env file (ENOENT branch).
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-env-file: missing -e env file does not create tmpdir", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run", "-e", "nonexistent.env", "ralph"],
        expectExitCode: 1,
        expectStderrNonEmpty: true,
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-env-file-unreadable: existing-but-unreadable -e local env
    // file (EACCES branch). Conditional on non-root: root reads mode-000
    // files unconditionally, defeating the unreadable-file setup.
    // ------------------------------------------------------------------------
    it.skipIf(IS_ROOT)(
      "T-TMP-12-cli-env-file-unreadable: unreadable -e env file does not create tmpdir",
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
          await assertCLINoTmpdirCreated({
            runtime,
            cwd: project.dir,
            parent: tmpdirParent,
            cliArgs: ["run", "-e", unreadable, "ralph"],
            expectExitCode: 1,
            expectStderrNonEmpty: true,
          });
        } finally {
          await chmod(unreadable, 0o644).catch(() => {});
        }
      },
    );

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-missing-workflow: target resolves to a workflow that does
    // not exist under .loopx/ (target-resolution failure).
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-missing-workflow: missing workflow does not create tmpdir", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run", "nonexistent-workflow"],
        expectExitCode: 1,
        expectStderrNonEmpty: true,
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-missing-script: workflow exists but qualified script
    // (`ralph:check`) does not — distinct target-resolution sub-path.
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-missing-script: missing script in existing workflow does not create tmpdir", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run", "ralph:check"],
        expectExitCode: 1,
        expectStderrNonEmpty: true,
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-missing-default-index: workflow exists but has no `index.*`
    // entry — bare target resolves to `ralph:index` and fails on missing
    // default entry point.
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-missing-default-index: workflow without index.* does not create tmpdir", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "check",
        `printf '{"stop":true}'`,
      );
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run", "ralph"],
        expectExitCode: 1,
        expectStderrNonEmpty: true,
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-target-validation: leading-colon target violates SPEC 4.1
    // delimiter syntax.
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-target-validation: leading-colon target does not create tmpdir", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run", ":script"],
        expectExitCode: 1,
        expectStderrNonEmpty: true,
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-target-name-invalid: name-pattern violation (`.` is not
    // in the SPEC §4.1 `[a-zA-Z0-9_][a-zA-Z0-9_-]*` workflow-name pattern).
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-target-name-invalid: name-pattern violation does not create tmpdir", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run", "bad.name"],
        expectExitCode: 1,
        expectStderrNonEmpty: true,
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-discovery: discovery-time global validation failure
    // (sibling workflow with name-collision in two extensions). SPEC §5.4:
    // global validation is fatal in run mode, so the target-workflow run
    // fails before tmpdir creation.
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-discovery: discovery validation failure does not create tmpdir", async () => {
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
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run", "ralph"],
        expectExitCode: 1,
        expectStderrNonEmpty: true,
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-missing-loopx: project root contains no `.loopx/` at all.
    // SPEC §7.2 missing-`.loopx/`-directory is fatal in run mode; SPEC §7.1
    // step 1 (discovery) runs before step 6 (tmpdir creation).
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-missing-loopx: missing .loopx/ does not create tmpdir", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest({
        withLoopxDir: false,
      });
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run", "ralph"],
        expectExitCode: 1,
        expectStderrNonEmpty: true,
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-global-env-unreadable: unreadable global env file under
    // an isolated XDG_CONFIG_HOME. SPEC §8.1: "If the file exists but is
    // unreadable ... loopx exits with code 1". Conditional on non-root.
    // ------------------------------------------------------------------------
    it.skipIf(IS_ROOT)(
      "T-TMP-12-cli-global-env-unreadable: unreadable global env file does not create tmpdir",
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
          await assertCLINoTmpdirCreated({
            runtime,
            cwd: project.dir,
            parent: tmpdirParent,
            cliArgs: ["run", "-n", "1", "ralph"],
            expectExitCode: 1,
            expectStderrNonEmpty: true,
            extraEnv: { XDG_CONFIG_HOME: xdg },
          });
        } finally {
          await chmod(globalEnv, 0o644).catch(() => {});
        }
      },
    );

    // ========================================================================
    // T-TMP-12-cli-usage (parser-layer failures + run-help short-circuit).
    //
    // Parser-error invocations never enter the SPEC §7.1 execution pre-
    // iteration sequence; help short-circuits exit before execution. SPEC
    // §11.2 permits run-help to perform non-fatal display-side discovery,
    // but that does not create a `LOOPX_TMPDIR`.
    // ========================================================================

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-no-target: bare `loopx run` (no positional, no flags) →
    // usage error, exit 1. The parser rejects the missing-target invocation
    // per SPEC §4.1.
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-no-target: bare `loopx run` does not create tmpdir", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run"],
        expectExitCode: 1,
        expectStderrNonEmpty: true,
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-unknown-flag: `loopx run --unknown ralph` → usage error,
    // exit 1 (per T-CLI-35). The parser rejects `--unknown` before reaching
    // pre-iteration.
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-unknown-flag: unknown flag does not create tmpdir", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run", "--unknown", "ralph"],
        expectExitCode: 1,
        expectStderrNonEmpty: true,
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-duplicate-n: `loopx run -n 3 -n 5 ralph` → usage error,
    // exit 1 (per T-CLI-20a). Duplicate `-n` is rejected at the parser
    // layer before pre-iteration.
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-duplicate-n: duplicate -n does not create tmpdir", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run", "-n", "3", "-n", "5", "ralph"],
        expectExitCode: 1,
        expectStderrNonEmpty: true,
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-duplicate-e: `loopx run -e a.env -e b.env ralph` → usage
    // error, exit 1 (per T-CLI-20b). Duplicate `-e` is rejected at the
    // parser layer before either env-file is loaded.
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-duplicate-e: duplicate -e does not create tmpdir", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      await writeFile(join(project.dir, "a.env"), "A=1\n", "utf-8");
      await writeFile(join(project.dir, "b.env"), "B=2\n", "utf-8");
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run", "-e", "a.env", "-e", "b.env", "ralph"],
        expectExitCode: 1,
        expectStderrNonEmpty: true,
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-help-with-unknown: `loopx run -h --unknown` → run-help
    // short-circuit, exit 0 (per T-CLI-54). The `-h` short-circuit does
    // not enter the execution pre-iteration sequence: no env-file loading,
    // no target resolution, no version check, no tmpdir creation, no
    // script spawn. SPEC §11.2 permits non-fatal display-side discovery,
    // but that does not create a `LOOPX_TMPDIR`.
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-help-with-unknown: run -h --unknown does not create tmpdir", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run", "-h", "--unknown"],
        expectExitCode: 0,
        expectStdoutMatch: /-n\b[\s\S]*-e\b|-e\b[\s\S]*-n\b/i,
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-12-cli-help-with-dashdash: `loopx run --help -- ralph` → run-help
    // short-circuit, exit 0 (per T-CLI-69a). Same short-circuit semantics
    // as T-TMP-12-cli-help-with-unknown but with the long-form `--help` and
    // a `--` token that would otherwise be a usage error.
    // ------------------------------------------------------------------------
    it("T-TMP-12-cli-help-with-dashdash: run --help -- target does not create tmpdir", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"stop":true}'`,
      );
      await assertCLINoTmpdirCreated({
        runtime,
        cwd: project.dir,
        parent: tmpdirParent,
        cliArgs: ["run", "--help", "--", "ralph"],
        expectExitCode: 0,
        expectStdoutMatch: /-n\b[\s\S]*-e\b|-e\b[\s\S]*-n\b/i,
      });
    });

    // ========================================================================
    // Tmpdir Creation Failure (T-TMP-12a / T-TMP-12b / T-TMP-12c)
    //
    // SPEC §7.2 / §7.4 specify that when any step of the tmpdir creation
    // sequence fails, loopx does not spawn any child, the CLI exits 1,
    // run() throws on first next(), and runPromise() rejects. These three
    // tests force a real `mkdtemp` failure (sub-step 1 of SPEC §7.4's
    // creation order) by setting `TMPDIR` to a parent directory whose mode
    // is `0500` — readable but not writable. mkdtemp(<parent>/loopx-) then
    // fails with EACCES, no path is created, and "no path exists, so no
    // cleanup is needed" per SPEC §7.4. The tests assert (a) the surface-
    // appropriate terminal failure surfaces, (b) stderr is non-empty (the
    // tmpdir-creation-failure error text is implementation-defined per
    // SPEC §7.4), (c) the ralph:index marker file does not exist (no
    // child spawned), (d) no `loopx-*` directory was created under the
    // unwritable parent, and (e) zero `LOOPX_TEST_CLEANUP_WARNING\t…`
    // marker lines on stderr — per SPEC §7.4, when `mkdtemp` itself fails
    // "no path exists, so no cleanup is needed"; the cleanup-warning path
    // must not be entered. (e) uses the test-only structured marker
    // contract from TEST-SPEC §1.4 (cleanup-warning lines are gated on
    // `NODE_ENV=test` and prefixed with `LOOPX_TEST_CLEANUP_WARNING\t`).
    //
    // All three sub-cases are conditional on `process.getuid() !== 0`:
    // root can write into a mode-0500 directory unconditionally,
    // defeating the unwritable-parent setup.
    // ========================================================================

    // ------------------------------------------------------------------------
    // T-TMP-12a: CLI — tmpdir creation failure causes exit 1 with no child
    // spawned and no spurious cleanup warning.
    // ------------------------------------------------------------------------
    it.skipIf(IS_ROOT)(
      "T-TMP-12a: CLI tmpdir creation failure exits 1 with no child spawned and no cleanup warning",
      async () => {
        const project = await createTempProject();
        const unwritableParent = await mkdtemp(
          join(tmpdir(), "loopx-test-unwritable-"),
        );
        const marker = join(project.dir, "child-ran.txt");
        const cleanupTask = async () => {
          await chmod(unwritableParent, 0o700).catch(() => {});
          await rm(unwritableParent, { recursive: true, force: true }).catch(
            () => {},
          );
          await project.cleanup().catch(() => {});
        };
        extraCleanups.push(cleanupTask);

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'ran' > "${marker}"\nprintf '{"stop":true}'`,
        );

        // Make the parent unwritable AFTER fixture creation so the bash
        // script and project tree are writable, but mkdtemp under TMPDIR
        // will fail with EACCES.
        await chmod(unwritableParent, 0o500);

        const before = listLoopxEntries(unwritableParent);
        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: { TMPDIR: unwritableParent, NODE_ENV: "test" },
        });
        const after = listLoopxEntries(unwritableParent);

        // (a) exit code 1
        expect(result.exitCode).toBe(1);
        // (b) stderr contains an error message (impl-defined text per §7.4)
        expect(result.stderr.length).toBeGreaterThan(0);
        // (c) the ralph:index marker file does NOT exist (no child spawned)
        expect(existsSync(marker)).toBe(false);
        // (d) no loopx-* directory was created under the unwritable parent
        expect(after.slice().sort()).toEqual(before.slice().sort());
        // (e) zero LOOPX_TEST_CLEANUP_WARNING\t lines on stderr — SPEC §7.4:
        //     "no path exists, so no cleanup is needed". A buggy impl that
        //     emitted a spurious cleanup warning despite no path to clean
        //     up would fail this assertion.
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(0);
      },
    );

    // ------------------------------------------------------------------------
    // T-TMP-12b: run() — tmpdir creation failure throws on first next().
    // ------------------------------------------------------------------------
    it.skipIf(IS_ROOT)(
      "T-TMP-12b: run() tmpdir creation failure throws on first next() with no child spawned and no cleanup warning",
      async () => {
        const project = await createTempProject();
        const unwritableParent = await mkdtemp(
          join(tmpdir(), "loopx-test-unwritable-"),
        );
        const marker = join(project.dir, "child-ran.txt");
        const cleanupTask = async () => {
          await chmod(unwritableParent, 0o700).catch(() => {});
          await rm(unwritableParent, { recursive: true, force: true }).catch(
            () => {},
          );
          await project.cleanup().catch(() => {});
        };
        extraCleanups.push(cleanupTask);

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'ran' > "${marker}"\nprintf '{"stop":true}'`,
        );

        await chmod(unwritableParent, 0o500);

        const before = listLoopxEntries(unwritableParent);
        const driverCode = `
import { run } from "loopx";
import { existsSync, readdirSync } from "node:fs";
const parent = ${JSON.stringify(unwritableParent)};
const marker = ${JSON.stringify(marker)};
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
const beforeSnap = snap();
let caught = false;
let errMsg = "";
let errName = "";
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  await gen.next();
} catch (e) {
  caught = true;
  errMsg = e instanceof Error ? e.message : String(e);
  errName = e instanceof Error ? (e.name || "") : "";
}
const afterSnap = snap();
console.log(JSON.stringify({ caught, errMsg, errName, beforeSnap, afterSnap, markerExists: existsSync(marker) }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: unwritableParent, NODE_ENV: "test" },
        });
        const after = listLoopxEntries(unwritableParent);

        // The driver process must complete cleanly to print its JSON
        // envelope. Pre-ADR-0004 implementations that have eager TMPDIR-
        // dependent module-load work (e.g., a NODE_PATH shim) crash on
        // import and fail this assertion — the test correctly fails
        // until the impl decouples shim location from LOOPX_TMPDIR
        // parent or makes the shim creation lazy / failure-tolerant.
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout) as {
          caught: boolean;
          errMsg: string;
          errName: string;
          beforeSnap: string[];
          afterSnap: string[];
          markerExists: boolean;
        };
        // (a) the generator threw a tmpdir-creation-failure error
        expect(data.caught).toBe(true);
        expect(data.errMsg.length).toBeGreaterThan(0);
        // (b) no child spawned (marker absent)
        expect(data.markerExists).toBe(false);
        // (c) no loopx-* entries appeared during the call
        expect(data.afterSnap.slice().sort()).toEqual(
          data.beforeSnap.slice().sort(),
        );
        // (host-side) the unwritable parent has no loopx-* entries either
        expect(after.slice().sort()).toEqual(before.slice().sort());
        // (d) zero LOOPX_TEST_CLEANUP_WARNING\t lines on stderr
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(0);
      },
    );

    // ------------------------------------------------------------------------
    // T-TMP-12c: runPromise() — tmpdir creation failure rejects.
    // ------------------------------------------------------------------------
    it.skipIf(IS_ROOT)(
      "T-TMP-12c: runPromise() tmpdir creation failure rejects with no child spawned and no cleanup warning",
      async () => {
        const project = await createTempProject();
        const unwritableParent = await mkdtemp(
          join(tmpdir(), "loopx-test-unwritable-"),
        );
        const marker = join(project.dir, "child-ran.txt");
        const cleanupTask = async () => {
          await chmod(unwritableParent, 0o700).catch(() => {});
          await rm(unwritableParent, { recursive: true, force: true }).catch(
            () => {},
          );
          await project.cleanup().catch(() => {});
        };
        extraCleanups.push(cleanupTask);

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'ran' > "${marker}"\nprintf '{"stop":true}'`,
        );

        await chmod(unwritableParent, 0o500);

        const before = listLoopxEntries(unwritableParent);
        const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readdirSync } from "node:fs";
const parent = ${JSON.stringify(unwritableParent)};
const marker = ${JSON.stringify(marker)};
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
const beforeSnap = snap();
let caught = false;
let errMsg = "";
let errName = "";
try {
  await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
} catch (e) {
  caught = true;
  errMsg = e instanceof Error ? e.message : String(e);
  errName = e instanceof Error ? (e.name || "") : "";
}
const afterSnap = snap();
console.log(JSON.stringify({ caught, errMsg, errName, beforeSnap, afterSnap, markerExists: existsSync(marker) }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: unwritableParent, NODE_ENV: "test" },
        });
        const after = listLoopxEntries(unwritableParent);

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout) as {
          caught: boolean;
          errMsg: string;
          errName: string;
          beforeSnap: string[];
          afterSnap: string[];
          markerExists: boolean;
        };
        // (a) the promise rejected with a tmpdir-creation-failure error
        expect(data.caught).toBe(true);
        expect(data.errMsg.length).toBeGreaterThan(0);
        // (b) no child spawned (marker absent)
        expect(data.markerExists).toBe(false);
        // (c) no loopx-* entries appeared during the call
        expect(data.afterSnap.slice().sort()).toEqual(
          data.beforeSnap.slice().sort(),
        );
        expect(after.slice().sort()).toEqual(before.slice().sort());
        // (d) zero LOOPX_TEST_CLEANUP_WARNING\t lines on stderr
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(0);
      },
    );

    // ========================================================================
    // Version-Check-Before-Tmpdir-Creation Ordering
    // (T-TMP-12f / 12f2 / 12f3 / 12f4 / 12f5 — CLI surface;
    //  T-TMP-12g — run() surface; T-TMP-12h — runPromise() surface)
    //
    // SPEC §7.1 normatively orders pre-iteration steps: step 5 is the
    // starting workflow's version check, step 6 is `LOOPX_TMPDIR` creation.
    // When step 5 produces a SPEC §3.2 `package.json` warning *and* step 6
    // fails, loopx must still emit the version-check warning — proving
    // step 5 ran to completion before step 6 attempted `mkdtemp`. A buggy
    // implementation that reordered the steps (e.g., creating the tmpdir
    // first and bailing out before the version check) would suppress the
    // warning and fail (b) on each variant.
    //
    // The fixture composes:
    //   - an unwritable tmpdir parent (chmod 0500) so SPEC §7.1 step 6's
    //     `mkdtemp(<parent>/loopx-)` fails with EACCES (sub-step 1 of SPEC
    //     §7.4 "Creation order"); same setup as T-TMP-12a / 12b / 12c.
    //   - a `.loopx/ralph/package.json` matching one of SPEC §3.2's five
    //     normatively-warning failure-mode branches:
    //       (i)   unsatisfied range  — version mismatch
    //       (ii)  invalid JSON       — parse failure
    //       (iii) invalid semver     — range parse failure
    //       (iv)  unreadable         — chmod 000 (non-root only)
    //       (v)   non-regular path   — `package.json/` is a directory
    //                                  (the new P-0004-03 warning branch)
    //   - a valid `.loopx/ralph/index.sh` that writes a marker file when
    //     executed (proves no child spawns).
    //
    // The CLI surface splits across five test IDs (T-TMP-12f / 12f2 / 12f3
    // / 12f4 / 12f5), one per variant; the programmatic surfaces use one
    // ID per surface (T-TMP-12g for `run()`, T-TMP-12h for `runPromise()`)
    // parameterized over all five variants.
    //
    // All sub-cases are conditional on `process.getuid() !== 0`: the
    // unwritable-parent setup needs non-root for every variant, and the
    // unreadable variant additionally needs non-root for the `chmod 000`
    // setup. One conditional covers both per the SPEC.
    // ========================================================================

    for (const surface of TMPDIR_FAULT_SURFACES) {
      for (const variant of PKG_JSON_VARIANTS) {
        const id = pkgJsonVariantTestId(surface, variant);
        const surfaceLabel =
          surface === "cli"
            ? "CLI"
            : surface === "run"
              ? "run()"
              : "runPromise()";
        // Per-test name retains both the SPEC ID and the variant label.
        // Example names:
        //   "T-TMP-12f (CLI, unsatisfied-range): version warning surfaces..."
        //   "T-TMP-12g (run(), invalid-json): version warning surfaces..."
        //   "T-TMP-12h (runPromise(), non-regular): version warning surfaces..."
        const testName = `${id} (${surfaceLabel}, ${variant}): version-check warning surfaces despite tmpdir creation failure`;
        it.skipIf(IS_ROOT)(testName, async () => {
          await runPkgJsonVariantBeforeTmpdirTest({
            runtime,
            surface,
            variant,
          });
        });
      }
    }

    // ========================================================================
    // Tmpdir Creation Sub-step Coverage
    // (T-TMP-12d / T-TMP-12d2 / T-TMP-12e / T-TMP-12e2 / T-TMP-12e3)
    //
    // SPEC §7.4 "Creation order" specifies three sub-steps with distinct
    // failure-handling behavior:
    //   1. mkdtemp itself fails → no path exists, no cleanup needed.
    //      (covered by T-TMP-12a / 12b / 12c via unwritable parent.)
    //   2. Identity capture fails (after mkdtemp succeeded) → loopx
    //      attempts a single non-recursive rmdir on the path.
    //   3. Mode-securing fails (after mkdtemp + identity capture succeeded)
    //      → loopx runs the full identity-fingerprint cleanup-safety
    //      routine on the partial directory.
    //
    // T-TMP-12d / T-TMP-12e exercise the success-cleanup branches of
    // sub-steps 2 and 3 via the `LOOPX_TEST_TMPDIR_FAULT` seam (TEST-SPEC
    // §1.4). T-TMP-12d2 covers the cleanup-failure-during-creation-failure
    // axis for sub-step 2 via the compound `identity-capture-fail-rmdir-
    // fail` seam value. T-TMP-12e2 / T-TMP-12e3 cover the same axis for
    // sub-step 3's two reachable cleanup-safety failure branches —
    // rule-4 recursive-removal and top-level lstat — via composition with
    // `LOOPX_TEST_CLEANUP_FAULT`.
    //
    // Each sub-case is parameterized over three execution surfaces (CLI /
    // run() / runPromise()) and (per the outer `forEachRuntime`) over node
    // and bun.
    // ========================================================================

    for (const surface of TMPDIR_FAULT_SURFACES) {
      // ----------------------------------------------------------------------
      // T-TMP-12d: identity-capture-fail seam — mkdtemp succeeds, identity
      // capture fails, the single non-recursive rmdir on the empty partial
      // directory succeeds. No residue, no cleanup warning.
      // ----------------------------------------------------------------------
      it(
        `T-TMP-12d (${surface}): identity-capture-fail — partial directory removed via single rmdir, no cleanup warning`,
        async () => {
          await runTmpdirFaultTest({
            runtime,
            surface,
            faultEnv: { LOOPX_TEST_TMPDIR_FAULT: "identity-capture-fail" },
            expectCleanupWarnings: 0,
            expectResidue: false,
          });
        },
      );

      // ----------------------------------------------------------------------
      // T-TMP-12d2: identity-capture-fail × rmdir-fail compound seam —
      // mkdtemp succeeds, identity capture fails, the single non-recursive
      // rmdir itself fails. Residue remains; exactly one cleanup warning.
      // The original tmpdir-creation-failure error is surfaced (not the
      // rmdir cleanup failure) per SPEC §7.4 "does not mask the original
      // creation error".
      // ----------------------------------------------------------------------
      it(
        `T-TMP-12d2 (${surface}): identity-capture-fail-rmdir-fail — partial directory remains, exactly one cleanup warning`,
        async () => {
          await runTmpdirFaultTest({
            runtime,
            surface,
            faultEnv: {
              LOOPX_TEST_TMPDIR_FAULT: "identity-capture-fail-rmdir-fail",
            },
            expectCleanupWarnings: 1,
            expectResidue: true,
          });
        },
      );

      // ----------------------------------------------------------------------
      // T-TMP-12e: mode-secure-fail seam — mkdtemp + identity capture both
      // succeed, mode-securing fails, the full identity-fingerprint cleanup-
      // safety routine runs and recursively removes the partial directory
      // under rule 4 (identity matches). No residue, no cleanup warning.
      // ----------------------------------------------------------------------
      it(
        `T-TMP-12e (${surface}): mode-secure-fail — full cleanup-safety routine recursively removes partial directory, no cleanup warning`,
        async () => {
          await runTmpdirFaultTest({
            runtime,
            surface,
            faultEnv: { LOOPX_TEST_TMPDIR_FAULT: "mode-secure-fail" },
            expectCleanupWarnings: 0,
            expectResidue: false,
          });
        },
      );

      // ----------------------------------------------------------------------
      // T-TMP-12e2: mode-secure-fail × recursive-remove-fail composition —
      // full cleanup-safety routine reaches rule 4 (identity matches), and
      // the recursive removal itself fails with EACCES. Residue remains;
      // exactly one cleanup warning. The original tmpdir-creation-failure
      // error is surfaced (not the recursive-remove cleanup failure) per
      // SPEC §7.4 "does not mask the original creation error".
      // ----------------------------------------------------------------------
      it(
        `T-TMP-12e2 (${surface}): mode-secure-fail × recursive-remove-fail — residue remains, exactly one cleanup warning`,
        async () => {
          await runTmpdirFaultTest({
            runtime,
            surface,
            faultEnv: {
              LOOPX_TEST_TMPDIR_FAULT: "mode-secure-fail",
              LOOPX_TEST_CLEANUP_FAULT: "recursive-remove-fail",
            },
            expectCleanupWarnings: 1,
            expectResidue: true,
          });
        },
      );

      // ----------------------------------------------------------------------
      // T-TMP-12e3: mode-secure-fail × lstat-fail composition — full
      // cleanup-safety routine starts but the top-level lstat itself fails
      // with EACCES, so rule dispatch never proceeds. Partial directory
      // remains; exactly one cleanup warning. The original tmpdir-creation-
      // failure error is surfaced (not the lstat cleanup failure) per
      // SPEC §7.4 "does not mask the original creation error".
      // ----------------------------------------------------------------------
      it(
        `T-TMP-12e3 (${surface}): mode-secure-fail × lstat-fail — partial directory remains, exactly one cleanup warning`,
        async () => {
          await runTmpdirFaultTest({
            runtime,
            surface,
            faultEnv: {
              LOOPX_TEST_TMPDIR_FAULT: "mode-secure-fail",
              LOOPX_TEST_CLEANUP_FAULT: "lstat-fail",
            },
            expectCleanupWarnings: 1,
            expectResidue: true,
          });
        },
      );
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

    // ========================================================================
    // Cleanup on Goto Resolution Failure (T-TMP-16..16j)
    //
    // SPEC §7.4 enumerates two distinct cleanup triggers in the goto
    // resolution path:
    //   - "missing workflow or script during `goto` resolution" — covered by
    //     T-TMP-16 / 16a / 16c / 16d / 16e / 16f (qualified targets) and
    //     T-TMP-16g / 16h / 16i (bare targets in current workflow).
    //   - "invalid `goto` target" — covered by T-TMP-16b (delimiter-syntax:
    //     multi-colon) and T-TMP-16j (name-restriction: leading dash) on all
    //     three execution surfaces (CLI / run() / runPromise()).
    //
    // Each test follows the same shape: ralph/index.sh observes
    // `$LOOPX_TMPDIR` into a marker external to the tmpdir, then emits the
    // failure-mode goto value. The harness asserts the surface-appropriate
    // failure surfaces, the error mentions the expected category-distinct
    // phrasing, the marker captured a non-empty tmpdir path (proving
    // LOOPX_TMPDIR was injected — fails until ADR-0004 is implemented), and
    // the recorded path no longer exists (proving cleanup ran on the
    // failure path — fails until ADR-0004 is implemented).
    // ========================================================================

    // ------------------------------------------------------------------------
    // T-TMP-16: CLI cleanup on missing-workflow goto (qualified target).
    // ------------------------------------------------------------------------
    it("T-TMP-16: CLI cleanup on missing-workflow goto", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(
          marker,
          '{"goto":"nonexistent-workflow:script"}',
        ),
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(1);
      // Stderr distinguishes "missing workflow" from delimiter-syntax /
      // name-restriction errors via the workflow name and "not found".
      expect(result.stderr).toMatch(/nonexistent-workflow/);
      expect(result.stderr).toMatch(/not found|workflow/i);
      const observed = readFileSync(marker, "utf-8");
      expect(observed.length).toBeGreaterThan(0);
      expect(existsSync(observed)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16a: CLI cleanup on missing-script goto in an existing workflow.
    // The qualified-target form `other:missing` reaches the missing-script
    // branch via cross-workflow resolution: workflow `other` exists, script
    // `missing` does not.
    // ------------------------------------------------------------------------
    it("T-TMP-16a: CLI cleanup on missing-script goto (qualified)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(marker, '{"goto":"other:missing"}'),
      );
      await createWorkflowScript(
        project,
        "other",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"stop":true}'\n`,
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(1);
      // Stderr mentions the missing script `missing` and the existing
      // workflow `other` — distinct from the missing-workflow phrasing.
      expect(result.stderr).toMatch(/missing/);
      expect(result.stderr).toMatch(/other/);
      const observed = readFileSync(marker, "utf-8");
      expect(observed.length).toBeGreaterThan(0);
      expect(existsSync(observed)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16b (CLI): truly malformed goto — delimiter-syntax violation.
    // The target `a:b:c` has multiple colons (violating SPEC 4.1's
    // "at most one colon" rule) and is rejected at the delimiter-counting
    // stage of `parseGoto()` — never reaches workflow resolution.
    // ------------------------------------------------------------------------
    it("T-TMP-16b (CLI): cleanup on malformed goto (multi-colon)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(marker, '{"goto":"a:b:c"}'),
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(1);
      // Failure must be about the target shape (multi-colon / delimiter),
      // not target resolution ("workflow not found").
      expect(result.stderr).toMatch(
        /multiple colons|only one .* delimiter|delimiter|invalid (goto|target)/i,
      );
      expect(result.stderr).not.toMatch(/not found in \.loopx\//);
      const observed = readFileSync(marker, "utf-8");
      expect(observed.length).toBeGreaterThan(0);
      expect(existsSync(observed)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16b (run): same fixture as the CLI sub-case, but driven via the
    // `run()` async-generator surface. The first iteration's emitted goto
    // surfaces as a throw on the next `next()` after iteration 1's yield —
    // here we drive via `for await`, which re-raises the throw at the loop
    // boundary. SPEC §9.1 / §9.3.
    // ------------------------------------------------------------------------
    it("T-TMP-16b (run): cleanup on malformed goto (multi-colon)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(marker, '{"goto":"a:b:c"}'),
      );

      const data = await driveRunGotoCleanup({
        runtime,
        projectDir: project.dir,
        tmpdirParent,
        marker,
      });
      expect(data.thrown).toBe(true);
      expect(data.errMsg).toMatch(
        /multiple colons|only one .* delimiter|delimiter|invalid (goto|target)/i,
      );
      expect(data.errMsg).not.toMatch(/not found in \.loopx\//);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16b (runPromise): same fixture, driven via `runPromise()`. SPEC
    // §9.2 / §9.3 — the multi-colon goto-resolution failure surfaces as
    // promise rejection.
    // ------------------------------------------------------------------------
    it("T-TMP-16b (runPromise): cleanup on malformed goto (multi-colon)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(marker, '{"goto":"a:b:c"}'),
      );

      const data = await driveRunPromiseGotoCleanup({
        runtime,
        projectDir: project.dir,
        tmpdirParent,
        marker,
      });
      expect(data.rejected).toBe(true);
      expect(data.errMsg).toMatch(
        /multiple colons|only one .* delimiter|delimiter|invalid (goto|target)/i,
      );
      expect(data.errMsg).not.toMatch(/not found in \.loopx\//);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16c: runPromise() cleanup on missing-workflow goto. Programmatic
    // counterpart to T-TMP-16. SPEC §7.4 / §9.2 / §9.3.
    // ------------------------------------------------------------------------
    it("T-TMP-16c: runPromise() cleanup on missing-workflow goto", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(
          marker,
          '{"goto":"nonexistent-workflow:script"}',
        ),
      );

      const data = await driveRunPromiseGotoCleanup({
        runtime,
        projectDir: project.dir,
        tmpdirParent,
        marker,
      });
      expect(data.rejected).toBe(true);
      expect(data.errMsg).toMatch(/nonexistent-workflow/);
      expect(data.errMsg).toMatch(/not found|workflow/i);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16d: runPromise() cleanup on missing-script goto (qualified).
    // Programmatic counterpart to T-TMP-16a. SPEC §7.4 / §9.2 / §9.3.
    // ------------------------------------------------------------------------
    it("T-TMP-16d: runPromise() cleanup on missing-script goto (qualified)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(marker, '{"goto":"other:missing"}'),
      );
      await createWorkflowScript(
        project,
        "other",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"stop":true}'\n`,
      );

      const data = await driveRunPromiseGotoCleanup({
        runtime,
        projectDir: project.dir,
        tmpdirParent,
        marker,
      });
      expect(data.rejected).toBe(true);
      expect(data.errMsg).toMatch(/missing/);
      expect(data.errMsg).toMatch(/other/);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16e: run() cleanup on missing-workflow goto. Generator-surface
    // counterpart to T-TMP-16c. SPEC §7.4 / §9.1 / §9.3.
    // ------------------------------------------------------------------------
    it("T-TMP-16e: run() cleanup on missing-workflow goto", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(
          marker,
          '{"goto":"nonexistent-workflow:script"}',
        ),
      );

      const data = await driveRunGotoCleanup({
        runtime,
        projectDir: project.dir,
        tmpdirParent,
        marker,
      });
      expect(data.thrown).toBe(true);
      expect(data.errMsg).toMatch(/nonexistent-workflow/);
      expect(data.errMsg).toMatch(/not found|workflow/i);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16f: run() cleanup on missing-script goto (qualified). Generator-
    // surface counterpart to T-TMP-16d. Together with T-TMP-16 / 16a (CLI),
    // T-TMP-16b (malformed-goto, three surfaces), T-TMP-16c/16d (runPromise),
    // and T-TMP-16e/16f (run()), the missing-workflow / missing-script /
    // malformed-goto cleanup triggers are pinned across all three surfaces.
    // SPEC §7.4 / §9.1 / §9.3.
    // ------------------------------------------------------------------------
    it("T-TMP-16f: run() cleanup on missing-script goto (qualified)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(marker, '{"goto":"other:missing"}'),
      );
      await createWorkflowScript(
        project,
        "other",
        "index",
        ".sh",
        `#!/bin/bash\nprintf '{"stop":true}'\n`,
      );

      const data = await driveRunGotoCleanup({
        runtime,
        projectDir: project.dir,
        tmpdirParent,
        marker,
      });
      expect(data.thrown).toBe(true);
      expect(data.errMsg).toMatch(/missing/);
      expect(data.errMsg).toMatch(/other/);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16g: CLI cleanup on bare-name goto resolving to a missing script
    // in the **current** workflow. The bare form `missing` is a same-
    // workflow lookup (not a cross-workflow lookup): the resolver does not
    // consult the workflow registry, only the current workflow's script set.
    // A buggy implementation that skipped cleanup on the same-workflow lookup
    // path would pass T-TMP-16a (qualified) but fail this test. SPEC §7.4 /
    // §7.2 / §4.1 / §2.2.
    // ------------------------------------------------------------------------
    it("T-TMP-16g: CLI cleanup on bare-name missing-script goto", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(marker, '{"goto":"missing"}'),
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(1);
      // Stderr mentions the missing script `missing` in the **current**
      // workflow `ralph` — distinct from T-TMP-16a's qualified phrasing
      // (script in `other`) and from T-TMP-16's missing-workflow phrasing.
      expect(result.stderr).toMatch(/missing/);
      expect(result.stderr).toMatch(/ralph/);
      const observed = readFileSync(marker, "utf-8");
      expect(observed.length).toBeGreaterThan(0);
      expect(existsSync(observed)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16h: runPromise() cleanup on bare-name goto resolving to a
    // missing script in the current workflow. Programmatic counterpart to
    // T-TMP-16g. Mirrors T-TMP-16d (qualified) on the bare-name lookup
    // path. SPEC §7.4 / §9.2 / §9.3 / §2.2.
    // ------------------------------------------------------------------------
    it("T-TMP-16h: runPromise() cleanup on bare-name missing-script goto", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(marker, '{"goto":"missing"}'),
      );

      const data = await driveRunPromiseGotoCleanup({
        runtime,
        projectDir: project.dir,
        tmpdirParent,
        marker,
      });
      expect(data.rejected).toBe(true);
      expect(data.errMsg).toMatch(/missing/);
      expect(data.errMsg).toMatch(/ralph/);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16i: run() cleanup on bare-name goto resolving to a missing
    // script in the current workflow. Generator-surface counterpart to
    // T-TMP-16g / 16h. Together they close the bare-name missing-script
    // cleanup branch across all three surfaces. SPEC §7.4 / §9.1 / §9.3 /
    // §2.2.
    // ------------------------------------------------------------------------
    it("T-TMP-16i: run() cleanup on bare-name missing-script goto", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(marker, '{"goto":"missing"}'),
      );

      const data = await driveRunGotoCleanup({
        runtime,
        projectDir: project.dir,
        tmpdirParent,
        marker,
      });
      expect(data.thrown).toBe(true);
      expect(data.errMsg).toMatch(/missing/);
      expect(data.errMsg).toMatch(/ralph/);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16j (CLI): cleanup on goto whose target violates the SPEC 4.1
    // **name-restriction pattern** (distinct from the delimiter-syntax
    // violations covered by T-TMP-16b). Target `-bad` has zero colons (so
    // delimiter checks pass), but the bare name `-bad` begins with `-`,
    // violating the `[a-zA-Z0-9_]` first-character requirement of SPEC 4.1.
    // A buggy implementation that wired up cleanup on the delimiter branch
    // but missed it on the name-restriction branch (e.g., dispatched the two
    // validation steps through different error paths) would pass T-TMP-16b
    // and fail this test. SPEC §7.4 / §7.2 / §4.1.
    // ------------------------------------------------------------------------
    it("T-TMP-16j (CLI): cleanup on goto with name-restriction violation", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(marker, '{"goto":"-bad"}'),
      );

      const result = await runCLI(["run", "-n", "2", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(1);
      // Stderr mentions the invalid target / name-restriction violation —
      // distinct from "workflow not found" (T-TMP-16) and from "multiple
      // colons" / "delimiter" (T-TMP-16b).
      expect(result.stderr).toMatch(
        /must match \[a-zA-Z|name.?restriction|name pattern|invalid (goto|target)/i,
      );
      expect(result.stderr).toMatch(/-bad/);
      expect(result.stderr).not.toMatch(/not found in \.loopx\//);
      expect(result.stderr).not.toMatch(
        /multiple colons|only one .* delimiter/i,
      );
      const observed = readFileSync(marker, "utf-8");
      expect(observed.length).toBeGreaterThan(0);
      expect(existsSync(observed)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16j (run): same fixture as the CLI sub-case, driven via the
    // `run()` async-generator surface. SPEC §7.4 / §9.1 / §9.3 / §4.1.
    // ------------------------------------------------------------------------
    it("T-TMP-16j (run): cleanup on goto with name-restriction violation", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(marker, '{"goto":"-bad"}'),
      );

      const data = await driveRunGotoCleanup({
        runtime,
        projectDir: project.dir,
        tmpdirParent,
        marker,
      });
      expect(data.thrown).toBe(true);
      expect(data.errMsg).toMatch(
        /must match \[a-zA-Z|name.?restriction|name pattern|invalid (goto|target)/i,
      );
      expect(data.errMsg).toMatch(/-bad/);
      expect(data.errMsg).not.toMatch(/not found in \.loopx\//);
      expect(data.errMsg).not.toMatch(
        /multiple colons|only one .* delimiter/i,
      );
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-16j (runPromise): same fixture, driven via `runPromise()`. Closes
    // both syntactic-invalidity families enumerated by SPEC 4.1 (delimiter
    // + name-restriction) across all three surfaces. SPEC §7.4 / §9.2 /
    // §9.3 / §4.1.
    // ------------------------------------------------------------------------
    it("T-TMP-16j (runPromise): cleanup on goto with name-restriction violation", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildGotoCleanupScript(marker, '{"goto":"-bad"}'),
      );

      const data = await driveRunPromiseGotoCleanup({
        runtime,
        projectDir: project.dir,
        tmpdirParent,
        marker,
      });
      expect(data.rejected).toBe(true);
      expect(data.errMsg).toMatch(
        /must match \[a-zA-Z|name.?restriction|name pattern|invalid (goto|target)/i,
      );
      expect(data.errMsg).toMatch(/-bad/);
      expect(data.errMsg).not.toMatch(/not found in \.loopx\//);
      expect(data.errMsg).not.toMatch(
        /multiple colons|only one .* delimiter/i,
      );
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ========================================================================
    // Cleanup Triggers (T-TMP-17..22f) — signal / abort / consumer cancellation
    // ========================================================================

    // ------------------------------------------------------------------------
    // T-TMP-17: Cleanup on SIGINT (CLI). SPEC §7.4 / §7.3.
    // ------------------------------------------------------------------------
    it("T-TMP-17: cleanup on SIGINT (CLI)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
echo "ready" >&2
sleep 999999
`,
      );

      const { result, sendSignal, waitForStderr } = runCLIWithSignal(
        ["run", "-n", "1", "ralph"],
        { cwd: project.dir, runtime, env: { TMPDIR: tmpdirParent }, timeout: 30_000 },
      );

      await waitForStderr("ready");
      const observed = readFileSync(marker, "utf-8");
      expect(observed.length).toBeGreaterThan(0);

      sendSignal("SIGINT");
      const outcome = await result;
      expect(outcome.exitCode).toBe(130);
      expect(existsSync(observed)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-18: Cleanup on SIGTERM (CLI). SPEC §7.4 / §7.3.
    // ------------------------------------------------------------------------
    it("T-TMP-18: cleanup on SIGTERM (CLI)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
echo "ready" >&2
sleep 999999
`,
      );

      const { result, sendSignal, waitForStderr } = runCLIWithSignal(
        ["run", "-n", "1", "ralph"],
        { cwd: project.dir, runtime, env: { TMPDIR: tmpdirParent }, timeout: 30_000 },
      );

      await waitForStderr("ready");
      const observed = readFileSync(marker, "utf-8");
      expect(observed.length).toBeGreaterThan(0);

      sendSignal("SIGTERM");
      const outcome = await result;
      expect(outcome.exitCode).toBe(143);
      expect(existsSync(observed)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-18a: Signal escalation + cleanup (SIGTERM trapped by child).
    // SPEC §7.3 grace period + SIGKILL escalation × SPEC §7.4 cleanup-after-
    // escalation. Loopx exits with the originally-forwarded signal (143),
    // not the escalation signal it sent to the child (137).
    // ------------------------------------------------------------------------
    it(
      "T-TMP-18a: SIGTERM grace-period escalation followed by tmpdir cleanup",
      async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const tmpdirMarker = join(project.dir, "tmpdir.txt");
        const pidMarker = join(project.dir, "pid.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$$" > "${pidMarker}"
trap '' TERM
echo "ready" >&2
while true; do sleep 1; done
`,
        );

        const { result, sendSignal, waitForStderr } = runCLIWithSignal(
          ["run", "-n", "1", "ralph"],
          { cwd: project.dir, runtime, env: { TMPDIR: tmpdirParent }, timeout: 30_000 },
        );

        await waitForStderr("ready");
        const observed = readFileSync(tmpdirMarker, "utf-8");
        const childPid = parseInt(readFileSync(pidMarker, "utf-8").trim(), 10);
        expect(observed.length).toBeGreaterThan(0);
        expect(Number.isFinite(childPid)).toBe(true);

        const start = Date.now();
        sendSignal("SIGTERM");
        const outcome = await result;
        const elapsed = Date.now() - start;

        // (a) Grace period (~5s) before SIGKILL escalation.
        expect(elapsed).toBeGreaterThanOrEqual(4_000);
        expect(elapsed).toBeLessThanOrEqual(15_000);
        // (b) Loopx exits with 143 (the originally-forwarded SIGTERM), not 137.
        expect(outcome.exitCode).toBe(143);
        // (c) Active child process group has been terminated.
        let childAlive = true;
        try {
          process.kill(childPid, 0);
        } catch {
          childAlive = false;
        }
        expect(childAlive).toBe(false);
        // (d) Tmpdir was removed after escalation completed.
        expect(existsSync(observed)).toBe(false);
      },
      { timeout: 30_000, retry: 3 },
    );

    // ------------------------------------------------------------------------
    // T-TMP-18b: Signal escalation + cleanup (SIGINT trapped by child).
    // SIGINT parity for T-TMP-18a. SPEC §7.3 / §7.4 escalation × cleanup ×
    // signal-symmetry combined contract.
    // ------------------------------------------------------------------------
    it(
      "T-TMP-18b: SIGINT grace-period escalation followed by tmpdir cleanup",
      async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const tmpdirMarker = join(project.dir, "tmpdir.txt");
        const pidMarker = join(project.dir, "pid.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$$" > "${pidMarker}"
trap '' INT
echo "ready" >&2
while true; do sleep 1; done
`,
        );

        const { result, sendSignal, waitForStderr } = runCLIWithSignal(
          ["run", "-n", "1", "ralph"],
          { cwd: project.dir, runtime, env: { TMPDIR: tmpdirParent }, timeout: 30_000 },
        );

        await waitForStderr("ready");
        const observed = readFileSync(tmpdirMarker, "utf-8");
        const childPid = parseInt(readFileSync(pidMarker, "utf-8").trim(), 10);
        expect(observed.length).toBeGreaterThan(0);
        expect(Number.isFinite(childPid)).toBe(true);

        const start = Date.now();
        sendSignal("SIGINT");
        const outcome = await result;
        const elapsed = Date.now() - start;

        // (a) Grace period (~5s) before SIGKILL escalation.
        expect(elapsed).toBeGreaterThanOrEqual(4_000);
        expect(elapsed).toBeLessThanOrEqual(15_000);
        // (b) Loopx exits with 130 (the originally-forwarded SIGINT), not 137.
        expect(outcome.exitCode).toBe(130);
        // (c) Active child process group has been terminated.
        let childAlive = true;
        try {
          process.kill(childPid, 0);
        } catch {
          childAlive = false;
        }
        expect(childAlive).toBe(false);
        // (d) Tmpdir was removed after escalation completed.
        expect(existsSync(observed)).toBe(false);
      },
      { timeout: 30_000, retry: 3 },
    );

    // ------------------------------------------------------------------------
    // T-TMP-19: Cleanup on programmatic AbortSignal abort. SPEC §7.4 / §9.1.
    // ------------------------------------------------------------------------
    it("T-TMP-19: cleanup on programmatic AbortSignal abort", async () => {
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
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const c = new AbortController();
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, signal: c.signal });
const first = await gen.next();
c.abort();
let thrown = false;
let errMsg = "";
let errName = "";
try { await gen.next(); } catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
  errName = e instanceof Error ? (e.name || "") : "";
}
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  firstOk: !first.done,
  thrown,
  errMsg,
  errName,
  observed,
  exist: existsSync(observed),
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.firstOk).toBe(true);
      expect(data.thrown).toBe(true);
      // Abort error: AbortError name OR message containing "abort".
      expect(
        data.errName === "AbortError" || /abort/i.test(data.errMsg),
      ).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-20: Cleanup on `.return()` while first `next()` is pending.
    // The script blocks forever after writing markers; `.return()` aborts
    // the active child PG and settles silently. SPEC §7.4 / §9.1.
    // ------------------------------------------------------------------------
    it("T-TMP-20: cleanup on .return() while first next() pending", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirMarker = join(project.dir, "tmpdir.txt");
      const pidMarker = join(project.dir, "pid.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$$" > "${pidMarker}"
while true; do sleep 1; done
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const tmpdirMarker = ${JSON.stringify(tmpdirMarker)};
const pidMarker = ${JSON.stringify(pidMarker)};
async function waitForMarkers() {
  for (let i = 0; i < 200; i++) {
    if (existsSync(tmpdirMarker) && existsSync(pidMarker)) {
      const t = readFileSync(tmpdirMarker, "utf-8");
      const p = readFileSync(pidMarker, "utf-8").trim();
      if (t.length > 0 && p.length > 0) return { tmpdir: t, pid: parseInt(p, 10) };
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("markers never appeared");
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitDead(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return !isAlive(pid);
}
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)} });
const nextP = gen.next().then(
  (r) => ({ kind: "resolved", done: r.done }),
  (e) => ({ kind: "rejected", msg: e instanceof Error ? e.message : String(e) }),
);
const { tmpdir, pid } = await waitForMarkers();
const settled = await gen.return(undefined);
const nextResult = await nextP;
const childDead = await waitDead(pid, 10_000);
console.log(JSON.stringify({
  tmpdir,
  pid,
  childDead,
  exist: existsSync(tmpdir),
  settledDone: settled.done,
  nextResult,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
        timeout: 30_000,
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      // (a) Active child process group terminated.
      expect(data.childDead).toBe(true);
      // (b) Tmpdir cleanup ran before generator settled.
      expect(data.exist).toBe(false);
      // (c) Generator settles cleanly (silent completion per SPEC §9.1).
      expect(data.settledDone).toBe(true);
    });

    // ------------------------------------------------------------------------
    // T-TMP-21: Cleanup on `.throw()` while first `next()` is pending.
    // Same fixture as T-TMP-20. SPEC §9.1 requires active child PG
    // termination and no further iterations; the consumer-error settlement
    // form is unspecified — assert only PG-termination + tmpdir-cleanup +
    // settlement (resolved or rejected). SPEC §7.4 / §9.1.
    // ------------------------------------------------------------------------
    it("T-TMP-21: cleanup on .throw() while first next() pending", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirMarker = join(project.dir, "tmpdir.txt");
      const pidMarker = join(project.dir, "pid.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$$" > "${pidMarker}"
while true; do sleep 1; done
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const tmpdirMarker = ${JSON.stringify(tmpdirMarker)};
const pidMarker = ${JSON.stringify(pidMarker)};
async function waitForMarkers() {
  for (let i = 0; i < 200; i++) {
    if (existsSync(tmpdirMarker) && existsSync(pidMarker)) {
      const t = readFileSync(tmpdirMarker, "utf-8");
      const p = readFileSync(pidMarker, "utf-8").trim();
      if (t.length > 0 && p.length > 0) return { tmpdir: t, pid: parseInt(p, 10) };
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("markers never appeared");
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitDead(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return !isAlive(pid);
}
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)} });
const nextP = gen.next().then(
  (r) => ({ kind: "resolved", done: r.done }),
  (e) => ({ kind: "rejected", msg: e instanceof Error ? e.message : String(e) }),
);
const { tmpdir, pid } = await waitForMarkers();
let throwResult;
try {
  const r = await gen.throw(new Error("consumer-err"));
  throwResult = { kind: "resolved", done: r.done };
} catch (e) {
  throwResult = { kind: "rejected", msg: e instanceof Error ? e.message : String(e) };
}
const nextResult = await nextP;
const childDead = await waitDead(pid, 10_000);
console.log(JSON.stringify({
  tmpdir,
  pid,
  childDead,
  exist: existsSync(tmpdir),
  throwResult,
  nextResult,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
        timeout: 30_000,
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      // (a) Active child process group terminated.
      expect(data.childDead).toBe(true);
      // (b) Tmpdir cleanup ran before generator settled.
      expect(data.exist).toBe(false);
      // (c) Generator reaches a settled state (resolved or rejected, both OK).
      expect(["resolved", "rejected"]).toContain(data.throwResult.kind);
      // (d) Pending nextP also settles (does not block).
      expect(["resolved", "rejected"]).toContain(data.nextResult.kind);
    });

    // ------------------------------------------------------------------------
    // T-TMP-22: Cleanup on `break` after yield. SPEC §7.4 / §9.1.
    // ------------------------------------------------------------------------
    it("T-TMP-22: cleanup on break after yield", async () => {
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
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)} });
for await (const _ of gen) { break; }
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
    // T-TMP-22a: Cleanup on `.return()` after yield (no active child).
    // Script yields {result:"ok"}, exits, then driver calls .return().
    // SPEC §7.4 / §9.1.
    // ------------------------------------------------------------------------
    it("T-TMP-22a: cleanup on .return() after yield (no active child)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"result":"ok"}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)} });
const first = await gen.next();
const settled = await gen.return(undefined);
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  firstDone: first.done,
  firstHasValue: first.value !== undefined,
  settledDone: settled.done,
  observed,
  exist: existsSync(observed),
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.firstHasValue).toBe(true);
      expect(data.settledDone).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-22b: Cleanup on `.throw()` after yield (no active child).
    // Per SPEC §9.1, .throw() on no-active-child path produces silent
    // completion — consumer-supplied error is swallowed. SPEC §7.4 / §9.1.
    // ------------------------------------------------------------------------
    it("T-TMP-22b: cleanup on .throw() after yield (no active child)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"result":"ok"}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)} });
const first = await gen.next();
let throwResult;
try {
  const r = await gen.throw(new Error("consumer-err"));
  throwResult = { kind: "resolved", done: r.done };
} catch (e) {
  throwResult = { kind: "rejected", msg: e instanceof Error ? e.message : String(e) };
}
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  firstDone: first.done,
  throwResult,
  observed,
  exist: existsSync(observed),
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.firstDone).toBe(false);
      // SPEC §9.1: silent completion — done:true, error not surfaced.
      expect(data.throwResult.kind).toBe("resolved");
      expect(data.throwResult.done).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-22c: Cleanup on `.return()` after final yield (maxIterations:1).
    // Settlement triggers cleanup on the post-final-yield boundary.
    // SPEC §7.4 / §9.1.
    // ------------------------------------------------------------------------
    it("T-TMP-22c: cleanup on .return() after final yield (maxIterations:1)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"result":"ok"}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
const first = await gen.next();
const settled = await gen.return(undefined);
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  firstDone: first.done,
  firstHasValue: first.value !== undefined,
  settledDone: settled.done,
  observed,
  exist: existsSync(observed),
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.firstHasValue).toBe(true);
      expect(data.settledDone).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-22d: Cleanup on `.throw()` after final yield (maxIterations:1).
    // Counterpart to T-TMP-22c. Silent completion per SPEC §9.1 since the
    // script exited before .throw() arrived. SPEC §7.4 / §9.1.
    // ------------------------------------------------------------------------
    it("T-TMP-22d: cleanup on .throw() after final yield (maxIterations:1)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"result":"ok"}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
const first = await gen.next();
let throwResult;
try {
  const r = await gen.throw(new Error("consumer-err"));
  throwResult = { kind: "resolved", done: r.done };
} catch (e) {
  throwResult = { kind: "rejected", msg: e instanceof Error ? e.message : String(e) };
}
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  firstDone: first.done,
  firstHasValue: first.value !== undefined,
  throwResult,
  observed,
  exist: existsSync(observed),
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.firstHasValue).toBe(true);
      expect(data.throwResult.kind).toBe("resolved");
      expect(data.throwResult.done).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-22e: Cleanup on `.return()` after stop:true-driven final yield.
    // Mirrors T-TMP-22c on the stop:true trigger. SPEC §7.4 / §9.1.
    // ------------------------------------------------------------------------
    it("T-TMP-22e: cleanup on .return() after stop:true-driven final yield", async () => {
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
const first = await gen.next();
const settled = await gen.return(undefined);
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  firstDone: first.done,
  firstStop: first.value && first.value.stop === true,
  settledDone: settled.done,
  observed,
  exist: existsSync(observed),
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.firstStop).toBe(true);
      expect(data.settledDone).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-22f: Cleanup on `.throw()` after stop:true-driven final yield.
    // Mirrors T-TMP-22d on the stop:true trigger. Silent completion per
    // SPEC §9.1 since the script exited. SPEC §7.4 / §9.1.
    // ------------------------------------------------------------------------
    it("T-TMP-22f: cleanup on .throw() after stop:true-driven final yield", async () => {
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
const first = await gen.next();
let throwResult;
try {
  const r = await gen.throw(new Error("consumer-err"));
  throwResult = { kind: "resolved", done: r.done };
} catch (e) {
  throwResult = { kind: "rejected", msg: e instanceof Error ? e.message : String(e) };
}
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  firstDone: first.done,
  firstStop: first.value && first.value.stop === true,
  throwResult,
  observed,
  exist: existsSync(observed),
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.firstStop).toBe(true);
      expect(data.throwResult.kind).toBe("resolved");
      expect(data.throwResult.done).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ========================================================================
    // Final-Yield-vs-Settlement Carve-out (T-TMP-23..24g)
    // SPEC §7.4 / §9.1 / §9.3 — settlement triggers cleanup; abort-after-final-
    // yield surfaces the abort error on the next interaction (with cleanup
    // first); external SIGKILL to loopx itself runs no cleanup.
    // ========================================================================

    // ------------------------------------------------------------------------
    // T-TMP-23: After the final yield, cleanup is guaranteed only once the
    // generator settles. The post-final-yield / pre-settlement cleanup state
    // is implementation-defined — only the post-settlement assertion is
    // contractual. SPEC §7.4 / §9.1.
    // ------------------------------------------------------------------------
    it("T-TMP-23: cleanup runs after settlement (post-final-yield, no abort)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"result":"ok"}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
const first = await gen.next();
const observed = readFileSync(marker, "utf-8");
// Intentionally no assertion here about tmpdir existence — SPEC §7.4 leaves
// the post-final-yield / pre-settlement cleanup window implementation-defined.
const settled = await gen.next();
console.log(JSON.stringify({
  firstDone: first.done,
  firstHasValue: first.value !== undefined,
  settledDone: settled.done,
  settledValue: settled.value,
  observed,
  existAfterSettle: existsSync(observed),
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.firstHasValue).toBe(true);
      expect(data.settledDone).toBe(true);
      expect(data.settledValue).toBeUndefined();
      expect(data.observed.length).toBeGreaterThan(0);
      // Settlement triggers cleanup — definite post-condition per SPEC §7.4.
      expect(data.existAfterSettle).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-24: Cleanup via full `for await` completion. `for await` drives
    // settlement automatically; tmpdir is removed after the loop exits.
    // SPEC §7.4 / §9.1.
    // ------------------------------------------------------------------------
    it("T-TMP-24: cleanup via full for-await completion", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"result":"ok"}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
let count = 0;
for await (const _ of gen) { count++; }
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  count,
  observed,
  exist: existsSync(observed),
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.count).toBe(1);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-24a: Abort after final yield (maxIterations:1) + .next() →
    // cleanup runs before the abort error surfaces. SPEC §7.4 / §9.3.
    // ------------------------------------------------------------------------
    it("T-TMP-24a: abort after final yield (maxIter) + .next() → cleanup before abort", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"result":"ok"}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
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
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  firstDone: first.done,
  firstHasValue: first.value !== undefined,
  result,
  observed,
  exist: existsSync(observed),
}));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.firstHasValue).toBe(true);
      expect(data.result.kind).toBe("rejected");
      // Abort error class — DOMException("AbortError") or signal.reason.
      expect(data.result.name === "AbortError" || /abort/i.test(data.result.msg)).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-24c: Abort after final yield (maxIter) + .return() → cleanup
    // before abort error. SPEC §7.4 / §9.3.
    // ------------------------------------------------------------------------
    it("T-TMP-24c: abort after final yield (maxIter) + .return() → cleanup before abort", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"result":"ok"}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
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
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  firstDone: first.done,
  result,
  observed,
  exist: existsSync(observed),
}));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.result.kind).toBe("rejected");
      expect(data.result.name === "AbortError" || /abort/i.test(data.result.msg)).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-24d: Abort after final yield (maxIter) + .throw() → cleanup
    // before abort error (which displaces the consumer-supplied error per
    // SPEC §9.3). SPEC §7.4 / §9.3.
    // ------------------------------------------------------------------------
    it("T-TMP-24d: abort after final yield (maxIter) + .throw() → abort displaces consumer error", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const marker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${marker}"
printf '{"result":"ok"}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
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
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  firstDone: first.done,
  result,
  observed,
  exist: existsSync(observed),
}));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.result.kind).toBe("rejected");
      // Abort error displaces consumer-supplied "consumer-err".
      expect(data.result.msg).not.toBe("consumer-err");
      expect(data.result.name === "AbortError" || /abort/i.test(data.result.msg)).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-24e: Abort after stop:true-driven final yield + .next() →
    // cleanup before abort error. SPEC §7.4 / §9.3.
    // ------------------------------------------------------------------------
    it("T-TMP-24e: abort after stop:true final yield + .next() → cleanup before abort", async () => {
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
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  firstDone: first.done,
  firstStop: first.value && first.value.stop === true,
  result,
  observed,
  exist: existsSync(observed),
}));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.firstDone).toBe(false);
      expect(data.firstStop).toBe(true);
      expect(data.result.kind).toBe("rejected");
      expect(data.result.name === "AbortError" || /abort/i.test(data.result.msg)).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-24f: Abort after stop:true-driven final yield + .return() →
    // cleanup before abort error. SPEC §7.4 / §9.3.
    // ------------------------------------------------------------------------
    it("T-TMP-24f: abort after stop:true final yield + .return() → cleanup before abort", async () => {
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
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  firstStop: first.value && first.value.stop === true,
  result,
  observed,
  exist: existsSync(observed),
}));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.firstStop).toBe(true);
      expect(data.result.kind).toBe("rejected");
      expect(data.result.name === "AbortError" || /abort/i.test(data.result.msg)).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-24g: Abort after stop:true-driven final yield + .throw() →
    // cleanup before abort error (displaces consumer error). SPEC §7.4 / §9.3.
    // ------------------------------------------------------------------------
    it("T-TMP-24g: abort after stop:true final yield + .throw() → abort displaces consumer error", async () => {
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
const observed = readFileSync(marker, "utf-8");
console.log(JSON.stringify({
  firstStop: first.value && first.value.stop === true,
  result,
  observed,
  exist: existsSync(observed),
}));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.firstStop).toBe(true);
      expect(data.result.kind).toBe("rejected");
      expect(data.result.msg).not.toBe("consumer-err");
      expect(data.result.name === "AbortError" || /abort/i.test(data.result.msg)).toBe(true);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.exist).toBe(false);
    });

    // ------------------------------------------------------------------------
    // T-TMP-24b: External SIGKILL to loopx itself does NOT run tmpdir
    // cleanup. SIGKILL cannot be intercepted, so the tmpdir survives the
    // loopx process death. SPEC §7.4. (CLI surface; not parameterized over
    // runtimes — uses node CLI invocation directly.)
    // ------------------------------------------------------------------------
    if (runtime === "node") {
      it("T-TMP-24b: external SIGKILL to loopx leaks tmpdir (no cleanup)", async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const tmpdirMarker = join(project.dir, "tmpdir.txt");
        const pidMarker = join(project.dir, "pid.txt");

        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$$" > "${pidMarker}"
echo "ready" >&2
while true; do sleep 1; done
`,
        );

        const { result, sendSignal, waitForStderr } = runCLIWithSignal(
          ["run", "ralph"],
          {
            cwd: project.dir,
            env: { TMPDIR: tmpdirParent },
            timeout: 30_000,
          },
        );

        await waitForStderr("ready");
        // Read tmpdir + child pid from the markers before killing.
        const observedTmpdir = readFileSync(tmpdirMarker, "utf-8");
        const childPidStr = readFileSync(pidMarker, "utf-8").trim();
        const childPid = parseInt(childPidStr, 10);
        expect(observedTmpdir.length).toBeGreaterThan(0);
        expect(Number.isFinite(childPid) && childPid > 0).toBe(true);

        // SIGKILL the loopx process directly — cleanup cannot run.
        sendSignal("SIGKILL");

        // Brief delay so the SIGKILL takes effect on loopx before we read the
        // tmpdir state. This pins down the "no cleanup runs" contract.
        await new Promise((r) => setTimeout(r, 100));
        // Tmpdir survives because loopx died without running its finally.
        const tmpdirSurvived = existsSync(observedTmpdir);

        // Kill the orphaned child (detached process group via execution.ts).
        // Required so the inherited stderr fd closes and runCLIWithSignal's
        // 'close' event fires; otherwise `await result` would block until
        // the test's outer timeout. This is test plumbing, not the
        // contract under test.
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // Child may already be reaped by the OS.
        }

        const cliResult = await result;
        expect(tmpdirSurvived).toBe(true);
        expect(cliResult.signal).toBe("SIGKILL");
      });
    }

    // ========================================================================
    // Tmpdir Parent Snapshot Timing (T-TMP-25..T-TMP-29k)
    // SPEC §7.4 / §8.1 / §9.1 / §9.2 / §9.5: the tmpdir parent is
    // `os.tmpdir()` evaluated in loopx's own process, captured on the
    // inherited-env snapshot schedule (eager at runPromise() call site,
    // lazy at first next() under run(), pre-iteration for the CLI).
    // `TMPDIR` / `TEMP` / `TMP` entries in env files or RunOptions.env
    // reach spawned scripts but do NOT mutate loopx's own process.env, so
    // they do not redirect the tmpdir parent.
    // ========================================================================

    // ------------------------------------------------------------------------
    // T-TMP-25 / 25a / 25b: CLI surface — tmpdir parent determined
    // pre-iteration from loopx's inherited TMPDIR / TEMP / TMP. SPEC §7.4.
    // ------------------------------------------------------------------------
    it("T-TMP-25: CLI tmpdir parent determined from inherited TMPDIR pre-iteration", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const parent = await makeTestParent("tmpdir25");
      const tmpdirMarker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: parent },
      });
      expect(result.exitCode).toBe(0);
      const observed = readFileSync(tmpdirMarker, "utf-8");
      expect(observed.length).toBeGreaterThan(0);
      expect(isAbsolute(observed)).toBe(true);
      expect(dirname(observed)).toBe(parent);
    });

    it("T-TMP-25a: CLI tmpdir parent via TEMP when TMPDIR unset", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const parent = await makeTestParent("temp25a");
      const tmpdirMarker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '{"stop":true}'
`,
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TMP: undefined,
        TEMP: parent,
      });

      await withInheritedTmpdirEnv(
        { TMPDIR: undefined, TMP: undefined, TEMP: parent },
        async () => {
          const result = await runCLI(["run", "-n", "1", "ralph"], {
            cwd: project.dir,
            runtime,
          });
          expect(result.exitCode).toBe(0);
          const observed = readFileSync(tmpdirMarker, "utf-8");
          expect(observed.length).toBeGreaterThan(0);
          expect(isAbsolute(observed)).toBe(true);
          expect(dirname(observed)).toBe(expectedParent);
        },
      );
    });

    it("T-TMP-25b: CLI tmpdir parent via TMP when TMPDIR and TEMP unset", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const parent = await makeTestParent("tmp25b");
      const tmpdirMarker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '{"stop":true}'
`,
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TEMP: undefined,
        TMP: parent,
      });

      await withInheritedTmpdirEnv(
        { TMPDIR: undefined, TEMP: undefined, TMP: parent },
        async () => {
          const result = await runCLI(["run", "-n", "1", "ralph"], {
            cwd: project.dir,
            runtime,
          });
          expect(result.exitCode).toBe(0);
          const observed = readFileSync(tmpdirMarker, "utf-8");
          expect(observed.length).toBeGreaterThan(0);
          expect(isAbsolute(observed)).toBe(true);
          expect(dirname(observed)).toBe(expectedParent);
        },
      );
    });

    // ------------------------------------------------------------------------
    // T-TMP-26 / 26-temp / 26-tmp: run() generator — tmpdir parent captured
    // lazily on first next(). SPEC §7.4 / §9.1.
    // ------------------------------------------------------------------------
    it("T-TMP-26: run() captures tmpdir parent lazily — TMPDIR mutation between run() and first next() redirects parent", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const parentA = await makeTestParent("p26-A");
      const parentB = await makeTestParent("p26-B");
      const tmpdirMarker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { readFileSync } from "node:fs";
process.env.TMPDIR = ${JSON.stringify(parentA)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
process.env.TMPDIR = ${JSON.stringify(parentB)};
for await (const _ of gen) { /* drain */ }
const observed = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
console.log(JSON.stringify({ observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: parentA },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(dirname(data.observed)).toBe(parentB);
    });

    it("T-TMP-26-temp: run() captures tmpdir parent lazily — TEMP mutation between run() and first next() redirects parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const parentA = await makeTestParent("p26temp-A");
      const parentB = await makeTestParent("p26temp-B");
      const tmpdirMarker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '{"stop":true}'
`,
      );

      // Probe what os.tmpdir() returns in an identically-configured child
      // process (TMPDIR / TMP unset, TEMP=parentB) to anchor the assertion
      // on the runtime's actual `os.tmpdir()` behavior.
      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TMP: undefined,
        TEMP: parentB,
      });

      const driverCode = `
import { run } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TMP;
process.env.TEMP = ${JSON.stringify(parentA)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
process.env.TEMP = ${JSON.stringify(parentB)};
for await (const _ of gen) { /* drain */ }
const observed = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
console.log(JSON.stringify({ observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TEMP: parentA },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(dirname(data.observed)).toBe(expectedParent);
    });

    it("T-TMP-26-tmp: run() captures tmpdir parent lazily — TMP mutation between run() and first next() redirects parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const parentA = await makeTestParent("p26tmp-A");
      const parentB = await makeTestParent("p26tmp-B");
      const tmpdirMarker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '{"stop":true}'
`,
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TEMP: undefined,
        TMP: parentB,
      });

      const driverCode = `
import { run } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TEMP;
process.env.TMP = ${JSON.stringify(parentA)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
process.env.TMP = ${JSON.stringify(parentB)};
for await (const _ of gen) { /* drain */ }
const observed = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
console.log(JSON.stringify({ observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMP: parentA },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(dirname(data.observed)).toBe(expectedParent);
    });

    // ------------------------------------------------------------------------
    // T-TMP-27 / 27-temp / 27-tmp: runPromise() — tmpdir parent captured
    // eagerly at call site. SPEC §7.4 / §9.2.
    // ------------------------------------------------------------------------
    it("T-TMP-27: runPromise() captures tmpdir parent eagerly — TMPDIR mutation after call site does NOT redirect parent", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const parentA = await makeTestParent("p27-A");
      const parentB = await makeTestParent("p27-B");
      const tmpdirMarker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
import { readFileSync } from "node:fs";
process.env.TMPDIR = ${JSON.stringify(parentA)};
const p = runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
process.env.TMPDIR = ${JSON.stringify(parentB)};
await p;
const observed = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
console.log(JSON.stringify({ observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: parentA },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(dirname(data.observed)).toBe(parentA);
    });

    it("T-TMP-27-temp: runPromise() captures tmpdir parent eagerly — TEMP mutation after call site does NOT redirect parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const parentA = await makeTestParent("p27temp-A");
      const parentB = await makeTestParent("p27temp-B");
      const tmpdirMarker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '{"stop":true}'
`,
      );

      // Anchor on the pre-mutation TEMP value (parentA), since the eager
      // snapshot fires at the call site before the mutation to parentB.
      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TMP: undefined,
        TEMP: parentA,
      });

      const driverCode = `
import { runPromise } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TMP;
process.env.TEMP = ${JSON.stringify(parentA)};
const p = runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
process.env.TEMP = ${JSON.stringify(parentB)};
await p;
const observed = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
console.log(JSON.stringify({ observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TEMP: parentA },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(dirname(data.observed)).toBe(expectedParent);
    });

    it("T-TMP-27-tmp: runPromise() captures tmpdir parent eagerly — TMP mutation after call site does NOT redirect parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const parentA = await makeTestParent("p27tmp-A");
      const parentB = await makeTestParent("p27tmp-B");
      const tmpdirMarker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '{"stop":true}'
`,
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TEMP: undefined,
        TMP: parentA,
      });

      const driverCode = `
import { runPromise } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TEMP;
process.env.TMP = ${JSON.stringify(parentA)};
const p = runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
process.env.TMP = ${JSON.stringify(parentB)};
await p;
const observed = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
console.log(JSON.stringify({ observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMP: parentA },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(data.observed.length).toBeGreaterThan(0);
      expect(dirname(data.observed)).toBe(expectedParent);
    });

    // ------------------------------------------------------------------------
    // T-TMP-27a: runPromise() does NOT create LOOPX_TMPDIR synchronously
    // before returning — creation happens asynchronously during the
    // pre-iteration sequence after runPromise() returns. SPEC §9.2 / §7.4.
    // ------------------------------------------------------------------------
    it("T-TMP-27a: runPromise() does not create LOOPX_TMPDIR synchronously before returning", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const parent = await makeTestParent("p27a");
      const tmpdirMarker = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readdirSync, readFileSync } from "node:fs";
const parent = ${JSON.stringify(parent)};
function listLoopx(p) {
  try {
    return readdirSync(p)
      .filter(e => e.startsWith("loopx-"))
      .filter(e => !e.startsWith("loopx-nodepath-shim-") && !e.startsWith("loopx-bun-jsx-") && !e.startsWith("loopx-install-"));
  } catch { return []; }
}
const before = listLoopx(parent);
const p = runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
// Synchronous snapshot — must run before any await / microtask interleaving.
const betweenSync = listLoopx(parent);
await p;
const after = listLoopx(parent);
const observed = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
console.log(JSON.stringify({
  before, betweenSync, after, observed, observedExists: existsSync(observed),
}));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: parent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      // (a) betweenSync set-equals before — runPromise() did NOT create a
      // tmpdir synchronously before returning.
      expect([...data.betweenSync].sort()).toEqual([...data.before].sort());
      // (b) the script observed a LOOPX_TMPDIR value during the run,
      // and that path lives under the configured parent.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(dirname(data.observed)).toBe(parent);
      // (c) after does not contain the just-created loopx-* entry —
      // SPEC §7.4 cleanup ran before runPromise() resolved.
      expect(data.observedExists).toBe(false);
      expect([...data.after].sort()).toEqual([...data.before].sort());
    });

    // ------------------------------------------------------------------------
    // T-TMP-28 / 28a / 28b / 28c-h: Global env file does NOT redirect
    // loopx's own tmpdir parent, but DOES reach spawned scripts. SPEC §7.4
    // / §8.1 / §8.3 / §9.1 / §9.2.
    // ------------------------------------------------------------------------
    it("T-TMP-28: CLI — TMPDIR from global env file does NOT redirect tmpdir parent", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p28-right");
      const wrongParent = await makeTestParent("p28-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpdirMarker = join(project.dir, "tmpdir-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildEnvObserveScript(["TMPDIR"]).replace(
          /\$OBS_LOOPX_TMPDIR_PATH/g,
          tmpdirMarker,
        ).replace(/\$OBS_TMPDIR_PATH/g, observedTmpdirMarker),
      );

      await withGlobalEnv({ TMPDIR: wrongParent }, async () => {
        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: { TMPDIR: rightParent },
        });
        expect(result.exitCode).toBe(0);
        const observedLoopxTmpdir = readFileSync(tmpdirMarker, "utf-8");
        const observedTmpdir = readFileSync(observedTmpdirMarker, "utf-8");
        expect(dirname(observedLoopxTmpdir)).toBe(rightParent);
        expect(observedTmpdir).toBe(wrongParent);
      });
    });

    it("T-TMP-28a: CLI — TEMP from global env file does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p28a-right");
      const wrongParent = await makeTestParent("p28a-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTempMarker = join(project.dir, "temp-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildEnvObserveScript(["TEMP"]).replace(
          /\$OBS_LOOPX_TMPDIR_PATH/g,
          tmpdirMarker,
        ).replace(/\$OBS_TEMP_PATH/g, observedTempMarker),
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TMP: undefined,
        TEMP: rightParent,
      });

      await withGlobalEnv({ TEMP: wrongParent }, async () => {
        await withInheritedTmpdirEnv(
          { TMPDIR: undefined, TMP: undefined, TEMP: rightParent },
          async () => {
            const result = await runCLI(["run", "-n", "1", "ralph"], {
              cwd: project.dir,
              runtime,
            });
            expect(result.exitCode).toBe(0);
            const observedLoopxTmpdir = readFileSync(tmpdirMarker, "utf-8");
            const observedTemp = readFileSync(observedTempMarker, "utf-8");
            expect(dirname(observedLoopxTmpdir)).toBe(expectedParent);
            expect(observedTemp).toBe(wrongParent);
          },
        );
      });
    });

    it("T-TMP-28b: CLI — TMP from global env file does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p28b-right");
      const wrongParent = await makeTestParent("p28b-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpMarker = join(project.dir, "tmp-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildEnvObserveScript(["TMP"]).replace(
          /\$OBS_LOOPX_TMPDIR_PATH/g,
          tmpdirMarker,
        ).replace(/\$OBS_TMP_PATH/g, observedTmpMarker),
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TEMP: undefined,
        TMP: rightParent,
      });

      await withGlobalEnv({ TMP: wrongParent }, async () => {
        await withInheritedTmpdirEnv(
          { TMPDIR: undefined, TEMP: undefined, TMP: rightParent },
          async () => {
            const result = await runCLI(["run", "-n", "1", "ralph"], {
              cwd: project.dir,
              runtime,
            });
            expect(result.exitCode).toBe(0);
            const observedLoopxTmpdir = readFileSync(tmpdirMarker, "utf-8");
            const observedTmp = readFileSync(observedTmpMarker, "utf-8");
            expect(dirname(observedLoopxTmpdir)).toBe(expectedParent);
            expect(observedTmp).toBe(wrongParent);
          },
        );
      });
    });

    it("T-TMP-28c: runPromise() — TMPDIR from global env file does NOT redirect tmpdir parent", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p28c-right");
      const wrongParent = await makeTestParent("p28c-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpdirMarker = join(project.dir, "tmpdir-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildEnvObserveScript(["TMPDIR"]).replace(
          /\$OBS_LOOPX_TMPDIR_PATH/g,
          tmpdirMarker,
        ).replace(/\$OBS_TMPDIR_PATH/g, observedTmpdirMarker),
      );

      const driverCode = `
import { runPromise } from "loopx";
import { readFileSync } from "node:fs";
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTmpdirMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      await withGlobalEnv({ TMPDIR: wrongParent }, async () => {
        const apiResult = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: rightParent },
        });
        expect(apiResult.exitCode).toBe(0);
        const data = JSON.parse(apiResult.stdout);
        expect(dirname(data.loopx)).toBe(rightParent);
        expect(data.observed).toBe(wrongParent);
      });
    });

    it("T-TMP-28d: runPromise() — TEMP from global env file does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p28d-right");
      const wrongParent = await makeTestParent("p28d-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTempMarker = join(project.dir, "temp-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildEnvObserveScript(["TEMP"]).replace(
          /\$OBS_LOOPX_TMPDIR_PATH/g,
          tmpdirMarker,
        ).replace(/\$OBS_TEMP_PATH/g, observedTempMarker),
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TMP: undefined,
        TEMP: rightParent,
      });

      const driverCode = `
import { runPromise } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TMP;
process.env.TEMP = ${JSON.stringify(rightParent)};
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTempMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      await withGlobalEnv({ TEMP: wrongParent }, async () => {
        const apiResult = await runAPIDriver(runtime, driverCode, {
          env: { TEMP: rightParent },
        });
        expect(apiResult.exitCode).toBe(0);
        const data = JSON.parse(apiResult.stdout);
        expect(dirname(data.loopx)).toBe(expectedParent);
        expect(data.observed).toBe(wrongParent);
      });
    });

    it("T-TMP-28e: runPromise() — TMP from global env file does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p28e-right");
      const wrongParent = await makeTestParent("p28e-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpMarker = join(project.dir, "tmp-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildEnvObserveScript(["TMP"]).replace(
          /\$OBS_LOOPX_TMPDIR_PATH/g,
          tmpdirMarker,
        ).replace(/\$OBS_TMP_PATH/g, observedTmpMarker),
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TEMP: undefined,
        TMP: rightParent,
      });

      const driverCode = `
import { runPromise } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TEMP;
process.env.TMP = ${JSON.stringify(rightParent)};
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTmpMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      await withGlobalEnv({ TMP: wrongParent }, async () => {
        const apiResult = await runAPIDriver(runtime, driverCode, {
          env: { TMP: rightParent },
        });
        expect(apiResult.exitCode).toBe(0);
        const data = JSON.parse(apiResult.stdout);
        expect(dirname(data.loopx)).toBe(expectedParent);
        expect(data.observed).toBe(wrongParent);
      });
    });

    it("T-TMP-28f: run() generator — TMPDIR from global env file does NOT redirect tmpdir parent", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p28f-right");
      const wrongParent = await makeTestParent("p28f-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpdirMarker = join(project.dir, "tmpdir-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildEnvObserveScript(["TMPDIR"]).replace(
          /\$OBS_LOOPX_TMPDIR_PATH/g,
          tmpdirMarker,
        ).replace(/\$OBS_TMPDIR_PATH/g, observedTmpdirMarker),
      );

      const driverCode = `
import { run } from "loopx";
import { readFileSync } from "node:fs";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
for await (const _ of gen) { /* drain */ }
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTmpdirMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      await withGlobalEnv({ TMPDIR: wrongParent }, async () => {
        const apiResult = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: rightParent },
        });
        expect(apiResult.exitCode).toBe(0);
        const data = JSON.parse(apiResult.stdout);
        expect(dirname(data.loopx)).toBe(rightParent);
        expect(data.observed).toBe(wrongParent);
      });
    });

    it("T-TMP-28g: run() generator — TEMP from global env file does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p28g-right");
      const wrongParent = await makeTestParent("p28g-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTempMarker = join(project.dir, "temp-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildEnvObserveScript(["TEMP"]).replace(
          /\$OBS_LOOPX_TMPDIR_PATH/g,
          tmpdirMarker,
        ).replace(/\$OBS_TEMP_PATH/g, observedTempMarker),
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TMP: undefined,
        TEMP: rightParent,
      });

      const driverCode = `
import { run } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TMP;
process.env.TEMP = ${JSON.stringify(rightParent)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
for await (const _ of gen) { /* drain */ }
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTempMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      await withGlobalEnv({ TEMP: wrongParent }, async () => {
        const apiResult = await runAPIDriver(runtime, driverCode, {
          env: { TEMP: rightParent },
        });
        expect(apiResult.exitCode).toBe(0);
        const data = JSON.parse(apiResult.stdout);
        expect(dirname(data.loopx)).toBe(expectedParent);
        expect(data.observed).toBe(wrongParent);
      });
    });

    it("T-TMP-28h: run() generator — TMP from global env file does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p28h-right");
      const wrongParent = await makeTestParent("p28h-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpMarker = join(project.dir, "tmp-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildEnvObserveScript(["TMP"]).replace(
          /\$OBS_LOOPX_TMPDIR_PATH/g,
          tmpdirMarker,
        ).replace(/\$OBS_TMP_PATH/g, observedTmpMarker),
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TEMP: undefined,
        TMP: rightParent,
      });

      const driverCode = `
import { run } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TEMP;
process.env.TMP = ${JSON.stringify(rightParent)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
for await (const _ of gen) { /* drain */ }
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTmpMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      await withGlobalEnv({ TMP: wrongParent }, async () => {
        const apiResult = await runAPIDriver(runtime, driverCode, {
          env: { TMP: rightParent },
        });
        expect(apiResult.exitCode).toBe(0);
        const data = JSON.parse(apiResult.stdout);
        expect(dirname(data.loopx)).toBe(expectedParent);
        expect(data.observed).toBe(wrongParent);
      });
    });

    // ------------------------------------------------------------------------
    // T-TMP-29 / 29b / 29c: RunOptions.env does NOT redirect loopx's own
    // tmpdir parent. SPEC §7.4 / §9.5 / §8.3.
    // ------------------------------------------------------------------------
    it("T-TMP-29: RunOptions.env TMPDIR does NOT redirect tmpdir parent", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p29-right");
      const wrongParent = "/tmp/loopx-p29-wrong-does-not-exist";
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpdirMarker = join(project.dir, "tmpdir-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildEnvObserveScript(["TMPDIR"]).replace(
          /\$OBS_LOOPX_TMPDIR_PATH/g,
          tmpdirMarker,
        ).replace(/\$OBS_TMPDIR_PATH/g, observedTmpdirMarker),
      );

      const driverCode = `
import { runPromise } from "loopx";
import { readFileSync } from "node:fs";
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, env: { TMPDIR: ${JSON.stringify(wrongParent)} } });
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTmpdirMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: rightParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(dirname(data.loopx)).toBe(rightParent);
      expect(data.observed).toBe(wrongParent);
    });

    it("T-TMP-29b: RunOptions.env TEMP does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p29b-right");
      const wrongParent = "/tmp/loopx-p29b-wrong-does-not-exist";
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTempMarker = join(project.dir, "temp-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildEnvObserveScript(["TEMP"]).replace(
          /\$OBS_LOOPX_TMPDIR_PATH/g,
          tmpdirMarker,
        ).replace(/\$OBS_TEMP_PATH/g, observedTempMarker),
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TMP: undefined,
        TEMP: rightParent,
      });

      const driverCode = `
import { runPromise } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TMP;
process.env.TEMP = ${JSON.stringify(rightParent)};
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, env: { TEMP: ${JSON.stringify(wrongParent)} } });
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTempMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TEMP: rightParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(dirname(data.loopx)).toBe(expectedParent);
      expect(data.observed).toBe(wrongParent);
    });

    it("T-TMP-29c: RunOptions.env TMP does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p29c-right");
      const wrongParent = "/tmp/loopx-p29c-wrong-does-not-exist";
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpMarker = join(project.dir, "tmp-env.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildEnvObserveScript(["TMP"]).replace(
          /\$OBS_LOOPX_TMPDIR_PATH/g,
          tmpdirMarker,
        ).replace(/\$OBS_TMP_PATH/g, observedTmpMarker),
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TEMP: undefined,
        TMP: rightParent,
      });

      const driverCode = `
import { runPromise } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TEMP;
process.env.TMP = ${JSON.stringify(rightParent)};
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1, env: { TMP: ${JSON.stringify(wrongParent)} } });
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTmpMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMP: rightParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(dirname(data.loopx)).toBe(expectedParent);
      expect(data.observed).toBe(wrongParent);
    });

    // ------------------------------------------------------------------------
    // T-TMP-29a / 29d / 29e: CLI -e local env file does NOT redirect
    // loopx's own tmpdir parent. SPEC §7.4 / §8.2 / §8.3.
    // ------------------------------------------------------------------------
    it("T-TMP-29a: CLI -e — TMPDIR from local env file does NOT redirect tmpdir parent", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p29a-right");
      const wrongParent = await makeTestParent("p29a-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpdirMarker = join(project.dir, "tmpdir-env.txt");
      const statMarker = join(project.dir, "stat.txt");
      const envFilePath = join(project.dir, "local.env");
      await createEnvFile(envFilePath, { TMPDIR: wrongParent });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$TMPDIR" > "${observedTmpdirMarker}"
if [ -d "$LOOPX_TMPDIR" ]; then
  printf 'exists-as-dir' > "${statMarker}"
else
  printf 'missing' > "${statMarker}"
fi
printf '{"stop":true}'
`,
      );

      const result = await runCLI(
        ["run", "-e", envFilePath, "-n", "1", "ralph"],
        {
          cwd: project.dir,
          runtime,
          env: { TMPDIR: rightParent },
        },
      );
      expect(result.exitCode).toBe(0);
      const observedLoopxTmpdir = readFileSync(tmpdirMarker, "utf-8");
      const observedTmpdir = readFileSync(observedTmpdirMarker, "utf-8");
      const stat = readFileSync(statMarker, "utf-8");
      expect(observedTmpdir).toBe(wrongParent);
      expect(dirname(observedLoopxTmpdir)).toBe(rightParent);
      expect(stat).toBe("exists-as-dir");
    });

    it("T-TMP-29d: CLI -e — TEMP from local env file does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p29d-right");
      const wrongParent = await makeTestParent("p29d-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTempMarker = join(project.dir, "temp-env.txt");
      const envFilePath = join(project.dir, "local.env");
      await createEnvFile(envFilePath, { TEMP: wrongParent });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$TEMP" > "${observedTempMarker}"
printf '{"stop":true}'
`,
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TMP: undefined,
        TEMP: rightParent,
      });

      await withInheritedTmpdirEnv(
        { TMPDIR: undefined, TMP: undefined, TEMP: rightParent },
        async () => {
          const result = await runCLI(
            ["run", "-e", envFilePath, "-n", "1", "ralph"],
            {
              cwd: project.dir,
              runtime,
            },
          );
          expect(result.exitCode).toBe(0);
          const observedLoopxTmpdir = readFileSync(tmpdirMarker, "utf-8");
          const observedTemp = readFileSync(observedTempMarker, "utf-8");
          expect(dirname(observedLoopxTmpdir)).toBe(expectedParent);
          expect(observedTemp).toBe(wrongParent);
        },
      );
    });

    it("T-TMP-29e: CLI -e — TMP from local env file does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p29e-right");
      const wrongParent = await makeTestParent("p29e-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpMarker = join(project.dir, "tmp-env.txt");
      const envFilePath = join(project.dir, "local.env");
      await createEnvFile(envFilePath, { TMP: wrongParent });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$TMP" > "${observedTmpMarker}"
printf '{"stop":true}'
`,
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TEMP: undefined,
        TMP: rightParent,
      });

      await withInheritedTmpdirEnv(
        { TMPDIR: undefined, TEMP: undefined, TMP: rightParent },
        async () => {
          const result = await runCLI(
            ["run", "-e", envFilePath, "-n", "1", "ralph"],
            {
              cwd: project.dir,
              runtime,
            },
          );
          expect(result.exitCode).toBe(0);
          const observedLoopxTmpdir = readFileSync(tmpdirMarker, "utf-8");
          const observedTmp = readFileSync(observedTmpMarker, "utf-8");
          expect(dirname(observedLoopxTmpdir)).toBe(expectedParent);
          expect(observedTmp).toBe(wrongParent);
        },
      );
    });

    // ------------------------------------------------------------------------
    // T-TMP-29f / 29g / 29h: RunOptions.envFile under runPromise() does NOT
    // redirect loopx's own tmpdir parent. SPEC §7.4 / §8.2 / §8.3 / §9.5.
    // ------------------------------------------------------------------------
    it("T-TMP-29f: runPromise({ envFile }) — TMPDIR from local env file does NOT redirect tmpdir parent", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p29f-right");
      const wrongParent = await makeTestParent("p29f-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpdirMarker = join(project.dir, "tmpdir-env.txt");
      const envFilePath = join(project.dir, "local.env");
      await createEnvFile(envFilePath, { TMPDIR: wrongParent });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$TMPDIR" > "${observedTmpdirMarker}"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
import { readFileSync } from "node:fs";
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, envFile: ${JSON.stringify(envFilePath)}, maxIterations: 1 });
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTmpdirMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: rightParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(dirname(data.loopx)).toBe(rightParent);
      expect(data.observed).toBe(wrongParent);
    });

    it("T-TMP-29g: runPromise({ envFile }) — TEMP from local env file does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p29g-right");
      const wrongParent = await makeTestParent("p29g-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTempMarker = join(project.dir, "temp-env.txt");
      const envFilePath = join(project.dir, "local.env");
      await createEnvFile(envFilePath, { TEMP: wrongParent });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$TEMP" > "${observedTempMarker}"
printf '{"stop":true}'
`,
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TMP: undefined,
        TEMP: rightParent,
      });

      const driverCode = `
import { runPromise } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TMP;
process.env.TEMP = ${JSON.stringify(rightParent)};
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, envFile: ${JSON.stringify(envFilePath)}, maxIterations: 1 });
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTempMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TEMP: rightParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(dirname(data.loopx)).toBe(expectedParent);
      expect(data.observed).toBe(wrongParent);
    });

    it("T-TMP-29h: runPromise({ envFile }) — TMP from local env file does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p29h-right");
      const wrongParent = await makeTestParent("p29h-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpMarker = join(project.dir, "tmp-env.txt");
      const envFilePath = join(project.dir, "local.env");
      await createEnvFile(envFilePath, { TMP: wrongParent });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$TMP" > "${observedTmpMarker}"
printf '{"stop":true}'
`,
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TEMP: undefined,
        TMP: rightParent,
      });

      const driverCode = `
import { runPromise } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TEMP;
process.env.TMP = ${JSON.stringify(rightParent)};
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, envFile: ${JSON.stringify(envFilePath)}, maxIterations: 1 });
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTmpMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMP: rightParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(dirname(data.loopx)).toBe(expectedParent);
      expect(data.observed).toBe(wrongParent);
    });

    // ------------------------------------------------------------------------
    // T-TMP-29i / 29j / 29k: RunOptions.envFile under run() generator does
    // NOT redirect loopx's own tmpdir parent. SPEC §7.4 / §8.2 / §8.3 /
    // §9.1 / §9.5.
    // ------------------------------------------------------------------------
    it("T-TMP-29i: run({ envFile }) — TMPDIR from local env file does NOT redirect tmpdir parent", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p29i-right");
      const wrongParent = await makeTestParent("p29i-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpdirMarker = join(project.dir, "tmpdir-env.txt");
      const envFilePath = join(project.dir, "local.env");
      await createEnvFile(envFilePath, { TMPDIR: wrongParent });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$TMPDIR" > "${observedTmpdirMarker}"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { readFileSync } from "node:fs";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, envFile: ${JSON.stringify(envFilePath)}, maxIterations: 1 });
for await (const _ of gen) { /* drain */ }
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTmpdirMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: rightParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(dirname(data.loopx)).toBe(rightParent);
      expect(data.observed).toBe(wrongParent);
    });

    it("T-TMP-29j: run({ envFile }) — TEMP from local env file does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p29j-right");
      const wrongParent = await makeTestParent("p29j-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTempMarker = join(project.dir, "temp-env.txt");
      const envFilePath = join(project.dir, "local.env");
      await createEnvFile(envFilePath, { TEMP: wrongParent });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$TEMP" > "${observedTempMarker}"
printf '{"stop":true}'
`,
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TMP: undefined,
        TEMP: rightParent,
      });

      const driverCode = `
import { run } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TMP;
process.env.TEMP = ${JSON.stringify(rightParent)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, envFile: ${JSON.stringify(envFilePath)}, maxIterations: 1 });
for await (const _ of gen) { /* drain */ }
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTempMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TEMP: rightParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(dirname(data.loopx)).toBe(expectedParent);
      expect(data.observed).toBe(wrongParent);
    });

    it("T-TMP-29k: run({ envFile }) — TMP from local env file does NOT redirect tmpdir parent (runtime-aware)", async () => {
      const project = await createTempProject();
      extraCleanups.push(() => project.cleanup());
      const rightParent = await makeTestParent("p29k-right");
      const wrongParent = await makeTestParent("p29k-wrong");
      const tmpdirMarker = join(project.dir, "loopx-tmpdir.txt");
      const observedTmpMarker = join(project.dir, "tmp-env.txt");
      const envFilePath = join(project.dir, "local.env");
      await createEnvFile(envFilePath, { TMP: wrongParent });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirMarker}"
printf '%s' "$TMP" > "${observedTmpMarker}"
printf '{"stop":true}'
`,
      );

      const expectedParent = getRuntimeOsTmpdir(runtime, {
        TMPDIR: undefined,
        TEMP: undefined,
        TMP: rightParent,
      });

      const driverCode = `
import { run } from "loopx";
import { readFileSync } from "node:fs";
delete process.env.TMPDIR;
delete process.env.TEMP;
process.env.TMP = ${JSON.stringify(rightParent)};
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, envFile: ${JSON.stringify(envFilePath)}, maxIterations: 1 });
for await (const _ of gen) { /* drain */ }
const loopx = readFileSync(${JSON.stringify(tmpdirMarker)}, "utf-8");
const observed = readFileSync(${JSON.stringify(observedTmpMarker)}, "utf-8");
console.log(JSON.stringify({ loopx, observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMP: rightParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);
      expect(dirname(data.loopx)).toBe(expectedParent);
      expect(data.observed).toBe(wrongParent);
    });

    // ========================================================================
    // T-TMP-32 / T-TMP-32a / T-TMP-32b / T-TMP-32c — Stale-tmpdir non-reaping.
    // T-TMP-33 — Renamed-away tmpdir cleanup is silent (no warning).
    //
    // SPEC §7.4: "loopx does not reap stale tmpdirs during CLI startup, CLI
    // `loopx run` setup, or any per-run setup performed for `run()` /
    // `runPromise()`. A run setup creates only its own `mkdtemp` directory
    // under the selected parent and does not scan for, validate, or remove
    // pre-existing `loopx-*` entries under that parent."
    //
    // SPEC §7.4: "A script that removes or renames its tmpdir during the run
    // defeats automatic cleanup of the moved directory; loopx does not chase
    // renamed tmpdirs." Plus cleanup-safety rule 1: "Path no longer exists
    // (ENOENT): no-op." T-TMP-33 pins down that the ENOENT no-op is silent
    // (no cleanup warning), so warning cardinality across the cleanup-
    // dispatch tree is fully characterized.
    // ========================================================================

    // ------------------------------------------------------------------------
    // T-TMP-32: No stale-tmpdir reaping during CLI `loopx run` setup.
    // ------------------------------------------------------------------------
    it("T-TMP-32: CLI run setup does not reap pre-existing loopx-* entries", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const stalePath = join(tmpdirParent, "loopx-stale-xyz");
      const staleMarker = join(stalePath, "marker.txt");
      await mkdir(stalePath, { recursive: true });
      await writeFile(staleMarker, "preexisting", "utf-8");

      const tmpdirObservation = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);

      // (a) Stale entry survives intact — loopx did not reap it.
      expect(existsSync(stalePath)).toBe(true);
      expect(existsSync(staleMarker)).toBe(true);
      expect(readFileSync(staleMarker, "utf-8")).toBe("preexisting");

      // (b) loopx's own freshly-created tmpdir was cleaned up after the run.
      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      expect(observedLoopxTmpdir.length).toBeGreaterThan(0);
      expect(dirname(observedLoopxTmpdir)).toBe(tmpdirParent);
      expect(observedLoopxTmpdir).not.toBe(stalePath);
      expect(existsSync(observedLoopxTmpdir)).toBe(false);

      // (c) Only the stale entry remains under the parent — no new loopx-*
      // entries leaked, and loopx did not delete the stale entry.
      expect(listLoopxEntries(tmpdirParent)).toEqual(["loopx-stale-xyz"]);
    });

    // ------------------------------------------------------------------------
    // T-TMP-32a: No stale-tmpdir reaping during runPromise() setup.
    // ------------------------------------------------------------------------
    it("T-TMP-32a: runPromise() setup does not reap pre-existing loopx-* entries", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const stalePath = join(tmpdirParent, "loopx-stale-xyz");
      const staleMarker = join(stalePath, "marker.txt");
      await mkdir(stalePath, { recursive: true });
      await writeFile(staleMarker, "preexisting", "utf-8");

      const tmpdirObservation = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
import { readFileSync } from "node:fs";
await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
const observed = readFileSync(${JSON.stringify(tmpdirObservation)}, "utf-8");
console.log(JSON.stringify({ observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);

      // (a) Stale entry survives.
      expect(existsSync(stalePath)).toBe(true);
      expect(existsSync(staleMarker)).toBe(true);
      expect(readFileSync(staleMarker, "utf-8")).toBe("preexisting");

      // (b) loopx's tmpdir lived under the parent and is now cleaned up.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(dirname(data.observed)).toBe(tmpdirParent);
      expect(data.observed).not.toBe(stalePath);
      expect(existsSync(data.observed)).toBe(false);

      // (c) Only the stale entry remains.
      expect(listLoopxEntries(tmpdirParent)).toEqual(["loopx-stale-xyz"]);
    });

    // ------------------------------------------------------------------------
    // T-TMP-32b: No stale-tmpdir reaping during run() setup.
    // ------------------------------------------------------------------------
    it("T-TMP-32b: run() setup does not reap pre-existing loopx-* entries", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const stalePath = join(tmpdirParent, "loopx-stale-xyz");
      const staleMarker = join(stalePath, "marker.txt");
      await mkdir(stalePath, { recursive: true });
      await writeFile(staleMarker, "preexisting", "utf-8");

      const tmpdirObservation = join(project.dir, "tmpdir.txt");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { readFileSync } from "node:fs";
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
for await (const _ of gen) { /* drain */ }
const observed = readFileSync(${JSON.stringify(tmpdirObservation)}, "utf-8");
console.log(JSON.stringify({ observed }));
`;
      const apiResult = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(apiResult.exitCode).toBe(0);
      const data = JSON.parse(apiResult.stdout);

      // (a) Stale entry survives.
      expect(existsSync(stalePath)).toBe(true);
      expect(existsSync(staleMarker)).toBe(true);
      expect(readFileSync(staleMarker, "utf-8")).toBe("preexisting");

      // (b) loopx's tmpdir lived under the parent and is now cleaned up.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(dirname(data.observed)).toBe(tmpdirParent);
      expect(data.observed).not.toBe(stalePath);
      expect(existsSync(data.observed)).toBe(false);

      // (c) Only the stale entry remains.
      expect(listLoopxEntries(tmpdirParent)).toEqual(["loopx-stale-xyz"]);
    });

    // ------------------------------------------------------------------------
    // T-TMP-32c: No stale-tmpdir reaping during non-`run` CLI startup.
    //
    // Four sub-cases exercise SPEC §7.4's literal "CLI startup" enumeration
    // through CLI invocations that do NOT reach `loopx run` setup:
    //   - c-help:         `loopx -h`         (top-level help short-circuit, exit 0)
    //   - c-version:      `loopx version`    (version subcommand, exit 0)
    //   - c-no-args:      `loopx`            (no subcommand, prints help, exit 0)
    //   - c-parser-error: `loopx --unknown`  (top-level usage error, exit 1)
    //
    // For each sub-case, assert: (a) the pre-created `loopx-stale-xyz/`
    // entry survives, (b) NO new `loopx-*` entry was materialized under the
    // parent (no startup-side scratch-dir creation), and (c) the variant-
    // specific exit code.
    // ------------------------------------------------------------------------
    const NON_RUN_CLI_CASES = [
      { id: "c-help", args: ["-h"], expectedExit: 0 },
      { id: "c-version", args: ["version"], expectedExit: 0 },
      { id: "c-no-args", args: [], expectedExit: 0 },
      { id: "c-parser-error", args: ["--unknown"], expectedExit: 1 },
    ] as const;

    for (const { id, args, expectedExit } of NON_RUN_CLI_CASES) {
      it(`T-TMP-32c (${id}): non-run CLI startup does not reap or create loopx-* entries`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const stalePath = join(tmpdirParent, "loopx-stale-xyz");
        const staleMarker = join(stalePath, "marker.txt");
        await mkdir(stalePath, { recursive: true });
        await writeFile(staleMarker, "preexisting", "utf-8");

        const result = await runCLI([...args], {
          cwd: project.dir,
          runtime,
          env: { TMPDIR: tmpdirParent },
        });

        // (a) Variant-specific exit code.
        expect(result.exitCode).toBe(expectedExit);

        // (b) Stale entry survives — no startup-side reaping.
        expect(existsSync(stalePath)).toBe(true);
        expect(existsSync(staleMarker)).toBe(true);
        expect(readFileSync(staleMarker, "utf-8")).toBe("preexisting");

        // (c) Only the pre-created stale entry exists under the parent —
        // no new `loopx-*` directory was materialized by the CLI startup
        // (no startup-side scratch-dir creation).
        expect(listLoopxEntries(tmpdirParent)).toEqual(["loopx-stale-xyz"]);
      });
    }

    // ------------------------------------------------------------------------
    // T-TMP-33: Renamed-away tmpdir is not chased; ENOENT cleanup is silent.
    //
    // SPEC §7.4: "A script that removes or renames its tmpdir during the
    // run defeats automatic cleanup of the moved directory; loopx does not
    // chase renamed tmpdirs." + cleanup-safety rule 1 (ENOENT no-op, no
    // warning).
    // ------------------------------------------------------------------------
    it("T-TMP-33: renamed-away tmpdir is not chased and emits no cleanup warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      // Fixture: observe LOOPX_TMPDIR, write a marker into the tmpdir,
      // rename the tmpdir directory itself to a sibling path under the
      // same parent, then emit stop:true.
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
printf 'initialized' > "$LOOPX_TMPDIR/marker.txt"
mv "$LOOPX_TMPDIR" "$LOOPX_TMPDIR-renamed"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);

      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      expect(observedLoopxTmpdir.length).toBeGreaterThan(0);
      const renamedPath = `${observedLoopxTmpdir}-renamed`;

      // (a) Original tmpdir path no longer exists (the rename moved it).
      expect(existsSync(observedLoopxTmpdir)).toBe(false);

      // (b) Renamed path still exists with the marker intact — loopx did
      // NOT chase the renamed directory and did NOT remove it.
      expect(existsSync(renamedPath)).toBe(true);
      const renamedMarker = join(renamedPath, "marker.txt");
      expect(existsSync(renamedMarker)).toBe(true);
      expect(readFileSync(renamedMarker, "utf-8")).toBe("initialized");

      // (c) No cleanup-related warning was emitted — ENOENT-at-cleanup is
      // silent (the structured marker line count is the implementation-
      // neutral predicate per TEST-SPEC §1.4).
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(0);
    });

    // ------------------------------------------------------------------------
    // T-TMP-34 / 34a / 34b: Symlink-replacement cleanup follows SPEC §7.4
    // cleanup-safety rule 2 — unlink the symlink entry, do NOT follow the
    // target. Surface-parity matrix across CLI / runPromise() / run().
    //
    // SPEC §7.4 dispatch case 2: "Path is a symlink: unlink the symlink
    // entry; do not follow the target." Successful rule-2 cleanup emits NO
    // cleanup warning (warnings are only emitted on failure or rule-3 / 5
    // — see T-TMP-35 / 36 for the warning-emitting branches and T-TMP-33
    // for rule-1 ENOENT silence).
    //
    // The fixture (shared across all three surfaces): observe LOOPX_TMPDIR,
    // create an external `target-survives/` directory under PROJECT_ROOT
    // with a `target-marker` file, replace LOOPX_TMPDIR with a symlink
    // pointing at that external directory, then emit `{"stop":true}`.
    //
    // Post-conditions per surface: (a) success outcome surfaces (CLI exit 0
    // / promise resolves / generator settles cleanly), (b) the LOOPX_TMPDIR
    // path no longer exists (loopx unlinked the symlink entry), (c) the
    // external `target-survives/target-marker` still exists with content
    // intact (loopx did NOT follow the symlink target — collateral-deletion
    // safety), (d) zero LOOPX_TEST_CLEANUP_WARNING\t… lines on stderr
    // (rule-2 success branch is silent).
    // ------------------------------------------------------------------------

    /**
     * Build the shared bash fixture body for T-TMP-34/34a/34b. The script
     * writes the observed LOOPX_TMPDIR path to `tmpdirObservation`, sets up
     * the external target directory with marker, replaces LOOPX_TMPDIR with
     * a symlink to that target, then emits stop:true.
     */
    function buildSymlinkReplacementFixture(args: {
      tmpdirObservation: string;
    }): string {
      return `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${args.tmpdirObservation}"
mkdir -p "$LOOPX_PROJECT_ROOT/target-survives"
printf 'preserved' > "$LOOPX_PROJECT_ROOT/target-survives/target-marker"
rm -rf "$LOOPX_TMPDIR"
ln -s "$LOOPX_PROJECT_ROOT/target-survives" "$LOOPX_TMPDIR"
printf '{"stop":true}'
`;
    }

    it("T-TMP-34: CLI symlink-replacement cleanup unlinks symlink, leaves target intact, no warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildSymlinkReplacementFixture({ tmpdirObservation }),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent },
      });

      // (a) CLI success outcome surfaces.
      expect(result.exitCode).toBe(0);

      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      expect(observedLoopxTmpdir.length).toBeGreaterThan(0);

      // (b) The LOOPX_TMPDIR path no longer exists — loopx unlinked the
      // symlink entry under cleanup-safety rule 2.
      expect(existsSync(observedLoopxTmpdir)).toBe(false);

      // (c) The external target directory still exists with marker intact —
      // loopx did NOT follow the symlink target (collateral-deletion
      // safety per SPEC §7.4 rule 2 "do not follow the target").
      const externalTargetDir = join(project.dir, "target-survives");
      expect(existsSync(externalTargetDir)).toBe(true);
      const externalMarker = join(externalTargetDir, "target-marker");
      expect(existsSync(externalMarker)).toBe(true);
      expect(readFileSync(externalMarker, "utf-8")).toBe("preserved");

      // (d) Zero cleanup warnings on stderr — rule-2 success branch is
      // silent (warnings only emitted on cleanup failure or rule 3 / 5).
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(0);
    });

    it("T-TMP-34a: runPromise() symlink-replacement cleanup unlinks symlink, leaves target intact, no warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildSymlinkReplacementFixture({ tmpdirObservation }),
      );

      const externalTargetDir = join(project.dir, "target-survives");
      const externalMarker = join(externalTargetDir, "target-marker");

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
const externalTargetDir = ${JSON.stringify(externalTargetDir)};
const externalMarker = ${JSON.stringify(externalMarker)};
let rejected = false;
let errMsg = "";
let outputs = [];
try {
  outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
} catch (e) {
  rejected = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
const targetDirExists = existsSync(externalTargetDir);
const markerExists = existsSync(externalMarker);
const markerContent = markerExists ? readFileSync(externalMarker, "utf-8") : "";
console.log(JSON.stringify({
  rejected,
  errMsg,
  outputsLen: outputs.length,
  observed,
  observedExists: existsSync(observed),
  targetDirExists,
  markerExists,
  markerContent,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Promise resolved (no rejection). One Output yielded.
      expect(data.rejected).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.outputsLen).toBe(1);

      // (b) LOOPX_TMPDIR symlink entry was unlinked.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedExists).toBe(false);

      // (c) External target directory and marker survive intact.
      expect(data.targetDirExists).toBe(true);
      expect(data.markerExists).toBe(true);
      expect(data.markerContent).toBe("preserved");

      // (d) Zero cleanup warnings on driver-process stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(0);
    });

    it("T-TMP-34b: run() symlink-replacement cleanup unlinks symlink, leaves target intact, no warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildSymlinkReplacementFixture({ tmpdirObservation }),
      );

      const externalTargetDir = join(project.dir, "target-survives");
      const externalMarker = join(externalTargetDir, "target-marker");

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
const externalTargetDir = ${JSON.stringify(externalTargetDir)};
const externalMarker = ${JSON.stringify(externalMarker)};
let thrown = false;
let errMsg = "";
let yieldCount = 0;
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  for await (const _ of gen) { yieldCount++; }
} catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
const targetDirExists = existsSync(externalTargetDir);
const markerExists = existsSync(externalMarker);
const markerContent = markerExists ? readFileSync(externalMarker, "utf-8") : "";
console.log(JSON.stringify({
  thrown,
  errMsg,
  yieldCount,
  observed,
  observedExists: existsSync(observed),
  targetDirExists,
  markerExists,
  markerContent,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Generator settled cleanly (no throw). One yield.
      expect(data.thrown).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.yieldCount).toBe(1);

      // (b) LOOPX_TMPDIR symlink entry was unlinked.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedExists).toBe(false);

      // (c) External target directory and marker survive intact.
      expect(data.targetDirExists).toBe(true);
      expect(data.markerExists).toBe(true);
      expect(data.markerContent).toBe("preserved");

      // (d) Zero cleanup warnings on driver-process stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(0);
    });

    // ------------------------------------------------------------------------
    // T-TMP-35 / 35a / 35b: Regular-file-replacement cleanup follows SPEC §7.4
    // cleanup-safety rule 3 — leave the non-directory non-symlink in place
    // and emit exactly one stderr warning. Surface-parity matrix across CLI
    // / runPromise() / run().
    //
    // SPEC §7.4 dispatch case 3: "Path is a regular file, FIFO, socket, or
    // other non-directory non-symlink: leave in place with a stderr warning.
    // Unlinking would risk mutating unrelated data (hard-link nlink decrement,
    // or data renamed into the path with nlink == 1)." Per-run cleanup-warning
    // cardinality (SPEC §7.2) is exactly one across the surface; the warning
    // does not promote the terminal outcome (CLI stays exit 0 / promise still
    // resolves / generator still settles cleanly) per SPEC §7.4.
    //
    // The fixture (shared across all three surfaces): observe LOOPX_TMPDIR,
    // remove the directory loopx created at the path, and replace it with a
    // regular file containing fixed content `regular-file-replacement`, then
    // emit `{"stop":true}`.
    //
    // Post-conditions per surface: (a) success outcome surfaces (CLI exit 0
    // / promise resolves / generator settles cleanly), (b) the LOOPX_TMPDIR
    // path still exists and is a regular file with content `regular-file-
    // replacement` (rule-3 leave-in-place), (c) exactly one
    // LOOPX_TEST_CLEANUP_WARNING\t… line on stderr.
    // ------------------------------------------------------------------------

    /**
     * Build the shared bash fixture body for T-TMP-35/35a/35b. The script
     * writes the observed LOOPX_TMPDIR path to `tmpdirObservation`, removes
     * the directory loopx created at the path, replaces it with a regular
     * file of fixed content, then emits stop:true.
     */
    function buildRegularFileReplacementFixture(args: {
      tmpdirObservation: string;
    }): string {
      return `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${args.tmpdirObservation}"
rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"
printf '{"stop":true}'
`;
    }

    it("T-TMP-35: CLI regular-file replacement leaves file in place with exactly one cleanup warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildRegularFileReplacementFixture({ tmpdirObservation }),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
      });

      // (c) CLI exit 0 — the cleanup warning does not affect the exit code.
      expect(result.exitCode).toBe(0);

      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      expect(observedLoopxTmpdir.length).toBeGreaterThan(0);

      // (a) Path still exists and is a regular file with the script-written
      // content — SPEC §7.4 rule 3 "leave in place with a stderr warning"
      // means the regular file was NOT unlinked.
      expect(existsSync(observedLoopxTmpdir)).toBe(true);
      const st = statSync(observedLoopxTmpdir);
      expect(st.isFile()).toBe(true);
      expect(readFileSync(observedLoopxTmpdir, "utf-8")).toBe(
        "regular-file-replacement",
      );

      // (b) Exactly one cleanup-related warning on stderr (per-run cleanup-
      // warning cardinality from SPEC §7.4; structured marker line count
      // is the implementation-neutral predicate per TEST-SPEC §1.4).
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // Harness clean-up: remove the leftover regular file at the recorded
      // path so the test-isolated tmpdir parent can be removed cleanly.
      await rm(observedLoopxTmpdir, { force: true }).catch(() => {});
    });

    it("T-TMP-35a: runPromise() regular-file replacement resolves with exactly one cleanup warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildRegularFileReplacementFixture({ tmpdirObservation }),
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readFileSync, statSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let rejected = false;
let errMsg = "";
let outputs = [];
try {
  outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
} catch (e) {
  rejected = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
const observedExists = existsSync(observed);
let observedIsFile = false;
let observedContent = "";
if (observedExists) {
  observedIsFile = statSync(observed).isFile();
  observedContent = readFileSync(observed, "utf-8");
}
const stop = outputs.length === 1 ? !!outputs[0].stop : false;
console.log(JSON.stringify({
  rejected,
  errMsg,
  outputsLen: outputs.length,
  stop,
  observed,
  observedExists,
  observedIsFile,
  observedContent,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Promise resolved (no rejection). Single Output with stop:true —
      // the terminal outcome is what the script produced, not a cleanup-
      // failure-class rejection. SPEC §7.4: cleanup warnings do not affect
      // the promise rejection reason.
      expect(data.rejected).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.outputsLen).toBe(1);
      expect(data.stop).toBe(true);

      // (b) LOOPX_TMPDIR path still exists as a regular file with the
      // expected content — SPEC §7.4 rule 3 leave-in-place held.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedExists).toBe(true);
      expect(data.observedIsFile).toBe(true);
      expect(data.observedContent).toBe("regular-file-replacement");

      // (c) Exactly one cleanup-related warning on driver-process stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // Harness clean-up: remove the leftover regular file at the recorded
      // path so the test-isolated tmpdir parent can be removed cleanly.
      await rm(data.observed, { force: true }).catch(() => {});
    });

    it("T-TMP-35b: run() regular-file replacement settles with exactly one cleanup warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildRegularFileReplacementFixture({ tmpdirObservation }),
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync, statSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let thrown = false;
let errMsg = "";
let yieldCount = 0;
let lastStop = false;
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  for await (const out of gen) {
    yieldCount++;
    lastStop = !!out.stop;
  }
} catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
const observedExists = existsSync(observed);
let observedIsFile = false;
let observedContent = "";
if (observedExists) {
  observedIsFile = statSync(observed).isFile();
  observedContent = readFileSync(observed, "utf-8");
}
console.log(JSON.stringify({
  thrown,
  errMsg,
  yieldCount,
  lastStop,
  observed,
  observedExists,
  observedIsFile,
  observedContent,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Generator settled cleanly (no throw). Single yield with stop:true
      // — the terminal outcome is what the script produced, not a cleanup-
      // failure-class throw. SPEC §7.4: cleanup warnings do not affect the
      // generator outcome.
      expect(data.thrown).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.yieldCount).toBe(1);
      expect(data.lastStop).toBe(true);

      // (b) LOOPX_TMPDIR path still exists as a regular file with the
      // expected content — SPEC §7.4 rule 3 leave-in-place held.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedExists).toBe(true);
      expect(data.observedIsFile).toBe(true);
      expect(data.observedContent).toBe("regular-file-replacement");

      // (c) Exactly one cleanup-related warning on driver-process stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // Harness clean-up: remove the leftover regular file at the recorded
      // path so the test-isolated tmpdir parent can be removed cleanly.
      await rm(data.observed, { force: true }).catch(() => {});
    });

    // ------------------------------------------------------------------------
    // T-TMP-36 / 36a / 36b: Mismatched-directory replacement cleanup follows
    // SPEC §7.4 cleanup-safety rule 5 — leave the directory in place and
    // emit exactly one stderr warning. Surface-parity matrix across CLI /
    // runPromise() / run().
    //
    // SPEC §7.4 dispatch case 5: "Path is a directory whose identity does
    // not match: leave in place with a stderr warning. loopx does not
    // recursively remove a directory it did not create." Per-run cleanup-
    // warning cardinality (SPEC §7.2) is exactly one across the surface;
    // the warning does not promote the terminal outcome (CLI stays exit 0
    // / promise still resolves / generator still settles cleanly) per
    // SPEC §7.4.
    //
    // The fixture (shared across all three surfaces): observe LOOPX_TMPDIR,
    // **rename** the original tmpdir aside (`mv tmpdir tmpdir-original-aside`)
    // and create a different directory at the original path with a
    // `mismatched-marker` file inside, then emit `{"stop":true}`. The
    // rename-aside step is essential for inode-distinctness (per the
    // T-TMP-36 TEST-SPEC text): a naive `rm -rf … && mkdir …` could let
    // the kernel reuse the original directory's inode and the test would
    // observe a successful (rather than mismatched) cleanup. By keeping
    // the original alive at a different path, its inode remains occupied
    // and the freshly-created directory at $LOOPX_TMPDIR is allocated a
    // distinct inode (which differs from the identity fingerprint loopx
    // captured at creation). The harness post-test removes the
    // `-original-aside` copy.
    //
    // Post-conditions per surface: (a) success outcome surfaces (CLI exit 0
    // / promise resolves / generator settles cleanly), (b) the LOOPX_TMPDIR
    // path still exists as a directory with the `mismatched-marker` file
    // inside (rule-5 leave-in-place), (c) exactly one
    // LOOPX_TEST_CLEANUP_WARNING\t… line on stderr, (d) the `-original-aside`
    // copy survives loopx (loopx does not chase renamed-away tmpdirs;
    // incidental defense-in-depth for SPEC §7.4 already covered by
    // T-TMP-33).
    // ------------------------------------------------------------------------

    /**
     * Build the shared bash fixture body for T-TMP-36/36a/36b. The script
     * writes the observed LOOPX_TMPDIR path to `tmpdirObservation`, renames
     * the original tmpdir aside, creates a distinct-inode replacement
     * directory at the original path with a marker file inside, then emits
     * stop:true.
     */
    function buildMismatchedDirectoryFixture(args: {
      tmpdirObservation: string;
    }): string {
      return `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${args.tmpdirObservation}"
mv "$LOOPX_TMPDIR" "$LOOPX_TMPDIR-original-aside"
mkdir "$LOOPX_TMPDIR"
touch "$LOOPX_TMPDIR/mismatched-marker"
printf '{"stop":true}'
`;
    }

    it("T-TMP-36: CLI mismatched-directory replacement leaves directory in place with exactly one cleanup warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildMismatchedDirectoryFixture({ tmpdirObservation }),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
      });

      // (d) CLI exit 0 — the cleanup warning does not affect the exit code
      // (SPEC §7.4: "cleanup warnings do not affect the CLI exit code").
      expect(result.exitCode).toBe(0);

      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      expect(observedLoopxTmpdir.length).toBeGreaterThan(0);

      // (a) The LOOPX_TMPDIR path still exists and is a directory — SPEC
      // §7.4 rule 5 "leave in place with a stderr warning" means loopx did
      // NOT recursively remove the mismatched-identity directory.
      expect(existsSync(observedLoopxTmpdir)).toBe(true);
      const st = statSync(observedLoopxTmpdir);
      expect(st.isDirectory()).toBe(true);

      // (b) The `mismatched-marker` file inside still exists — loopx did
      // not recursively remove the directory's contents (the filesystem-
      // safety outcome per SPEC §7.4 rule 5).
      const mismatchedMarker = join(observedLoopxTmpdir, "mismatched-marker");
      expect(existsSync(mismatchedMarker)).toBe(true);

      // (c) Exactly one cleanup-related warning on stderr (per-run cleanup-
      // warning cardinality from SPEC §7.4; structured marker line count
      // is the implementation-neutral predicate per TEST-SPEC §1.4).
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // (e) The renamed-aside copy survives — loopx does not chase
      // renamed-away tmpdirs (SPEC §7.4 "no chasing renamed tmpdirs",
      // already covered by T-TMP-33; this assertion provides incidental
      // defense-in-depth via the rename-aside fixture pattern).
      const renamedAside = `${observedLoopxTmpdir}-original-aside`;
      expect(existsSync(renamedAside)).toBe(true);
      expect(statSync(renamedAside).isDirectory()).toBe(true);

      // Harness clean-up: remove both the leftover mismatched directory and
      // the renamed-aside copy so the test-isolated tmpdir parent can be
      // removed cleanly.
      await rm(observedLoopxTmpdir, {
        recursive: true,
        force: true,
      }).catch(() => {});
      await rm(renamedAside, { recursive: true, force: true }).catch(() => {});
    });

    it("T-TMP-36a: runPromise() mismatched-directory replacement resolves with exactly one cleanup warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildMismatchedDirectoryFixture({ tmpdirObservation }),
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let rejected = false;
let errMsg = "";
let outputs = [];
try {
  outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
} catch (e) {
  rejected = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
const observedExists = existsSync(observed);
let observedIsDir = false;
let mismatchedMarkerExists = false;
if (observedExists) {
  observedIsDir = statSync(observed).isDirectory();
  mismatchedMarkerExists = existsSync(join(observed, "mismatched-marker"));
}
const renamedAside = observed + "-original-aside";
const renamedAsideExists = existsSync(renamedAside);
const stop = outputs.length === 1 ? !!outputs[0].stop : false;
console.log(JSON.stringify({
  rejected,
  errMsg,
  outputsLen: outputs.length,
  stop,
  observed,
  observedExists,
  observedIsDir,
  mismatchedMarkerExists,
  renamedAside,
  renamedAsideExists,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Promise resolved (no rejection). Single Output with stop:true —
      // the terminal outcome is what the script produced, not a cleanup-
      // failure-class rejection. SPEC §7.4: cleanup warnings do not affect
      // the promise rejection reason.
      expect(data.rejected).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.outputsLen).toBe(1);
      expect(data.stop).toBe(true);

      // (b) LOOPX_TMPDIR path still exists as a directory with the marker
      // file inside — SPEC §7.4 rule 5 leave-in-place held.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedExists).toBe(true);
      expect(data.observedIsDir).toBe(true);
      expect(data.mismatchedMarkerExists).toBe(true);

      // (c) The renamed-aside copy survives — incidental defense-in-depth
      // for the renamed-away-tmpdir contract.
      expect(data.renamedAsideExists).toBe(true);

      // (d) Exactly one cleanup-related warning on driver-process stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // Harness clean-up.
      await rm(data.observed, {
        recursive: true,
        force: true,
      }).catch(() => {});
      await rm(data.renamedAside, {
        recursive: true,
        force: true,
      }).catch(() => {});
    });

    it("T-TMP-36b: run() mismatched-directory replacement settles with exactly one cleanup warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildMismatchedDirectoryFixture({ tmpdirObservation }),
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let thrown = false;
let errMsg = "";
let yieldCount = 0;
let lastStop = false;
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  for await (const out of gen) {
    yieldCount++;
    lastStop = !!out.stop;
  }
} catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
const observedExists = existsSync(observed);
let observedIsDir = false;
let mismatchedMarkerExists = false;
if (observedExists) {
  observedIsDir = statSync(observed).isDirectory();
  mismatchedMarkerExists = existsSync(join(observed, "mismatched-marker"));
}
const renamedAside = observed + "-original-aside";
const renamedAsideExists = existsSync(renamedAside);
console.log(JSON.stringify({
  thrown,
  errMsg,
  yieldCount,
  lastStop,
  observed,
  observedExists,
  observedIsDir,
  mismatchedMarkerExists,
  renamedAside,
  renamedAsideExists,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Generator settled cleanly (no throw). Single yield with
      // stop:true — the terminal outcome is what the script produced, not
      // a cleanup-failure-class throw. SPEC §7.4: cleanup warnings do not
      // affect the generator outcome.
      expect(data.thrown).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.yieldCount).toBe(1);
      expect(data.lastStop).toBe(true);

      // (b) LOOPX_TMPDIR path still exists as a directory with the marker
      // file inside — SPEC §7.4 rule 5 leave-in-place held.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedExists).toBe(true);
      expect(data.observedIsDir).toBe(true);
      expect(data.mismatchedMarkerExists).toBe(true);

      // (c) The renamed-aside copy survives — incidental defense-in-depth
      // for the renamed-away-tmpdir contract.
      expect(data.renamedAsideExists).toBe(true);

      // (d) Exactly one cleanup-related warning on driver-process stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // Harness clean-up.
      await rm(data.observed, {
        recursive: true,
        force: true,
      }).catch(() => {});
      await rm(data.renamedAside, {
        recursive: true,
        force: true,
      }).catch(() => {});
    });

    // ------------------------------------------------------------------------
    // T-TMP-35c / 35d / 35e: Cleanup warning does not mask a script-error
    // terminal across all three execution surfaces (CLI / runPromise() /
    // run()) × both warning-emitting cleanup-safety branches (regular-file
    // replacement → SPEC §7.4 rule 3; mismatched-directory replacement →
    // SPEC §7.4 rule 5). SPEC §7.4: "cleanup warnings do not affect the CLI
    // exit code, the generator outcome, or the promise rejection reason."
    //
    // T-TMP-35 / 35a / 35b (rule-3 success terminal) and T-TMP-36 / 36a / 36b
    // (rule-5 success terminal) pin the cleanup-warning-cardinality contract
    // against a `stop: true` script termination. These three new tests pin
    // the error-terminal variant: a cleanup warning must not promote a
    // script-failure outcome into a cleanup-failure outcome, nor mask the
    // script failure as success. The error output / rejection / throw must
    // identify the script failure as the primary cause rather than
    // conflating it with the cleanup-warning category.
    //
    // The CLI surface uses an additional defense — a distinctive
    // SCRIPT-FAILURE-MARKER line printed to stderr before the script's
    // path-tampering. Both the script-failure path and a hypothetical
    // cleanup-promoted-to-failure path produce CLI exit 1, so exit-code
    // alone cannot distinguish them; the marker proves the script's own
    // pre-failure stderr reached the user observably disjoint from the
    // cleanup warning. The programmatic surfaces additionally inspect the
    // rejection / throw error message for the script-failure shape
    // ("exited with code") — matching the loop.ts contract — and the
    // absence of any "cleanup" classifier.
    //
    // Both fixture variants run the same shape:
    //   1. Observe LOOPX_TMPDIR into the external `tmpdir.txt` marker.
    //   2. Print SCRIPT-FAILURE-MARKER-T-TMP-35C line to stderr (CLI test
    //      uses this for the disjoint-line assertion; the API tests have
    //      a stronger error-shape probe and don't need it but produce
    //      the same fixture for consistency).
    //   3. Perform the variant-specific replacement (rule-3 or rule-5).
    //   4. `exit 1` (script fails).
    //
    // For variant b (mismatched-directory), the rename-aside pattern from
    // T-TMP-36 guarantees inode-distinctness so the cleanup dispatch
    // reaches rule 5 deterministically.
    // ------------------------------------------------------------------------

    /** Variant labels used in the parameterized tests' sub-case naming. */
    const SCRIPT_ERROR_CLEANUP_VARIANTS = [
      "regular-file-replacement",
      "mismatched-directory-replacement",
    ] as const;
    type ScriptErrorCleanupVariant =
      (typeof SCRIPT_ERROR_CLEANUP_VARIANTS)[number];

    /**
     * Build the shared bash fixture body for the script-error-terminal
     * variants of T-TMP-35c / 35d / 35e. Returns the bash content that
     * observes `$LOOPX_TMPDIR` into `tmpdirObservation`, prints the
     * distinctive script-failure marker to stderr, performs the variant-
     * specific path manipulation, then `exit 1` (script fails).
     */
    function buildScriptErrorCleanupFixture(args: {
      tmpdirObservation: string;
      variant: ScriptErrorCleanupVariant;
    }): string {
      const replacement =
        args.variant === "regular-file-replacement"
          ? `rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"`
          : `mv "$LOOPX_TMPDIR" "$LOOPX_TMPDIR-original-aside"
mkdir "$LOOPX_TMPDIR"
touch "$LOOPX_TMPDIR/mismatched-marker"`;
      return `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${args.tmpdirObservation}"
printf 'SCRIPT-FAILURE-MARKER-T-TMP-35C: script about to fail with non-zero exit\\n' >&2
${replacement}
exit 1
`;
    }

    for (const variant of SCRIPT_ERROR_CLEANUP_VARIANTS) {
      it(`T-TMP-35c (${variant}): CLI cleanup warning does not mask script-error exit code`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const tmpdirObservation = join(project.dir, "tmpdir.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          buildScriptErrorCleanupFixture({ tmpdirObservation, variant }),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
        });

        // (a) Exit 1 — from the SCRIPT failure, not a cleanup-failure
        // promotion. Both paths produce exit 1, so exit-code alone cannot
        // distinguish; (b) and (d) below carry the load-bearing
        // distinguishing assertions.
        expect(result.exitCode).toBe(1);

        const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
        expect(observedLoopxTmpdir.length).toBeGreaterThan(0);

        // (b) The script's distinctive pre-failure marker reached stderr.
        // An implementation that masked the script's stderr behind a
        // cleanup-failure error wrapper would lose this line.
        const stderrLines = result.stderr.split("\n");
        const markerLines = stderrLines.filter((l) =>
          l.includes("SCRIPT-FAILURE-MARKER-T-TMP-35C"),
        );
        expect(markerLines.length).toBe(1);

        // (c) Exactly one cleanup-related warning on stderr (per-run
        // cleanup-warning cardinality from SPEC §7.4 still holds under
        // the script-error terminal).
        const cleanupWarnings = stderrLines.filter((l) =>
          l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"),
        );
        expect(cleanupWarnings.length).toBe(1);

        // (d) The cleanup warning and the script-failure marker are on
        // distinct stderr lines. An implementation that wrapped or
        // replaced the marker with a cleanup-classifier wrapper would
        // make these overlap.
        expect(markerLines[0]).not.toContain("LOOPX_TEST_CLEANUP_WARNING");
        expect(cleanupWarnings[0]).not.toContain(
          "SCRIPT-FAILURE-MARKER-T-TMP-35C",
        );

        // (e) The path persistence for each cleanup-safety branch.
        // Variant a (rule 3): regular file with the script-written content.
        // Variant b (rule 5): directory with the mismatched-marker inside.
        if (variant === "regular-file-replacement") {
          expect(existsSync(observedLoopxTmpdir)).toBe(true);
          const st = statSync(observedLoopxTmpdir);
          expect(st.isFile()).toBe(true);
          expect(readFileSync(observedLoopxTmpdir, "utf-8")).toBe(
            "regular-file-replacement",
          );
          await rm(observedLoopxTmpdir, { force: true }).catch(() => {});
        } else {
          expect(existsSync(observedLoopxTmpdir)).toBe(true);
          expect(statSync(observedLoopxTmpdir).isDirectory()).toBe(true);
          const mismatchedMarker = join(
            observedLoopxTmpdir,
            "mismatched-marker",
          );
          expect(existsSync(mismatchedMarker)).toBe(true);
          const renamedAside = `${observedLoopxTmpdir}-original-aside`;
          expect(existsSync(renamedAside)).toBe(true);
          await rm(observedLoopxTmpdir, {
            recursive: true,
            force: true,
          }).catch(() => {});
          await rm(renamedAside, { recursive: true, force: true }).catch(
            () => {},
          );
        }
      });
    }

    for (const variant of SCRIPT_ERROR_CLEANUP_VARIANTS) {
      it(`T-TMP-35d (${variant}): runPromise() cleanup warning does not mask script-error rejection reason`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const tmpdirObservation = join(project.dir, "tmpdir.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          buildScriptErrorCleanupFixture({ tmpdirObservation, variant }),
        );

        const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let rejected = false;
let errMsg = "";
let outputs = [];
try {
  outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
} catch (e) {
  rejected = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
const observedExists = existsSync(observed);
let observedIsFile = false;
let observedContent = "";
let observedIsDir = false;
let mismatchedMarkerExists = false;
let renamedAsideExists = false;
if (observedExists) {
  const st = statSync(observed);
  observedIsFile = st.isFile();
  observedIsDir = st.isDirectory();
  if (observedIsFile) observedContent = readFileSync(observed, "utf-8");
  if (observedIsDir) {
    mismatchedMarkerExists = existsSync(join(observed, "mismatched-marker"));
  }
}
const renamedAside = observed + "-original-aside";
renamedAsideExists = existsSync(renamedAside);
console.log(JSON.stringify({
  rejected,
  errMsg,
  outputsLen: outputs.length,
  observed,
  observedExists,
  observedIsFile,
  observedContent,
  observedIsDir,
  mismatchedMarkerExists,
  renamedAside,
  renamedAsideExists,
}));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
        });
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);

        // (a) The promise rejected (it did not resolve to a partial-output
        // array because cleanup produced "only a warning"). SPEC §7.4:
        // cleanup warnings do not affect the promise rejection reason.
        expect(data.rejected).toBe(true);

        // (b) The rejection reason is a SCRIPT-failure error matching the
        // loop.ts contract ("Script '<wf>:<scr>' exited with code <n>").
        // It must NOT be a cleanup-failure-class wrapper. The "cleanup"
        // word does not appear in the script-failure error message.
        expect(data.errMsg).toMatch(/exited with code/);
        expect(data.errMsg.toLowerCase()).not.toContain("cleanup");

        // (c) Exactly one cleanup-related warning on stderr (per-run
        // cleanup-warning cardinality still holds under the script-error
        // terminal).
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(1);

        // (d) Path persistence per cleanup-safety branch.
        expect(data.observed.length).toBeGreaterThan(0);
        expect(data.observedExists).toBe(true);
        if (variant === "regular-file-replacement") {
          expect(data.observedIsFile).toBe(true);
          expect(data.observedContent).toBe("regular-file-replacement");
          await rm(data.observed, { force: true }).catch(() => {});
        } else {
          expect(data.observedIsDir).toBe(true);
          expect(data.mismatchedMarkerExists).toBe(true);
          expect(data.renamedAsideExists).toBe(true);
          await rm(data.observed, {
            recursive: true,
            force: true,
          }).catch(() => {});
          await rm(data.renamedAside, {
            recursive: true,
            force: true,
          }).catch(() => {});
        }
      });
    }

    for (const variant of SCRIPT_ERROR_CLEANUP_VARIANTS) {
      it(`T-TMP-35e (${variant}): run() generator cleanup warning does not mask script-error throw`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const tmpdirObservation = join(project.dir, "tmpdir.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          buildScriptErrorCleanupFixture({ tmpdirObservation, variant }),
        );

        const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let thrown = false;
let errMsg = "";
let yieldCount = 0;
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  for await (const _ of gen) {
    yieldCount++;
  }
} catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
const observedExists = existsSync(observed);
let observedIsFile = false;
let observedContent = "";
let observedIsDir = false;
let mismatchedMarkerExists = false;
let renamedAsideExists = false;
if (observedExists) {
  const st = statSync(observed);
  observedIsFile = st.isFile();
  observedIsDir = st.isDirectory();
  if (observedIsFile) observedContent = readFileSync(observed, "utf-8");
  if (observedIsDir) {
    mismatchedMarkerExists = existsSync(join(observed, "mismatched-marker"));
  }
}
const renamedAside = observed + "-original-aside";
renamedAsideExists = existsSync(renamedAside);
console.log(JSON.stringify({
  thrown,
  errMsg,
  yieldCount,
  observed,
  observedExists,
  observedIsFile,
  observedContent,
  observedIsDir,
  mismatchedMarkerExists,
  renamedAside,
  renamedAsideExists,
}));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
        });
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);

        // (a) The generator threw (the for-await exited via a rejection
        // rather than completing cleanly). SPEC §7.4: cleanup warnings
        // do not affect the generator outcome. yieldCount may be 0 (the
        // script never produced parseable structured stdout before
        // failing) — what matters is that the surface settled via throw.
        expect(data.thrown).toBe(true);

        // (b) The throw is a SCRIPT-failure error matching loop.ts's
        // ("Script '<wf>:<scr>' exited with code <n>"), not a cleanup-
        // failure-class wrapper.
        expect(data.errMsg).toMatch(/exited with code/);
        expect(data.errMsg.toLowerCase()).not.toContain("cleanup");

        // (c) Exactly one cleanup-related warning on stderr.
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(1);

        // (d) Path persistence per cleanup-safety branch.
        expect(data.observed.length).toBeGreaterThan(0);
        expect(data.observedExists).toBe(true);
        if (variant === "regular-file-replacement") {
          expect(data.observedIsFile).toBe(true);
          expect(data.observedContent).toBe("regular-file-replacement");
          await rm(data.observed, { force: true }).catch(() => {});
        } else {
          expect(data.observedIsDir).toBe(true);
          expect(data.mismatchedMarkerExists).toBe(true);
          expect(data.renamedAsideExists).toBe(true);
          await rm(data.observed, {
            recursive: true,
            force: true,
          }).catch(() => {});
          await rm(data.renamedAside, {
            recursive: true,
            force: true,
          }).catch(() => {});
        }
      });
    }

    // ------------------------------------------------------------------------
    // T-TMP-35f / 35g / 35h: Cleanup warning does not mask a signal/abort
    // terminal across all three execution surfaces (CLI / runPromise() /
    // run()) × both warning-emitting cleanup-safety branches (regular-file
    // replacement → SPEC §7.4 rule 3; mismatched-directory replacement →
    // SPEC §7.4 rule 5). SPEC §7.4: "cleanup warnings do not affect the CLI
    // exit code, the generator outcome, or the promise rejection reason."
    //
    // T-TMP-35 / 35a / 35b (rule-3 success terminal), T-TMP-36 / 36a / 36b
    // (rule-5 success terminal), and T-TMP-35c / 35d / 35e (rule 3+5
    // script-error terminal) pin the cleanup-warning-cardinality contract
    // against script-completion outcomes. These three new tests pin the
    // same contract against the signal terminal (SIGINT/SIGTERM, CLI) and
    // the programmatic abort terminal (run() / runPromise() with
    // RunOptions.signal): a cleanup warning from the §7.4 cleanup-safety
    // dispatch must not promote a signal-driven CLI exit into a
    // cleanup-failure exit code, mask the abort rejection reason on
    // runPromise(), nor mask the abort throw on run(). The CLI surface
    // additionally pins child-PG termination implicitly via the signal
    // exit code (130/143 means the child was terminated and loopx
    // forwarded the signal). The programmatic surfaces explicitly probe
    // child-PG termination per SPEC §9.5 / §9.1: when an abort fires
    // while a child is in flight, loopx must terminate the child PG
    // (SIGTERM, then SIGKILL after 5s) before the surface settles.
    //
    // The shared fixture tampers with $LOOPX_TMPDIR (variant-specific
    // rule 3 or rule 5), then writes the tmpdir-observation marker
    // AFTER tampering completes (so the marker's existence implies
    // tampering finished — important for the API drivers that poll for
    // marker existence to know when to abort), writes the script's pid
    // to a separate marker (for child-termination probing), prints
    // "ready" to stderr (CLI signal coordinator via waitForStderr),
    // then blocks forever. The signal/abort delivered while the script
    // blocks triggers loopx's terminal handling: child PG killed,
    // cleanup runs, cleanup hits the tampered tmpdir, cleanup warning
    // is emitted, and the surface settles with the signal/abort
    // terminal — not a cleanup-failure terminal.
    //
    // Path persistence per cleanup-safety branch is preserved across
    // the signal/abort terminal because cleanup makes no further
    // changes after detecting rule 3 (regular file: leave with warning)
    // or rule 5 (mismatched directory: leave with warning).
    //
    // For variant b (mismatched-directory), the rename-aside pattern
    // from T-TMP-36 guarantees inode-distinctness so the cleanup
    // dispatch reaches rule 5 deterministically rather than rule 4 by
    // accident of inode reuse.
    // ------------------------------------------------------------------------

    /** Variant labels used in the parameterized signal/abort tests. */
    const SIGNAL_ABORT_CLEANUP_VARIANTS = [
      "regular-file-replacement",
      "mismatched-directory-replacement",
    ] as const;
    type SignalAbortCleanupVariant =
      (typeof SIGNAL_ABORT_CLEANUP_VARIANTS)[number];

    /**
     * Build the shared bash fixture body for the signal/abort terminal
     * variants of T-TMP-35f / 35g / 35h. Returns the bash content that:
     *   1. Tampers with $LOOPX_TMPDIR (variant-specific rule 3 or rule 5).
     *   2. Writes the original LOOPX_TMPDIR path to `tmpdirObservation`
     *      AFTER tampering completes (existence of the marker implies
     *      tampering finished — the API drivers poll for this to know
     *      when to abort).
     *   3. Writes the script's own pid to `pidMarker` for child-PG
     *      termination probing under the API surfaces.
     *   4. Prints "ready" to stderr (CLI surface signal coordinator
     *      via runCLIWithSignal's waitForStderr).
     *   5. Blocks forever (until killed by signal or abort).
     */
    function buildSignalAbortCleanupFixture(args: {
      tmpdirObservation: string;
      pidMarker: string;
      variant: SignalAbortCleanupVariant;
    }): string {
      const tampering =
        args.variant === "regular-file-replacement"
          ? `rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"`
          : `mv "$LOOPX_TMPDIR" "$LOOPX_TMPDIR-original-aside"
mkdir "$LOOPX_TMPDIR"
touch "$LOOPX_TMPDIR/mismatched-marker"`;
      return `#!/bin/bash
set -e
ORIG_TMPDIR="$LOOPX_TMPDIR"
${tampering}
printf '%s' "$ORIG_TMPDIR" > "${args.tmpdirObservation}"
printf '%s' "$$" > "${args.pidMarker}"
echo "ready" >&2
while true; do sleep 1; done
`;
    }

    /** Signal labels for the T-TMP-35f parameterization. */
    const SIGNAL_VARIANTS = ["SIGINT", "SIGTERM"] as const;

    for (const variant of SIGNAL_ABORT_CLEANUP_VARIANTS) {
      for (const signalName of SIGNAL_VARIANTS) {
        it(`T-TMP-35f (${variant} × ${signalName}): CLI cleanup warning does not mask signal exit code`, async () => {
          const { project, tmpdirParent } = await setupTmpdirTest();
          const tmpdirObservation = join(project.dir, "tmpdir.txt");
          const pidMarker = join(project.dir, "pid.txt");

          await createWorkflowScript(
            project,
            "ralph",
            "index",
            ".sh",
            buildSignalAbortCleanupFixture({
              tmpdirObservation,
              pidMarker,
              variant,
            }),
          );

          const { result, sendSignal, waitForStderr } = runCLIWithSignal(
            ["run", "-n", "1", "ralph"],
            {
              cwd: project.dir,
              runtime,
              env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
              timeout: 30_000,
            },
          );

          await waitForStderr("ready");

          sendSignal(signalName);
          const outcome = await result;

          // (a) Exit code matches the signal terminal (130 for SIGINT,
          // 143 for SIGTERM). The cleanup warning does not promote the
          // signal terminal into a cleanup-failure exit code per
          // SPEC §7.4.
          const expectedCode = signalName === "SIGINT" ? 130 : 143;
          expect(outcome.exitCode).toBe(expectedCode);

          const observedLoopxTmpdir = readFileSync(
            tmpdirObservation,
            "utf-8",
          );
          expect(observedLoopxTmpdir.length).toBeGreaterThan(0);

          // (b) Exactly one cleanup-related warning on stderr — per-run
          // cleanup-warning cardinality holds under the signal terminal.
          const cleanupWarnings = outcome.stderr
            .split("\n")
            .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
          expect(cleanupWarnings.length).toBe(1);

          // (c) Path persistence per cleanup-safety branch — cleanup
          // emitted a warning and made no further changes per SPEC §7.4.
          if (variant === "regular-file-replacement") {
            expect(existsSync(observedLoopxTmpdir)).toBe(true);
            const st = statSync(observedLoopxTmpdir);
            expect(st.isFile()).toBe(true);
            expect(readFileSync(observedLoopxTmpdir, "utf-8")).toBe(
              "regular-file-replacement",
            );
            await rm(observedLoopxTmpdir, { force: true }).catch(() => {});
          } else {
            expect(existsSync(observedLoopxTmpdir)).toBe(true);
            expect(statSync(observedLoopxTmpdir).isDirectory()).toBe(true);
            const mismatchedMarker = join(
              observedLoopxTmpdir,
              "mismatched-marker",
            );
            expect(existsSync(mismatchedMarker)).toBe(true);
            const renamedAside = `${observedLoopxTmpdir}-original-aside`;
            expect(existsSync(renamedAside)).toBe(true);
            await rm(observedLoopxTmpdir, {
              recursive: true,
              force: true,
            }).catch(() => {});
            await rm(renamedAside, { recursive: true, force: true }).catch(
              () => {},
            );
          }
        });
      }
    }

    for (const variant of SIGNAL_ABORT_CLEANUP_VARIANTS) {
      it(`T-TMP-35g (${variant}): runPromise() cleanup warning does not mask abort rejection reason`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const tmpdirObservation = join(project.dir, "tmpdir.txt");
        const pidMarker = join(project.dir, "pid.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          buildSignalAbortCleanupFixture({
            tmpdirObservation,
            pidMarker,
            variant,
          }),
        );

        const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
const pidMarker = ${JSON.stringify(pidMarker)};
async function waitForObservation() {
  for (let i = 0; i < 600; i++) {
    if (existsSync(tmpdirObservation) && existsSync(pidMarker)) {
      const t = readFileSync(tmpdirObservation, "utf-8");
      const p = readFileSync(pidMarker, "utf-8").trim();
      if (t.length > 0 && p.length > 0) return { tmpdir: t, pid: parseInt(p, 10) };
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("markers never appeared");
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitDead(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return !isAlive(pid);
}
const c = new AbortController();
const p = runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, signal: c.signal });
const { tmpdir: observed, pid } = await waitForObservation();
c.abort();
let rejected = false;
let errMsg = "";
let errName = "";
try {
  await p;
} catch (e) {
  rejected = true;
  errMsg = e instanceof Error ? e.message : String(e);
  errName = e instanceof Error ? (e.name || "") : "";
}
const childDead = await waitDead(pid, 10_000);
const observedExists = existsSync(observed);
let observedIsFile = false;
let observedContent = "";
let observedIsDir = false;
let mismatchedMarkerExists = false;
let renamedAsideExists = false;
if (observedExists) {
  const st = statSync(observed);
  observedIsFile = st.isFile();
  observedIsDir = st.isDirectory();
  if (observedIsFile) observedContent = readFileSync(observed, "utf-8");
  if (observedIsDir) {
    mismatchedMarkerExists = existsSync(join(observed, "mismatched-marker"));
  }
}
const renamedAside = observed + "-original-aside";
renamedAsideExists = existsSync(renamedAside);
console.log(JSON.stringify({
  rejected,
  errMsg,
  errName,
  observed,
  pid,
  childDead,
  observedExists,
  observedIsFile,
  observedContent,
  observedIsDir,
  mismatchedMarkerExists,
  renamedAside,
  renamedAsideExists,
}));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
          timeout: 30_000,
        });
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);

        // (a) Promise rejected with abort error. Cleanup warning does
        // not mask the abort rejection reason per SPEC §7.4. Abort
        // error class — DOMException("AbortError") or signal.reason.
        expect(data.rejected).toBe(true);
        expect(
          data.errName === "AbortError" || /abort/i.test(data.errMsg),
        ).toBe(true);
        expect(data.errMsg.toLowerCase()).not.toContain("cleanup");

        // (b) Exactly one cleanup-related warning on driver-process
        // stderr.
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(1);

        // (c) Active child PG terminated per SPEC §9.1 / §9.5.
        expect(data.childDead).toBe(true);

        // (d) Path persistence per cleanup-safety branch.
        expect(data.observed.length).toBeGreaterThan(0);
        expect(data.observedExists).toBe(true);
        if (variant === "regular-file-replacement") {
          expect(data.observedIsFile).toBe(true);
          expect(data.observedContent).toBe("regular-file-replacement");
          await rm(data.observed, { force: true }).catch(() => {});
        } else {
          expect(data.observedIsDir).toBe(true);
          expect(data.mismatchedMarkerExists).toBe(true);
          expect(data.renamedAsideExists).toBe(true);
          await rm(data.observed, {
            recursive: true,
            force: true,
          }).catch(() => {});
          await rm(data.renamedAside, {
            recursive: true,
            force: true,
          }).catch(() => {});
        }
      });
    }

    for (const variant of SIGNAL_ABORT_CLEANUP_VARIANTS) {
      it(`T-TMP-35h (${variant}): run() generator cleanup warning does not mask abort throw`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const tmpdirObservation = join(project.dir, "tmpdir.txt");
        const pidMarker = join(project.dir, "pid.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          buildSignalAbortCleanupFixture({
            tmpdirObservation,
            pidMarker,
            variant,
          }),
        );

        const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
const pidMarker = ${JSON.stringify(pidMarker)};
async function waitForObservation() {
  for (let i = 0; i < 600; i++) {
    if (existsSync(tmpdirObservation) && existsSync(pidMarker)) {
      const t = readFileSync(tmpdirObservation, "utf-8");
      const p = readFileSync(pidMarker, "utf-8").trim();
      if (t.length > 0 && p.length > 0) return { tmpdir: t, pid: parseInt(p, 10) };
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("markers never appeared");
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitDead(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return !isAlive(pid);
}
const c = new AbortController();
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, signal: c.signal });
const nextP = gen.next();
nextP.catch(() => {});
const { tmpdir: observed, pid } = await waitForObservation();
c.abort();
let thrown = false;
let errMsg = "";
let errName = "";
try {
  await nextP;
} catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
  errName = e instanceof Error ? (e.name || "") : "";
}
const childDead = await waitDead(pid, 10_000);
const observedExists = existsSync(observed);
let observedIsFile = false;
let observedContent = "";
let observedIsDir = false;
let mismatchedMarkerExists = false;
let renamedAsideExists = false;
if (observedExists) {
  const st = statSync(observed);
  observedIsFile = st.isFile();
  observedIsDir = st.isDirectory();
  if (observedIsFile) observedContent = readFileSync(observed, "utf-8");
  if (observedIsDir) {
    mismatchedMarkerExists = existsSync(join(observed, "mismatched-marker"));
  }
}
const renamedAside = observed + "-original-aside";
renamedAsideExists = existsSync(renamedAside);
console.log(JSON.stringify({
  thrown,
  errMsg,
  errName,
  observed,
  pid,
  childDead,
  observedExists,
  observedIsFile,
  observedContent,
  observedIsDir,
  mismatchedMarkerExists,
  renamedAside,
  renamedAsideExists,
}));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
          timeout: 30_000,
        });
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);

        // (a) Generator threw abort error. Cleanup warning does not
        // mask the generator outcome per SPEC §7.4.
        expect(data.thrown).toBe(true);
        expect(
          data.errName === "AbortError" || /abort/i.test(data.errMsg),
        ).toBe(true);
        expect(data.errMsg.toLowerCase()).not.toContain("cleanup");

        // (b) Exactly one cleanup-related warning on driver-process
        // stderr.
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(1);

        // (c) Active child PG terminated per SPEC §9.1 / §9.5.
        expect(data.childDead).toBe(true);

        // (d) Path persistence per cleanup-safety branch.
        expect(data.observed.length).toBeGreaterThan(0);
        expect(data.observedExists).toBe(true);
        if (variant === "regular-file-replacement") {
          expect(data.observedIsFile).toBe(true);
          expect(data.observedContent).toBe("regular-file-replacement");
          await rm(data.observed, { force: true }).catch(() => {});
        } else {
          expect(data.observedIsDir).toBe(true);
          expect(data.mismatchedMarkerExists).toBe(true);
          expect(data.renamedAsideExists).toBe(true);
          await rm(data.observed, {
            recursive: true,
            force: true,
          }).catch(() => {});
          await rm(data.renamedAside, {
            recursive: true,
            force: true,
          }).catch(() => {});
        }
      });
    }

    // ------------------------------------------------------------------------
    // T-TMP-37 / 37d / 37e: Recursive cleanup of an identity-matched directory
    // unlinks nested symlink entries WITHOUT traversing their targets — SPEC
    // §7.4 cleanup-safety rule 4. Surface-parity matrix across CLI /
    // runPromise() / run().
    //
    // SPEC §7.4 dispatch case 4: "Path is a directory whose identity matches
    // the recorded identity: recursively remove. Symlink entries encountered
    // during the walk are unlinked but not traversed, so symlinks pointing
    // outside the tmpdir do not collateral-delete their targets." Rule-4
    // success path emits NO cleanup warning (warnings only fire on cleanup
    // failure or rules 3 / 5 — see T-TMP-35 / 36 for the warning-emitting
    // branches and T-TMP-34 for the rule-2 no-warning branch).
    //
    // The fixture (shared across all three surfaces): observe LOOPX_TMPDIR,
    // create an external `external-target-dir/` under PROJECT_ROOT containing
    // an `external-file` with sentinel content, then create a NESTED symlink
    // INSIDE LOOPX_TMPDIR pointing at the external directory
    // (`$LOOPX_TMPDIR/nested-link -> $LOOPX_PROJECT_ROOT/external-target-dir`),
    // then emit `{"stop":true}`. The top-level entry remains the
    // identity-matched directory loopx created (rule 4 applies); only an
    // entry INSIDE the tmpdir is a symlink, so the recursive walk's
    // symlink-handling clause is what's under test.
    //
    // Post-conditions per surface: (a) success outcome surfaces (CLI exit 0
    // / promise resolves / generator settles cleanly), (b) the LOOPX_TMPDIR
    // path no longer exists (rule-4 recursive cleanup completed), (c) the
    // external `external-target-dir/external-file` still exists with content
    // intact (the recursive walk unlinked the nested symlink entry but did
    // NOT follow the symlink target — collateral-deletion safety per SPEC
    // §7.4 rule 4 "symlinks pointing outside the tmpdir do not collateral-
    // delete their targets"), (d) zero LOOPX_TEST_CLEANUP_WARNING\t… lines
    // on stderr (rule-4 success branch is silent). NODE_ENV=test is set so
    // the structured marker is gated on; absence of the marker is then a
    // load-bearing assertion, not a trivially-true non-emission.
    //
    // A buggy implementation that wired surface-specific recursive-walk
    // dispatchers (e.g., a CLI-only `rmSync({recursive:true})` that conforms
    // to rule 4 and a programmatic-driver path that traversed nested symlinks
    // — silently deleting external target contents) would pass T-TMP-37 yet
    // fail T-TMP-37d / 37e.
    // ------------------------------------------------------------------------

    /**
     * Build the shared bash fixture body for T-TMP-37/37d/37e. The script
     * writes the observed LOOPX_TMPDIR path to `tmpdirObservation`, sets up
     * the external target directory with `external-file`, creates a nested
     * symlink inside LOOPX_TMPDIR pointing at that external directory, then
     * emits stop:true.
     */
    function buildNestedSymlinkFixture(args: {
      tmpdirObservation: string;
    }): string {
      return `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${args.tmpdirObservation}"
mkdir -p "$LOOPX_PROJECT_ROOT/external-target-dir"
printf 'external-content' > "$LOOPX_PROJECT_ROOT/external-target-dir/external-file"
ln -s "$LOOPX_PROJECT_ROOT/external-target-dir" "$LOOPX_TMPDIR/nested-link"
printf '{"stop":true}'
`;
    }

    it("T-TMP-37: CLI recursive cleanup unlinks nested symlink without traversing target, no warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildNestedSymlinkFixture({ tmpdirObservation }),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
      });

      // (a) CLI success outcome surfaces.
      expect(result.exitCode).toBe(0);

      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      expect(observedLoopxTmpdir.length).toBeGreaterThan(0);

      // (b) The LOOPX_TMPDIR path no longer exists — rule-4 recursive
      // cleanup ran on the identity-matched directory.
      expect(existsSync(observedLoopxTmpdir)).toBe(false);

      // (c) The external target directory and `external-file` still exist
      // with content intact — the recursive walk unlinked the nested
      // symlink entry but did NOT follow the symlink target (collateral-
      // deletion safety per SPEC §7.4 rule 4).
      const externalTargetDir = join(project.dir, "external-target-dir");
      expect(existsSync(externalTargetDir)).toBe(true);
      const externalFile = join(externalTargetDir, "external-file");
      expect(existsSync(externalFile)).toBe(true);
      expect(readFileSync(externalFile, "utf-8")).toBe("external-content");

      // (d) Zero cleanup warnings on stderr — rule-4 success branch is
      // silent. NODE_ENV=test is set above, so the structured marker would
      // be emitted if any warning happened — making this a load-bearing
      // negative assertion, not a trivially-true non-emission.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(0);
    });

    // ----------------------------------------------------------------------
    // T-TMP-37a / 37b / 37c: SPEC §7.4 cleanup-safety rule 3 — non-directory
    // non-symlink replacement is left in place with exactly one warning.
    // Rule 3 reads: "Path is a regular file, FIFO, socket, or other non-
    // directory non-symlink: leave in place with a stderr warning. Unlinking
    // would risk mutating unrelated data (hard-link `nlink` decrement, or
    // data renamed into the path with `nlink == 1`)." T-TMP-35 covers the
    // regular-file branch; T-TMP-37a/b/c cover the FIFO, socket, and hard-
    // link branches respectively, proving the rule is typed generically
    // (any non-directory non-symlink leaves-in-place + warns) rather than
    // narrowly special-cased to regular files. Implementation note:
    // `cleanupTmpdir` in packages/loop-extender/src/tmpdir.ts dispatches
    // case 3 via `!stat.isDirectory()` (after the symlink early-return),
    // which is the correct generic dispatch — the tests here pin the
    // contract against any future narrowing of that branch.
    // ----------------------------------------------------------------------

    it("T-TMP-37a: CLI FIFO replacement leaves FIFO in place with exactly one cleanup warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
rm -rf "$LOOPX_TMPDIR"
mkfifo "$LOOPX_TMPDIR"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
      });

      // (c) CLI exit 0 — cleanup warning does not affect the exit code.
      expect(result.exitCode).toBe(0);

      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      expect(observedLoopxTmpdir.length).toBeGreaterThan(0);

      // (a) Path still exists and is a FIFO — SPEC §7.4 rule 3 leaves
      // non-directory non-symlink entries in place. `lstatSync().isFIFO()`
      // is the implementation-neutral predicate for the FIFO branch.
      expect(existsSync(observedLoopxTmpdir)).toBe(true);
      const lst = lstatSync(observedLoopxTmpdir);
      expect(lst.isFIFO()).toBe(true);
      expect(lst.isDirectory()).toBe(false);
      expect(lst.isSymbolicLink()).toBe(false);

      // (b) Exactly one cleanup-related warning on stderr (per-run cleanup-
      // warning cardinality from SPEC §7.4; structured marker line count is
      // the implementation-neutral predicate per TEST-SPEC §1.4).
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // Harness clean-up: remove the leftover FIFO so the test-isolated
      // tmpdir parent can be removed cleanly.
      await rm(observedLoopxTmpdir, { force: true }).catch(() => {});
    });

    it("T-TMP-37b: CLI Unix-domain socket replacement leaves socket in place with exactly one cleanup warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      // .ts fixture — creating a SOCK_STREAM Unix-domain socket portably from
      // bash is awkward, while Node's `net.createServer().listen(<path>)`
      // reliably binds a socket inode at a path on every POSIX runtime
      // targeted by this suite (works under tsx for Node and natively for
      // Bun). The script binds the socket, then emits `output({ stop: true })`
      // which calls `process.exit(0)` synchronously without invoking
      // `server.close()` — Unix-domain socket files are NOT auto-unlinked by
      // the kernel on process exit, so the socket inode persists on the
      // filesystem at cleanup time when loopx's `lstat` runs.
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { output } from "loopx";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
const tmpdir = process.env.LOOPX_TMPDIR;
if (!tmpdir) throw new Error("LOOPX_TMPDIR not set");
writeFileSync(tmpdirObservation, tmpdir);
rmSync(tmpdir, { recursive: true, force: true });
const server = createServer();
await new Promise<void>((resolve, reject) => {
  server.once("listening", () => resolve());
  server.once("error", reject);
  server.listen(tmpdir);
});
output({ stop: true });
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
      });

      // (c) CLI exit 0 — cleanup warning does not affect the exit code.
      expect(result.exitCode).toBe(0);

      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      expect(observedLoopxTmpdir.length).toBeGreaterThan(0);

      // (a) Path still exists and is a Unix-domain socket — SPEC §7.4 rule 3
      // leaves non-directory non-symlink entries in place.
      expect(existsSync(observedLoopxTmpdir)).toBe(true);
      const lst = lstatSync(observedLoopxTmpdir);
      expect(lst.isSocket()).toBe(true);
      expect(lst.isDirectory()).toBe(false);
      expect(lst.isSymbolicLink()).toBe(false);

      // (b) Exactly one cleanup-related warning on stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // Harness clean-up: remove the leftover socket entry.
      await rm(observedLoopxTmpdir, { force: true }).catch(() => {});
    });

    it("T-TMP-37c: CLI hard-link replacement leaves entry in place with nlink unchanged and exactly one cleanup warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();

      // Hard links require the source and destination to be on the same
      // filesystem. Both `project.dir` (under os.tmpdir()) and `tmpdirParent`
      // (also under os.tmpdir()) are typically same-device on POSIX, but
      // assert this explicitly so a cross-device test environment fails fast
      // with a clear message rather than producing a confusing `EXDEV` error
      // when the script tries to `ln`. Per SPEC §7.4 rule-3 hard-link sub-
      // clause coverage rationale.
      const projectDev = lstatSync(project.dir).dev;
      const parentDev = lstatSync(tmpdirParent).dev;
      if (projectDev !== parentDev) {
        // Skip if cross-device (unprivileged hard-link is not possible).
        // No structured `it.skip` here because we discovered the device
        // mismatch only after `setupTmpdirTest()`; emit a no-op assertion
        // and return.
        // eslint-disable-next-line no-console
        console.warn(
          `T-TMP-37c skipped: project.dir and tmpdirParent are on different devices (${projectDev} vs ${parentDev}); unprivileged hard-link is not possible.`,
        );
        return;
      }

      const tmpdirObservation = join(project.dir, "tmpdir.txt");
      const externalPathObservation = join(project.dir, "external-path.txt");
      const preCleanupNlinkObservation = join(project.dir, "pre-nlink.txt");

      // Bash fixture creates an external regular file (`external-content`),
      // removes the directory loopx created at `$LOOPX_TMPDIR`, and replaces
      // it with a HARD LINK to the external file — both paths now share the
      // same inode with `nlink == 2`. The script captures the pre-cleanup
      // `nlink` count of the external path into a marker (read after
      // loopx exits, so the harness can assert post-cleanup `nlink` equals
      // it). Use a portable `stat` invocation: GNU coreutils (`stat -c %h`)
      // or BSD/macOS (`stat -f %l`).
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
mkdir -p "$LOOPX_PROJECT_ROOT/external"
printf 'external-content' > "$LOOPX_PROJECT_ROOT/external/external-target-file"
printf '%s' "$LOOPX_PROJECT_ROOT/external/external-target-file" > "${externalPathObservation}"
rm -rf "$LOOPX_TMPDIR"
ln "$LOOPX_PROJECT_ROOT/external/external-target-file" "$LOOPX_TMPDIR"
{ stat -c '%h' "$LOOPX_PROJECT_ROOT/external/external-target-file" 2>/dev/null \\
  || stat -f '%l' "$LOOPX_PROJECT_ROOT/external/external-target-file"; } \\
  > "${preCleanupNlinkObservation}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
      });

      // (g) CLI exit 0 — cleanup warning does not affect the exit code.
      expect(result.exitCode).toBe(0);

      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      const externalPath = readFileSync(externalPathObservation, "utf-8");
      const preCleanupNlinkRaw = readFileSync(
        preCleanupNlinkObservation,
        "utf-8",
      ).trim();
      const preCleanupNlink = Number.parseInt(preCleanupNlinkRaw, 10);
      expect(observedLoopxTmpdir.length).toBeGreaterThan(0);
      expect(externalPath.length).toBeGreaterThan(0);
      expect(Number.isFinite(preCleanupNlink)).toBe(true);

      // (a) The tmpdir-side path still exists — loopx did NOT unlink the
      // hard-link entry under SPEC §7.4 rule 3.
      expect(existsSync(observedLoopxTmpdir)).toBe(true);
      const tmpdirLst = lstatSync(observedLoopxTmpdir);
      expect(tmpdirLst.isFile()).toBe(true);
      expect(readFileSync(observedLoopxTmpdir, "utf-8")).toBe(
        "external-content",
      );

      // (b) The external path also still exists with original content.
      expect(existsSync(externalPath)).toBe(true);
      const externalLst = lstatSync(externalPath);
      expect(externalLst.isFile()).toBe(true);
      expect(readFileSync(externalPath, "utf-8")).toBe("external-content");

      // (c) Pre-cleanup nlink == 2 (sanity: `ln A B` produces nlink=2
      // sharing one inode); post-cleanup external-path nlink == pre-cleanup
      // nlink — proving loopx did NOT decrement nlink by unlinking the
      // tmpdir-side entry. SPEC §7.4 rule 3 names this exact scenario as
      // the rationale for "leave in place".
      expect(preCleanupNlink).toBe(2);
      expect(externalLst.nlink).toBe(preCleanupNlink);

      // (d) Tmpdir-side nlink also unchanged at 2 (both ends of the hard-
      // link pair preserved).
      expect(tmpdirLst.nlink).toBe(2);

      // (e) Same inode on both ends — the hard-link relationship is intact.
      expect(tmpdirLst.ino).toBe(externalLst.ino);

      // (f) Exactly one cleanup-related warning on stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // Harness clean-up: remove the leftover hard-link entry. The
      // external file lives under `project.dir` and is removed by
      // `setupTmpdirTest`'s registered cleanup.
      await rm(observedLoopxTmpdir, { force: true }).catch(() => {});
    });

    it("T-TMP-37d: runPromise() recursive cleanup unlinks nested symlink without traversing target, no warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildNestedSymlinkFixture({ tmpdirObservation }),
      );

      const externalTargetDir = join(project.dir, "external-target-dir");
      const externalFile = join(externalTargetDir, "external-file");

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
const externalTargetDir = ${JSON.stringify(externalTargetDir)};
const externalFile = ${JSON.stringify(externalFile)};
let rejected = false;
let errMsg = "";
let outputs = [];
try {
  outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
} catch (e) {
  rejected = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
const externalDirExists = existsSync(externalTargetDir);
const externalFileExists = existsSync(externalFile);
const externalFileContent = externalFileExists ? readFileSync(externalFile, "utf-8") : "";
console.log(JSON.stringify({
  rejected,
  errMsg,
  outputsLen: outputs.length,
  observed,
  observedExists: existsSync(observed),
  externalDirExists,
  externalFileExists,
  externalFileContent,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Promise resolved (no rejection). One Output yielded.
      expect(data.rejected).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.outputsLen).toBe(1);

      // (b) LOOPX_TMPDIR removed — rule-4 recursive cleanup ran.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedExists).toBe(false);

      // (c) External target directory and `external-file` survive intact —
      // recursive walk did NOT traverse the nested symlink.
      expect(data.externalDirExists).toBe(true);
      expect(data.externalFileExists).toBe(true);
      expect(data.externalFileContent).toBe("external-content");

      // (d) Zero cleanup warnings on driver-process stderr — rule-4 success
      // branch is silent. NODE_ENV=test is set so the structured marker
      // would be emitted if any warning happened — load-bearing negative.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(0);
    });

    it("T-TMP-37e: run() recursive cleanup unlinks nested symlink without traversing target, no warning", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildNestedSymlinkFixture({ tmpdirObservation }),
      );

      const externalTargetDir = join(project.dir, "external-target-dir");
      const externalFile = join(externalTargetDir, "external-file");

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
const externalTargetDir = ${JSON.stringify(externalTargetDir)};
const externalFile = ${JSON.stringify(externalFile)};
let thrown = false;
let errMsg = "";
let yieldCount = 0;
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  for await (const _ of gen) { yieldCount++; }
} catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
const externalDirExists = existsSync(externalTargetDir);
const externalFileExists = existsSync(externalFile);
const externalFileContent = externalFileExists ? readFileSync(externalFile, "utf-8") : "";
console.log(JSON.stringify({
  thrown,
  errMsg,
  yieldCount,
  observed,
  observedExists: existsSync(observed),
  externalDirExists,
  externalFileExists,
  externalFileContent,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: { TMPDIR: tmpdirParent, NODE_ENV: "test" },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Generator settled cleanly (no throw). One yield.
      expect(data.thrown).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.yieldCount).toBe(1);

      // (b) LOOPX_TMPDIR removed — rule-4 recursive cleanup ran.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedExists).toBe(false);

      // (c) External target directory and `external-file` survive intact —
      // recursive walk did NOT traverse the nested symlink.
      expect(data.externalDirExists).toBe(true);
      expect(data.externalFileExists).toBe(true);
      expect(data.externalFileContent).toBe("external-content");

      // (d) Zero cleanup warnings on driver-process stderr — rule-4 success
      // branch is silent.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(0);
    });

    // ----------------------------------------------------------------------
    // T-TMP-40 / T-TMP-41 / T-TMP-42: SPEC §7.4 cleanup-failure branches.
    // SPEC §7.4 final paragraph: "If the top-level `lstat` fails for any
    // reason other than ENOENT, the `unlink` in case 2 fails, or the
    // recursive removal in case 4 fails, loopx emits a single stderr
    // warning and makes no further changes." The three failure branches are
    // specified normatively; black-box reproduction is unreliable on a
    // same-user-owned directory, so coverage is via the TEST-SPEC §1.4
    // `LOOPX_TEST_CLEANUP_FAULT` seam (gated on NODE_ENV=test). T-TMP-40
    // covers `lstat-fail` (top-level lstat failure path), T-TMP-41 covers
    // `symlink-unlink-fail` (rule-2 unlink failure), T-TMP-42 covers
    // `recursive-remove-fail` (rule-4 recursive removal failure). Each is
    // parameterized over the three execution surfaces (CLI / runPromise /
    // run) — load-bearing because a buggy implementation that wired one
    // stream of "warnings do not affect outcome" handling for the CLI exit-
    // code path and a separate stream for the API rejection path could
    // pass the CLI variant and fail the API variants. Together with
    // T-TMP-35 (rule-3 cleanup-safety warning branch) and T-TMP-36 (rule-5
    // cleanup-safety warning branch), this closes the cleanup-warning
    // coverage axis on the success terminal across all five SPEC §7.4
    // dispatch branches. Per-cleanup-attempt warning cardinality is
    // exactly one per SPEC §7.4 "single stderr warning"; the surfaced
    // outcome is unaffected per SPEC §7.4 "warnings do not affect the CLI
    // exit code, the generator outcome, or the promise rejection reason".
    // Implementation: the LOOPX_TEST_CLEANUP_FAULT seam is at three
    // failure-injection points in packages/loop-extender/src/tmpdir.ts —
    // the top of `cleanupTmpdir` for lstat-fail, the rule-2 unlink for
    // symlink-unlink-fail, and the rule-4 rmSync for recursive-remove-fail.
    // ----------------------------------------------------------------------

    it("T-TMP-40: CLI lstat-fail seam emits exactly one cleanup warning, exit 0, path remains", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      // Fixture: observe LOOPX_TMPDIR into an external marker (under
      // project.dir, not under the tmpdir, so the marker survives any
      // hypothetical cleanup) and emit stop:true. No path manipulation is
      // needed — the lstat-fail seam fires on the top-level `lstat` before
      // any dispatch rule is reached.
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_CLEANUP_FAULT: "lstat-fail",
        },
      });

      // (a) CLI exit 0 — cleanup-failure warning does not affect exit code
      // per SPEC §7.4 "warnings do not affect the CLI exit code".
      expect(result.exitCode).toBe(0);

      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      expect(observedLoopxTmpdir.length).toBeGreaterThan(0);

      // (b) Path observed in the marker still exists on disk — cleanup
      // aborted at the top-level lstat seam before any file operations,
      // per SPEC §7.4 "no further changes".
      expect(existsSync(observedLoopxTmpdir)).toBe(true);

      // (c) Exactly one cleanup-related warning on stderr (SPEC §7.4
      // "single stderr warning"; structured marker line count is the
      // implementation-neutral predicate per TEST-SPEC §1.4).
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);
    });

    it("T-TMP-40a: runPromise() lstat-fail seam emits exactly one cleanup warning, resolves, path remains", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let rejected = false;
let errMsg = "";
let outputs = [];
try {
  outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
} catch (e) {
  rejected = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
console.log(JSON.stringify({
  rejected,
  errMsg,
  outputsLen: outputs.length,
  observed,
  observedExists: existsSync(observed),
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_CLEANUP_FAULT: "lstat-fail",
        },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Promise resolved — cleanup warning does not affect the promise
      // rejection reason per SPEC §7.4. One Output yielded.
      expect(data.rejected).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.outputsLen).toBe(1);

      // (b) Path observed still exists — cleanup aborted at the seam.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedExists).toBe(true);

      // (c) Exactly one cleanup-related warning on driver-process stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);
    });

    it("T-TMP-40b: run() lstat-fail seam emits exactly one cleanup warning, settles cleanly, path remains", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let thrown = false;
let errMsg = "";
let yieldCount = 0;
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  for await (const _ of gen) { yieldCount++; }
} catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
console.log(JSON.stringify({
  thrown,
  errMsg,
  yieldCount,
  observed,
  observedExists: existsSync(observed),
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_CLEANUP_FAULT: "lstat-fail",
        },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Generator settled cleanly — cleanup warning does not affect the
      // generator outcome per SPEC §7.4. One yield.
      expect(data.thrown).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.yieldCount).toBe(1);

      // (b) Path observed still exists — cleanup aborted at the seam.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedExists).toBe(true);

      // (c) Exactly one cleanup-related warning on driver-process stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);
    });

    it("T-TMP-41: CLI symlink-unlink-fail seam emits exactly one cleanup warning, exit 0, symlink remains", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      // Fixture: observe LOOPX_TMPDIR, replace it with a symlink so the
      // cleanup dispatch reaches rule 2 (where the seam fires). The
      // symlink target (`/tmp`) is intentionally outside the tmpdir parent
      // so a buggy implementation that followed the symlink despite the
      // SPEC §7.4 "do not follow the target" clause would be detectable
      // (though here we additionally fault the rule-2 unlink itself).
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
rm -rf "$LOOPX_TMPDIR"
ln -s /tmp "$LOOPX_TMPDIR"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_CLEANUP_FAULT: "symlink-unlink-fail",
        },
      });

      // (a) CLI exit 0 per SPEC §7.4 "warnings do not affect the CLI exit
      // code".
      expect(result.exitCode).toBe(0);

      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      expect(observedLoopxTmpdir.length).toBeGreaterThan(0);

      // (b) Symlink at the recorded path still exists — rule-2 unlink was
      // faulted, so loopx made no further changes per SPEC §7.4.
      const lst = lstatSync(observedLoopxTmpdir);
      expect(lst.isSymbolicLink()).toBe(true);

      // (c) Exactly one cleanup-related warning on stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // Harness clean-up: remove the leftover symlink so the test-isolated
      // tmpdir parent can be torn down without confusion. (`rm` on a
      // symlink unlinks the symlink entry; it does not follow the target.)
      await rm(observedLoopxTmpdir, { force: true }).catch(() => {});
    });

    it("T-TMP-41a: runPromise() symlink-unlink-fail seam emits exactly one cleanup warning, resolves, symlink remains", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
rm -rf "$LOOPX_TMPDIR"
ln -s /tmp "$LOOPX_TMPDIR"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, lstatSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let rejected = false;
let errMsg = "";
let outputs = [];
try {
  outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
} catch (e) {
  rejected = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
let observedIsSymlink = false;
try {
  observedIsSymlink = lstatSync(observed).isSymbolicLink();
} catch {}
console.log(JSON.stringify({
  rejected,
  errMsg,
  outputsLen: outputs.length,
  observed,
  observedIsSymlink,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_CLEANUP_FAULT: "symlink-unlink-fail",
        },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Promise resolved — cleanup warning does not affect the promise
      // rejection reason per SPEC §7.4. One Output yielded.
      expect(data.rejected).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.outputsLen).toBe(1);

      // (b) Symlink at the recorded path still exists.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedIsSymlink).toBe(true);

      // (c) Exactly one cleanup-related warning on driver-process stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // Harness clean-up: remove the leftover symlink.
      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      await rm(observedLoopxTmpdir, { force: true }).catch(() => {});
    });

    it("T-TMP-41b: run() symlink-unlink-fail seam emits exactly one cleanup warning, settles cleanly, symlink remains", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
rm -rf "$LOOPX_TMPDIR"
ln -s /tmp "$LOOPX_TMPDIR"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, lstatSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let thrown = false;
let errMsg = "";
let yieldCount = 0;
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  for await (const _ of gen) { yieldCount++; }
} catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
let observedIsSymlink = false;
try {
  observedIsSymlink = lstatSync(observed).isSymbolicLink();
} catch {}
console.log(JSON.stringify({
  thrown,
  errMsg,
  yieldCount,
  observed,
  observedIsSymlink,
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_CLEANUP_FAULT: "symlink-unlink-fail",
        },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Generator settled cleanly — cleanup warning does not affect
      // the generator outcome per SPEC §7.4. One yield.
      expect(data.thrown).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.yieldCount).toBe(1);

      // (b) Symlink at the recorded path still exists.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedIsSymlink).toBe(true);

      // (c) Exactly one cleanup-related warning on driver-process stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // Harness clean-up: remove the leftover symlink.
      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      await rm(observedLoopxTmpdir, { force: true }).catch(() => {});
    });

    it("T-TMP-42: CLI recursive-remove-fail seam emits exactly one cleanup warning, exit 0, path remains", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      // Fixture: observe LOOPX_TMPDIR, write a few files inside (so the
      // path is a non-empty identity-matched directory) and emit stop:true.
      // The seam fires when the dispatch reaches rule 4 (identity-matched
      // directory recursive removal). The contents are not load-bearing —
      // the seam fires before `rmSync` is invoked — but populating the
      // directory matches the TEST-SPEC pattern and pins that recursive
      // removal would normally have visited the inner files.
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
echo content > "$LOOPX_TMPDIR/file-1"
mkdir "$LOOPX_TMPDIR/sub"
echo more > "$LOOPX_TMPDIR/sub/file-2"
printf '{"stop":true}'
`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_CLEANUP_FAULT: "recursive-remove-fail",
        },
      });

      // (a) CLI exit 0 per SPEC §7.4 "warnings do not affect the CLI exit
      // code".
      expect(result.exitCode).toBe(0);

      const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
      expect(observedLoopxTmpdir.length).toBeGreaterThan(0);

      // (b) Path observed in the marker still exists — cleanup made no
      // further changes after the simulated rule-4 failure per SPEC §7.4.
      // (The partial walk's effect on inner files is implementation-
      // defined, but the path itself remains visible at the recorded
      // location.)
      expect(existsSync(observedLoopxTmpdir)).toBe(true);

      // (c) Exactly one cleanup-related warning on stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);
    });

    it("T-TMP-42d: runPromise() recursive-remove-fail seam emits exactly one cleanup warning, resolves, path remains", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
echo content > "$LOOPX_TMPDIR/file-1"
mkdir "$LOOPX_TMPDIR/sub"
echo more > "$LOOPX_TMPDIR/sub/file-2"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let rejected = false;
let errMsg = "";
let outputs = [];
try {
  outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
} catch (e) {
  rejected = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
console.log(JSON.stringify({
  rejected,
  errMsg,
  outputsLen: outputs.length,
  observed,
  observedExists: existsSync(observed),
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_CLEANUP_FAULT: "recursive-remove-fail",
        },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Promise resolved — cleanup warning does not affect the promise
      // rejection reason per SPEC §7.4. One Output yielded.
      expect(data.rejected).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.outputsLen).toBe(1);

      // (b) Path observed still exists.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedExists).toBe(true);

      // (c) Exactly one cleanup-related warning on driver-process stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);
    });

    it("T-TMP-42e: run() recursive-remove-fail seam emits exactly one cleanup warning, settles cleanly, path remains", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const tmpdirObservation = join(project.dir, "tmpdir.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${tmpdirObservation}"
echo content > "$LOOPX_TMPDIR/file-1"
mkdir "$LOOPX_TMPDIR/sub"
echo more > "$LOOPX_TMPDIR/sub/file-2"
printf '{"stop":true}'
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let thrown = false;
let errMsg = "";
let yieldCount = 0;
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  for await (const _ of gen) { yieldCount++; }
} catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
console.log(JSON.stringify({
  thrown,
  errMsg,
  yieldCount,
  observed,
  observedExists: existsSync(observed),
}));
`;
      const result = await runAPIDriver(runtime, driverCode, {
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_CLEANUP_FAULT: "recursive-remove-fail",
        },
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);

      // (a) Generator settled cleanly — cleanup warning does not affect
      // the generator outcome per SPEC §7.4. One yield.
      expect(data.thrown).toBe(false);
      expect(data.errMsg).toBe("");
      expect(data.yieldCount).toBe(1);

      // (b) Path observed still exists.
      expect(data.observed.length).toBeGreaterThan(0);
      expect(data.observedExists).toBe(true);

      // (c) Exactly one cleanup-related warning on driver-process stderr.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);
    });

    // ----------------------------------------------------------------------
    // T-TMP-42a: cleanup-fault warning does not mask non-zero script exit.
    // SPEC §7.4 final paragraph: "warnings do not affect the CLI exit code,
    // the generator outcome, or the promise rejection reason." T-TMP-40/41/42
    // pin this on the success terminal across the three fault seams ×
    // three surfaces. T-TMP-42a closes the matrix on the script-failure
    // terminal: the script exits non-zero AND a cleanup-fault seam fires
    // during the §7.4 cleanup-safety dispatch (lstat-fail / symlink-unlink-
    // fail / recursive-remove-fail), and the surfaced terminal must remain
    // the SCRIPT failure (CLI exit 1 with the script's stderr passed
    // through; runPromise rejects with the script-failure error; run()
    // throws the script-failure error), not a cleanup-failure-class
    // outcome. The implementation in `runLoop`
    // (packages/loop-extender/src/loop.ts:120-217) wraps the iteration body
    // in `try/finally` so `cleanupTmpdir` (which emits the warning) runs
    // before the script-failure `throw new Error('Script <wf>:<scr>
    // exited with code <n>')` propagates out of the generator. The CLI
    // test carries an observably-disjoint-lines assertion (mirroring
    // T-TMP-35c): a distinctive `SCRIPT-FAILURE-MARKER-T-TMP-42A` line
    // printed to stderr by the script before its tampering must reach the
    // user's stderr on a separate line from the
    // `LOOPX_TEST_CLEANUP_WARNING\t…` marker. Since both the script-failure
    // path and a hypothetical cleanup-promoted-to-failure path produce CLI
    // exit 1, exit-code alone cannot distinguish — the disjoint-lines
    // assertion is what catches a buggy implementation that wrapped or
    // replaced the script's stderr with a cleanup-classifier wrapper.
    // The API tests carry an error-message-shape probe: rejection reason
    // (runPromise) / throw value (run) must match the loop.ts contract
    // `Script '<wf>:<scr>' exited with code <n>` (regex `/exited with
    // code/`) and must NOT contain "cleanup" anywhere in the message.
    // Per fault-seam path persistence: lstat-fail leaves the original
    // identity-matched directory; symlink-unlink-fail leaves the
    // script-installed symlink; recursive-remove-fail leaves the original
    // directory with files inside.
    // ----------------------------------------------------------------------

    const CLEANUP_FAULT_VARIANTS = [
      "lstat-fail",
      "symlink-unlink-fail",
      "recursive-remove-fail",
    ] as const;
    type CleanupFaultVariant = (typeof CLEANUP_FAULT_VARIANTS)[number];

    function buildScriptErrorCleanupFaultFixture(args: {
      tmpdirObservation: string;
      fault: CleanupFaultVariant;
    }): string {
      // Per-fault tampering required to make the seam fire on the failure
      // path:
      //   - lstat-fail: seam fires at the top-level lstat in
      //     cleanupTmpdir; no path manipulation needed.
      //   - symlink-unlink-fail: seam fires only when dispatch reaches
      //     rule 2 (path is a symlink), so the script must replace the
      //     tmpdir with a symlink.
      //   - recursive-remove-fail: seam fires only when dispatch reaches
      //     rule 4 (identity-matched directory); the original loopx-
      //     created directory satisfies that. Populating the directory
      //     with files matches the success-terminal T-TMP-42 fixture and
      //     pins that recursive removal would normally have visited the
      //     inner files.
      let tampering: string;
      if (args.fault === "lstat-fail") {
        tampering = "";
      } else if (args.fault === "symlink-unlink-fail") {
        tampering = `rm -rf "$LOOPX_TMPDIR"
ln -s /tmp "$LOOPX_TMPDIR"`;
      } else {
        tampering = `echo content > "$LOOPX_TMPDIR/file-1"
mkdir "$LOOPX_TMPDIR/sub"
echo more > "$LOOPX_TMPDIR/sub/file-2"`;
      }
      return `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${args.tmpdirObservation}"
printf 'SCRIPT-FAILURE-MARKER-T-TMP-42A: script about to fail with non-zero exit\\n' >&2
${tampering}
exit 1
`;
    }

    for (const fault of CLEANUP_FAULT_VARIANTS) {
      it(`T-TMP-42a (${fault}): CLI cleanup-fault warning does not mask script-error exit code`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const tmpdirObservation = join(project.dir, "tmpdir.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          buildScriptErrorCleanupFaultFixture({
            tmpdirObservation,
            fault,
          }),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: {
            TMPDIR: tmpdirParent,
            NODE_ENV: "test",
            LOOPX_TEST_CLEANUP_FAULT: fault,
          },
        });

        // (a) CLI exit 1 — cleanup-fault warning does not mask the
        // script-failure exit code per SPEC §7.4.
        expect(result.exitCode).toBe(1);

        const observedLoopxTmpdir = readFileSync(tmpdirObservation, "utf-8");
        expect(observedLoopxTmpdir.length).toBeGreaterThan(0);

        const stderrLines = result.stderr.split("\n");

        // (b) Exactly one script-failure marker on stderr.
        const markerLines = stderrLines.filter((l) =>
          l.includes("SCRIPT-FAILURE-MARKER-T-TMP-42A"),
        );
        expect(markerLines.length).toBe(1);

        // (c) Exactly one cleanup-related warning on stderr.
        const cleanupWarnings = stderrLines.filter((l) =>
          l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"),
        );
        expect(cleanupWarnings.length).toBe(1);

        // (d) Marker line and warning line are observably disjoint —
        // catches a buggy implementation that wrapped script stderr in a
        // cleanup classifier or vice versa.
        expect(markerLines[0]).not.toContain("LOOPX_TEST_CLEANUP_WARNING");
        expect(cleanupWarnings[0]).not.toContain(
          "SCRIPT-FAILURE-MARKER-T-TMP-42A",
        );

        // (e) Path persistence per cleanup-fault seam — cleanup made no
        // further changes after the simulated failure per SPEC §7.4.
        if (fault === "symlink-unlink-fail") {
          const lst = lstatSync(observedLoopxTmpdir);
          expect(lst.isSymbolicLink()).toBe(true);
          await rm(observedLoopxTmpdir, { force: true }).catch(() => {});
        } else {
          expect(existsSync(observedLoopxTmpdir)).toBe(true);
        }
      });
    }

    for (const fault of CLEANUP_FAULT_VARIANTS) {
      it(`T-TMP-42a (${fault}): runPromise() cleanup-fault warning does not mask script-error rejection reason`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const tmpdirObservation = join(project.dir, "tmpdir.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          buildScriptErrorCleanupFaultFixture({
            tmpdirObservation,
            fault,
          }),
        );

        const driverCode = `
import { runPromise } from "loopx";
import { existsSync, lstatSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let rejected = false;
let errMsg = "";
let outputs = [];
try {
  outputs = await runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
} catch (e) {
  rejected = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
const observedExists = existsSync(observed);
let observedIsSymlink = false;
try { observedIsSymlink = lstatSync(observed).isSymbolicLink(); } catch {}
console.log(JSON.stringify({
  rejected,
  errMsg,
  outputsLen: outputs.length,
  observed,
  observedExists,
  observedIsSymlink,
}));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: {
            TMPDIR: tmpdirParent,
            NODE_ENV: "test",
            LOOPX_TEST_CLEANUP_FAULT: fault,
          },
        });
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);

        // (a) Promise rejected — cleanup-fault warning does not mask the
        // script-failure rejection reason per SPEC §7.4.
        expect(data.rejected).toBe(true);

        // (b) Rejection reason matches the script-failure shape from
        // loop.ts and does NOT mention "cleanup".
        expect(data.errMsg).toMatch(/exited with code/);
        expect(data.errMsg.toLowerCase()).not.toContain("cleanup");

        // (c) Exactly one cleanup-related warning on driver-process stderr.
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(1);

        // (d) Path persistence per cleanup-fault seam.
        expect(data.observed.length).toBeGreaterThan(0);
        if (fault === "symlink-unlink-fail") {
          expect(data.observedIsSymlink).toBe(true);
          await rm(data.observed, { force: true }).catch(() => {});
        } else {
          expect(data.observedExists).toBe(true);
        }
      });
    }

    for (const fault of CLEANUP_FAULT_VARIANTS) {
      it(`T-TMP-42a (${fault}): run() generator cleanup-fault warning does not mask script-error throw`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const tmpdirObservation = join(project.dir, "tmpdir.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          buildScriptErrorCleanupFaultFixture({
            tmpdirObservation,
            fault,
          }),
        );

        const driverCode = `
import { run } from "loopx";
import { existsSync, lstatSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
let thrown = false;
let errMsg = "";
let yieldCount = 0;
try {
  const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
  for await (const _ of gen) { yieldCount++; }
} catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
const observed = readFileSync(tmpdirObservation, "utf-8");
const observedExists = existsSync(observed);
let observedIsSymlink = false;
try { observedIsSymlink = lstatSync(observed).isSymbolicLink(); } catch {}
console.log(JSON.stringify({
  thrown,
  errMsg,
  yieldCount,
  observed,
  observedExists,
  observedIsSymlink,
}));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: {
            TMPDIR: tmpdirParent,
            NODE_ENV: "test",
            LOOPX_TEST_CLEANUP_FAULT: fault,
          },
        });
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);

        // (a) Generator threw — cleanup-fault warning does not mask the
        // script-failure throw per SPEC §7.4.
        expect(data.thrown).toBe(true);

        // (b) Thrown error matches the script-failure shape from loop.ts
        // and does NOT mention "cleanup".
        expect(data.errMsg).toMatch(/exited with code/);
        expect(data.errMsg.toLowerCase()).not.toContain("cleanup");

        // (c) Exactly one cleanup-related warning on driver-process stderr.
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(1);

        // (d) Path persistence per cleanup-fault seam.
        expect(data.observed.length).toBeGreaterThan(0);
        if (fault === "symlink-unlink-fail") {
          expect(data.observedIsSymlink).toBe(true);
          await rm(data.observed, { force: true }).catch(() => {});
        } else {
          expect(data.observedExists).toBe(true);
        }
      });
    }

    // ------------------------------------------------------------------------
    // T-TMP-42b: cleanup-fault warning does not mask the abort terminal
    // across the two programmatic surfaces (run() / runPromise()). Companion
    // to T-TMP-42a (cleanup-failure × script-error × all surfaces) and
    // T-TMP-42c (cleanup-failure × CLI signal terminal). Together with
    // T-TMP-35g / T-TMP-35h (cleanup-safety × abort × programmatic surfaces),
    // this closes the cleanup-warning-does-not-affect-outcome coverage axis
    // on the abort terminal × cleanup-failure-warning branch.
    //
    // SPEC §7.4: "cleanup warnings do not affect the CLI exit code, the
    // generator outcome, or the promise rejection reason." A buggy
    // implementation that promoted the cleanup-failure warning to a
    // cleanup-failure-class rejection in place of the abort error would
    // pass T-TMP-35g / T-TMP-35h (cleanup-safety branch on the same
    // terminal) yet fail this test, distinguishing the cleanup-safety
    // warning branch from the cleanup-failure warning branch on the abort
    // terminal.
    //
    // Parameterized over the three cleanup-fault seam values (lstat-fail,
    // symlink-unlink-fail, recursive-remove-fail) and over both programmatic
    // surfaces (runPromise() / run()) — six sub-cases per runtime.
    //
    // Per-fault tampering required to make the seam fire under the abort
    // terminal (same as T-TMP-42c's per-fault dispatch reasoning):
    //   - lstat-fail: seam fires at the top-level lstat in cleanupTmpdir;
    //     no path manipulation needed.
    //   - symlink-unlink-fail: seam fires only when dispatch reaches
    //     rule 2 (path is a symlink), so the script must replace the
    //     tmpdir with a symlink before blocking.
    //   - recursive-remove-fail: seam fires only when dispatch reaches
    //     rule 4 (identity-matched directory). Populating the directory
    //     pins that recursive removal would normally have visited inner
    //     entries.
    //
    // The fixture writes its PID to a marker so the harness can verify
    // active-child termination (SPEC §9.1) after the abort, and writes
    // the original LOOPX_TMPDIR path to an external observation marker so
    // post-run path-persistence assertions can run regardless of the per-
    // fault tampering.
    // ------------------------------------------------------------------------

    /**
     * Build the bash fixture body for the T-TMP-42b (abort × cleanup-fault)
     * variants. Observes LOOPX_TMPDIR into an external marker, performs the
     * fault-specific tampering required to drive the cleanup-safety dispatch
     * into the seam-protected branch, writes its PID to a separate marker,
     * then blocks indefinitely so the run can only terminate via the abort
     * delivered by the harness once both markers are visible.
     */
    function buildAbortCleanupFaultFixture(args: {
      tmpdirObservation: string;
      pidMarker: string;
      fault: CleanupFaultVariant;
    }): string {
      let tampering: string;
      if (args.fault === "lstat-fail") {
        tampering = "";
      } else if (args.fault === "symlink-unlink-fail") {
        tampering = `rm -rf "$LOOPX_TMPDIR"
ln -s /tmp "$LOOPX_TMPDIR"`;
      } else {
        tampering = `echo content > "$LOOPX_TMPDIR/file-1"
mkdir "$LOOPX_TMPDIR/sub"
echo more > "$LOOPX_TMPDIR/sub/file-2"`;
      }
      return `#!/bin/bash
set -e
ORIG_TMPDIR="$LOOPX_TMPDIR"
${tampering}
printf '%s' "$ORIG_TMPDIR" > "${args.tmpdirObservation}"
printf '%s' "$$" > "${args.pidMarker}"
while true; do sleep 1; done
`;
    }

    for (const fault of CLEANUP_FAULT_VARIANTS) {
      it(`T-TMP-42b (${fault}): runPromise() cleanup-fault warning does not mask abort rejection reason`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const tmpdirObservation = join(project.dir, "tmpdir.txt");
        const pidMarker = join(project.dir, "pid.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          buildAbortCleanupFaultFixture({
            tmpdirObservation,
            pidMarker,
            fault,
          }),
        );

        const driverCode = `
import { runPromise } from "loopx";
import { existsSync, lstatSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
const pidMarker = ${JSON.stringify(pidMarker)};
async function waitForObservation() {
  for (let i = 0; i < 600; i++) {
    if (existsSync(tmpdirObservation) && existsSync(pidMarker)) {
      const t = readFileSync(tmpdirObservation, "utf-8");
      const p = readFileSync(pidMarker, "utf-8").trim();
      if (t.length > 0 && p.length > 0) return { tmpdir: t, pid: parseInt(p, 10) };
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("markers never appeared");
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitDead(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return !isAlive(pid);
}
const c = new AbortController();
const p = runPromise("ralph", { cwd: ${JSON.stringify(project.dir)}, signal: c.signal });
const { tmpdir: observed, pid } = await waitForObservation();
c.abort();
let rejected = false;
let errMsg = "";
let errName = "";
try {
  await p;
} catch (e) {
  rejected = true;
  errMsg = e instanceof Error ? e.message : String(e);
  errName = e instanceof Error ? (e.name || "") : "";
}
const childDead = await waitDead(pid, 10_000);
const observedExists = existsSync(observed);
let observedIsSymlink = false;
try { observedIsSymlink = lstatSync(observed).isSymbolicLink(); } catch {}
console.log(JSON.stringify({
  rejected,
  errMsg,
  errName,
  observed,
  pid,
  childDead,
  observedExists,
  observedIsSymlink,
}));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: {
            TMPDIR: tmpdirParent,
            NODE_ENV: "test",
            LOOPX_TEST_CLEANUP_FAULT: fault,
          },
          timeout: 30_000,
        });
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);

        // (a) Promise rejected with abort error. Cleanup-fault warning
        // does not mask the abort rejection reason per SPEC §7.4.
        // Load-bearing: a buggy implementation that promoted the cleanup-
        // failure warning to a cleanup-failure-class rejection in place
        // of the abort error would fail this assertion.
        expect(data.rejected).toBe(true);
        expect(
          data.errName === "AbortError" || /abort/i.test(data.errMsg),
        ).toBe(true);
        expect(data.errMsg.toLowerCase()).not.toContain("cleanup");

        // (b) Exactly one cleanup-related warning on driver-process
        // stderr — per-run cleanup-warning cardinality from SPEC §7.4
        // holds under the abort terminal × cleanup-failure branch.
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(1);

        // (c) Active child PG terminated per SPEC §9.1 / §9.5 — abort-
        // driven process-group termination still applies under the
        // cleanup-failure branch.
        expect(data.childDead).toBe(true);

        // (d) Path persistence per cleanup-fault seam — cleanup made no
        // further changes after the simulated failure per SPEC §7.4.
        expect(data.observed.length).toBeGreaterThan(0);
        if (fault === "symlink-unlink-fail") {
          expect(data.observedIsSymlink).toBe(true);
          await rm(data.observed, { force: true }).catch(() => {});
        } else {
          expect(data.observedExists).toBe(true);
        }
      });
    }

    for (const fault of CLEANUP_FAULT_VARIANTS) {
      it(`T-TMP-42b (${fault}): run() generator cleanup-fault warning does not mask abort throw`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const tmpdirObservation = join(project.dir, "tmpdir.txt");
        const pidMarker = join(project.dir, "pid.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          buildAbortCleanupFaultFixture({
            tmpdirObservation,
            pidMarker,
            fault,
          }),
        );

        const driverCode = `
import { run } from "loopx";
import { existsSync, lstatSync, readFileSync } from "node:fs";
const tmpdirObservation = ${JSON.stringify(tmpdirObservation)};
const pidMarker = ${JSON.stringify(pidMarker)};
async function waitForObservation() {
  for (let i = 0; i < 600; i++) {
    if (existsSync(tmpdirObservation) && existsSync(pidMarker)) {
      const t = readFileSync(tmpdirObservation, "utf-8");
      const p = readFileSync(pidMarker, "utf-8").trim();
      if (t.length > 0 && p.length > 0) return { tmpdir: t, pid: parseInt(p, 10) };
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("markers never appeared");
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitDead(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return !isAlive(pid);
}
const c = new AbortController();
const gen = run("ralph", { cwd: ${JSON.stringify(project.dir)}, signal: c.signal });
const nextP = gen.next();
nextP.catch(() => {});
const { tmpdir: observed, pid } = await waitForObservation();
c.abort();
let thrown = false;
let errMsg = "";
let errName = "";
try {
  await nextP;
} catch (e) {
  thrown = true;
  errMsg = e instanceof Error ? e.message : String(e);
  errName = e instanceof Error ? (e.name || "") : "";
}
const childDead = await waitDead(pid, 10_000);
const observedExists = existsSync(observed);
let observedIsSymlink = false;
try { observedIsSymlink = lstatSync(observed).isSymbolicLink(); } catch {}
console.log(JSON.stringify({
  thrown,
  errMsg,
  errName,
  observed,
  pid,
  childDead,
  observedExists,
  observedIsSymlink,
}));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          env: {
            TMPDIR: tmpdirParent,
            NODE_ENV: "test",
            LOOPX_TEST_CLEANUP_FAULT: fault,
          },
          timeout: 30_000,
        });
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);

        // (a) Generator threw abort error. Cleanup-fault warning does not
        // mask the generator outcome per SPEC §7.4. Load-bearing: a
        // buggy implementation that wrapped the abort error in a cleanup-
        // failure error or routed run() settlement through a different
        // dispatcher than runPromise() rejection would fail this counter-
        // part to the runPromise variant above.
        expect(data.thrown).toBe(true);
        expect(
          data.errName === "AbortError" || /abort/i.test(data.errMsg),
        ).toBe(true);
        expect(data.errMsg.toLowerCase()).not.toContain("cleanup");

        // (b) Exactly one cleanup-related warning on driver-process
        // stderr — per-run cleanup-warning cardinality from SPEC §7.4.
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(1);

        // (c) Active child PG terminated per SPEC §9.1 / §9.5.
        expect(data.childDead).toBe(true);

        // (d) Path persistence per cleanup-fault seam.
        expect(data.observed.length).toBeGreaterThan(0);
        if (fault === "symlink-unlink-fail") {
          expect(data.observedIsSymlink).toBe(true);
          await rm(data.observed, { force: true }).catch(() => {});
        } else {
          expect(data.observedExists).toBe(true);
        }
      });
    }

    // ------------------------------------------------------------------------
    // T-TMP-42c: cleanup-fault warning does not mask CLI signal terminal.
    // SPEC §7.4 final paragraph: "warnings do not affect the CLI exit code,
    // the generator outcome, or the promise rejection reason." The
    // contract holds for both the cleanup-safety warning branch and the
    // cleanup-failure warning branch.
    //
    // Coverage matrix entries already pinned:
    //   T-TMP-35f (cleanup-safety × signal × CLI),
    //   T-TMP-40 / T-TMP-41 / T-TMP-42 (cleanup-failure × success × all
    //     three surfaces),
    //   T-TMP-42a (cleanup-failure × script-error × all three surfaces),
    //   T-TMP-42b (cleanup-failure × abort × programmatic surfaces — abort
    //     is programmatic-only).
    //
    // T-TMP-42c closes the remaining diagonal: cleanup-failure warning ×
    // CLI signal terminal. A buggy implementation that wired the signal-
    // terminal `128 + signal-number` exit-code path correctly for rule-3 /
    // rule-5 cleanup-safety warnings (passing T-TMP-35f) yet routed
    // cleanup-failure warnings (lstat-fail / symlink-unlink-fail /
    // recursive-remove-fail) through a separate stream that promoted the
    // warning to a cleanup-failure-class exit code under signal — exit 1
    // or some implementation-specific cleanup-failure code instead of the
    // signal code — would pass T-TMP-35f / T-TMP-40 / T-TMP-41 / T-TMP-42 /
    // T-TMP-42a / T-TMP-42b and fail this test.
    //
    // Parameterized over the three cleanup-fault seam values (lstat-fail,
    // symlink-unlink-fail, recursive-remove-fail) and over both signals
    // (SIGINT, SIGTERM) — six sub-cases per runtime.
    //
    // Per-fault tampering required to make the seam fire under the signal
    // terminal:
    //   - lstat-fail: seam fires at the top-level lstat in cleanupTmpdir;
    //     no path manipulation needed.
    //   - symlink-unlink-fail: seam fires only when dispatch reaches
    //     rule 2 (path is a symlink), so the script must replace the
    //     tmpdir with a symlink before blocking.
    //   - recursive-remove-fail: seam fires only when dispatch reaches
    //     rule 4 (identity-matched directory); the original loopx-created
    //     directory satisfies that. Populating the directory with files
    //     pins that recursive removal would normally have visited inner
    //     entries.
    //
    // Per-fault path persistence (cleanup made no further changes after
    // simulated failure per SPEC §7.4):
    //   - lstat-fail: top-level lstat throws, dispatch never starts;
    //     identity-matched directory at recorded path remains.
    //   - symlink-unlink-fail: rule-2 unlink throws; the script-installed
    //     symlink remains.
    //   - recursive-remove-fail: rule-4 rmSync throws; the recorded path
    //     itself remains visible (the partial walk's effect on inner
    //     entries is implementation-defined per SPEC §7.4 "no further
    //     changes" wording, but the recorded path remains).
    //
    // Together with T-TMP-35f (cleanup-safety × signal × CLI), T-TMP-40 /
    // T-TMP-41 / T-TMP-42 (cleanup-failure × success × all surfaces),
    // T-TMP-42a (cleanup-failure × script-error × all surfaces), and
    // T-TMP-42b (cleanup-failure × abort × programmatic surfaces), this
    // closes the cleanup-warning-does-not-affect-outcome coverage axis
    // for the cleanup-failure branch across all four terminal types —
    // success, script-error, signal, abort.
    // ----------------------------------------------------------------------

    /**
     * Build the bash fixture body for the T-TMP-42c (signal × cleanup-
     * fault) variants. Observes LOOPX_TMPDIR into an external marker so
     * the harness can verify post-run path persistence, performs the
     * fault-specific tampering required to drive the cleanup-safety
     * dispatch into the seam-protected branch, prints "ready" to stderr
     * (consumed by the CLI signal coordinator via runCLIWithSignal's
     * waitForStderr), then blocks indefinitely so the run can only
     * terminate via signal.
     */
    function buildSignalCleanupFaultFixture(args: {
      tmpdirObservation: string;
      fault: CleanupFaultVariant;
    }): string {
      let tampering: string;
      if (args.fault === "lstat-fail") {
        tampering = "";
      } else if (args.fault === "symlink-unlink-fail") {
        tampering = `rm -rf "$LOOPX_TMPDIR"
ln -s /tmp "$LOOPX_TMPDIR"`;
      } else {
        tampering = `echo content > "$LOOPX_TMPDIR/file-1"
mkdir "$LOOPX_TMPDIR/sub"
echo more > "$LOOPX_TMPDIR/sub/file-2"`;
      }
      return `#!/bin/bash
set -e
printf '%s' "$LOOPX_TMPDIR" > "${args.tmpdirObservation}"
${tampering}
echo "ready" >&2
while true; do sleep 1; done
`;
    }

    for (const fault of CLEANUP_FAULT_VARIANTS) {
      for (const signalName of SIGNAL_VARIANTS) {
        it(`T-TMP-42c (${fault} × ${signalName}): CLI cleanup-fault warning does not mask signal exit code`, async () => {
          const { project, tmpdirParent } = await setupTmpdirTest();
          const tmpdirObservation = join(project.dir, "tmpdir.txt");

          await createWorkflowScript(
            project,
            "ralph",
            "index",
            ".sh",
            buildSignalCleanupFaultFixture({
              tmpdirObservation,
              fault,
            }),
          );

          const { result, sendSignal, waitForStderr } = runCLIWithSignal(
            ["run", "-n", "1", "ralph"],
            {
              cwd: project.dir,
              runtime,
              env: {
                TMPDIR: tmpdirParent,
                NODE_ENV: "test",
                LOOPX_TEST_CLEANUP_FAULT: fault,
              },
              timeout: 30_000,
            },
          );

          await waitForStderr("ready");
          sendSignal(signalName);
          const outcome = await result;

          // (a) CLI exit code matches the signal terminal (130 for
          // SIGINT, 143 for SIGTERM). The cleanup-failure warning did
          // not mask, replace, or override the signal exit code per
          // SPEC §7.4 — load-bearing.
          const expectedCode = signalName === "SIGINT" ? 130 : 143;
          expect(outcome.exitCode).toBe(expectedCode);

          const observedLoopxTmpdir = readFileSync(
            tmpdirObservation,
            "utf-8",
          );
          expect(observedLoopxTmpdir.length).toBeGreaterThan(0);

          // (b) Exactly one cleanup-related warning on stderr — per-run
          // cleanup-warning cardinality from SPEC §7.4 holds under the
          // signal terminal; the signal does not double the warning
          // emission.
          const cleanupWarnings = outcome.stderr
            .split("\n")
            .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
          expect(cleanupWarnings.length).toBe(1);

          // (c) Path persistence per fault seam — cleanup made no
          // further changes after the simulated failure per SPEC §7.4.
          if (fault === "symlink-unlink-fail") {
            const lst = lstatSync(observedLoopxTmpdir);
            expect(lst.isSymbolicLink()).toBe(true);
            await rm(observedLoopxTmpdir, { force: true }).catch(() => {});
          } else {
            expect(existsSync(observedLoopxTmpdir)).toBe(true);
          }
        });
      }
    }

    // ------------------------------------------------------------------------
    // T-TMP-38 / T-TMP-39: SPEC §7.2 / §7.4 cleanup-idempotence and
    // warning-cardinality contracts under racing terminal triggers.
    //
    // SPEC §7.2: "The first terminal trigger observed by loopx determines the
    // surfaced outcome among genuinely racing triggers" + "Racing terminal
    // triggers ... do not start a second cleanup attempt and do not re-emit
    // cleanup warnings." Both rules pin behavior at the sub-millisecond
    // granularity that black-box tests cannot reach without a coordination
    // seam.
    //
    // The TEST-SPEC §1.4 `LOOPX_TEST_TERMINAL_TRIGGER_PAUSE=cleanup-start`
    // seam pauses loopx at the entry of the cleanup routine for a bounded
    // interval, after writing a parent-observable marker, so the harness can
    // race a second terminal trigger in deterministically. The companion
    // `LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER` env var names the marker
    // file path.
    //
    // T-TMP-38 covers the regular-file (SPEC §7.4 rule 3) cleanup-warning
    // branch under SIGINT-then-SIGTERM-during-cleanup-pause race.
    // T-TMP-39 covers the mismatched-directory (SPEC §7.4 rule 5) branch
    // under the same race.
    //
    // For both tests the load-bearing assertions are:
    //   (a) loopx exits with the SIGINT exit code 130 (the first-observed
    //       signal — SPEC §7.2 first-trigger-wins; the post-cleanup-start
    //       SIGTERM does not displace the first signal's exit code).
    //   (b) Exactly one cleanup-related warning on stderr (per-run cleanup-
    //       warning cardinality from SPEC §7.4: cleanup runs once and warns
    //       once).
    //   (c) Path persistence per cleanup-safety branch — cleanup completed
    //       once, leaving the rule-3 / rule-5 path in place.
    //
    // A buggy implementation that started a second cleanup attempt on the
    // racing SIGTERM would produce a second warning and fail (b).
    // ------------------------------------------------------------------------

    /**
     * Build the bash fixture body for the racing-trigger tests. Tampers with
     * $LOOPX_TMPDIR (rule-3 regular-file replacement, or rule-5 mismatched-
     * directory rename-aside), writes "ready" to stderr (consumed by the CLI
     * signal coordinator via `waitForStderr`), then blocks forever. The
     * signal/cleanup race begins after "ready".
     */
    function buildRaceFixture(args: {
      variant: "regular-file" | "mismatched-directory";
    }): string {
      const tampering =
        args.variant === "regular-file"
          ? `rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"`
          : `mv "$LOOPX_TMPDIR" "$LOOPX_TMPDIR-aside"
mkdir "$LOOPX_TMPDIR"
touch "$LOOPX_TMPDIR/mismatched-marker"`;
      return `#!/bin/bash
set -e
${tampering}
echo "ready" >&2
while true; do sleep 1; done
`;
    }

    /**
     * Polls for the presence of `path` for up to `timeoutMs`, sleeping
     * `intervalMs` between checks. Resolves true when the file exists,
     * false on timeout. Used to coordinate the cleanup-start pause with
     * the racing-second-signal harness step.
     */
    async function waitForFile(
      path: string,
      timeoutMs: number,
      intervalMs: number = 50,
    ): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (existsSync(path)) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return false;
    }

    it("T-TMP-38: cleanup idempotence under racing SIGINT → SIGTERM (rule-3 regular-file)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const pauseMarker = join(project.dir, "pause-marker.json");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildRaceFixture({ variant: "regular-file" }),
      );

      const { result, sendSignal, waitForStderr } = runCLIWithSignal(
        ["run", "-n", "1", "ralph"],
        {
          cwd: project.dir,
          runtime,
          env: {
            TMPDIR: tmpdirParent,
            NODE_ENV: "test",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "cleanup-start",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          },
          timeout: 30_000,
        },
      );

      // Wait for the script to finish tampering and start blocking.
      await waitForStderr("ready");

      // First-observed signal: SIGINT. Triggers abort → cleanup → seam pause.
      sendSignal("SIGINT");

      // Poll for the parent-observable marker → cleanup is paused at entry.
      const markerWritten = await waitForFile(pauseMarker, 10_000);
      expect(markerWritten).toBe(true);

      // Marker payload echoes the resolved window value (TEST-SPEC §1.4).
      const marker = JSON.parse(readFileSync(pauseMarker, "utf-8"));
      expect(marker.window).toBe("cleanup-start");

      // Second-observed signal: SIGTERM. Delivered while loopx is paused at
      // cleanup-start. SPEC §7.2 first-trigger-wins: must NOT displace the
      // SIGINT exit code; SPEC §7.4 idempotence: must NOT start a second
      // cleanup attempt or re-emit a cleanup warning.
      sendSignal("SIGTERM");

      const outcome = await result;

      // (a) SIGINT exit code preserved across the SIGTERM-during-cleanup race.
      expect(outcome.exitCode).toBe(130);

      // (b) Exactly one cleanup-related warning — single cleanup attempt.
      const cleanupWarnings = outcome.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // (c) Path persistence — rule-3 leave-with-warning preserved.
      // Find the loopx tmpdir entry under the test-isolated parent.
      const remaining = listLoopxEntries(tmpdirParent);
      expect(remaining.length).toBe(1);
      const tmpdirPath = join(tmpdirParent, remaining[0]);
      expect(existsSync(tmpdirPath)).toBe(true);
      const st = statSync(tmpdirPath);
      expect(st.isFile()).toBe(true);
      expect(readFileSync(tmpdirPath, "utf-8")).toBe(
        "regular-file-replacement",
      );

      await rm(tmpdirPath, { force: true }).catch(() => {});
    }, { timeout: 60_000, retry: 2 });

    it("T-TMP-39: warning cardinality under racing SIGINT → SIGTERM (rule-5 mismatched-dir)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const pauseMarker = join(project.dir, "pause-marker.json");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildRaceFixture({ variant: "mismatched-directory" }),
      );

      const { result, sendSignal, waitForStderr } = runCLIWithSignal(
        ["run", "-n", "1", "ralph"],
        {
          cwd: project.dir,
          runtime,
          env: {
            TMPDIR: tmpdirParent,
            NODE_ENV: "test",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "cleanup-start",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          },
          timeout: 30_000,
        },
      );

      await waitForStderr("ready");
      sendSignal("SIGINT");

      const markerWritten = await waitForFile(pauseMarker, 10_000);
      expect(markerWritten).toBe(true);
      const marker = JSON.parse(readFileSync(pauseMarker, "utf-8"));
      expect(marker.window).toBe("cleanup-start");

      sendSignal("SIGTERM");

      const outcome = await result;

      // (a) SIGINT exit code preserved.
      expect(outcome.exitCode).toBe(130);

      // (b) Exactly one cleanup-related warning across the racing triggers.
      const cleanupWarnings = outcome.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // (c) rule-5 mismatched-dir replacement and the renamed-aside copy
      // both survive the cleanup race.
      // Find the loopx tmpdir replacement (the dir loopx would have removed
      // had the identity matched) and the renamed-aside copy.
      const remaining = listLoopxEntries(tmpdirParent);
      // Both `loopx-XXXX` (the replacement) and `loopx-XXXX-aside` (the
      // renamed copy of the original) should still be there.
      expect(remaining.length).toBe(2);
      const replacementName =
        remaining.find((e) => !e.endsWith("-aside")) ?? "";
      const asideName =
        remaining.find((e) => e.endsWith("-aside")) ?? "";
      expect(replacementName).not.toBe("");
      expect(asideName).not.toBe("");
      const replacementPath = join(tmpdirParent, replacementName);
      const asidePath = join(tmpdirParent, asideName);

      expect(existsSync(replacementPath)).toBe(true);
      expect(statSync(replacementPath).isDirectory()).toBe(true);
      const mismatchedMarker = join(replacementPath, "mismatched-marker");
      expect(existsSync(mismatchedMarker)).toBe(true);

      expect(existsSync(asidePath)).toBe(true);
      expect(statSync(asidePath).isDirectory()).toBe(true);

      await rm(replacementPath, { recursive: true, force: true }).catch(
        () => {},
      );
      await rm(asidePath, { recursive: true, force: true }).catch(() => {});
    }, { timeout: 60_000, retry: 2 });

    it("T-TMP-38f: cleanup idempotence under racing SIGTERM → SIGINT (inverted-order parity)", async () => {
      // SPEC §7.2 first-trigger-wins applies symmetrically across SIGINT and
      // SIGTERM — neither signal is privileged. T-TMP-38 covers SIGINT-first ×
      // SIGTERM-second-during-cleanup; this test inverts the order so a buggy
      // implementation that special-cased SIGINT-first cleanup-race handling
      // would pass T-TMP-38 yet fail here. Same fixture and seam configuration
      // as T-TMP-38 (rule-3 regular-file-replacement cleanup-warning branch).
      const { project, tmpdirParent } = await setupTmpdirTest();
      const pauseMarker = join(project.dir, "pause-marker.json");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildRaceFixture({ variant: "regular-file" }),
      );

      const { result, sendSignal, waitForStderr } = runCLIWithSignal(
        ["run", "-n", "1", "ralph"],
        {
          cwd: project.dir,
          runtime,
          env: {
            TMPDIR: tmpdirParent,
            NODE_ENV: "test",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "cleanup-start",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          },
          timeout: 30_000,
        },
      );

      // Wait for the script to finish tampering and start blocking.
      await waitForStderr("ready");

      // First-observed signal: SIGTERM. Triggers abort → cleanup → seam pause.
      sendSignal("SIGTERM");

      // Poll for the parent-observable marker → cleanup is paused at entry.
      const markerWritten = await waitForFile(pauseMarker, 10_000);
      expect(markerWritten).toBe(true);

      // Marker payload echoes the resolved window value (TEST-SPEC §1.4).
      const marker = JSON.parse(readFileSync(pauseMarker, "utf-8"));
      expect(marker.window).toBe("cleanup-start");

      // Second-observed signal: SIGINT. Delivered while loopx is paused at
      // cleanup-start. SPEC §7.2 first-trigger-wins (symmetric across signals):
      // must NOT displace the SIGTERM exit code (143) with the SIGINT code
      // (130); SPEC §7.4 idempotence: must NOT start a second cleanup attempt
      // or re-emit a cleanup warning.
      sendSignal("SIGINT");

      const outcome = await result;

      // (a) SIGTERM exit code preserved across the SIGINT-during-cleanup race
      // — first-observed-wins applies symmetrically; the post-pause SIGINT
      // does NOT shift the exit code from 143 down to 130.
      expect(outcome.exitCode).toBe(143);

      // (b) Exactly one cleanup-related warning — single cleanup attempt.
      const cleanupWarnings = outcome.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // (c) Path persistence — rule-3 leave-with-warning preserved.
      const remaining = listLoopxEntries(tmpdirParent);
      expect(remaining.length).toBe(1);
      const tmpdirPath = join(tmpdirParent, remaining[0]);
      expect(existsSync(tmpdirPath)).toBe(true);
      const st = statSync(tmpdirPath);
      expect(st.isFile()).toBe(true);
      expect(readFileSync(tmpdirPath, "utf-8")).toBe(
        "regular-file-replacement",
      );

      await rm(tmpdirPath, { force: true }).catch(() => {});
    }, { timeout: 60_000, retry: 2 });

    // ------------------------------------------------------------------------
    // T-TMP-38a: SPEC §7.2 first-observed-wins applied to the abort-vs-
    // consumer-cancellation race on the run() programmatic surface, paired with
    // the SPEC §7.4 cleanup-idempotence and at-most-one-warning contracts.
    //
    // T-TMP-38 / T-TMP-39 / T-TMP-38f cover the signal-vs-signal race on the
    // CLI surface; T-TMP-38a is the analogue on the run() surface where the
    // racing triggers are an external `ac.abort()` and a consumer `gen.return()`.
    // The fixture writes a regular-file replacement at $LOOPX_TMPDIR (rule-3
    // cleanup-warning branch), surfaces a "fixture-ready" marker so the
    // driver knows tampering is complete, then blocks indefinitely.
    //
    // Drive: ac.abort() observed first → loopx enters cleanup → cleanup-start
    // seam pauses → driver polls the parent-observable pause marker, then
    // calls gen.return(). The wrapper's first-observed-wins logic must NOT
    // pin returnCalled (because abort was first), so the in-flight
    // wrapper.next() surfaces the abort error to the for-await loop. A buggy
    // wrapper that always pinned returnCalled on .return() would silence the
    // abort error here.
    //
    // Different from T-TMP-22 (consumer .return() observed first → silent
    // completion); the discriminator is internalAc.signal.aborted at .return()-
    // call time.
    // ------------------------------------------------------------------------
    it("T-TMP-38a: SPEC §7.2 first-observed-wins under racing abort → .return() during cleanup-start (run() rule-3)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const fixtureReady = join(project.dir, "fixture-ready.flag");
      const pauseMarker = join(project.dir, "pause-marker.json");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"
touch "$FIXTURE_READY_PATH"
while true; do sleep 1; done
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync } from "node:fs";

const fixtureReady = ${JSON.stringify(fixtureReady)};
const pauseMarker = ${JSON.stringify(pauseMarker)};

const ac = new AbortController();
const gen = run("ralph", { signal: ac.signal });

let errName = "";
let errMessage = "";

const iterPromise = (async () => {
  try {
    for await (const _ of gen) { /* drain */ }
  } catch (e) {
    const ex = e as { name?: string; message?: string };
    errName = ex?.name ?? "";
    errMessage = ex?.message ?? String(e);
  }
})();

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const fxReady = await waitForFile(fixtureReady, 15_000);
if (!fxReady) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "fixture-ready never appeared" }));
  process.exit(1);
}

ac.abort();

const pauseSeen = await waitForFile(pauseMarker, 10_000);
if (!pauseSeen) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "pause-marker never appeared" }));
  process.exit(1);
}

await gen.return();
await iterPromise;

console.log(JSON.stringify({ errName, errMessage }));
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "cleanup-start",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          FIXTURE_READY_PATH: fixtureReady,
        },
        timeout: 60_000,
      });

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout.trim());

      // (a) For-await loop threw an abort error (first-observed abort wins
      // over the consumer-cancellation contract, per SPEC §7.2).
      expect(envelope.errName).toBe("AbortError");

      // (b) Exactly one cleanup-related warning across the racing triggers
      // (SPEC §7.4 idempotence / at-most-one-warning).
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // (c) Path persistence — rule-3 leave-with-warning preserved (the
      // cleanup-start pause + racing .return() did not start a second cleanup
      // attempt that would have replaced the file with something else).
      const remaining = listLoopxEntries(tmpdirParent);
      expect(remaining.length).toBe(1);
      const tmpdirPath = join(tmpdirParent, remaining[0]);
      expect(existsSync(tmpdirPath)).toBe(true);
      const st = statSync(tmpdirPath);
      expect(st.isFile()).toBe(true);
      expect(readFileSync(tmpdirPath, "utf-8")).toBe(
        "regular-file-replacement",
      );

      await rm(tmpdirPath, { force: true }).catch(() => {});
    }, { timeout: 60_000, retry: 2 });

    // ------------------------------------------------------------------------
    // T-TMP-38a2: SPEC §7.2 first-observed-wins applied to the inverted
    // observation order of T-TMP-38a — mid-loop `.return()` observed FIRST
    // (post first-next()), racing abort during the cleanup-start pause.
    //
    // T-TMP-38a covers abort-first × .return()-second on the run() surface
    // (where SPEC §7.2's first-observed-wins rule pins the surfaced outcome
    // to the abort error). T-TMP-38a2 covers the inverted order — .return()
    // is observed first, the post-pause abort does NOT displace the clean
    // .return() settlement, AND does NOT start a second cleanup attempt
    // (per SPEC §7.4 idempotence + at-most-one-warning).
    //
    // T-TERM-02 variant b covers the surfaced-outcome axis on a non-warning-
    // emitting fixture (cleanup runs warning-free), but its assertion that
    // "the generator settles cleanly" cannot distinguish single-cleanup from
    // double-cleanup paths — both single and double cleanup of an empty
    // rule-4 directory are warning-free and outcome-equivalent. This test
    // pins the warning-cardinality axis on the same race by adding the
    // rule-3 regular-file replacement that drives a warning-emitting branch.
    //
    // A buggy implementation that wired `.return()` to start cleanup and
    // then re-entered cleanup on a racing abort observation (e.g., one
    // dispatcher pinned to consumer-cancellation and a separate one pinned
    // to abort-listener, missing the shared CleanupState gate) would emit
    // a second warning and fail (b).
    // ------------------------------------------------------------------------
    it("T-TMP-38a2: SPEC §7.2 first-observed-wins under racing .return() → abort during cleanup-start (run() rule-3, inverted order)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const fixtureReady = join(project.dir, "fixture-ready.flag");
      const pauseMarker = join(project.dir, "pause-marker.json");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"
touch "$FIXTURE_READY_PATH"
while true; do sleep 1; done
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync } from "node:fs";

const fixtureReady = ${JSON.stringify(fixtureReady)};
const pauseMarker = ${JSON.stringify(pauseMarker)};

const ac = new AbortController();
const gen = run("ralph", { signal: ac.signal });

let errName = "";
let errMessage = "";

const iterPromise = (async () => {
  try {
    for await (const _ of gen) { /* drain */ }
  } catch (e) {
    const ex = e as { name?: string; message?: string };
    errName = ex?.name ?? "";
    errMessage = ex?.message ?? String(e);
  }
})();

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const fxReady = await waitForFile(fixtureReady, 15_000);
if (!fxReady) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "fixture-ready never appeared", returnDone: false, returnValue: null }));
  process.exit(1);
}

// INVERTED order from T-TMP-38a: .return() observed FIRST (mid-loop, post
// first-next()) — this kicks off the cleanup routine via the wrapper's
// consumer-cancellation contract; the racing ac.abort() arrives DURING the
// cleanup-start pause window.
const returnPromise = gen.return(undefined);

const pauseSeen = await waitForFile(pauseMarker, 10_000);
if (!pauseSeen) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "pause-marker never appeared", returnDone: false, returnValue: null }));
  process.exit(1);
}

// Racing abort: arrives during the cleanup-start pause. Per SPEC §7.2
// first-observed-wins, the .return() observed earlier wins as the surfaced
// outcome — the abort here must NOT displace the clean settlement and must
// NOT initiate a second cleanup attempt.
ac.abort();

const settled = await returnPromise;
await iterPromise;

console.log(JSON.stringify({
  errName,
  errMessage,
  returnDone: settled.done === true,
  returnValue: settled.value === undefined ? null : settled.value,
}));
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "cleanup-start",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          FIXTURE_READY_PATH: fixtureReady,
        },
        timeout: 60_000,
      });

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout.trim());

      // (a) Generator settles cleanly with the .return() value — the
      // .return() was observed first and per SPEC §7.2 first-observed-wins
      // residual rule the post-pause abort does NOT displace the clean
      // settlement. Settlement is NOT the abort error.
      expect(envelope.returnDone).toBe(true);
      expect(envelope.returnValue).toBe(null);
      // The for-await loop also exits cleanly — no error thrown to the
      // iter-loop. A buggy wrapper that pinned returnCalled=false on .return()
      // when abort was already aborted (or didn't pin returnCalled at all)
      // would let the in-flight wrapper.next() surface the abort error here.
      expect(envelope.errName).toBe("");

      // (b) Exactly one cleanup-related warning across the racing triggers
      // (SPEC §7.4 idempotence / at-most-one-warning). A buggy implementation
      // that started a second cleanup attempt on the racing abort would emit
      // a second warning here.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // (c) Path persistence — rule-3 leave-with-warning preserved. The
      // single cleanup attempt completed and left the regular-file
      // replacement in place; no second attempt mutated it.
      const remaining = listLoopxEntries(tmpdirParent);
      expect(remaining.length).toBe(1);
      const tmpdirPath = join(tmpdirParent, remaining[0]);
      expect(existsSync(tmpdirPath)).toBe(true);
      const st = statSync(tmpdirPath);
      expect(st.isFile()).toBe(true);
      expect(readFileSync(tmpdirPath, "utf-8")).toBe(
        "regular-file-replacement",
      );

      await rm(tmpdirPath, { force: true }).catch(() => {});
    }, { timeout: 60_000, retry: 2 });

    // ------------------------------------------------------------------------
    // T-TMP-38b / T-TMP-38b-run: SPEC §7.2 first-observed-wins applied to the
    // non-zero-script-exit-vs-abort race during the cleanup-start pause window
    // on the programmatic surfaces.
    //
    // Race configuration: the script exits non-zero (rule-3 regular-file
    // replacement, then exit 1); loopx observes script-failure FIRST and
    // throws Error('Script <wf>:<scr> exited with code 1') from runLoop; the
    // throw propagates into the try/finally, which awaits cleanupTmpdir. The
    // cleanup-start seam pauses cleanup for ≥2s; during the pause the harness
    // calls ac.abort(). Per SPEC §7.2 first-observed-wins, the script-failure
    // error must be the surfaced rejection / throw; the post-pause abort must
    // NOT displace it. Per SPEC §7.4 idempotence + at-most-one-warning, the
    // racing abort must NOT initiate a second cleanup attempt and must NOT
    // emit a second warning.
    //
    // T-TMP-38b covers the runPromise() surface.
    // T-TMP-38b-run covers the run() generator surface (a buggy implementation
    // that wired idempotence correctly on runPromise rejection but routed
    // run() settlement through a different cleanup-dispatcher could pass
    // T-TMP-38b and fail T-TMP-38b-run).
    // ------------------------------------------------------------------------
    function buildScriptFailureRule3Fixture(): string {
      return `#!/bin/bash
set -e
rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"
touch "$FIXTURE_READY_PATH"
exit 1
`;
    }

    it("T-TMP-38b: SPEC §7.2 first-observed-wins under racing non-zero-exit → abort during cleanup-start (runPromise() rule-3)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const fixtureReady = join(project.dir, "fixture-ready.flag");
      const pauseMarker = join(project.dir, "pause-marker.json");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildScriptFailureRule3Fixture(),
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync } from "node:fs";

const fixtureReady = ${JSON.stringify(fixtureReady)};
const pauseMarker = ${JSON.stringify(pauseMarker)};

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const ac = new AbortController();

let errName = "";
let errMessage = "";

const promise = runPromise("ralph", { signal: ac.signal, maxIterations: 1 });

const fxReady = await waitForFile(fixtureReady, 15_000);
if (!fxReady) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "fixture-ready never appeared" }));
  process.exit(1);
}

const pauseSeen = await waitForFile(pauseMarker, 10_000);
if (!pauseSeen) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "pause-marker never appeared" }));
  process.exit(1);
}

ac.abort();

try {
  await promise;
} catch (e) {
  const ex = e as { name?: string; message?: string };
  errName = ex?.name ?? "";
  errMessage = ex?.message ?? String(e);
}

console.log(JSON.stringify({ errName, errMessage }));
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "cleanup-start",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          FIXTURE_READY_PATH: fixtureReady,
        },
        timeout: 60_000,
      });

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout.trim());

      // (a) Promise rejects with the script-failure error (first-observed
      // wins; post-cleanup-start abort does NOT displace it). Error message
      // matches /exited with code/ and does NOT contain abort-class hints.
      expect(envelope.errMessage).toMatch(/exited with code/);
      expect(envelope.errName).not.toBe("AbortError");
      expect(envelope.errMessage).not.toMatch(/abort/i);

      // (b) Exactly one cleanup-related warning across the racing triggers
      // (SPEC §7.4 idempotence / at-most-one-warning). A buggy implementation
      // that started a second cleanup attempt on the racing abort would emit
      // a second warning here.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // (c) Path persistence — rule-3 leave-with-warning preserved. The
      // single cleanup attempt completed and left the regular-file
      // replacement in place; no second attempt mutated it.
      const remaining = listLoopxEntries(tmpdirParent);
      expect(remaining.length).toBe(1);
      const tmpdirPath = join(tmpdirParent, remaining[0]);
      expect(existsSync(tmpdirPath)).toBe(true);
      const st = statSync(tmpdirPath);
      expect(st.isFile()).toBe(true);
      expect(readFileSync(tmpdirPath, "utf-8")).toBe(
        "regular-file-replacement",
      );

      await rm(tmpdirPath, { force: true }).catch(() => {});
    }, { timeout: 60_000, retry: 2 });

    it("T-TMP-38b-run: SPEC §7.2 first-observed-wins under racing non-zero-exit → abort during cleanup-start (run() rule-3)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const fixtureReady = join(project.dir, "fixture-ready.flag");
      const pauseMarker = join(project.dir, "pause-marker.json");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildScriptFailureRule3Fixture(),
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync } from "node:fs";

const fixtureReady = ${JSON.stringify(fixtureReady)};
const pauseMarker = ${JSON.stringify(pauseMarker)};

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const ac = new AbortController();
const gen = run("ralph", { signal: ac.signal, maxIterations: 1 });

let errName = "";
let errMessage = "";

const iterPromise = (async () => {
  try {
    for await (const _ of gen) { /* drain */ }
  } catch (e) {
    const ex = e as { name?: string; message?: string };
    errName = ex?.name ?? "";
    errMessage = ex?.message ?? String(e);
  }
})();

const fxReady = await waitForFile(fixtureReady, 15_000);
if (!fxReady) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "fixture-ready never appeared" }));
  process.exit(1);
}

const pauseSeen = await waitForFile(pauseMarker, 10_000);
if (!pauseSeen) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "pause-marker never appeared" }));
  process.exit(1);
}

ac.abort();

await iterPromise;

console.log(JSON.stringify({ errName, errMessage }));
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "cleanup-start",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          FIXTURE_READY_PATH: fixtureReady,
        },
        timeout: 60_000,
      });

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout.trim());

      // (a) For-await loop threw the script-failure error (first-observed
      // wins; post-cleanup-start abort does NOT displace it).
      expect(envelope.errMessage).toMatch(/exited with code/);
      expect(envelope.errName).not.toBe("AbortError");
      expect(envelope.errMessage).not.toMatch(/abort/i);

      // (b) Exactly one cleanup-related warning across the racing triggers.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // (c) Path persistence — rule-3 leave-with-warning preserved.
      const remaining = listLoopxEntries(tmpdirParent);
      expect(remaining.length).toBe(1);
      const tmpdirPath = join(tmpdirParent, remaining[0]);
      expect(existsSync(tmpdirPath)).toBe(true);
      const st = statSync(tmpdirPath);
      expect(st.isFile()).toBe(true);
      expect(readFileSync(tmpdirPath, "utf-8")).toBe(
        "regular-file-replacement",
      );

      await rm(tmpdirPath, { force: true }).catch(() => {});
    }, { timeout: 60_000, retry: 2 });

    // ------------------------------------------------------------------------
    // T-TMP-38b2 / T-TMP-38b2-run: SPEC §7.2 first-observed-wins inverted-order
    // parity for T-TMP-38b / T-TMP-38b-run (which covered iteration-error first
    // × abort second). Here abort is observed FIRST and a racing non-zero
    // script exit arrives during the bounded TEST-SPEC §1.4 `abort-listener`
    // pause — i.e., the user-signal listener has already pinned abort as
    // first-observed AND the seam has paused the internalAc.abort() dispatch,
    // keeping the active child alive (qualified form (a): mid-loop). The
    // harness sends SIGUSR1 to the still-alive script's process group; the
    // fixture's `trap 'exit 1' USR1` causes the child to exit non-zero, which
    // runLoop observes as a script-failure. Per SPEC §7.2 first-observed-wins,
    // the abort error must be the surfaced terminal outcome — the racing
    // iteration-error must NOT displace it. Per SPEC §7.4 idempotence + at-
    // most-one-warning, the racing iteration-error must NOT initiate a second
    // cleanup attempt and must NOT emit a second warning.
    //
    // T-TMP-38b2 covers the runPromise() programmatic surface. T-TMP-38b2-run
    // covers the run() generator surface (a buggy implementation that wired
    // the abort-listener seam correctly on runPromise rejection but routed
    // run() settlement through a different first-observed dispatcher would
    // pass T-TMP-38b2 and fail T-TMP-38b2-run).
    //
    // The seam used here (`abort-listener`) differs from T-TMP-38b's seam
    // (`cleanup-start`) because by `cleanup-start` time the child has already
    // exited (per SPEC §9.1's terminate-child → wait-for-exit → cleanup →
    // surface ordering), so a `cleanup-start` pause cannot stage the
    // racing-non-zero-exit-against-abort-during-active-child scenario. The
    // `abort-listener` seam fires AFTER abort is recorded as first-observed
    // but BEFORE loopx terminates the active child, so the harness can race
    // a child-driven non-zero exit into the still-alive process group.
    // ------------------------------------------------------------------------
    function buildAbortListenerRule3SignalTrapFixture(): string {
      return `#!/bin/bash
set -e
rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"
printf '%s' "$$" > "$PID_MARKER_PATH"
trap 'exit 1' USR1
touch "$FIXTURE_READY_PATH"
sleep 30 &
wait
`;
    }

    it("T-TMP-38b2: SPEC §7.2 first-observed-wins under racing abort → non-zero-exit during abort-listener (runPromise() rule-3)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const fixtureReady = join(project.dir, "fixture-ready.flag");
      const pauseMarker = join(project.dir, "pause-marker.json");
      const pidMarker = join(project.dir, "pid.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildAbortListenerRule3SignalTrapFixture(),
      );

      const driverCode = `
import { runPromise } from "loopx";
import { existsSync, readFileSync } from "node:fs";

const fixtureReady = ${JSON.stringify(fixtureReady)};
const pauseMarker = ${JSON.stringify(pauseMarker)};
const pidMarker = ${JSON.stringify(pidMarker)};

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const ac = new AbortController();

let errName = "";
let errMessage = "";

const promise = runPromise("ralph", { signal: ac.signal, maxIterations: 1 });

const fxReady = await waitForFile(fixtureReady, 15_000);
if (!fxReady) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "fixture-ready never appeared" }));
  process.exit(1);
}

// Abort observed FIRST. The user-signal listener pins firstObservedRef
// to "abort" and (because LOOPX_TEST_TERMINAL_TRIGGER_PAUSE=abort-listener)
// schedules the bounded §1.4 pause before dispatching internalAc.abort().
// During the pause the child is still alive — execution.ts's onAbort has
// not fired — so SIGUSR1 sent to its process group will reach the script.
ac.abort();

const pauseSeen = await waitForFile(pauseMarker, 10_000);
if (!pauseSeen) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "pause-marker never appeared" }));
  process.exit(1);
}

const pidStr = readFileSync(pidMarker, "utf-8").trim();
const pid = parseInt(pidStr, 10);
if (Number.isNaN(pid) || pid <= 0) {
  console.log(JSON.stringify({ errName: "RangeError", errMessage: "invalid pid in marker: " + pidStr }));
  process.exit(1);
}

// Racing non-zero exit. SIGUSR1 → bash trap → exit 1 → runLoop observes
// the iteration-level error during the still-paused abort dispatch. Per
// SPEC §7.2, the abort error must remain the surfaced terminal outcome
// (firstObservedRef.trigger === "abort" already pinned).
try {
  process.kill(-pid, "SIGUSR1");
} catch {
  // ESRCH is acceptable — script may have already exited.
}

try {
  await promise;
} catch (e) {
  const ex = e as { name?: string; message?: string };
  errName = ex?.name ?? "";
  errMessage = ex?.message ?? String(e);
}

console.log(JSON.stringify({ errName, errMessage }));
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "abort-listener",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          FIXTURE_READY_PATH: fixtureReady,
          PID_MARKER_PATH: pidMarker,
        },
        timeout: 60_000,
      });

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout.trim());

      // (a) Promise rejects with the abort error (first-observed wins; the
      // racing non-zero exit during the abort-listener pause does NOT
      // displace it). Load-bearing: a buggy wrapper.next() catch that
      // surfaced the iteration error directly (without consulting
      // firstObservedRef) would show /exited with code/ here.
      expect(envelope.errName).toBe("AbortError");
      expect(envelope.errMessage).not.toMatch(/exited with code/);

      // (b) Exactly one cleanup-related warning across the racing triggers
      // (SPEC §7.4 idempotence / at-most-one-warning). A buggy implementation
      // that started a second cleanup attempt on the racing iteration error
      // would emit a second warning here.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // (c) Path persistence — rule-3 leave-with-warning preserved. The
      // single cleanup attempt completed and left the regular-file
      // replacement in place; no second attempt mutated it.
      const remaining = listLoopxEntries(tmpdirParent);
      expect(remaining.length).toBe(1);
      const tmpdirPath = join(tmpdirParent, remaining[0]);
      expect(existsSync(tmpdirPath)).toBe(true);
      const st = statSync(tmpdirPath);
      expect(st.isFile()).toBe(true);
      expect(readFileSync(tmpdirPath, "utf-8")).toBe(
        "regular-file-replacement",
      );

      await rm(tmpdirPath, { force: true }).catch(() => {});
    }, { timeout: 60_000, retry: 2 });

    it("T-TMP-38b2-run: SPEC §7.2 first-observed-wins under racing abort → non-zero-exit during abort-listener (run() rule-3)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const fixtureReady = join(project.dir, "fixture-ready.flag");
      const pauseMarker = join(project.dir, "pause-marker.json");
      const pidMarker = join(project.dir, "pid.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        buildAbortListenerRule3SignalTrapFixture(),
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync, readFileSync } from "node:fs";

const fixtureReady = ${JSON.stringify(fixtureReady)};
const pauseMarker = ${JSON.stringify(pauseMarker)};
const pidMarker = ${JSON.stringify(pidMarker)};

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const ac = new AbortController();
const gen = run("ralph", { signal: ac.signal, maxIterations: 1 });

let errName = "";
let errMessage = "";

const iterPromise = (async () => {
  try {
    for await (const _ of gen) { /* drain */ }
  } catch (e) {
    const ex = e as { name?: string; message?: string };
    errName = ex?.name ?? "";
    errMessage = ex?.message ?? String(e);
  }
})();

const fxReady = await waitForFile(fixtureReady, 15_000);
if (!fxReady) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "fixture-ready never appeared" }));
  process.exit(1);
}

ac.abort();

const pauseSeen = await waitForFile(pauseMarker, 10_000);
if (!pauseSeen) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "pause-marker never appeared" }));
  process.exit(1);
}

const pidStr = readFileSync(pidMarker, "utf-8").trim();
const pid = parseInt(pidStr, 10);
if (Number.isNaN(pid) || pid <= 0) {
  console.log(JSON.stringify({ errName: "RangeError", errMessage: "invalid pid in marker: " + pidStr }));
  process.exit(1);
}

try {
  process.kill(-pid, "SIGUSR1");
} catch {
  // ESRCH is acceptable.
}

await iterPromise;

console.log(JSON.stringify({ errName, errMessage }));
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "abort-listener",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          FIXTURE_READY_PATH: fixtureReady,
          PID_MARKER_PATH: pidMarker,
        },
        timeout: 60_000,
      });

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout.trim());

      // (a) For-await loop threw the abort error (first-observed wins; the
      // racing non-zero exit during the abort-listener pause does NOT
      // displace it).
      expect(envelope.errName).toBe("AbortError");
      expect(envelope.errMessage).not.toMatch(/exited with code/);

      // (b) Exactly one cleanup-related warning across the racing triggers.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // (c) Path persistence — rule-3 leave-with-warning preserved.
      const remaining = listLoopxEntries(tmpdirParent);
      expect(remaining.length).toBe(1);
      const tmpdirPath = join(tmpdirParent, remaining[0]);
      expect(existsSync(tmpdirPath)).toBe(true);
      const st = statSync(tmpdirPath);
      expect(st.isFile()).toBe(true);
      expect(readFileSync(tmpdirPath, "utf-8")).toBe(
        "regular-file-replacement",
      );

      await rm(tmpdirPath, { force: true }).catch(() => {});
    }, { timeout: 60_000, retry: 2 });

    // ------------------------------------------------------------------------
    // T-TMP-38c: SPEC §7.2 first-observed-wins applied to the abort-vs-
    // consumer-cancellation race on the run() programmatic surface for the
    // .throw() axis. Companion to T-TMP-38a (the .return() axis): both pin
    // SPEC §7.2's "abort concurrent with consumer .return() / .throw()"
    // enumeration on the cleanup-idempotence axis (SPEC §7.4: at-most-one
    // cleanup attempt and at-most-one cleanup warning per run, regardless of
    // observation order across racing terminal triggers).
    //
    // Race configuration: ac.abort() observed first → loopx enters cleanup →
    // cleanup-start seam pauses → driver polls the parent-observable pause
    // marker, then calls gen.throw(new Error("test-throw")). The wrapper's
    // first-observed-wins logic (run.ts wrapper.throw) MUST NOT pin
    // returnCalled when abort was observed first, leaving the in-flight
    // wrapper.next() free to surface the abort error to the for-await loop.
    // The consumer-supplied error is silently absorbed per SPEC §9.1 silent-
    // clean-completion contract on .throw() with no active child (cleanup
    // routine has already terminated the script). A buggy wrapper that
    // re-entered cleanup on the racing .throw() would emit a second warning;
    // a buggy wrapper that surfaced the consumer-thrown error or wrapped it
    // around the abort would shift the surfaced terminal away from AbortError.
    // ------------------------------------------------------------------------
    it("T-TMP-38c: SPEC §7.2 first-observed-wins under racing abort → .throw() during cleanup-start (run() rule-3)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const fixtureReady = join(project.dir, "fixture-ready.flag");
      const pauseMarker = join(project.dir, "pause-marker.json");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"
touch "$FIXTURE_READY_PATH"
while true; do sleep 1; done
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync } from "node:fs";

const fixtureReady = ${JSON.stringify(fixtureReady)};
const pauseMarker = ${JSON.stringify(pauseMarker)};

const ac = new AbortController();
const gen = run("ralph", { signal: ac.signal });

let errName = "";
let errMessage = "";

const iterPromise = (async () => {
  try {
    for await (const _ of gen) { /* drain */ }
  } catch (e) {
    const ex = e as { name?: string; message?: string };
    errName = ex?.name ?? "";
    errMessage = ex?.message ?? String(e);
  }
})();

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const fxReady = await waitForFile(fixtureReady, 15_000);
if (!fxReady) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "fixture-ready never appeared" }));
  process.exit(1);
}

ac.abort();

const pauseSeen = await waitForFile(pauseMarker, 10_000);
if (!pauseSeen) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "pause-marker never appeared" }));
  process.exit(1);
}

await gen.throw(new Error("test-throw"));
await iterPromise;

console.log(JSON.stringify({ errName, errMessage }));
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "cleanup-start",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          FIXTURE_READY_PATH: fixtureReady,
        },
        timeout: 60_000,
      });

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout.trim());

      // (a) For-await loop threw an abort error (first-observed abort wins
      // over the racing consumer .throw(); the consumer-supplied "test-throw"
      // error is silently absorbed by the wrapper's consumer-cancellation
      // contract per SPEC §9.1 — what reaches for-await is exclusively the
      // first-observed abort). A buggy wrapper that surfaced the consumer
      // error or wrapped it around the abort would fail this assertion.
      expect(envelope.errName).toBe("AbortError");
      expect(envelope.errMessage).not.toMatch(/test-throw/);

      // (b) Exactly one cleanup-related warning across the racing triggers
      // (SPEC §7.4 idempotence / at-most-one-warning). A buggy implementation
      // that started a second cleanup attempt on the racing .throw() would
      // emit a second warning here.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // (c) Path persistence — rule-3 leave-with-warning preserved (the
      // cleanup-start pause + racing .throw() did not start a second cleanup
      // attempt that would have replaced or removed the file).
      const remaining = listLoopxEntries(tmpdirParent);
      expect(remaining.length).toBe(1);
      const tmpdirPath = join(tmpdirParent, remaining[0]);
      expect(existsSync(tmpdirPath)).toBe(true);
      const st = statSync(tmpdirPath);
      expect(st.isFile()).toBe(true);
      expect(readFileSync(tmpdirPath, "utf-8")).toBe(
        "regular-file-replacement",
      );

      await rm(tmpdirPath, { force: true }).catch(() => {});
    }, { timeout: 60_000, retry: 2 });

    // ------------------------------------------------------------------------
    // T-TMP-38c2: SPEC §7.2 first-observed-wins applied to the inverted
    // observation order of T-TMP-38c — mid-loop `.throw()` observed FIRST
    // (post first-next()), racing abort during the consumer-throw-observed
    // pause window on the run() programmatic surface, rule-3 cleanup branch.
    //
    // T-TMP-38c covers abort-first × .throw()-second on the run() surface
    // (where SPEC §7.2's first-observed-wins rule pins the surfaced outcome
    // to the abort error). T-TMP-38c2 covers the inverted order: .throw()
    // is observed first → loopx records it as the first-observed terminal
    // trigger AND pauses at the new TEST-SPEC §1.4 `consumer-throw-observed`
    // seam BEFORE dispatching the resulting silent settlement → driver polls
    // the parent-observable pause marker, then calls `ac.abort()` during the
    // bounded pause. Per SPEC §7.2 first-observed-wins, the .throw() observed
    // earlier wins as the surfaced outcome — the racing abort must NOT
    // displace the silent-clean-completion settlement (SPEC §9.1) and must
    // NOT initiate a second cleanup attempt (SPEC §7.4 idempotence + at-most
    // -one-warning).
    //
    // T-TERM-02d covers the surfaced-outcome axis on a non-warning-emitting
    // fixture (cleanup runs warning-free), but its assertion that "the
    // generator settles cleanly" cannot distinguish single-cleanup from
    // double-cleanup paths — both single and double cleanup of an empty
    // rule-4 directory are warning-free and outcome-equivalent. This test
    // pins the warning-cardinality axis on the same race configuration by
    // adding the rule-3 regular-file replacement that drives a warning-
    // emitting branch.
    //
    // A buggy implementation that wired `.throw()` to start cleanup and then
    // re-entered cleanup on a racing abort observation (e.g., one dispatcher
    // pinned to consumer-cancellation and a separate one pinned to abort-
    // listener, missing the shared CleanupState gate) would emit a second
    // warning and fail (b). A buggy implementation that surfaced the
    // consumer-thrown "test-throw" error or the abort error to the for-await
    // loop instead of silent-clean-completion (per SPEC §9.1's consumer-
    // cancellation contract) would shift envelope.errName / errMessage and
    // fail (a).
    // ------------------------------------------------------------------------
    it("T-TMP-38c2: SPEC §7.2 first-observed-wins under racing .throw() → abort during consumer-throw-observed (run() rule-3, inverted order)", async () => {
      const { project, tmpdirParent } = await setupTmpdirTest();
      const fixtureReady = join(project.dir, "fixture-ready.flag");
      const pauseMarker = join(project.dir, "pause-marker.json");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        `#!/bin/bash
set -e
rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"
touch "$FIXTURE_READY_PATH"
while true; do sleep 1; done
`,
      );

      const driverCode = `
import { run } from "loopx";
import { existsSync } from "node:fs";

const fixtureReady = ${JSON.stringify(fixtureReady)};
const pauseMarker = ${JSON.stringify(pauseMarker)};

const ac = new AbortController();
const gen = run("ralph", { signal: ac.signal });

let errName = "";
let errMessage = "";

const iterPromise = (async () => {
  try {
    for await (const _ of gen) { /* drain */ }
  } catch (e) {
    const ex = e as { name?: string; message?: string };
    errName = ex?.name ?? "";
    errMessage = ex?.message ?? String(e);
  }
})();

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const fxReady = await waitForFile(fixtureReady, 15_000);
if (!fxReady) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "fixture-ready never appeared", throwDone: false, throwValue: null }));
  process.exit(1);
}

// INVERTED order from T-TMP-38c: .throw() observed FIRST (mid-loop, post
// first-next()) — this kicks off the wrapper.throw consumer-cancellation
// path which pauses at the new consumer-throw-observed seam BEFORE
// dispatching the silent settlement (terminate active child / cleanup /
// surface). The racing ac.abort() arrives DURING that pause window.
const throwPromise = gen.throw(new Error("test-throw"));

const pauseSeen = await waitForFile(pauseMarker, 10_000);
if (!pauseSeen) {
  console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "pause-marker never appeared", throwDone: false, throwValue: null }));
  process.exit(1);
}

// Racing abort: arrives during the consumer-throw-observed pause. Per SPEC
// §7.2 first-observed-wins, the .throw() observed earlier wins as the
// surfaced outcome — the abort here must NOT displace the silent-clean-
// completion settlement (SPEC §9.1) and must NOT initiate a second cleanup
// attempt (SPEC §7.4 idempotence + at-most-one-warning).
ac.abort();

const settled = await throwPromise;
await iterPromise;

console.log(JSON.stringify({
  errName,
  errMessage,
  throwDone: settled.done === true,
  throwValue: settled.value === undefined ? null : settled.value,
}));
`;

      const result = await runAPIDriver(runtime, driverCode, {
        cwd: project.dir,
        env: {
          TMPDIR: tmpdirParent,
          NODE_ENV: "test",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "consumer-throw-observed",
          LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          FIXTURE_READY_PATH: fixtureReady,
        },
        timeout: 60_000,
      });

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout.trim());

      // (a) The generator settlement is NOT the abort error (the .throw()
      // was observed first; per SPEC §7.2 first-observed-wins residual rule
      // the post-pause abort does NOT displace the silent settlement). The
      // for-await loop also exits cleanly — no error reaches the iter loop.
      // The consumer-supplied "test-throw" error is silently absorbed per
      // SPEC §9.1's consumer-cancellation contract (silent clean completion
      // for .throw() with no further iterations). A buggy wrapper that
      // surfaced the abort or the consumer-supplied error would shift these
      // assertions.
      expect(envelope.throwDone).toBe(true);
      expect(envelope.throwValue).toBe(null);
      expect(envelope.errName).toBe("");
      expect(envelope.errMessage).not.toMatch(/abort/i);
      expect(envelope.errMessage).not.toMatch(/test-throw/);

      // (b) Exactly one cleanup-related warning across the racing triggers
      // (SPEC §7.4 idempotence / at-most-one-warning). A buggy implementation
      // that started a second cleanup attempt on the racing abort would
      // emit a second warning here.
      const cleanupWarnings = result.stderr
        .split("\n")
        .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
      expect(cleanupWarnings.length).toBe(1);

      // (c) Path persistence — rule-3 leave-with-warning preserved. The
      // single cleanup attempt completed and left the regular-file
      // replacement in place; no second attempt mutated it.
      const remaining = listLoopxEntries(tmpdirParent);
      expect(remaining.length).toBe(1);
      const tmpdirPath = join(tmpdirParent, remaining[0]);
      expect(existsSync(tmpdirPath)).toBe(true);
      const st = statSync(tmpdirPath);
      expect(st.isFile()).toBe(true);
      expect(readFileSync(tmpdirPath, "utf-8")).toBe(
        "regular-file-replacement",
      );

      await rm(tmpdirPath, { force: true }).catch(() => {});
    }, { timeout: 60_000, retry: 2 });

    // ------------------------------------------------------------------------
    // T-TMP-38d3: SPEC §7.2 / §7.4 / §9.1 / §9.3 — post-final-yield consumer
    // `.return()` observed FIRST (post first-next()), racing abort during the
    // `consumer-return-observed` pause window on the run() programmatic
    // surface, rule-3 cleanup branch.
    //
    // `.return()`-axis symmetric counterpart to T-TMP-38d2 (which covers the
    // `.throw()` axis on the same observation order). Together with T-TMP-38d
    // (abort-first × `.throw()`-second) and T-TMP-38d4 (abort-first ×
    // `.return()`-second), this closes the post-final-yield consumer-
    // cancellation × abort race symmetrically across both observation orders
    // × both consumer-cancellation axes (`.return()` and `.throw()`).
    //
    // Per SPEC §9.3's second paragraph (the first-observed-wins residual
    // carve-out from the abort-after-final-yield rule), when `.return()` is
    // observed first post-final-yield and the script has already exited (no
    // active child), §9.1's silent-clean-completion rule for consumer
    // cancellation when no child is active produces clean
    // `{ done: true, value: undefined }` settlement. The racing post-pause
    // abort does NOT displace this outcome.
    //
    // **Seam choice rationale.** SPEC §7.4 guarantees cleanup on `run()`
    // normal completion only once the generator is driven to settlement; it
    // does NOT forbid an implementation from opportunistically running
    // cleanup after the final yield but before settlement. A `cleanup-start`
    // pause therefore cannot reliably coordinate this race: an opportunistic
    // implementation may have already entered the cleanup routine (firing the
    // seam) before the harness's `gen.return()` is observed. This test uses
    // the `consumer-return-observed` seam, which fires the moment loopx's
    // consumer-cancellation tracking observes the post-first-`next()`
    // `.return()` and pauses BEFORE loopx begins running cleanup or surfacing
    // the settlement.
    //
    // **Parameterized over the final-yield trigger** (per SPEC 9.3 "via
    // `stop: true` or `maxIterations` reached"): variant **(stop)** the
    // script-driven `stop: true` final-yield path; variant **(maxIterations)**
    // the loopx-driven iteration-count-limit final-yield path.
    //
    // Buggy-implementation scenarios this test catches:
    //   - Surfacing the abort error here (displacing the first-observed
    //     `.return()`): fails (a).
    //   - Starting a second cleanup attempt on the racing abort: emits a
    //     second cleanup warning (fails b) and re-touches the rule-3 entry
    //     (fails c).
    // ------------------------------------------------------------------------
    const FINAL_YIELD_VARIANTS = ["stop", "maxIterations"] as const;

    for (const variant of FINAL_YIELD_VARIANTS) {
      it(`T-TMP-38d3 (${variant}): SPEC §7.2 first-observed-wins under racing post-final-yield .return() → abort during consumer-return-observed (run() rule-3)`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const pauseMarker = join(project.dir, "pause-marker.json");

        // Variant-specific final-yield trigger:
        //   (stop) — script emits {"stop":true} so the first yield is final
        //            even though maxIterations permits more iterations.
        //   (maxIterations) — script emits raw `{}` (parses as
        //            { result: "{}" } per SPEC §2.3 raw-fallback) so the
        //            iteration is non-terminating; maxIterations: 1 makes it
        //            final via the iteration-count limit.
        const yieldEmit =
          variant === "stop"
            ? `printf '%s' '{"stop":true}'`
            : `printf '%s' '{}'`;

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          `#!/bin/bash
set -e
rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"
${yieldEmit}
exit 0
`,
        );

        const maxIters = variant === "stop" ? 5 : 1;

        const driverCode = `
import { run } from "loopx";
import { existsSync } from "node:fs";

const pauseMarker = ${JSON.stringify(pauseMarker)};

const ac = new AbortController();
const gen = run("ralph", { signal: ac.signal, maxIterations: ${maxIters} });

let firstStop = false;
let firstDone = true;
let returnDone = false;
let returnValue = null;
let errName = "";
let errMessage = "";

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

try {
  const first = await gen.next();
  firstDone = first.done === true;
  firstStop = !first.done && first.value && first.value.stop === true;

  // Post-final-yield .return() — first-observed terminal trigger after the
  // final yield. wrapper.return pins returnCalled=true and pauses at the
  // consumer-return-observed seam BEFORE dispatching settlement (cleanup +
  // gen.return drive). Capture the promise so we can poll for the marker
  // and inject the racing abort during the bounded pause.
  const returnPromise = gen.return(undefined);

  const pauseSeen = await waitForFile(pauseMarker, 10_000);
  if (!pauseSeen) {
    console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "pause-marker never appeared", returnDone: false, returnValue: null, firstStop, firstDone }));
    process.exit(1);
  }

  // Racing abort: arrives during the consumer-return-observed pause. Per
  // SPEC §9.3 second paragraph + §9.1 silent-clean-completion-when-no-child
  // rule, the .return() observed earlier wins as the surfaced outcome — the
  // racing abort here must NOT displace the silent-clean-completion
  // settlement and must NOT initiate a second cleanup attempt
  // (SPEC §7.4 idempotence + at-most-one-warning).
  ac.abort();

  const settled = await returnPromise;
  returnDone = settled.done === true;
  returnValue = settled.value === undefined ? null : settled.value;
} catch (e) {
  const ex = e;
  errName = ex && ex.name ? ex.name : "";
  errMessage = ex && ex.message ? ex.message : String(e);
}

console.log(JSON.stringify({ errName, errMessage, returnDone, returnValue, firstStop, firstDone }));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
          env: {
            TMPDIR: tmpdirParent,
            NODE_ENV: "test",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "consumer-return-observed",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          },
          timeout: 60_000,
        });

        expect(result.exitCode).toBe(0);
        const envelope = JSON.parse(result.stdout.trim());

        // Variant-specific first-yield observation — confirms the harness
        // entered the post-final-yield window before calling gen.return().
        if (variant === "stop") {
          expect(envelope.firstStop).toBe(true);
        } else {
          expect(envelope.firstDone).toBe(false);
        }

        // (a) Generator settles cleanly with { done: true, value: undefined }
        // — the first-observed .return() wins; the racing post-pause abort
        // does NOT displace the silent-clean-completion settlement (SPEC
        // §9.3 second paragraph + §9.1 silent completion when no child
        // active). A buggy wrapper that surfaced the abort error would shift
        // returnDone / errName.
        expect(envelope.returnDone).toBe(true);
        expect(envelope.returnValue).toBe(null);
        expect(envelope.errName).toBe("");
        expect(envelope.errMessage).not.toMatch(/abort/i);

        // (b) Exactly one cleanup-related warning across the racing triggers
        // (SPEC §7.4 idempotence / at-most-one-warning). A buggy
        // implementation that started a second cleanup attempt on the racing
        // abort would emit a second warning.
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(1);

        // (c) Path persistence — rule-3 leave-with-warning preserved. The
        // single cleanup attempt completed and left the regular-file
        // replacement in place; no second attempt mutated it. A buggy
        // implementation that re-touched the rule-3 entry on the second
        // attempt would corrupt or remove the file.
        const remaining = listLoopxEntries(tmpdirParent);
        expect(remaining.length).toBe(1);
        const tmpdirPath = join(tmpdirParent, remaining[0]);
        expect(existsSync(tmpdirPath)).toBe(true);
        const st = statSync(tmpdirPath);
        expect(st.isFile()).toBe(true);
        expect(readFileSync(tmpdirPath, "utf-8")).toBe(
          "regular-file-replacement",
        );

        await rm(tmpdirPath, { force: true }).catch(() => {});
      }, { timeout: 60_000, retry: 2 });
    }

    // ------------------------------------------------------------------------
    // T-TMP-38d2: SPEC §7.2 / §7.4 / §9.1 / §9.3 — post-final-yield consumer
    // `.throw()` observed FIRST (post first-next()), racing abort during the
    // `consumer-throw-observed` pause window on the run() programmatic
    // surface, rule-3 cleanup branch.
    //
    // `.throw()`-axis symmetric counterpart to T-TMP-38d3 (which covers the
    // `.return()` axis on the same observation order). Together with T-TMP-38d
    // (abort-first × `.throw()`-second) and T-TMP-38d4 (abort-first ×
    // `.return()`-second), this closes the post-final-yield consumer-
    // cancellation × abort race symmetrically across both observation orders
    // × both consumer-cancellation axes (`.return()` and `.throw()`).
    //
    // Per SPEC §9.3's second paragraph (the first-observed-wins residual
    // carve-out from the abort-after-final-yield rule), when `.throw()` is
    // observed first post-final-yield and the script has already exited (no
    // active child), §9.1's silent-clean-completion rule for consumer
    // cancellation when no child is active produces clean
    // `{ done: true, value: undefined }` settlement; the consumer-supplied
    // error is silently absorbed. The racing post-pause abort does NOT
    // displace this outcome.
    //
    // **Seam choice rationale.** SPEC §7.4 guarantees cleanup on `run()`
    // normal completion only once the generator is driven to settlement; it
    // does NOT forbid an implementation from opportunistically running
    // cleanup after the final yield but before settlement. A `cleanup-start`
    // pause therefore cannot reliably coordinate this race: an opportunistic
    // implementation may have already entered the cleanup routine (firing the
    // seam) before the harness's `gen.throw()` is observed. This test uses
    // the `consumer-throw-observed` seam, which fires the moment loopx's
    // consumer-cancellation tracking observes the post-first-`next()`
    // `.throw()` and pauses BEFORE loopx begins running cleanup or surfacing
    // the settlement.
    //
    // **Parameterized over the final-yield trigger** (per SPEC 9.3 "via
    // `stop: true` or `maxIterations` reached"): variant **(stop)** the
    // script-driven `stop: true` final-yield path; variant **(maxIterations)**
    // the loopx-driven iteration-count-limit final-yield path.
    //
    // Buggy-implementation scenarios this test catches:
    //   - Surfacing the abort error here (displacing the first-observed
    //     `.throw()`): fails (a) on the errMessage /abort/i probe.
    //   - Surfacing the consumer-supplied "test-throw" error: fails (a) on
    //     the errMessage /test-throw/ probe.
    //   - Starting a second cleanup attempt on the racing abort: emits a
    //     second cleanup warning (fails b) and re-touches the rule-3 entry
    //     (fails c).
    // ------------------------------------------------------------------------
    const POST_FINAL_YIELD_THROW_VARIANTS = ["stop", "maxIterations"] as const;

    for (const variant of POST_FINAL_YIELD_THROW_VARIANTS) {
      it(`T-TMP-38d2 (${variant}): SPEC §7.2 first-observed-wins under racing post-final-yield .throw() → abort during consumer-throw-observed (run() rule-3)`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const pauseMarker = join(project.dir, "pause-marker.json");

        // Variant-specific final-yield trigger:
        //   (stop) — script emits {"stop":true} so the first yield is final
        //            even though maxIterations permits more iterations.
        //   (maxIterations) — script emits raw `{}` (parses as
        //            { result: "{}" } per SPEC §2.3 raw-fallback) so the
        //            iteration is non-terminating; maxIterations: 1 makes it
        //            final via the iteration-count limit.
        const yieldEmit =
          variant === "stop"
            ? `printf '%s' '{"stop":true}'`
            : `printf '%s' '{}'`;

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          `#!/bin/bash
set -e
rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"
${yieldEmit}
exit 0
`,
        );

        const maxIters = variant === "stop" ? 5 : 1;

        const driverCode = `
import { run } from "loopx";
import { existsSync } from "node:fs";

const pauseMarker = ${JSON.stringify(pauseMarker)};

const ac = new AbortController();
const gen = run("ralph", { signal: ac.signal, maxIterations: ${maxIters} });

let firstStop = false;
let firstDone = true;
let throwDone = false;
let throwValue = null;
let errName = "";
let errMessage = "";

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

try {
  const first = await gen.next();
  firstDone = first.done === true;
  firstStop = !first.done && first.value && first.value.stop === true;

  // Post-final-yield .throw() — first-observed terminal trigger after the
  // final yield. wrapper.throw pins returnCalled=true and pauses at the
  // consumer-throw-observed seam BEFORE dispatching settlement (cleanup +
  // gen.return drive). Capture the promise so we can poll for the marker
  // and inject the racing abort during the bounded pause.
  const throwPromise = gen.throw(new Error("test-throw"));

  const pauseSeen = await waitForFile(pauseMarker, 10_000);
  if (!pauseSeen) {
    console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "pause-marker never appeared", throwDone: false, throwValue: null, firstStop, firstDone }));
    process.exit(1);
  }

  // Racing abort: arrives during the consumer-throw-observed pause. Per
  // SPEC §9.3 second paragraph + §9.1 silent-clean-completion-when-no-child
  // rule, the .throw() observed earlier wins as the surfaced outcome — the
  // consumer-supplied error is silently absorbed AND the racing abort here
  // must NOT displace the silent-clean-completion settlement; neither must
  // it initiate a second cleanup attempt (SPEC §7.4 idempotence + at-most-
  // one-warning).
  ac.abort();

  const settled = await throwPromise;
  throwDone = settled.done === true;
  throwValue = settled.value === undefined ? null : settled.value;
} catch (e) {
  const ex = e;
  errName = ex && ex.name ? ex.name : "";
  errMessage = ex && ex.message ? ex.message : String(e);
}

console.log(JSON.stringify({ errName, errMessage, throwDone, throwValue, firstStop, firstDone }));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
          env: {
            TMPDIR: tmpdirParent,
            NODE_ENV: "test",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "consumer-throw-observed",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          },
          timeout: 60_000,
        });

        expect(result.exitCode).toBe(0);
        const envelope = JSON.parse(result.stdout.trim());

        // Variant-specific first-yield observation — confirms the harness
        // entered the post-final-yield window before calling gen.throw().
        if (variant === "stop") {
          expect(envelope.firstStop).toBe(true);
        } else {
          expect(envelope.firstDone).toBe(false);
        }

        // (a) Generator settles cleanly with { done: true, value: undefined }
        // — the first-observed .throw() wins; the racing post-pause abort
        // does NOT displace the silent-clean-completion settlement (SPEC
        // §9.3 second paragraph + §9.1 silent completion when no child
        // active). The consumer-supplied "test-throw" error is silently
        // absorbed per SPEC §9.1's consumer-cancellation contract. A buggy
        // wrapper that surfaced the abort error or the consumer-supplied
        // error would shift throwDone / errName / errMessage.
        expect(envelope.throwDone).toBe(true);
        expect(envelope.throwValue).toBe(null);
        expect(envelope.errName).toBe("");
        expect(envelope.errMessage).not.toMatch(/abort/i);
        expect(envelope.errMessage).not.toMatch(/test-throw/);

        // (b) Exactly one cleanup-related warning across the racing triggers
        // (SPEC §7.4 idempotence / at-most-one-warning). A buggy
        // implementation that started a second cleanup attempt on the racing
        // abort would emit a second warning.
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(1);

        // (c) Path persistence — rule-3 leave-with-warning preserved. The
        // single cleanup attempt completed and left the regular-file
        // replacement in place; no second attempt mutated it. A buggy
        // implementation that re-touched the rule-3 entry on the second
        // attempt would corrupt or remove the file.
        const remaining = listLoopxEntries(tmpdirParent);
        expect(remaining.length).toBe(1);
        const tmpdirPath = join(tmpdirParent, remaining[0]);
        expect(existsSync(tmpdirPath)).toBe(true);
        const st = statSync(tmpdirPath);
        expect(st.isFile()).toBe(true);
        expect(readFileSync(tmpdirPath, "utf-8")).toBe(
          "regular-file-replacement",
        );

        await rm(tmpdirPath, { force: true }).catch(() => {});
      }, { timeout: 60_000, retry: 2 });
    }

    // ------------------------------------------------------------------------
    // T-TMP-38d: SPEC §7.2 / §7.4 / §9.3 — post-final-yield abort observed
    // FIRST, racing `.throw()` during the `abort-listener` pause window on the
    // run() programmatic surface, rule-3 cleanup branch.
    //
    // `.throw()`-axis abort-first counterpart on the post-final-yield × abort
    // race. Together with T-TMP-38d2 (.throw()-first × abort-second post-
    // final-yield), T-TMP-38d3 (.return()-first × abort-second), and T-TMP-38d4
    // (abort-first × .return()-second), this closes the post-final-yield
    // consumer-cancellation × abort race symmetrically across both observation
    // orders × both consumer-cancellation axes (`.return()` and `.throw()`).
    //
    // Per SPEC §9.3's abort-after-final-yield rule, when abort is observed
    // first after the final yield (before generator settlement), the abort
    // outcome displaces normal completion — the consumer-thrown error is NOT
    // surfaced to the consumer, and the racing `.throw()` does NOT produce a
    // clean settlement. Equivalent contract to T-API-66b / T-API-66e but
    // driven through the abort-listener pause race rather than direct
    // interaction sequencing.
    //
    // **Seam choice rationale.** SPEC §7.4 guarantees cleanup on `run()`
    // normal completion only once the generator is driven to settlement; it
    // does NOT forbid an implementation from opportunistically running
    // cleanup after the final yield but before settlement. A `cleanup-start`
    // pause therefore cannot reliably coordinate this race: an opportunistic
    // implementation may have already entered the cleanup routine (firing the
    // seam) before the harness's `c.abort()` is observed. This test uses the
    // `abort-listener` seam, which fires the moment the captured AbortSignal's
    // abort listener observes the abort and pauses BEFORE loopx begins
    // running cleanup or surfacing the abort error — so the seam fires
    // deterministically when `c.abort()` is delivered.
    //
    // **Parameterized over the final-yield trigger** (per SPEC 9.3 "via
    // `stop: true` or `maxIterations` reached"): variant **(stop)** the
    // script-driven `stop: true` final-yield path; variant **(maxIterations)**
    // the loopx-driven iteration-count-limit final-yield path. Both variants
    // exercise the same SPEC 9.3 abort-after-final-yield clause but through
    // structurally distinct loopx code paths.
    //
    // Buggy-implementation scenarios this test catches:
    //   - Surfacing the consumer-thrown "test-throw" error (failing to apply
    //     the SPEC §9.3 abort-after-final-yield carve-out): fails (a) on the
    //     errMessage /test-throw/ probe.
    //   - Surfacing a clean settlement (failing to displace the would-be
    //     `.throw()` outcome): fails (a) on the errName === "AbortError"
    //     probe.
    //   - Starting a second cleanup attempt on the racing `.throw()`: emits
    //     a second cleanup warning (fails b) and re-touches the rule-3 entry
    //     (fails c).
    // ------------------------------------------------------------------------
    const POST_FINAL_YIELD_ABORT_FIRST_THROW_VARIANTS = [
      "stop",
      "maxIterations",
    ] as const;

    for (const variant of POST_FINAL_YIELD_ABORT_FIRST_THROW_VARIANTS) {
      it(`T-TMP-38d (${variant}): SPEC §7.2 first-observed-wins under racing post-final-yield abort → .throw() during abort-listener (run() rule-3)`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const pauseMarker = join(project.dir, "pause-marker.json");

        // Variant-specific final-yield trigger:
        //   (stop) — script emits {"stop":true} so the first yield is final
        //            even though maxIterations permits more iterations.
        //   (maxIterations) — script emits raw `{}` (parses as
        //            { result: "{}" } per SPEC §2.3 raw-fallback) so the
        //            iteration is non-terminating; maxIterations: 1 makes it
        //            final via the iteration-count limit.
        const yieldEmit =
          variant === "stop"
            ? `printf '%s' '{"stop":true}'`
            : `printf '%s' '{}'`;

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          `#!/bin/bash
set -e
rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"
${yieldEmit}
exit 0
`,
        );

        const maxIters = variant === "stop" ? 5 : 1;

        const driverCode = `
import { run } from "loopx";
import { existsSync } from "node:fs";

const pauseMarker = ${JSON.stringify(pauseMarker)};

const ac = new AbortController();
const gen = run("ralph", { signal: ac.signal, maxIterations: ${maxIters} });

let firstStop = false;
let firstDone = true;
let throwDone = false;
let throwValue = null;
let errName = "";
let errMessage = "";

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

try {
  const first = await gen.next();
  firstDone = first.done === true;
  firstStop = !first.done && first.value && first.value.stop === true;

  // Abort observed FIRST (post-final-yield, first-observed terminal trigger).
  // The user-signal listener pins firstObservedRef.trigger="abort" and
  // (because LOOPX_TEST_TERMINAL_TRIGGER_PAUSE=abort-listener) schedules a
  // bounded async pause before dispatching internalAc.abort().
  ac.abort();

  const pauseSeen = await waitForFile(pauseMarker, 10_000);
  if (!pauseSeen) {
    console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "pause-marker never appeared", throwDone: false, throwValue: null, firstStop, firstDone }));
    process.exit(1);
  }

  // Racing post-final-yield .throw() during the abort-listener pause. Per
  // SPEC §9.3 abort-after-final-yield rule, the abort outcome (first-observed)
  // pins the surfaced terminal outcome — wrapper.throw enters the post-final-
  // yield abort branch (firstObservedRef.trigger === "abort"), drives the
  // inner gen's finally (cleanup runs once with rule-3 warning), and throws
  // AbortError. The consumer-supplied "test-throw" error is NOT surfaced.
  const throwPromise = gen.throw(new Error("test-throw"));

  const settled = await throwPromise;
  throwDone = settled.done === true;
  throwValue = settled.value === undefined ? null : settled.value;
} catch (e) {
  const ex = e;
  errName = ex && ex.name ? ex.name : "";
  errMessage = ex && ex.message ? ex.message : String(e);
}

console.log(JSON.stringify({ errName, errMessage, throwDone, throwValue, firstStop, firstDone }));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
          env: {
            TMPDIR: tmpdirParent,
            NODE_ENV: "test",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "abort-listener",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          },
          timeout: 60_000,
        });

        expect(result.exitCode).toBe(0);
        const envelope = JSON.parse(result.stdout.trim());

        // Variant-specific first-yield observation — confirms the harness
        // entered the post-final-yield window before calling ac.abort().
        if (variant === "stop") {
          expect(envelope.firstStop).toBe(true);
        } else {
          expect(envelope.firstDone).toBe(false);
        }

        // (a) Generator throws AbortError — the first-observed abort wins per
        // SPEC §9.3 abort-after-final-yield rule; the racing post-pause
        // .throw() does NOT displace the abort outcome and the consumer-
        // supplied "test-throw" error is NOT surfaced. Load-bearing: a buggy
        // wrapper that surfaced the consumer-thrown error or a clean
        // settlement would shift errName / errMessage.
        expect(envelope.errName).toBe("AbortError");
        expect(envelope.errMessage).not.toMatch(/test-throw/);
        expect(envelope.throwDone).toBe(false);

        // (b) Exactly one cleanup-related warning across the racing triggers
        // (SPEC §7.4 idempotence / at-most-one-warning). A buggy
        // implementation that started a second cleanup attempt on the racing
        // .throw() would emit a second warning.
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(1);

        // (c) Path persistence — rule-3 leave-with-warning preserved. The
        // single cleanup attempt completed and left the regular-file
        // replacement in place; no second attempt mutated it. A buggy
        // implementation that re-touched the rule-3 entry on the second
        // attempt would corrupt or remove the file.
        const remaining = listLoopxEntries(tmpdirParent);
        expect(remaining.length).toBe(1);
        const tmpdirPath = join(tmpdirParent, remaining[0]);
        expect(existsSync(tmpdirPath)).toBe(true);
        const st = statSync(tmpdirPath);
        expect(st.isFile()).toBe(true);
        expect(readFileSync(tmpdirPath, "utf-8")).toBe(
          "regular-file-replacement",
        );

        await rm(tmpdirPath, { force: true }).catch(() => {});
      }, { timeout: 60_000, retry: 2 });
    }

    // ------------------------------------------------------------------------
    // T-TMP-38d4: SPEC §7.2 / §7.4 / §9.1 / §9.3 — post-final-yield abort
    // observed FIRST, racing `.return()` during the `abort-listener` pause
    // window on the run() programmatic surface, rule-3 cleanup branch.
    //
    // `.return()`-axis abort-first counterpart to T-TMP-38d (which covers the
    // `.throw()` axis on the same observation order). Together with T-TMP-38d
    // (abort-first × `.throw()`), T-TMP-38d2 (`.throw()`-first × abort), and
    // T-TMP-38d3 (`.return()`-first × abort), this closes the post-final-yield
    // consumer-cancellation × abort race symmetrically across the full
    // {`.return()` / `.throw()`} × {abort-first / consumer-first} 2×2 matrix.
    //
    // Per SPEC §9.3's abort-after-final-yield rule, when abort is observed
    // first after the final yield (before generator settlement), the abort
    // outcome displaces normal completion regardless of which consumer
    // cancellation later races against it. Equivalent contract to T-API-66b /
    // T-API-66e (abort-first × `.return()` post-final-yield), but driven
    // through the abort-listener pause race rather than direct interaction
    // sequencing — pinning the warning-cardinality axis on the same race.
    //
    // **Seam choice rationale.** Same as T-TMP-38d (the `.throw()` companion):
    // the `abort-listener` seam fires deterministically when `c.abort()` is
    // delivered, regardless of whether the implementation had also
    // opportunistically begun cleanup before the abort arrived.
    //
    // **Parameterized over the final-yield trigger** (per SPEC 9.3 "via
    // `stop: true` or `maxIterations` reached"): variant **(stop)** the
    // script-driven `stop: true` final-yield path; variant **(maxIterations)**
    // the loopx-driven iteration-count-limit final-yield path.
    //
    // Buggy-implementation scenarios this test catches:
    //   - Surfacing a clean `.return()` settlement (failing to displace the
    //     would-be `.return()` outcome with the first-observed abort): fails
    //     (a) on the errName === "AbortError" probe.
    //   - Starting a second cleanup attempt on the racing `.return()` (e.g.,
    //     handling the abort-first × `.throw()` race in T-TMP-38d via a "is
    //     consumer interaction `.throw()`?" gate but missing the `.return()`
    //     axis): emits a second cleanup warning (fails b) and re-touches the
    //     rule-3 entry (fails c).
    // ------------------------------------------------------------------------
    const POST_FINAL_YIELD_ABORT_FIRST_RETURN_VARIANTS = [
      "stop",
      "maxIterations",
    ] as const;

    for (const variant of POST_FINAL_YIELD_ABORT_FIRST_RETURN_VARIANTS) {
      it(`T-TMP-38d4 (${variant}): SPEC §7.2 first-observed-wins under racing post-final-yield abort → .return() during abort-listener (run() rule-3)`, async () => {
        const { project, tmpdirParent } = await setupTmpdirTest();
        const pauseMarker = join(project.dir, "pause-marker.json");

        const yieldEmit =
          variant === "stop"
            ? `printf '%s' '{"stop":true}'`
            : `printf '%s' '{}'`;

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          `#!/bin/bash
set -e
rm -rf "$LOOPX_TMPDIR"
printf '%s' "regular-file-replacement" > "$LOOPX_TMPDIR"
${yieldEmit}
exit 0
`,
        );

        const maxIters = variant === "stop" ? 5 : 1;

        const driverCode = `
import { run } from "loopx";
import { existsSync } from "node:fs";

const pauseMarker = ${JSON.stringify(pauseMarker)};

const ac = new AbortController();
const gen = run("ralph", { signal: ac.signal, maxIterations: ${maxIters} });

let firstStop = false;
let firstDone = true;
let returnDone = false;
let returnValue = null;
let errName = "";
let errMessage = "";

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

try {
  const first = await gen.next();
  firstDone = first.done === true;
  firstStop = !first.done && first.value && first.value.stop === true;

  // Abort observed FIRST (post-final-yield, first-observed terminal trigger).
  // The user-signal listener pins firstObservedRef.trigger="abort" and
  // (because LOOPX_TEST_TERMINAL_TRIGGER_PAUSE=abort-listener) schedules a
  // bounded async pause before dispatching internalAc.abort().
  ac.abort();

  const pauseSeen = await waitForFile(pauseMarker, 10_000);
  if (!pauseSeen) {
    console.log(JSON.stringify({ errName: "TimeoutError", errMessage: "pause-marker never appeared", returnDone: false, returnValue: null, firstStop, firstDone }));
    process.exit(1);
  }

  // Racing post-final-yield .return() during the abort-listener pause. Per
  // SPEC §9.3 abort-after-final-yield rule, the abort outcome (first-observed)
  // pins the surfaced terminal outcome — wrapper.return enters the post-final-
  // yield abort branch (firstObservedRef.trigger === "abort"), drives the
  // inner gen's finally (cleanup runs once with rule-3 warning), and throws
  // AbortError. The .return() does NOT produce a clean { done: true }
  // settlement.
  const returnPromise = gen.return(undefined);

  const settled = await returnPromise;
  returnDone = settled.done === true;
  returnValue = settled.value === undefined ? null : settled.value;
} catch (e) {
  const ex = e;
  errName = ex && ex.name ? ex.name : "";
  errMessage = ex && ex.message ? ex.message : String(e);
}

console.log(JSON.stringify({ errName, errMessage, returnDone, returnValue, firstStop, firstDone }));
`;

        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
          env: {
            TMPDIR: tmpdirParent,
            NODE_ENV: "test",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE: "abort-listener",
            LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER: pauseMarker,
          },
          timeout: 60_000,
        });

        expect(result.exitCode).toBe(0);
        const envelope = JSON.parse(result.stdout.trim());

        // Variant-specific first-yield observation — confirms the harness
        // entered the post-final-yield window before calling ac.abort().
        if (variant === "stop") {
          expect(envelope.firstStop).toBe(true);
        } else {
          expect(envelope.firstDone).toBe(false);
        }

        // (a) Generator throws AbortError — the first-observed abort wins per
        // SPEC §9.3 abort-after-final-yield rule; the racing post-pause
        // .return() does NOT produce a clean { done: true } settlement and
        // does NOT displace the abort outcome. Load-bearing: a buggy wrapper
        // that surfaced a clean settlement would shift errName / returnDone.
        expect(envelope.errName).toBe("AbortError");
        expect(envelope.returnDone).toBe(false);

        // (b) Exactly one cleanup-related warning across the racing triggers
        // (SPEC §7.4 idempotence / at-most-one-warning). A buggy
        // implementation that started a second cleanup attempt on the racing
        // .return() (e.g., one that handled abort-first × `.throw()` correctly
        // via a "is consumer interaction `.throw()`?" gate but missed the
        // `.return()` axis) would emit a second warning.
        const cleanupWarnings = result.stderr
          .split("\n")
          .filter((l) => l.startsWith("LOOPX_TEST_CLEANUP_WARNING\t"));
        expect(cleanupWarnings.length).toBe(1);

        // (c) Path persistence — rule-3 leave-with-warning preserved. The
        // single cleanup attempt completed and left the regular-file
        // replacement in place; no second attempt mutated it.
        const remaining = listLoopxEntries(tmpdirParent);
        expect(remaining.length).toBe(1);
        const tmpdirPath = join(tmpdirParent, remaining[0]);
        expect(existsSync(tmpdirPath)).toBe(true);
        const st = statSync(tmpdirPath);
        expect(st.isFile()).toBe(true);
        expect(readFileSync(tmpdirPath, "utf-8")).toBe(
          "regular-file-replacement",
        );

        await rm(tmpdirPath, { force: true }).catch(() => {});
      }, { timeout: 60_000, retry: 2 });
    }
  });
});
