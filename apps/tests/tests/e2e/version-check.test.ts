import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  createTempProject,
  createBashWorkflowScript,
  createWorkflowScript,
  createWorkflowPackageJson,
  createWorkflow,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { startLocalGitServer, type GitServer } from "../helpers/servers.js";
import { forEachRuntime } from "../helpers/runtime.js";

// ─────────────────────────────────────────────────────────────
// Version & range helpers
// ─────────────────────────────────────────────────────────────

function getRunningVersion(): string {
  const pkgPath = resolve(process.cwd(), "node_modules/loopx/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version as string;
}

/** Returns a semver range that is guaranteed to be satisfied by the running loopx. */
function satisfiedRange(): string {
  return getRunningVersion();
}

/** Returns a semver range that is guaranteed to NOT be satisfied by the running loopx. */
function unsatisfiedRange(): string {
  return ">=999.0.0";
}

/** Returns a string that is valid JSON but NOT a valid semver range. */
const INVALID_SEMVER = "not-a-range!!!";

/** A valid package.json containing no loopx declaration at all. */
const PACKAGE_JSON_NO_LOOPX = JSON.stringify(
  { name: "my-workflow", version: "1.0.0" },
  null,
  2,
);

/** Broken/unparseable JSON content. */
const BROKEN_JSON = "{{{INVALID";

// ─────────────────────────────────────────────────────────────
// Warning predicates — pattern-match common warning shapes on stderr
// ─────────────────────────────────────────────────────────────

/** True iff stderr has a version-mismatch warning mentioning the workflow name. */
function hasVersionMismatchWarning(stderr: string, workflowName: string): boolean {
  return (
    stderr.includes(workflowName) &&
    /version|mismatch|range|satisf/i.test(stderr)
  );
}

/** Count occurrences of version-mismatch warning lines for a given workflow. */
function countVersionMismatchWarnings(
  stderr: string,
  workflowName: string,
): number {
  return stderr
    .split("\n")
    .filter(
      (line) =>
        line.includes(workflowName) &&
        /version|mismatch|range|satisf/i.test(line),
    ).length;
}

/** True iff stderr has an invalid-JSON parse warning mentioning the workflow. */
function hasInvalidJsonWarning(stderr: string, workflowName: string): boolean {
  return (
    stderr.includes(workflowName) &&
    /(invalid.*json|parse|parsing|package\.json)/i.test(stderr)
  );
}

function countInvalidJsonWarnings(
  stderr: string,
  workflowName: string,
): number {
  return stderr
    .split("\n")
    .filter(
      (line) =>
        line.includes(workflowName) &&
        /(invalid.*json|parse|parsing|package\.json)/i.test(line),
    ).length;
}

/** True iff stderr has an invalid-semver-range warning mentioning the workflow. */
function hasInvalidSemverWarning(stderr: string, workflowName: string): boolean {
  return (
    stderr.includes(workflowName) &&
    /(semver|range|not.*(valid|parse))/i.test(stderr)
  );
}

function countInvalidSemverWarnings(
  stderr: string,
  workflowName: string,
): number {
  return stderr
    .split("\n")
    .filter(
      (line) =>
        line.includes(workflowName) &&
        /(semver|range|invalid)/i.test(line),
    ).length;
}

/** True iff stderr has an unreadable-file warning mentioning the workflow. */
function hasUnreadableWarning(stderr: string, workflowName: string): boolean {
  return (
    stderr.includes(workflowName) &&
    /(unreadable|permission|EACCES|EPERM|cannot.*read|read.*fail|denied)/i.test(
      stderr,
    )
  );
}

function countUnreadableWarnings(
  stderr: string,
  workflowName: string,
): number {
  return stderr
    .split("\n")
    .filter(
      (line) =>
        line.includes(workflowName) &&
        /(unreadable|permission|EACCES|EPERM|cannot.*read|read.*fail|denied)/i.test(
          line,
        ),
    ).length;
}

/** True iff stderr has any package.json-related warning mentioning the workflow. */
function hasAnyPackageJsonWarning(
  stderr: string,
  workflowName: string,
): boolean {
  return (
    hasInvalidJsonWarning(stderr, workflowName) ||
    hasInvalidSemverWarning(stderr, workflowName) ||
    hasUnreadableWarning(stderr, workflowName)
  );
}

// ─────────────────────────────────────────────────────────────
// Bash helpers for multi-iteration scripts
// ─────────────────────────────────────────────────────────────

/** A bash body that writes a marker then produces no output (reset). */
function bashMarker(markerFile: string): string {
  return `printf 'ran' >> "${markerFile}"\n`;
}

/**
 * A bash body that mutates the workflow's package.json AFTER the first iteration
 * (first iteration leaves it alone so we can prove "first entry reads original").
 */
function bashMutatePkgAfterFirst(
  counterFile: string,
  pkgPath: string,
  newContent: string,
): string {
  // On iteration 1, counter file doesn't exist → wc says 0. We check first, then append.
  return [
    `COUNT=0`,
    `if [ -f "${counterFile}" ]; then`,
    `  COUNT=$(wc -c < "${counterFile}" | tr -d ' ')`,
    `fi`,
    `printf '1' >> "${counterFile}"`,
    `if [ "$COUNT" -ge 1 ]; then`,
    `  cat > "${pkgPath}" <<'__LOOPX_PKG_EOF__'`,
    newContent,
    `__LOOPX_PKG_EOF__`,
    `fi`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────
// File permission helpers
// ─────────────────────────────────────────────────────────────

async function makeUnreadable(path: string): Promise<void> {
  await chmod(path, 0o000);
}

/** Restore read permissions recursively so cleanup doesn't leave stale files. */
function restorePerms(dir: string): void {
  try {
    execSync(`chmod -R u+rw "${dir}"`, { stdio: "ignore" });
  } catch {
    // best-effort
  }
}

// ═════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════

describe("SPEC: Workflow-Level Version Checking (T-VER-* — §4.13)", () => {
  let project: TempProject | null = null;
  let gitServer: GitServer | null = null;

  afterEach(async () => {
    if (project) {
      restorePerms(project.dir);
      await project.cleanup();
      project = null;
    }
    if (gitServer) {
      await gitServer.close();
      gitServer = null;
    }
  });

  // ───────────────────────────────────────────────
  // Runtime: Basic satisfied / unsatisfied paths
  // ───────────────────────────────────────────────

  forEachRuntime((runtime) => {
    it("T-VER-01: satisfied range → execution proceeds, no warning", async () => {
      project = await createTempProject();
      const markerFile = join(project.dir, "ran.marker");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        bashMarker(markerFile),
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: satisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerFile)).toBe(true);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    it("T-VER-02: unsatisfied range → warning on stderr, execution continues (exit 0)", async () => {
      project = await createTempProject();
      const markerFile = join(project.dir, "ran.marker");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        bashMarker(markerFile),
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerFile)).toBe(true);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(true);
    });

    // ─────────────────────────────────────────────
    // First-entry-only dedupe
    // ─────────────────────────────────────────────

    it("T-VER-03: version warning emitted only on first entry to a workflow", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter");
      // Empty-output script → loop resets to start; with -n 3 ralph is entered 3 times
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '1' >> "${counterFile}"\n`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "3", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      // Proves the script was entered 3 times
      const count = readFileSync(counterFile, "utf-8").length;
      expect(count).toBe(3);
      expect(countVersionMismatchWarnings(result.stderr, "ralph")).toBe(1);
    });

    it("T-VER-04: cross-workflow first-entry warning on goto into workflow with unsatisfied range", async () => {
      project = await createTempProject();
      const betaMarker = join(project.dir, "beta.marker");
      // start has no package.json, emits goto to beta:index
      await createBashWorkflowScript(
        project,
        "start",
        "index",
        `printf '{"goto":"beta:index"}'`,
      );
      await createBashWorkflowScript(
        project,
        "beta",
        "index",
        bashMarker(betaMarker),
      );
      await createWorkflowPackageJson(project, "beta", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "2", "start"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(betaMarker)).toBe(true);
      expect(hasVersionMismatchWarning(result.stderr, "beta")).toBe(true);
      expect(hasVersionMismatchWarning(result.stderr, "start")).toBe(false);
    });

    it("T-VER-04a: cross-workflow alternating re-entry — exactly one warning per workflow", async () => {
      project = await createTempProject();
      // alpha emits goto beta:index; beta emits no output (reset to alpha)
      // -n 4: alpha(warn), beta(warn), alpha(no warn), beta(no warn)
      await createBashWorkflowScript(
        project,
        "alpha",
        "index",
        `printf '{"goto":"beta:index"}'`,
      );
      await createBashWorkflowScript(project, "beta", "index", `# no output\n`);
      await createWorkflowPackageJson(project, "alpha", {
        dependencies: { loopx: unsatisfiedRange() },
      });
      await createWorkflowPackageJson(project, "beta", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "4", "alpha"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(countVersionMismatchWarnings(result.stderr, "alpha")).toBe(1);
      expect(countVersionMismatchWarnings(result.stderr, "beta")).toBe(1);
    });

    it("T-VER-05: starting workflow is checked before first iteration (warning appears even though first iteration runs)", async () => {
      project = await createTempProject();
      const markerFile = join(project.dir, "ran.marker");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        bashMarker(markerFile),
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerFile)).toBe(true);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(true);
    });

    it("T-VER-06: -n 0 skips workflow version warnings", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"x"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "0", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    // ─────────────────────────────────────────────
    // package.json failure modes (runtime)
    // ─────────────────────────────────────────────

    it.skipIf(process.getuid?.() === 0)(
      "T-VER-07: unreadable package.json → warning, execution continues",
      async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.marker");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          bashMarker(markerFile),
        );
        const pkgPath = await createWorkflowPackageJson(project, "ralph", {
          dependencies: { loopx: satisfiedRange() },
        });
        await makeUnreadable(pkgPath);

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerFile)).toBe(true);
        expect(hasUnreadableWarning(result.stderr, "ralph")).toBe(true);
      },
    );

    it("T-VER-07a: invalid-JSON package.json failure warning follows first-entry-only dedupe", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '1' >> "${counterFile}"\n`,
      );
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const result = await runCLI(["run", "-n", "3", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(counterFile, "utf-8").length).toBe(3);
      expect(countInvalidJsonWarnings(result.stderr, "ralph")).toBe(1);
    });

    it("T-VER-07b: invalid-semver package.json warning follows first-entry-only dedupe", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '1' >> "${counterFile}"\n`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: INVALID_SEMVER },
      });

      const result = await runCLI(["run", "-n", "3", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(counterFile, "utf-8").length).toBe(3);
      expect(countInvalidSemverWarnings(result.stderr, "ralph")).toBe(1);
    });

    it.skipIf(process.getuid?.() === 0)(
      "T-VER-07c: unreadable package.json warning follows first-entry-only dedupe",
      async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '1' >> "${counterFile}"\n`,
        );
        const pkgPath = await createWorkflowPackageJson(project, "ralph", {
          dependencies: { loopx: satisfiedRange() },
        });
        await makeUnreadable(pkgPath);

        const result = await runCLI(["run", "-n", "3", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(counterFile, "utf-8").length).toBe(3);
        expect(countUnreadableWarnings(result.stderr, "ralph")).toBe(1);
      },
    );

    it("T-VER-07d: cross-workflow invalid-JSON package.json warning via goto — exactly once", async () => {
      project = await createTempProject();
      const brokenMarker = join(project.dir, "broken.marker");
      await createBashWorkflowScript(
        project,
        "clean",
        "index",
        `printf '{"goto":"broken:index"}'`,
      );
      await createBashWorkflowScript(
        project,
        "broken",
        "index",
        bashMarker(brokenMarker),
      );
      await createWorkflowPackageJson(project, "broken", BROKEN_JSON);

      const result = await runCLI(["run", "-n", "4", "clean"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(brokenMarker)).toBe(true);
      expect(countInvalidJsonWarnings(result.stderr, "broken")).toBe(1);
      expect(hasAnyPackageJsonWarning(result.stderr, "clean")).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)(
      "T-VER-07e: cross-workflow unreadable package.json warning via goto — exactly once",
      async () => {
        project = await createTempProject();
        const brokenMarker = join(project.dir, "broken.marker");
        await createBashWorkflowScript(
          project,
          "clean",
          "index",
          `printf '{"goto":"broken:index"}'`,
        );
        await createBashWorkflowScript(
          project,
          "broken",
          "index",
          bashMarker(brokenMarker),
        );
        const pkgPath = await createWorkflowPackageJson(project, "broken", {
          dependencies: { loopx: satisfiedRange() },
        });
        await makeUnreadable(pkgPath);

        const result = await runCLI(["run", "-n", "4", "clean"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(brokenMarker)).toBe(true);
        expect(countUnreadableWarnings(result.stderr, "broken")).toBe(1);
        expect(hasAnyPackageJsonWarning(result.stderr, "clean")).toBe(false);
      },
    );

    it("T-VER-07f: cross-workflow invalid-semver package.json warning via goto — exactly once", async () => {
      project = await createTempProject();
      const brokenMarker = join(project.dir, "broken.marker");
      await createBashWorkflowScript(
        project,
        "clean",
        "index",
        `printf '{"goto":"broken:index"}'`,
      );
      await createBashWorkflowScript(
        project,
        "broken",
        "index",
        bashMarker(brokenMarker),
      );
      await createWorkflowPackageJson(project, "broken", {
        dependencies: { loopx: INVALID_SEMVER },
      });

      const result = await runCLI(["run", "-n", "4", "clean"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(brokenMarker)).toBe(true);
      expect(countInvalidSemverWarnings(result.stderr, "broken")).toBe(1);
      expect(hasAnyPackageJsonWarning(result.stderr, "clean")).toBe(false);
    });

    it("T-VER-08: invalid-JSON package.json → warning, execution continues", async () => {
      project = await createTempProject();
      const markerFile = join(project.dir, "ran.marker");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        bashMarker(markerFile),
      );
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerFile)).toBe(true);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(true);
    });

    it("T-VER-09/T-VER-09a: invalid semver range in package.json → warning, execution continues", async () => {
      project = await createTempProject();
      const markerFile = join(project.dir, "ran.marker");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        bashMarker(markerFile),
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: INVALID_SEMVER },
      });

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerFile)).toBe(true);
      expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(true);
    });

    // ─────────────────────────────────────────────
    // dependencies vs devDependencies precedence
    // ─────────────────────────────────────────────

    it("T-VER-10: dependencies precedence — satisfied wins; reversed → warning fires from dependencies", async () => {
      // Case A: dependencies satisfied, devDependencies unsatisfied → no warning
      {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"result":"ok"}'`,
        );
        await createWorkflowPackageJson(project, "ralph", {
          dependencies: { loopx: satisfiedRange() },
          devDependencies: { loopx: unsatisfiedRange() },
        });

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);

        restorePerms(project.dir);
        await project.cleanup();
        project = null;
      }

      // Case B: dependencies unsatisfied, devDependencies satisfied → warning fires
      {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"result":"ok"}'`,
        );
        await createWorkflowPackageJson(project, "ralph", {
          dependencies: { loopx: unsatisfiedRange() },
          devDependencies: { loopx: satisfiedRange() },
        });

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(true);
      }
    });

    it("T-VER-10a: deps invalid-semver → invalid-semver warning, no mismatch warning, no fallback to devDeps", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: INVALID_SEMVER },
        devDependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(true);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
    });

    it("T-VER-10b: deps satisfied → devDeps fully ignored (no warnings even if malformed)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: satisfiedRange() },
        devDependencies: { loopx: INVALID_SEMVER },
      });

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
      expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(false);
    });

    // ─────────────────────────────────────────────
    // optionalDependencies / peerDependencies ignored
    // ─────────────────────────────────────────────

    it("T-VER-11: optionalDependencies.loopx with unsatisfied range → ignored (no warning)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        optionalDependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
    });

    it("T-VER-11a: optionalDependencies.loopx with invalid semver → ignored (no warning)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        optionalDependencies: { loopx: INVALID_SEMVER },
      });

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
      expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(false);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    it("T-VER-11b/T-VER-11b2/T-VER-11d: peerDependencies.loopx with unsatisfied range → ignored (no warning)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        peerDependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    it("T-VER-11c: optionalDependencies.loopx (satisfied) does not rescue deps.loopx (unsatisfied)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: unsatisfiedRange() },
        optionalDependencies: { loopx: satisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(true);
    });

    // ─────────────────────────────────────────────
    // devDependencies-only path
    // ─────────────────────────────────────────────

    it("T-VER-14/T-VER-14b/T-VER-14c/T-VER-14d: devDependencies.loopx only (unsatisfied) → warning, execution continues", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        devDependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(true);
    });

    it("T-VER-14a: optionalDependencies.loopx (satisfied) does not rescue devDeps.loopx (unsatisfied)", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        devDependencies: { loopx: unsatisfiedRange() },
        optionalDependencies: { loopx: satisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(true);
    });

    // ─────────────────────────────────────────────
    // No loopx declared
    // ─────────────────────────────────────────────

    it("T-VER-16: valid package.json with no loopx declared → no version check, no warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", PACKAGE_JSON_NO_LOOPX);

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    // ─────────────────────────────────────────────
    // Unentered siblings not version-checked
    // ─────────────────────────────────────────────

    it("T-VER-18: unentered sibling workflow's unsatisfied range emits no warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "good",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createBashWorkflowScript(
        project,
        "sibling",
        "index",
        `printf '{"result":"should-not-run"}'`,
      );
      await createWorkflowPackageJson(project, "sibling", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "1", "good"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasVersionMismatchWarning(result.stderr, "sibling")).toBe(false);
    });

    it("T-VER-18a: unentered sibling with broken package.json emits no warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "good",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createBashWorkflowScript(
        project,
        "sibling",
        "index",
        `printf '{"result":"should-not-run"}'`,
      );
      await createWorkflowPackageJson(project, "sibling", BROKEN_JSON);

      const result = await runCLI(["run", "-n", "1", "good"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasAnyPackageJsonWarning(result.stderr, "sibling")).toBe(false);
    });

    // ─────────────────────────────────────────────
    // `run -h` does not perform version checks
    // ─────────────────────────────────────────────

    it("T-VER-19: `run -h` does not perform version or package.json checks", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-h"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)(
      "T-VER-19a: `run -h` does not read workflow package.json — unreadable variant",
      async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '{"result":"ok"}'`,
        );
        const pkgPath = await createWorkflowPackageJson(project, "ralph", {
          dependencies: { loopx: satisfiedRange() },
        });
        await makeUnreadable(pkgPath);

        const result = await runCLI(["run", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(hasUnreadableWarning(result.stderr, "ralph")).toBe(false);
      },
    );

    it("T-VER-19b: `run -h` does not read workflow package.json — invalid JSON variant", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const result = await runCLI(["run", "-h"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    it("T-VER-19c: `run -h` does not read workflow package.json — invalid semver variant", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: INVALID_SEMVER },
      });

      const result = await runCLI(["run", "-h"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(false);
    });

    // ─────────────────────────────────────────────
    // No re-read after first entry (mutation)
    // ─────────────────────────────────────────────

    it("T-VER-20: workflow package.json is not re-read after first entry (satisfied → unsatisfied mutation)", async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter");
      const pkgPath = join(project.loopxDir, "ralph", "package.json");
      const unsatisfiedPkgContent = JSON.stringify(
        { dependencies: { loopx: unsatisfiedRange() } },
        null,
        2,
      );
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        bashMutatePkgAfterFirst(counterFile, pkgPath, unsatisfiedPkgContent),
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: satisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "3", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(counterFile, "utf-8").length).toBe(3);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
    });

    it("T-VER-20a: absent-then-broken mutation — package.json not re-read after first entry", async () => {
      project = await createTempProject();
      await createWorkflow(project, "ralph");
      const counterFile = join(project.dir, "counter");
      const pkgPath = join(project.loopxDir, "ralph", "package.json");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        bashMutatePkgAfterFirst(counterFile, pkgPath, BROKEN_JSON),
      );
      // Deliberately no initial package.json created.

      const result = await runCLI(["run", "-n", "3", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(counterFile, "utf-8").length).toBe(3);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    // ─────────────────────────────────────────────
    // Absent package.json
    // ─────────────────────────────────────────────

    it("T-VER-21: workflow with no package.json runs without warnings", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    // ─────────────────────────────────────────────
    // Stray .loopx/package.json ignored at runtime
    // ─────────────────────────────────────────────

    it("T-VER-23: stray .loopx/package.json is ignored at runtime", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      const strayPath = join(project.loopxDir, "package.json");
      await (await import("node:fs/promises")).writeFile(
        strayPath,
        JSON.stringify({ dependencies: { loopx: unsatisfiedRange() } }, null, 2),
        "utf-8",
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
    });

    // ─────────────────────────────────────────────
    // Target resolution precedes version check
    // ─────────────────────────────────────────────

    it("T-VER-24: bare target with missing index → resolution error, no version/package warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "check",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    it("T-VER-24a: bare target with missing index — broken JSON variant — no package.json warning", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "check",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const result = await runCLI(["run", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    it("T-VER-24b: explicit workflow:missing start target → resolution error, no warnings", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "ralph:missing"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    it("T-VER-24c: explicit workflow:missing start target — broken JSON variant — no warnings", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const result = await runCLI(["run", "ralph:missing"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    it("T-VER-24d: explicit :index target on workflow with no index → resolution error, no warnings", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "check",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "ralph:index"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
      expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    it("T-VER-24e: explicit :index on workflow with no index — broken JSON — no warnings", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "ralph",
        "check",
        `printf '{"result":"ok"}'`,
      );
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const result = await runCLI(["run", "ralph:index"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(false);
    });

    it("T-VER-25: goto into missing script → resolution error, no version/package warning for target workflow", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "start",
        "index",
        `printf '{"goto":"other:missing"}'`,
      );
      await createBashWorkflowScript(
        project,
        "other",
        "index",
        `printf '{"result":"other-ok"}'`,
      );
      await createWorkflowPackageJson(project, "other", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "2", "start"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(hasVersionMismatchWarning(result.stderr, "other")).toBe(false);
      expect(hasAnyPackageJsonWarning(result.stderr, "other")).toBe(false);
    });

    it("T-VER-25a: goto into missing script — broken JSON variant — no warnings for target workflow", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "start",
        "index",
        `printf '{"goto":"other:missing"}'`,
      );
      await createBashWorkflowScript(
        project,
        "other",
        "index",
        `printf '{"result":"other-ok"}'`,
      );
      await createWorkflowPackageJson(project, "other", BROKEN_JSON);

      const result = await runCLI(["run", "-n", "2", "start"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(hasInvalidJsonWarning(result.stderr, "other")).toBe(false);
    });

    it("T-VER-25b: goto into workflow:index when target has no index → resolution error, no warnings", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "start",
        "index",
        `printf '{"goto":"other:index"}'`,
      );
      await createBashWorkflowScript(
        project,
        "other",
        "check",
        `printf '{"result":"other-ok"}'`,
      );
      await createWorkflowPackageJson(project, "other", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "2", "start"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(hasVersionMismatchWarning(result.stderr, "other")).toBe(false);
      expect(hasAnyPackageJsonWarning(result.stderr, "other")).toBe(false);
    });

    it("T-VER-25c: goto into workflow:index when target has no index — broken JSON — no warnings", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(
        project,
        "start",
        "index",
        `printf '{"goto":"other:index"}'`,
      );
      await createBashWorkflowScript(
        project,
        "other",
        "check",
        `printf '{"result":"other-ok"}'`,
      );
      await createWorkflowPackageJson(project, "other", BROKEN_JSON);

      const result = await runCLI(["run", "-n", "2", "start"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(hasInvalidJsonWarning(result.stderr, "other")).toBe(false);
    });

    // ─────────────────────────────────────────────
    // Explicit script entry into no-index workflow
    // ─────────────────────────────────────────────

    it("T-VER-26: version check fires on explicit-script entry into a no-index workflow", async () => {
      project = await createTempProject();
      const markerFile = join(project.dir, "ran.marker");
      await createBashWorkflowScript(
        project,
        "ralph",
        "check",
        bashMarker(markerFile),
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "1", "ralph:check"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerFile)).toBe(true);
      expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(true);
    });

    it("T-VER-26a: invalid-JSON warning fires on explicit-script entry into a no-index workflow", async () => {
      project = await createTempProject();
      const markerFile = join(project.dir, "ran.marker");
      await createBashWorkflowScript(
        project,
        "ralph",
        "check",
        bashMarker(markerFile),
      );
      await createWorkflowPackageJson(project, "ralph", BROKEN_JSON);

      const result = await runCLI(["run", "-n", "1", "ralph:check"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerFile)).toBe(true);
      expect(hasInvalidJsonWarning(result.stderr, "ralph")).toBe(true);
    });

    it("T-VER-26b: invalid-semver warning fires on explicit-script entry into a no-index workflow", async () => {
      project = await createTempProject();
      const markerFile = join(project.dir, "ran.marker");
      await createBashWorkflowScript(
        project,
        "ralph",
        "check",
        bashMarker(markerFile),
      );
      await createWorkflowPackageJson(project, "ralph", {
        dependencies: { loopx: INVALID_SEMVER },
      });

      const result = await runCLI(["run", "-n", "1", "ralph:check"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerFile)).toBe(true);
      expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(true);
    });

    it.skipIf(process.getuid?.() === 0)(
      "T-VER-26c/T-VER-26d: unreadable-file warning fires on explicit-script entry into a no-index workflow",
      async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.marker");
        await createBashWorkflowScript(
          project,
          "ralph",
          "check",
          bashMarker(markerFile),
        );
        const pkgPath = await createWorkflowPackageJson(project, "ralph", {
          dependencies: { loopx: satisfiedRange() },
        });
        await makeUnreadable(pkgPath);

        const result = await runCLI(["run", "-n", "1", "ralph:check"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerFile)).toBe(true);
        expect(hasUnreadableWarning(result.stderr, "ralph")).toBe(true);
      },
    );

    // ─────────────────────────────────────────────
    // Cross-workflow goto into no-index workflow
    // ─────────────────────────────────────────────

    it("T-VER-27: cross-workflow first-entry version warning for no-index workflow via qualified goto", async () => {
      project = await createTempProject();
      const betaMarker = join(project.dir, "beta.marker");
      await createBashWorkflowScript(
        project,
        "alpha",
        "index",
        `printf '{"goto":"beta:check"}'`,
      );
      await createBashWorkflowScript(
        project,
        "beta",
        "check",
        bashMarker(betaMarker),
      );
      await createWorkflowPackageJson(project, "beta", {
        dependencies: { loopx: unsatisfiedRange() },
      });

      const result = await runCLI(["run", "-n", "2", "alpha"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(betaMarker)).toBe(true);
      expect(hasVersionMismatchWarning(result.stderr, "beta")).toBe(true);
      expect(hasVersionMismatchWarning(result.stderr, "alpha")).toBe(false);
    });

    it("T-VER-27a: cross-workflow invalid-JSON warning for no-index workflow via qualified goto — exactly once", async () => {
      project = await createTempProject();
      const brokenMarker = join(project.dir, "broken.marker");
      await createBashWorkflowScript(
        project,
        "clean",
        "index",
        `printf '{"goto":"broken:check"}'`,
      );
      await createBashWorkflowScript(
        project,
        "broken",
        "check",
        bashMarker(brokenMarker),
      );
      await createWorkflowPackageJson(project, "broken", BROKEN_JSON);

      const result = await runCLI(["run", "-n", "4", "clean"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(brokenMarker)).toBe(true);
      expect(countInvalidJsonWarnings(result.stderr, "broken")).toBe(1);
      expect(hasAnyPackageJsonWarning(result.stderr, "clean")).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)(
      "T-VER-27b: cross-workflow unreadable-file warning for no-index workflow via qualified goto — exactly once",
      async () => {
        project = await createTempProject();
        const brokenMarker = join(project.dir, "broken.marker");
        await createBashWorkflowScript(
          project,
          "clean",
          "index",
          `printf '{"goto":"broken:check"}'`,
        );
        await createBashWorkflowScript(
          project,
          "broken",
          "check",
          bashMarker(brokenMarker),
        );
        const pkgPath = await createWorkflowPackageJson(project, "broken", {
          dependencies: { loopx: satisfiedRange() },
        });
        await makeUnreadable(pkgPath);

        const result = await runCLI(["run", "-n", "4", "clean"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(brokenMarker)).toBe(true);
        expect(countUnreadableWarnings(result.stderr, "broken")).toBe(1);
        expect(hasAnyPackageJsonWarning(result.stderr, "clean")).toBe(false);
      },
    );

    it("T-VER-27c/T-VER-27d: cross-workflow invalid-semver warning for no-index workflow via qualified goto — exactly once", async () => {
      project = await createTempProject();
      const brokenMarker = join(project.dir, "broken.marker");
      await createBashWorkflowScript(
        project,
        "clean",
        "index",
        `printf '{"goto":"broken:check"}'`,
      );
      await createBashWorkflowScript(
        project,
        "broken",
        "check",
        bashMarker(brokenMarker),
      );
      await createWorkflowPackageJson(project, "broken", {
        dependencies: { loopx: INVALID_SEMVER },
      });

      const result = await runCLI(["run", "-n", "4", "clean"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(brokenMarker)).toBe(true);
      expect(countInvalidSemverWarnings(result.stderr, "broken")).toBe(1);
      expect(hasAnyPackageJsonWarning(result.stderr, "clean")).toBe(false);
    });

    it("T-VER-28/T-VER-28a/T-VER-28aa/T-VER-28aa2/T-VER-28ab/T-VER-28ab2/T-VER-28ac/T-VER-28ac2/T-VER-28ad/T-VER-28ad2/T-VER-28ae/T-VER-28af/T-VER-28ag/T-VER-28ah/T-VER-28ai/T-VER-28ai2/T-VER-28b/T-VER-28c/T-VER-28d/T-VER-28d2/T-VER-28e/T-VER-28f/T-VER-28g/T-VER-28h/T-VER-28i/T-VER-28i2/T-VER-28j/T-VER-28k/T-VER-28l/T-VER-28m/T-VER-28n/T-VER-28o/T-VER-28p/T-VER-28q/T-VER-28r/T-VER-28s/T-VER-28t/T-VER-28u/T-VER-28v/T-VER-28w/T-VER-28x/T-VER-28y/T-VER-28y2: non-regular workflow package.json warns and execution continues", async () => {
      project = await createTempProject();
      const markerFile = join(project.dir, "nonregular-package-ran.marker");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        bashMarker(markerFile),
      );
      await mkdir(join(project.loopxDir, "ralph", "package.json"));

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerFile)).toBe(true);
      expect(result.stderr).toMatch(/package\.json|regular|directory|version/i);
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Install-time version checking (T-VER-12, 12a, 12b, 13, 13a, 13b, 13c, 15, 15a, 17, 22, 23a)
  // ═════════════════════════════════════════════════════════════

  describe("Install-time version checking", () => {
    const INDEX_SH = `#!/bin/bash\nprintf '{"result":"installed-ok"}'\n`;

    forEachRuntime((runtime) => {
      it("T-VER-12: install — dependencies wins over devDependencies (precedence)", async () => {
        // Case A: deps satisfied, devDeps unsatisfied → install succeeds
        {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "ralph",
              files: {
                "index.sh": INDEX_SH,
                "package.json": JSON.stringify({
                  dependencies: { loopx: satisfiedRange() },
                  devDependencies: { loopx: unsatisfiedRange() },
                }),
              },
            },
          ]);

          const result = await runCLI(
            ["install", "--no-install", `${gitServer.url}/ralph.git`],
            { cwd: project.dir, runtime },
          );

          expect(result.exitCode).toBe(0);
          expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);

          restorePerms(project.dir);
          await project.cleanup();
          project = null;
          await gitServer.close();
          gitServer = null;
        }

        // Case B: deps unsatisfied, devDeps satisfied → install fails
        {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "ralph",
              files: {
                "index.sh": INDEX_SH,
                "package.json": JSON.stringify({
                  dependencies: { loopx: unsatisfiedRange() },
                  devDependencies: { loopx: satisfiedRange() },
                }),
              },
            },
          ]);

          const result = await runCLI(
            ["install", "--no-install", `${gitServer.url}/ralph.git`],
            { cwd: project.dir, runtime },
          );

          expect(result.exitCode).toBe(1);
          expect(existsSync(join(project.loopxDir, "ralph"))).toBe(false);
        }
      });

      it("T-VER-12a: install — deps invalid-semver → warning, install succeeds (no fallback to devDeps)", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": INDEX_SH,
              "package.json": JSON.stringify({
                dependencies: { loopx: INVALID_SEMVER },
                devDependencies: { loopx: unsatisfiedRange() },
              }),
            },
          },
        ]);

        const result = await runCLI(["install", "--no-install", `${gitServer.url}/ralph.git`], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(true);
      });

      it("T-VER-12b/T-VER-12c: install — deps satisfied → devDeps fully ignored (no warning even if malformed)", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": INDEX_SH,
              "package.json": JSON.stringify({
                dependencies: { loopx: satisfiedRange() },
                devDependencies: { loopx: INVALID_SEMVER },
              }),
            },
          },
        ]);

        const result = await runCLI(["install", "--no-install", `${gitServer.url}/ralph.git`], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(false);
      });

      it("T-VER-13: install — optionalDependencies.loopx is ignored", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": INDEX_SH,
              "package.json": JSON.stringify({
                optionalDependencies: { loopx: unsatisfiedRange() },
              }),
            },
          },
        ]);

        const result = await runCLI(["install", "--no-install", `${gitServer.url}/ralph.git`], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
      });

      it("T-VER-13a: install — optionalDependencies.loopx with invalid semver is ignored", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": INDEX_SH,
              "package.json": JSON.stringify({
                optionalDependencies: { loopx: INVALID_SEMVER },
              }),
            },
          },
        ]);

        const result = await runCLI(["install", "--no-install", `${gitServer.url}/ralph.git`], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(hasInvalidSemverWarning(result.stderr, "ralph")).toBe(false);
        expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
      });

      it("T-VER-13b/T-VER-13b2/T-VER-13d: install — peerDependencies.loopx is ignored", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": INDEX_SH,
              "package.json": JSON.stringify({
                peerDependencies: { loopx: unsatisfiedRange() },
              }),
            },
          },
        ]);

        const result = await runCLI(["install", "--no-install", `${gitServer.url}/ralph.git`], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
      });

      it("T-VER-13c: install — optionalDependencies does not rescue unsatisfied dependencies; -y overrides", async () => {
        // Without -y
        {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "ralph",
              files: {
                "index.sh": INDEX_SH,
                "package.json": JSON.stringify({
                  dependencies: { loopx: unsatisfiedRange() },
                  optionalDependencies: { loopx: satisfiedRange() },
                }),
              },
            },
          ]);

          const result = await runCLI(
            ["install", `${gitServer.url}/ralph.git`],
            { cwd: project.dir, runtime },
          );

          expect(result.exitCode).toBe(1);
          expect(existsSync(join(project.loopxDir, "ralph"))).toBe(false);

          restorePerms(project.dir);
          await project.cleanup();
          project = null;
          await gitServer.close();
          gitServer = null;
        }

        // With -y
        {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "ralph",
              files: {
                "index.sh": INDEX_SH,
                "package.json": JSON.stringify({
                  dependencies: { loopx: unsatisfiedRange() },
                  optionalDependencies: { loopx: satisfiedRange() },
                }),
              },
            },
          ]);

          const result = await runCLI(
            ["install", "-y", "--no-install", `${gitServer.url}/ralph.git`],
            { cwd: project.dir, runtime },
          );

          expect(result.exitCode).toBe(0);
          expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        }
      });

      it("T-VER-15/T-VER-15b/T-VER-15c/T-VER-15d: install — devDependencies.loopx only (unsatisfied) → install refused", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": INDEX_SH,
              "package.json": JSON.stringify({
                devDependencies: { loopx: unsatisfiedRange() },
              }),
            },
          },
        ]);

        const result = await runCLI(["install", "--no-install", `${gitServer.url}/ralph.git`], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(false);
      });

      it("T-VER-15a: install — optionalDependencies does not rescue unsatisfied devDependencies; -y overrides", async () => {
        // Without -y
        {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "ralph",
              files: {
                "index.sh": INDEX_SH,
                "package.json": JSON.stringify({
                  devDependencies: { loopx: unsatisfiedRange() },
                  optionalDependencies: { loopx: satisfiedRange() },
                }),
              },
            },
          ]);

          const result = await runCLI(
            ["install", "--no-install", `${gitServer.url}/ralph.git`],
            { cwd: project.dir, runtime },
          );

          expect(result.exitCode).toBe(1);
          expect(existsSync(join(project.loopxDir, "ralph"))).toBe(false);

          restorePerms(project.dir);
          await project.cleanup();
          project = null;
          await gitServer.close();
          gitServer = null;
        }

        // With -y
        {
          project = await createTempProject();
          gitServer = await startLocalGitServer([
            {
              name: "ralph",
              files: {
                "index.sh": INDEX_SH,
                "package.json": JSON.stringify({
                  devDependencies: { loopx: unsatisfiedRange() },
                  optionalDependencies: { loopx: satisfiedRange() },
                }),
              },
            },
          ]);

          const result = await runCLI(
            ["install", "-y", "--no-install", `${gitServer.url}/ralph.git`],
            { cwd: project.dir, runtime },
          );

          expect(result.exitCode).toBe(0);
          expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        }
      });

      it("T-VER-17: install — valid package.json with no loopx declared → no version check, no warnings", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": INDEX_SH,
              "package.json": PACKAGE_JSON_NO_LOOPX,
            },
          },
        ]);

        const result = await runCLI(["install", "--no-install", `${gitServer.url}/ralph.git`], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
        expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
      });

      it("T-VER-22: install — workflow with no package.json installs without warnings", async () => {
        project = await createTempProject();
        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": INDEX_SH,
            },
          },
        ]);

        const result = await runCLI(["install", "--no-install", `${gitServer.url}/ralph.git`], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
        expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
      });

      it("T-VER-23a: pre-existing stray .loopx/package.json is ignored at install time and preserved", async () => {
        project = await createTempProject();
        const strayPath = join(project.loopxDir, "package.json");
        const strayContent = JSON.stringify(
          { dependencies: { loopx: unsatisfiedRange() } },
          null,
          2,
        );
        await (await import("node:fs/promises")).writeFile(
          strayPath,
          strayContent,
          "utf-8",
        );

        gitServer = await startLocalGitServer([
          {
            name: "ralph",
            files: {
              "index.sh": INDEX_SH,
            },
          },
        ]);

        const result = await runCLI(["install", "--no-install", `${gitServer.url}/ralph.git`], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(project.loopxDir, "ralph"))).toBe(true);
        // Stray preserved unchanged
        expect(existsSync(strayPath)).toBe(true);
        const preservedContent = await readFile(strayPath, "utf-8");
        expect(preservedContent).toBe(strayContent);
        expect(hasVersionMismatchWarning(result.stderr, "ralph")).toBe(false);
        expect(hasAnyPackageJsonWarning(result.stderr, "ralph")).toBe(false);
      });
    });
  });
});
