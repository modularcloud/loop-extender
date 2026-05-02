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
import { runCLI, runCLIWithSignal } from "../helpers/cli.js";
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
  });
});
