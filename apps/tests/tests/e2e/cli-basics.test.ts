import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { writeFile, mkdir, mkdtemp, chmod, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createTempProject,
  createWorkflow,
  createWorkflowScript,
  createBashWorkflowScript,
  createWorkflowPackageJson,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI, type CLIResult } from "../helpers/cli.js";
import { createEnvFile, writeEnvFileRaw } from "../helpers/env.js";
import {
  counter,
  writeEnvToFile,
  writeValueToFile,
} from "../helpers/fixture-scripts.js";
import { forEachRuntime } from "../helpers/runtime.js";

// ---------------------------------------------------------------------------
// TEST-SPEC §4.1 — CLI Basics (workflow model per ADR-0003)
// Spec refs: 4.1, 4.2, 4.3, 11.1, 11.2
// ---------------------------------------------------------------------------

function getExpectedVersion(): string {
  const pkgPath = resolve(process.cwd(), "node_modules/loopx/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version as string;
}

// Top-level help discriminator: stdout contains "loopx" + "usage" (case-insensitive).
function assertTopLevelHelp(result: CLIResult): void {
  expect(result.exitCode).toBe(0);
  const lower = result.stdout.toLowerCase();
  expect(lower).toContain("loopx");
  expect(lower).toContain("usage");
}

// Run-help discriminator: stdout mentions -n and -e options.
function assertRunHelp(result: CLIResult): void {
  expect(result.exitCode).toBe(0);
  const lower = result.stdout.toLowerCase();
  expect(lower).toMatch(/-n\b/);
  expect(lower).toMatch(/-e\b/);
}

describe("SPEC: CLI Basics (ADR-0003 workflow model, T-CLI-* §4.1)", () => {
  let project: TempProject | null = null;
  const extraCleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of extraCleanups.splice(0)) {
      await cleanup().catch(() => {});
    }
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  // ========================================================================
  // Help & Version (T-CLI-01, 01a, 01b)
  // ========================================================================
  describe("SPEC: Help & Version", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-01: `loopx version` prints the bare version + newline, exits 0, no .loopx/ required", async () => {
        project = await createTempProject({ withLoopxDir: false });
        const result = await runCLI(["version"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(0);
        const expectedVersion = getExpectedVersion();
        expect(result.stdout).toBe(`${expectedVersion}\n`);
      });

      it("T-CLI-01a: `loopx version extra` (extra positional after version) → usage error, exit 1", async () => {
        // SPEC §4.3 specifies `loopx version` as a no-argument subcommand;
        // SPEC §12's usage-error enumeration is non-exhaustive and the
        // consistent grammar pattern is that extra positionals to fixed-grammar
        // subcommands are usage errors. The version-print short-circuit must
        // not fire when the parser rejects the invocation.
        project = await createTempProject({ withLoopxDir: false });
        const result = await runCLI(["version", "extra"], {
          cwd: project.dir,
          runtime,
        });
        const expectedVersion = getExpectedVersion();

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        // (c) stdout does NOT contain the version string — the print
        // short-circuit must not fire when args are rejected. We assert the
        // exact version literal is absent from stdout.
        expect(result.stdout).not.toContain(expectedVersion);
      });

      it.each(["--help", "-h"])(
        "T-CLI-01b: `loopx version %s` → usage error, exit 1, no version, no version-scoped help block",
        async (helpFlag) => {
          // SPEC §11 defines exactly three help forms — top-level, run, install
          // — with no "Version Help" section. SPEC §4.3 does not document a
          // help form for `version`. The deliberate omission combined with
          // SPEC §12's non-exhaustive usage-error enumeration makes the
          // consistent reading "extra arguments to a no-argument subcommand
          // are usage errors", which subsumes `--help` / `-h` as unrecognized
          // arguments at the version-subcommand parser level.
          project = await createTempProject({ withLoopxDir: false });
          const result = await runCLI(["version", helpFlag], {
            cwd: project.dir,
            runtime,
          });
          const expectedVersion = getExpectedVersion();

          // (i) exit code 1
          expect(result.exitCode).toBe(1);
          // (ii) stderr surfaces a usage / unrecognized-argument error
          expect(result.stderr.length).toBeGreaterThan(0);
          // (iii) stdout does NOT contain the version string
          expect(result.stdout).not.toContain(expectedVersion);
          // (iv) stdout does NOT contain a version-scoped help block — no
          //      "Usage: loopx version ..." synopsis text, since the version
          //      subcommand has no help form per SPEC §11.
          expect(result.stdout).not.toMatch(/usage:\s*loopx\s+version/i);
        },
      );
    });
  });

  // ========================================================================
  // Top-Level Help (T-CLI-02–06, 07e/f/g/j, 39, 61, 90, 91)
  // ========================================================================
  describe("SPEC: Top-Level Help", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-02: `loopx -h` prints usage with subcommands, no -n/-e at top level, no flat-script grammar", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h"], { cwd: project.dir, runtime });

        assertTopLevelHelp(result);
        // Lists available subcommands
        expect(result.stdout).toMatch(/\brun\b/);
        expect(result.stdout).toMatch(/\bversion\b/);
        expect(result.stdout).toMatch(/\boutput\b/);
        expect(result.stdout).toMatch(/\benv\b/);
        expect(result.stdout).toMatch(/\binstall\b/);
        // Subcommand-based grammar — not the legacy flat-script form
        const lower = result.stdout.toLowerCase();
        expect(lower).not.toMatch(/loopx\s+\[options\]\s+\[script-name\]/);
        expect(lower).not.toMatch(/loopx\s+\[script-name\]/);
        // -n / -e are not advertised as top-level option entries
        const optionsBlock = result.stdout.split(/\n\s*\n/).filter((b) =>
          /options/i.test(b),
        );
        for (const block of optionsBlock) {
          expect(block).not.toMatch(/^\s*-n\b/m);
          expect(block).not.toMatch(/^\s*-e\b/m);
        }
      });

      it("T-CLI-03: `loopx --help` byte-identical to `loopx -h` even with workflows + collision present", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(project, "ralph", "check", "printf 'a'");
        await createWorkflowScript(project, "ralph", "check", ".ts", "console.log('b');\n");
        await createWorkflow(project, "-bad-workflow");

        const [shortRes, longRes] = await Promise.all([
          runCLI(["-h"], { cwd: project.dir, runtime }),
          runCLI(["--help"], { cwd: project.dir, runtime }),
        ]);

        expect(shortRes.exitCode).toBe(0);
        expect(longRes.exitCode).toBe(0);
        expect(longRes.stdout).toBe(shortRes.stdout);
        expect(longRes.stderr).toBe(shortRes.stderr);
        expect(shortRes.stderr).toBe("");
      });

      it("T-CLI-04: `loopx -h` with workflows does NOT list workflow or script names", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "alpha", "index", "printf '{\"stop\":true}'");
        await createWorkflowScript(
          project,
          "beta",
          "index",
          ".ts",
          'import { output } from "loopx";\noutput({ stop: true });\n',
        );
        await createBashWorkflowScript(project, "alpha", "check-ready", "printf 'x'");

        const result = await runCLI(["-h"], { cwd: project.dir, runtime });

        assertTopLevelHelp(result);
        expect(result.stdout).not.toMatch(/\balpha\b/);
        expect(result.stdout).not.toMatch(/\bbeta\b/);
        expect(result.stdout).not.toMatch(/\bcheck-ready\b/);
      });

      it("T-CLI-05: `loopx -h` without `.loopx/` still prints help, no error, no warnings", async () => {
        project = await createTempProject({ withLoopxDir: false });
        const result = await runCLI(["-h"], { cwd: project.dir, runtime });

        assertTopLevelHelp(result);
        expect(result.stderr).toBe("");
      });

      it("T-CLI-06: `loopx -h` with name collisions does NOT print warnings on stderr", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "dupe", "printf 'a'");
        await createWorkflowScript(project, "ralph", "dupe", ".ts", "console.log('b');\n");

        const result = await runCLI(["-h"], { cwd: project.dir, runtime });

        assertTopLevelHelp(result);
        expect(result.stderr).toBe("");
      });

      it("T-CLI-07e: `loopx -h version` prints top-level help (precedence over subcommand)", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h", "version"], { cwd: project.dir, runtime });
        assertTopLevelHelp(result);
        // The version subcommand did not execute — stdout is help, not the bare version string.
        expect(result.stdout).not.toMatch(/^[0-9]+\.[0-9]+\.[0-9]+\s*$/);
      });

      it("T-CLI-07f: `loopx -h env set FOO bar` prints top-level help (precedence over env subcommand)", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h", "env", "set", "FOO", "bar"], {
          cwd: project.dir,
          runtime,
        });
        assertTopLevelHelp(result);
      });

      it("T-CLI-07g: `loopx -h --invalid-flag` prints top-level help (precedence over invalid flag)", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h", "--invalid-flag"], { cwd: project.dir, runtime });
        assertTopLevelHelp(result);
      });

      it("T-CLI-07j: `loopx -h -e nonexistent.env` prints top-level help (precedence over -e)", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h", "-e", "nonexistent.env"], {
          cwd: project.dir,
          runtime,
        });
        assertTopLevelHelp(result);
      });

      it("T-CLI-39: `loopx -h run foo` shows top-level help (not run help)", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h", "run", "foo"], { cwd: project.dir, runtime });
        assertTopLevelHelp(result);
        // Top-level help does not include the run-help-only -n/-e listings as primary options.
        // Compare with loopx run -h to make sure it is NOT the run help.
        const runHelp = await runCLI(["run", "-h"], { cwd: project.dir, runtime });
        expect(result.stdout).not.toBe(runHelp.stdout);
      });

      it("T-CLI-61: `loopx --help run foo` shows top-level help (not run help)", async () => {
        project = await createTempProject();
        const result = await runCLI(["--help", "run", "foo"], {
          cwd: project.dir,
          runtime,
        });
        assertTopLevelHelp(result);
      });

      it("T-CLI-90: `loopx --help --invalid-flag` prints top-level help", async () => {
        project = await createTempProject();
        const result = await runCLI(["--help", "--invalid-flag"], {
          cwd: project.dir,
          runtime,
        });
        assertTopLevelHelp(result);
      });

      it("T-CLI-91: `loopx --help -e nonexistent.env` prints top-level help", async () => {
        project = await createTempProject();
        const result = await runCLI(["--help", "-e", "nonexistent.env"], {
          cwd: project.dir,
          runtime,
        });
        assertTopLevelHelp(result);
      });
    });
  });

  // ========================================================================
  // Run Help (T-CLI-40, 40a, 41, 42, 43, 43a, 44, 101, 101a, 102,
  //          104, 104a–104e, 105, 106, 62, 120, 120a, 120b, 121, 122)
  // ========================================================================
  describe("SPEC: Run Help", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-40: `loopx run -h` lists workflows + scripts + -n/-e + index marker", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(project, "ralph", "check-ready", "printf 'x'");
        await createBashWorkflowScript(project, "tools", "deploy", "printf 'y'");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        assertRunHelp(result);
        // Workflows listed
        expect(result.stdout).toMatch(/\bralph\b/);
        expect(result.stdout).toMatch(/\btools\b/);
        // Scripts listed
        expect(result.stdout).toMatch(/\bcheck-ready\b/);
        expect(result.stdout).toMatch(/\bdeploy\b/);
        expect(result.stdout).toMatch(/\bindex\b/);
      });

      it("T-CLI-40a: run help advertises workflow-based grammar, not the legacy flat-script form", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(0);
        // Positive: the run help mentions a workflow target form.
        expect(result.stdout).toMatch(/<workflow>|workflow:script/i);
        // Negative: must NOT advertise the legacy bare-<script> top-level positional grammar.
        expect(result.stdout).not.toMatch(/run\s+\[options?\]\s+<script[-_]?name>/);
        expect(result.stdout).not.toMatch(/run\s+\[options?\]\s+<script>(?!\b\s*[:>])/);
      });

      it("T-CLI-40b: run help usage grammar reflects SPEC 11.2 / 12 limits (no `--`, no name=value tail)", async () => {
        // SPEC 11.2: "The printed usage reflects these limits." Parser-level
        // rejection of `--` and `name=value` is covered by
        // T-CLI-RUN-DASHDASH-01..05 / T-CLI-RUN-NAMEVAL-01..03; this test
        // covers the help-text reflection of those limits. Scope assertions
        // to the contiguous Usage / Synopsis block to distinguish synopsis
        // grammar from explanatory prose (SPEC 11.2's shell-env-prefix
        // example `key=value loopx run <target>` legitimately appears in
        // example/prose blocks but must not appear in the synopsis grammar).
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(0);

        // Extract the usage / synopsis block(s): the contiguous lines from
        // the first "Usage:" line up until the first blank line or
        // structured section header (Options:/Examples:/Available...).
        const lines = result.stdout.split("\n");
        const usageStart = lines.findIndex((line) => /^\s*usage:/i.test(line));
        expect(usageStart).toBeGreaterThanOrEqual(0);
        const usageBlockLines: string[] = [];
        for (let i = usageStart; i < lines.length; i++) {
          const line = lines[i];
          if (i > usageStart) {
            // Stop at blank line or section header (indented Options/Examples/etc.)
            if (line.trim() === "") break;
            if (/^\s*(options|examples|available|commands|sources|arguments)\s*:/i.test(line)) break;
          }
          usageBlockLines.push(line);
        }
        const usageBlock = usageBlockLines.join("\n");

        // (a) Usage line does NOT contain `[--]` / `[-- ...]` / a trailing
        //     `--` placeholder.
        expect(usageBlock).not.toMatch(/\[\s*--\s*(\.{3}|\]|\s)/);
        expect(usageBlock).not.toMatch(/\[\s*--\s*[^\]]*\]/);

        // (b) Usage line does NOT show a `name=value` named-argument tail —
        //     no `[name=value...]`, `[<var>=<value>...]`, `[KEY=VALUE...]`,
        //     etc., appearing AFTER the target argument or after `--`.
        expect(usageBlock).not.toMatch(/\[[^\]]*=\s*[^\]]*\.{3}\]/);
        expect(usageBlock).not.toMatch(/\[\s*name\s*=\s*value/i);
        expect(usageBlock).not.toMatch(/\[\s*<\s*var\s*>\s*=\s*<\s*value/i);
        expect(usageBlock).not.toMatch(/\[\s*KEY\s*=\s*VALUE/);
      });

      it("T-CLI-41: `loopx run --help` byte-identical to `loopx run -h` (including non-fatal warnings)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(project, "ralph", "check", "printf 'a'");
        await createWorkflowScript(project, "ralph", "check", ".ts", "console.log('b');\n");

        const [shortRes, longRes] = await Promise.all([
          runCLI(["run", "-h"], { cwd: project.dir, runtime }),
          runCLI(["run", "--help"], { cwd: project.dir, runtime }),
        ]);

        expect(shortRes.exitCode).toBe(0);
        expect(longRes.exitCode).toBe(0);
        expect(longRes.stdout).toBe(shortRes.stdout);
        expect(longRes.stderr).toBe(shortRes.stderr);
      });

      it("T-CLI-42: `loopx run -h` without `.loopx/` prints run help with warning, no scripts section", async () => {
        project = await createTempProject({ withLoopxDir: false });

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        assertRunHelp(result);
        const combined = (result.stdout + "\n" + result.stderr).toLowerCase();
        expect(combined).toMatch(/\.loopx|not found|no\s+workflows|directory|missing/);
      });

      it("T-CLI-43: `loopx run -h` with name collisions prints warnings on stderr", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "dupe", "printf 'a'");
        await createWorkflowScript(project, "ralph", "dupe", ".ts", "console.log('b');\n");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(0);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stderr).toMatch(/dupe/);
      });

      it("T-CLI-43a: `loopx run -h` with `index` collision warns just like other collisions", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf 'a'");
        await createWorkflowScript(project, "ralph", "index", ".ts", "console.log('b');\n");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(0);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stderr).toMatch(/index/);
      });

      it("T-CLI-44: `loopx run -h` with invalid script name warns + lists offender", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(project, "ralph", "-startswithdash", "printf 'x'");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/-startswithdash/);
        expect(result.stdout).toMatch(/-startswithdash/);
      });

      it("T-CLI-101: `run -h` marks index as default entry point for workflows that have it", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(project, "ralph", "check", "printf 'x'");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        assertRunHelp(result);
        expect(result.stdout).toMatch(/\bralph\b/);
        expect(result.stdout).toMatch(/\bindex\b/);
        // The "default" or "entry" annotation appears near the index entry.
        expect(result.stdout).toMatch(/index[\s\S]*?(default|entry)/i);
      });

      it("T-CLI-101a: `run -h` lists workflow w/o index but does not mark a default entry point", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "tools", "check", "printf 'x'");
        await createBashWorkflowScript(project, "tools", "deploy", "printf 'y'");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        assertRunHelp(result);
        expect(result.stdout).toMatch(/\btools\b/);
        expect(result.stdout).toMatch(/\bcheck\b/);
        expect(result.stdout).toMatch(/\bdeploy\b/);
        // No script in `tools` is marked default (no `index` exists).
        const toolsSection = result.stdout
          .split(/\n(?=\S)/)
          .filter((b) => /\btools\b/.test(b))
          .join("\n");
        expect(toolsSection).not.toMatch(/default|entry/i);
      });

      it("T-CLI-102: `run -h` with invalid script names — workflow still listed, non-fatal warnings", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(project, "ralph", "-bad", "printf 'x'");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/\bralph\b/);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stderr).toMatch(/-bad/);
      });

      it("T-CLI-104: `run -h` ignores loose files placed directly in `.loopx/`", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        // Loose file directly in .loopx/
        await writeFile(
          join(project.loopxDir, "loose-script.sh"),
          "#!/bin/bash\nprintf 'x'\n",
          "utf-8",
        );
        await chmod(join(project.loopxDir, "loose-script.sh"), 0o755);

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        assertRunHelp(result);
        expect(result.stdout).toMatch(/\bralph\b/);
        expect(result.stdout).not.toMatch(/loose-script/);
        expect(result.stderr).not.toMatch(/loose-script/);
      });

      it("T-CLI-104a: `run -h` ignores empty subdirectories of `.loopx/`", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await mkdir(join(project.loopxDir, "empty"), { recursive: true });

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        assertRunHelp(result);
        expect(result.stdout).toMatch(/\bralph\b/);
        expect(result.stdout).not.toMatch(/\bempty\b/);
        expect(result.stderr).not.toMatch(/\bempty\b/);
      });

      it("T-CLI-104b: `run -h` ignores subdirs with only non-script files", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const metaDir = join(project.loopxDir, "meta");
        await mkdir(metaDir, { recursive: true });
        await writeFile(join(metaDir, "config.json"), "{}\n", "utf-8");
        await writeFile(join(metaDir, "notes.md"), "# notes\n", "utf-8");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        assertRunHelp(result);
        expect(result.stdout).toMatch(/\bralph\b/);
        expect(result.stdout).not.toMatch(/\bmeta\b/);
        expect(result.stderr).not.toMatch(/\bmeta\b/);
      });

      it("T-CLI-104c: `run -h` does not treat package.json + nested src/ as a workflow (no top-level script)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const mp = join(project.loopxDir, "mypipeline");
        await mkdir(join(mp, "src"), { recursive: true });
        await writeFile(join(mp, "package.json"), JSON.stringify({ main: "src/run.js" }), "utf-8");
        await writeFile(join(mp, "src", "run.js"), "console.log('hi');\n", "utf-8");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        assertRunHelp(result);
        expect(result.stdout).toMatch(/\bralph\b/);
        expect(result.stdout).not.toMatch(/\bmypipeline\b/);
        expect(result.stderr).not.toMatch(/\bmypipeline\b/);
      });

      it("T-CLI-104d: `run -h` does not warn about files in nested subdirectories of a workflow", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const lib = join(project.loopxDir, "ralph", "lib");
        await mkdir(lib, { recursive: true });
        await writeFile(join(lib, "-bad.ts"), "console.log('bad');\n", "utf-8");
        await writeFile(join(lib, "check.sh"), "#!/bin/bash\nprintf 'a'\n", "utf-8");
        await chmod(join(lib, "check.sh"), 0o755);
        await writeFile(join(lib, "check.ts"), "console.log('b');\n", "utf-8");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        assertRunHelp(result);
        expect(result.stdout).toMatch(/\bralph\b/);
        expect(result.stderr).not.toMatch(/-bad/);
        expect(result.stderr).not.toMatch(/collision|conflict|duplicate/i);
      });

      it("T-CLI-104e: `run -h` does not list nested files in the workflow's script listing", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const lib = join(project.loopxDir, "ralph", "lib");
        await mkdir(lib, { recursive: true });
        await writeFile(join(lib, "helpers.ts"), "console.log('h');\n", "utf-8");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        assertRunHelp(result);
        expect(result.stdout).toMatch(/\bralph\b/);
        expect(result.stdout).toMatch(/\bindex\b/);
        expect(result.stdout).not.toMatch(/\bhelpers\b/);
      });

      it("T-CLI-105: `loopx run ralph -h` is identical to `loopx run -h` (target ignored under help)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");

        const [base, withTarget] = await Promise.all([
          runCLI(["run", "-h"], { cwd: project.dir, runtime }),
          runCLI(["run", "ralph", "-h"], { cwd: project.dir, runtime }),
        ]);

        expect(withTarget.exitCode).toBe(0);
        expect(withTarget.stdout).toBe(base.stdout);
        expect(withTarget.stderr).toBe(base.stderr);
      });

      it("T-CLI-106: `loopx run ralph:index -h` is identical to `loopx run -h` (qualified target ignored)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");

        const [base, withTarget] = await Promise.all([
          runCLI(["run", "-h"], { cwd: project.dir, runtime }),
          runCLI(["run", "ralph:index", "-h"], { cwd: project.dir, runtime }),
        ]);

        expect(withTarget.exitCode).toBe(0);
        expect(withTarget.stdout).toBe(base.stdout);
        expect(withTarget.stderr).toBe(base.stderr);
      });

      it("T-CLI-62: `loopx run myscript --help` shows run help (long form after target)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "myscript", "index", "printf '{\"stop\":true}'");

        const result = await runCLI(["run", "myscript", "--help"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-120: `run -h` with invalid workflow name warns + lists offender", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(project, "-bad-workflow", "index", "printf 'x'");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/-bad-workflow/);
        expect(result.stdout).toMatch(/-bad-workflow/);
      });

      it("T-CLI-120a: `run -h` with workflow name containing `:` warns + lists offender", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(project, "foo:bar", "index", "printf 'x'");

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/foo:bar/);
        expect(result.stdout).toMatch(/foo:bar/);
      });

      it("T-CLI-120b: `run -h` with script name containing `:` warns + lists offender", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        // Create the colon-named script directly because helpers do not validate names but
        // file creation through them works fine here too.
        const colonScript = join(project.loopxDir, "ralph", "check:ready.sh");
        await writeFile(colonScript, "#!/bin/bash\nprintf 'x'\n", "utf-8");
        await chmod(colonScript, 0o755);

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/check:ready/);
        expect(result.stdout).toMatch(/check:ready/);
      });

      it("T-CLI-121: `run -h` lists symlinked workflow under the symlink's own name", async () => {
        project = await createTempProject();
        const realDir = await mkdtemp(join(tmpdir(), "loopx-real-workflow-"));
        extraCleanups.push(() => rm(realDir, { recursive: true, force: true }));
        const realScript = join(realDir, "index.sh");
        await writeFile(realScript, "#!/bin/bash\nprintf '{\"stop\":true}'\n", "utf-8");
        await chmod(realScript, 0o755);
        symlinkSync(realDir, join(project.loopxDir, "my-alias"));

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        assertRunHelp(result);
        expect(result.stdout).toMatch(/\bmy-alias\b/);
        // The target directory's basename (e.g., "loopx-real-workflow-XXXX") must not appear.
        const targetBase = realDir.split("/").pop()!;
        expect(result.stdout).not.toContain(targetBase);
      });

      it("T-CLI-122: `run -h` lists symlinked script under the symlink's own basename", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const realDir = await mkdtemp(join(tmpdir(), "loopx-real-script-"));
        extraCleanups.push(() => rm(realDir, { recursive: true, force: true }));
        const realScript = join(realDir, "original-check.sh");
        await writeFile(realScript, "#!/bin/bash\nprintf '{\"stop\":true}'\n", "utf-8");
        await chmod(realScript, 0o755);
        symlinkSync(realScript, join(project.loopxDir, "ralph", "my-check.sh"));

        const result = await runCLI(["run", "-h"], { cwd: project.dir, runtime });

        assertRunHelp(result);
        expect(result.stdout).toMatch(/\bmy-check\b/);
        expect(result.stdout).not.toMatch(/\boriginal-check\b/);
      });
    });
  });

  // ========================================================================
  // Run Help Short-Circuit (T-CLI-48–54, 63, 67–70, 92–95)
  // ========================================================================
  describe("SPEC: Run Help Short-Circuit", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-48: `loopx run -h foo` shows run help (target ignored)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "foo"], { cwd: project.dir, runtime });
        assertRunHelp(result);
      });

      it("T-CLI-49: `loopx run ralph -h` matches canonical run help byte-for-byte", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");

        const [canonical, withTarget] = await Promise.all([
          runCLI(["run", "-h"], { cwd: project.dir, runtime }),
          runCLI(["run", "ralph", "-h"], { cwd: project.dir, runtime }),
        ]);

        expect(withTarget.exitCode).toBe(0);
        expect(withTarget.stdout).toBe(canonical.stdout);
        expect(withTarget.stderr).toBe(canonical.stderr);
      });

      it("T-CLI-50: `loopx run -h -e missing.env` shows run help (env not validated)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "-e", "missing.env"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-51: `loopx run -h -n bad` shows run help (-n not validated)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "-n", "bad"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-52: `loopx run -h -n 5 -n 10` shows run help (duplicates not rejected)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "-n", "5", "-n", "10"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-53: `loopx run -h foo bar` shows run help (extra positional ignored)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "foo", "bar"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-54: `loopx run -h --unknown` shows run help (unknown flag ignored)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "--unknown"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-63: `loopx run -h -e a.env -e b.env` shows run help (duplicate -e ignored)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "-e", "a.env", "-e", "b.env"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-67: `loopx run ralph -h --unknown` shows run help", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "ralph", "-h", "--unknown"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-68: `loopx run ralph -h -e missing.env` shows run help", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "ralph", "-h", "-e", "missing.env"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-69: `loopx run --help --unknown` shows run help (long form, unknown ignored)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "--help", "--unknown"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-70: `loopx run ralph --help -e missing.env` shows run help", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "ralph", "--help", "-e", "missing.env"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-70a: `loopx run --help ralph adr=0003` shows run help (long-form suppresses extra-positional / name=value)", async () => {
        // Long-form counterpart to T-CLI-RUN-DASHDASH-05 / T-CLI-RUN-NAMEVAL-*:
        // verifies that `--help` after the `run` subcommand suppresses
        // extra-positional and `name=value` tail rejection identically to
        // `-h`.
        project = await createTempProject();
        const result = await runCLI(["run", "--help", "ralph", "adr=0003"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-92: `loopx run -h -n` shows run help (missing -n operand ignored)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "-n"], { cwd: project.dir, runtime });
        assertRunHelp(result);
      });

      it("T-CLI-93: `loopx run -h -e` shows run help (missing -e operand ignored)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "-e"], { cwd: project.dir, runtime });
        assertRunHelp(result);
      });

      it("T-CLI-94: `loopx run --help -n` shows run help (long form, missing -n operand ignored)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "--help", "-n"], { cwd: project.dir, runtime });
        assertRunHelp(result);
      });

      it("T-CLI-95: `loopx run --help -e` shows run help (long form, missing -e operand ignored)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "--help", "-e"], { cwd: project.dir, runtime });
        assertRunHelp(result);
      });

      // Would-be-operand variants: a naive parser would consume `-h` /
      // `--help` as the operand of `-n` / `-e`, but the help short-circuit
      // fires unconditionally. Mirrors install-side T-INST-49f. Together with
      // T-CLI-92..95 (operand missing → -h after) and T-CLI-68 (target then
      // help-first) these close the run-help-after-target × would-be-operand
      // coverage.

      it("T-CLI-123: `loopx run -n -h` shows run help (would-be -n operand)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-n", "-h"], { cwd: project.dir, runtime });
        assertRunHelp(result);
      });

      it("T-CLI-123a: `loopx run ralph -n -h` shows run help (target-position would-be -n operand)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "ralph", "-n", "-h"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-124: `loopx run -e -h` shows run help (would-be -e operand)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-e", "-h"], { cwd: project.dir, runtime });
        assertRunHelp(result);
      });

      it("T-CLI-124a: `loopx run ralph -e -h` shows run help (target-position would-be -e operand)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "ralph", "-e", "-h"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-125: `loopx run -n --help` shows run help (long-form would-be -n operand)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-n", "--help"], { cwd: project.dir, runtime });
        assertRunHelp(result);
      });

      it("T-CLI-126: `loopx run -e --help` shows run help (long-form would-be -e operand)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-e", "--help"], { cwd: project.dir, runtime });
        assertRunHelp(result);
      });
    });
  });

  // ========================================================================
  // Late-Help Short-Circuit (Invalid Args Before -h: T-CLI-73–78, 78a–78d, 84)
  // ========================================================================
  describe("SPEC: Late-Help Short-Circuit", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-73: `loopx run --unknown -h` shows run help (-h after invalid still wins)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "--unknown", "-h"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-74: `loopx run -e missing.env -h` shows run help", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-e", "missing.env", "-h"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-75: `loopx run -n 5 -n 10 -h` shows run help", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-n", "5", "-n", "10", "-h"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-76: `loopx run foo bar -h` shows run help (extra positional + late -h)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "foo", "bar", "-h"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-77: `loopx run -n bad -h` shows run help (bad -n + late -h)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-n", "bad", "-h"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-78: `loopx run --unknown --help` shows run help", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "--unknown", "--help"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-78a: `loopx run \":script\" -h` shows run help (malformed leading-colon target ignored)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", ":script", "-h"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-78b: `loopx run \"a:b:c\" --help` shows run help (multiple-colons target ignored)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "a:b:c", "--help"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-78c: `loopx run \"bad.name\" -h` shows run help (name-pattern violation ignored)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "bad.name", "-h"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-78d: `loopx run \"ralph:-bad\" --help` shows run help (script-portion violation ignored)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "ralph:-bad", "--help"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });

      it("T-CLI-84: `loopx run -e a.env -e b.env -h` shows run help", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-e", "a.env", "-e", "b.env", "-h"], {
          cwd: project.dir,
          runtime,
        });
        assertRunHelp(result);
      });
    });
  });

  // ========================================================================
  // Bare Invocation & Top-Level Parsing Errors
  // (T-CLI-28, 33, 34, 71, 36, 37, 07b, 07c, 38, 79)
  // ========================================================================
  describe("SPEC: Bare Invocation & Top-Level Parsing Errors", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-28: bare `loopx` shows top-level help (no discovery, no warnings)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "dupe", "printf 'a'");
        await createWorkflowScript(project, "ralph", "dupe", ".ts", "console.log('b');\n");

        const [bare, hLong] = await Promise.all([
          runCLI([], { cwd: project.dir, runtime }),
          runCLI(["-h"], { cwd: project.dir, runtime }),
        ]);

        assertTopLevelHelp(bare);
        expect(bare.stdout).toBe(hLong.stdout);
        expect(bare.stdout).not.toMatch(/\bralph\b/);
        expect(bare.stderr).toBe("");
      });

      it("T-CLI-33: `loopx ralph` is a usage error (no implicit fallback to `run`)", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-33.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          writeValueToFile("ran", marker).slice(12),
        );

        const result = await runCLI(["ralph"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(1);
        expect(existsSync(marker)).toBe(false);
      });

      it("T-CLI-34: `loopx --unknown` is a usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(["--unknown"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-71: `loopx -x` is a usage error (unknown short flag)", async () => {
        project = await createTempProject();
        const result = await runCLI(["-x"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-71a: `loopx --unknown -h` is a usage error (top-level parsing fails before -h)", async () => {
        // The first argument is an unrecognized top-level flag, so the
        // top-level help short-circuit does not apply.
        project = await createTempProject();
        const result = await runCLI(["--unknown", "-h"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-71b: `loopx --unknown --help` is a usage error (top-level parsing fails before --help)", async () => {
        // The first argument is an unrecognized top-level flag, so the
        // top-level help short-circuit does not apply.
        project = await createTempProject();
        const result = await runCLI(["--unknown", "--help"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-36: `loopx -n 5 ralph` is a usage error (-n not top-level)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["-n", "5", "ralph"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-37: `loopx -e .env ralph` is a usage error (-e not top-level)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const envPath = join(project.dir, ".env");
        await createEnvFile(envPath, { FOO: "bar" });
        const result = await runCLI(["-e", ".env", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-07b: `loopx -n 5 -h` is a usage error (top-level parsing fails before -h)", async () => {
        project = await createTempProject();
        const result = await runCLI(["-n", "5", "-h"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-07c: `loopx ralph -h` is a usage error (ralph is unrecognized subcommand)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["ralph", "-h"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-38: `loopx foo -h` is a usage error (foo is unrecognized subcommand)", async () => {
        project = await createTempProject();
        const result = await runCLI(["foo", "-h"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-79: `loopx foo --help` is a usage error", async () => {
        project = await createTempProject();
        const result = await runCLI(["foo", "--help"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
      });
    });
  });

  // ========================================================================
  // Target Invocation via `run`
  // (T-CLI-30, 11, 107, 108, 109, 109a, 110, 12, 111, 111a, 13, 29, 64, 65,
  //  59, 60, 85, 31, 32, 66, 80, 81)
  // ========================================================================
  describe("SPEC: Target Invocation via run", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-30: `loopx run -n 1 ralph` runs index script (marker)", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-30.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          writeValueToFile("ran-30", marker).slice(12),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(marker, "utf-8")).toBe("ran-30");
      });

      it("T-CLI-11: `loopx run ralph` (no flags) runs index w/ stop:true, exit 0", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-11.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'ran-11' > "${marker}"\nprintf '{"stop":true}'`,
        );

        const result = await runCLI(["run", "ralph"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(marker, "utf-8")).toBe("ran-11");
      });

      it("T-CLI-107: `loopx run ralph:check-ready` runs the named script (marker)", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-107.txt");
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(
          project,
          "ralph",
          "check-ready",
          `printf 'cr' > "${marker}"\nprintf '{"stop":true}'`,
        );

        const result = await runCLI(["run", "ralph:check-ready"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(marker, "utf-8")).toBe("cr");
      });

      it("T-CLI-108: `loopx run ralph:index` ≡ `loopx run ralph` (same script runs)", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-108.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' "I" >> "${marker}"\nprintf '{"stop":true}'`,
        );

        const a = await runCLI(["run", "ralph"], { cwd: project.dir, runtime });
        const b = await runCLI(["run", "ralph:index"], { cwd: project.dir, runtime });

        expect(a.exitCode).toBe(0);
        expect(b.exitCode).toBe(0);
        expect(readFileSync(marker, "utf-8")).toBe("II");
      });

      it("T-CLI-109: `loopx run ralph` w/o index script → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "check", "printf 'x'");

        const result = await runCLI(["run", "ralph"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-109a: `loopx run ralph:index` w/o index script → exit 1 (explicit)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "check", "printf 'x'");

        const result = await runCLI(["run", "ralph:index"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-110: `loopx run ralph:check` w/o index → succeeds", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-110.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "check",
          `printf 'ok' > "${marker}"\nprintf '{"stop":true}'`,
        );

        const result = await runCLI(["run", "ralph:check"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(marker, "utf-8")).toBe("ok");
      });

      it("T-CLI-12: `loopx run nonexistent` → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");

        const result = await runCLI(["run", "nonexistent"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-111: `loopx run ralph:nonexistent` → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");

        const result = await runCLI(["run", "ralph:nonexistent"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-111a: bare `loopx run check-ready` does not resolve to ralph:check-ready", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-111a.txt");
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(
          project,
          "ralph",
          "check-ready",
          `printf 'cr' > "${marker}"\nprintf '{"stop":true}'`,
        );

        const result = await runCLI(["run", "check-ready"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(existsSync(marker)).toBe(false);
      });

      it("T-CLI-13: `loopx run -n 1 default` runs the index script in workflow named `default`", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-13.txt");
        await createBashWorkflowScript(
          project,
          "default",
          "index",
          writeValueToFile("ran-13", marker).slice(12),
        );

        const result = await runCLI(["run", "-n", "1", "default"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(marker, "utf-8")).toBe("ran-13");
      });

      it("T-CLI-29: `loopx run` with no target is a usage error (no discovery)", async () => {
        project = await createTempProject();
        const result = await runCLI(["run"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-64: `loopx run` with `.loopx/default/index.sh` present still exits 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "default", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-65: bare `loopx` with `.loopx/default/index.sh` shows top-level help", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "default", "index", "printf '{\"stop\":true}'");
        const result = await runCLI([], { cwd: project.dir, runtime });
        assertTopLevelHelp(result);
      });

      it("T-CLI-59: `loopx run -n 5` (options but no target) → exit 1, no discovery warnings", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "dupe", "printf 'a'");
        await createWorkflowScript(project, "ralph", "dupe", ".ts", "console.log('b');\n");

        const result = await runCLI(["run", "-n", "5"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).not.toMatch(/dupe|collision|conflict|duplicate/i);
      });

      it("T-CLI-60: `loopx run` with collision → exit 1, no discovery warnings", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "dupe", "printf 'a'");
        await createWorkflowScript(project, "ralph", "dupe", ".ts", "console.log('b');\n");

        const result = await runCLI(["run"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).not.toMatch(/dupe|collision|conflict|duplicate/i);
      });

      it("T-CLI-85: `loopx run -e missing.env` (no target) → exit 1, no env warnings", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-e", "missing.env"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).not.toMatch(/missing\.env/);
      });

      it("T-CLI-31: `loopx run -n 1 version` runs workflow named version (not subcommand)", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-31.txt");
        await createBashWorkflowScript(
          project,
          "version",
          "index",
          writeValueToFile("ran-31", marker).slice(12),
        );

        const result = await runCLI(["run", "-n", "1", "version"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(marker, "utf-8")).toBe("ran-31");
        // CLI stdout is empty — proves the version subcommand did NOT dispatch.
        expect(result.stdout).toBe("");
      });

      it("T-CLI-32: `loopx run -n 1 run` runs workflow named `run`", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-32.txt");
        await createBashWorkflowScript(
          project,
          "run",
          "index",
          writeValueToFile("ran-32", marker).slice(12),
        );

        const result = await runCLI(["run", "-n", "1", "run"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(marker, "utf-8")).toBe("ran-32");
      });

      it("T-CLI-66: `loopx version` with `.loopx/version/index.sh` still prints CLI version", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-66.txt");
        await createBashWorkflowScript(
          project,
          "version",
          "index",
          writeValueToFile("workflow-ran", marker).slice(12),
        );

        const result = await runCLI(["version"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(`${getExpectedVersion()}\n`);
        expect(existsSync(marker)).toBe(false);
      });

      it("T-CLI-80: `loopx output --result \"x\"` runs built-in (not `.loopx/output/index.sh`)", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-80.txt");
        await createBashWorkflowScript(
          project,
          "output",
          "index",
          writeValueToFile("workflow-ran", marker).slice(12),
        );

        const result = await runCLI(["output", "--result", "x"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.result).toBe("x");
        expect(existsSync(marker)).toBe(false);
      });

      it("T-CLI-81: `loopx env list` runs built-in (not `.loopx/env/index.ts`)", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-81.txt");
        await createWorkflowScript(
          project,
          "env",
          "index",
          ".ts",
          `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "workflow-ran");\n`,
        );

        const result = await runCLI(["env", "list"], { cwd: project.dir, runtime });

        expect(result.exitCode).toBe(0);
        expect(existsSync(marker)).toBe(false);
      });
    });
  });

  // ========================================================================
  // Target Validation
  // (T-CLI-112–118, 118a, 114a, 118b)
  // ========================================================================
  describe("SPEC: Target Validation", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-112: `loopx run \"\"` (empty) → exit 1, stderr names target shape", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", ""], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/target|invalid|empty/i);
      });

      it("T-CLI-113: `loopx run \":\"` (bare colon) → exit 1, stderr names target shape", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", ":"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/target|invalid|colon/i);
      });

      it("T-CLI-114: `loopx run \":script\"` (leading colon) → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", ":script"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/target|invalid|colon/i);
      });

      it("T-CLI-115: `loopx run \"workflow:\"` (trailing colon) → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "workflow:"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/target|invalid|colon/i);
      });

      it("T-CLI-116: `loopx run \"a:b:c\"` (multiple colons) → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "a:b:c"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/target|invalid|colon|delimiter/i);
      });

      it("T-CLI-117: `loopx run \"bad.name:index\"` (bad workflow portion) → exit 1, name violation", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "bad.name:index"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/name|invalid|restrict|pattern/i);
      });

      it("T-CLI-118: `loopx run \"ralph:bad.name\"` (bad script portion) → exit 1, name violation", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "ralph:bad.name"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/name|invalid|restrict|pattern/i);
      });

      it("T-CLI-118a: `loopx run \"bad.name\"` (bare invalid workflow name) → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "bad.name"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/name|invalid|restrict|pattern/i);
      });

      it("T-CLI-114a: malformed-colon target rejected after discovery (sees collision warning)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "broken", "check", "printf 'a'");
        await createWorkflowScript(project, "broken", "check", ".ts", "console.log('b');\n");
        await createBashWorkflowScript(project, "valid", "index", "printf '{\"stop\":true}'");

        const result = await runCLI(["run", ":script"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        // Discovery + global validation ran before target rejection.
        expect(result.stderr).toMatch(/check|broken|collision|conflict/i);
      });

      it("T-CLI-118b: name-restriction target rejected after discovery (sees collision warning)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "broken", "check", "printf 'a'");
        await createWorkflowScript(project, "broken", "check", ".ts", "console.log('b');\n");
        await createBashWorkflowScript(project, "valid", "index", "printf '{\"stop\":true}'");

        const result = await runCLI(["run", "bad.name"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/check|broken|collision|conflict/i);
      });
    });
  });

  // ========================================================================
  // Option Order (T-CLI-57, 58, 83)
  // ========================================================================
  describe("SPEC: Option Order", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-57: `loopx run ralph -n 1` (target before -n) runs exactly once", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter-57.txt");
        await createBashWorkflowScript(project, "ralph", "index", counter(counterFile).slice(12));

        const result = await runCLI(["run", "ralph", "-n", "1"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(counterFile, "utf-8")).toBe("1");
      });

      it("T-CLI-58: `loopx run ralph -e local.env -n 1` loads env, runs once", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-58.txt");
        const envPath = join(project.dir, "local.env");
        await createEnvFile(envPath, { MY_VAR: "from-env" });
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          writeEnvToFile("MY_VAR", marker).slice(12),
        );

        const result = await runCLI(["run", "ralph", "-e", "local.env", "-n", "1"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(marker, "utf-8")).toBe("from-env");
      });

      it("T-CLI-83: `loopx run -e local.env ralph -n 1` (interleaved) loads env + runs once", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-83.txt");
        const envPath = join(project.dir, "local.env");
        await createEnvFile(envPath, { MY_VAR: "from-env-83" });
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          writeEnvToFile("MY_VAR", marker).slice(12),
        );

        const result = await runCLI(["run", "-e", "local.env", "ralph", "-n", "1"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(marker, "utf-8")).toBe("from-env-83");
      });
    });
  });

  // ========================================================================
  // CLI -n Option
  // (T-CLI-14, 15, 16, 17, 18, 19, 19a, 20, 56, 119*, 119a, 119b, 119d,
  //  119g, 119h, 119i, 119j, 119k)
  // ========================================================================
  describe("SPEC: CLI -n Option", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-14: `-n 3 ralph` runs exactly 3 iterations", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter-14.txt");
        await createBashWorkflowScript(project, "ralph", "index", counter(counterFile).slice(12));

        const result = await runCLI(["run", "-n", "3", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(counterFile, "utf-8")).toBe("111");
      });

      it("T-CLI-15: `-n 0 ralph` exits 0 without running the script", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter-15.txt");
        await createBashWorkflowScript(project, "ralph", "index", counter(counterFile).slice(12));

        const result = await runCLI(["run", "-n", "0", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(counterFile)).toBe(false);
      });

      it("T-CLI-16: `-n -1 ralph` → exit 1 (negative)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "-n", "-1", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-17: `-n 1.5 ralph` → exit 1 (non-integer)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "-n", "1.5", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-18: `-n abc ralph` → exit 1 (non-numeric)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "-n", "abc", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-19: `-n 0 nonexistent` → exit 1 (workflow validated under -n 0)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "-n", "0", "nonexistent"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-19a: `-n 0 ralph` with `.loopx/` missing → exit 1", async () => {
        project = await createTempProject({ withLoopxDir: false });
        const result = await runCLI(["run", "-n", "0", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-19b: `loopx run ralph` without `.loopx/` emits remediation guidance per SPEC 7.2", async () => {
        // SPEC 7.2: "When executing via `loopx run <target>`, if `.loopx/` does
        // not exist, loopx exits with an error instructing the user to create
        // it." Existing tests pin (a) exit 1 + (b) `.loopx/` mention, but not
        // the *creation-guidance* part of the SPEC 7.2 error contract.
        project = await createTempProject({ withLoopxDir: false });
        const result = await runCLI(["run", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        // (a) exit code 1
        expect(result.exitCode).toBe(1);
        // (b) stderr mentions `.loopx/` (or `.loopx`)
        expect(result.stderr).toMatch(/\.loopx\/?/);
        // (c) stderr contains actionable creation guidance — structurally
        //     distinct from a bare "directory not found" error. Accept any
        //     of the canonical remediation signals: literal mention of
        //     creating / initializing / making `.loopx/`, a suggested
        //     command (`mkdir`, `loopx install`), or a "create it" hint.
        const remediation = /\b(create|creat\w*|init\w*|mak(?:e|ing)|mkdir|loopx\s+install|set\s*up|setup|add\s+workflows?)\b/i;
        expect(result.stderr).toMatch(remediation);
      });

      it("T-CLI-20: `-n 1 ralph` runs exactly 1 iteration even without stop", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter-20.txt");
        await createBashWorkflowScript(project, "ralph", "index", counter(counterFile).slice(12));

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(counterFile, "utf-8")).toBe("1");
      });

      it("T-CLI-56: `-n 0 ralph` with valid workflow does discovery+validation, exits 0", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "-n", "0", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-119: `-n 0 ralph` skips workflow version check (unsatisfied range)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createWorkflowPackageJson(project, "ralph", {
          dependencies: { loopx: ">=999.0.0" },
        });

        const result = await runCLI(["run", "-n", "0", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/version|mismatch|loopx.*999/i);
      });

      it("T-CLI-119c: `-n 0 ralph` skips package.json reading entirely (invalid JSON)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createWorkflowPackageJson(project, "ralph", "{broken");

        const result = await runCLI(["run", "-n", "0", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/package\.json|json|parse/i);
      });

      it.skipIf(process.getuid?.() === 0)(
        "T-CLI-119e: `-n 0 ralph` skips package.json reading (unreadable file)",
        async () => {
          project = await createTempProject();
          await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
          const pkgPath = await createWorkflowPackageJson(project, "ralph", { name: "ralph" });
          await chmod(pkgPath, 0o000);
          extraCleanups.push(async () => {
            await chmod(pkgPath, 0o644).catch(() => {});
          });

          const result = await runCLI(["run", "-n", "0", "ralph"], {
            cwd: project.dir,
            runtime,
          });

          expect(result.exitCode).toBe(0);
          expect(result.stderr).not.toMatch(/package\.json|permission|EACCES/i);
        },
      );

      it("T-CLI-119f: `-n 0 ralph` skips version check (invalid semver range)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createWorkflowPackageJson(project, "ralph", {
          dependencies: { loopx: "not-a-range" },
        });

        const result = await runCLI(["run", "-n", "0", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/version|semver|range|invalid/i);
      });

      it("T-CLI-119a: `-n 0 ralph` w/o index → exit 1 (target resolution still happens)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "check", "printf 'x'");
        const result = await runCLI(["run", "-n", "0", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-119b: `-n 0 ralph:missing` → exit 1 (script must exist under -n 0)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "-n", "0", "ralph:missing"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-119d: `-n 0 \":script\"` → exit 1 (target syntax validated under -n 0)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "-n", "0", ":script"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-119g: `-n 0 ralph:check` w/o index → exit 0 (workflow valid via explicit script)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "check", "printf 'x'");
        const result = await runCLI(["run", "-n", "0", "ralph:check"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-119h: `-n 0 ralph:check` w/o index, unsatisfied loopx range → exit 0, no warning", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "check", "printf 'x'");
        await createWorkflowPackageJson(project, "ralph", {
          dependencies: { loopx: ">=999.0.0" },
        });

        const result = await runCLI(["run", "-n", "0", "ralph:check"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/version|mismatch|999/i);
      });

      it("T-CLI-119i: `-n 0 ralph:check` w/o index, invalid JSON pkg → exit 0, no warning", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "check", "printf 'x'");
        await createWorkflowPackageJson(project, "ralph", "{broken");

        const result = await runCLI(["run", "-n", "0", "ralph:check"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/package\.json|json|parse/i);
      });

      it("T-CLI-119j: `-n 0 ralph:check` w/o index, invalid semver pkg → exit 0, no warning", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "check", "printf 'x'");
        await createWorkflowPackageJson(project, "ralph", {
          dependencies: { loopx: "not-a-range" },
        });

        const result = await runCLI(["run", "-n", "0", "ralph:check"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/version|semver|range|invalid/i);
      });

      it.skipIf(process.getuid?.() === 0)(
        "T-CLI-119k: `-n 0 ralph:check` w/o index, unreadable pkg → exit 0, no warning",
        async () => {
          project = await createTempProject();
          await createBashWorkflowScript(project, "ralph", "check", "printf 'x'");
          const pkgPath = await createWorkflowPackageJson(project, "ralph", { name: "ralph" });
          await chmod(pkgPath, 0o000);
          extraCleanups.push(async () => {
            await chmod(pkgPath, 0o644).catch(() => {});
          });

          const result = await runCLI(["run", "-n", "0", "ralph:check"], {
            cwd: project.dir,
            runtime,
          });

          expect(result.exitCode).toBe(0);
          expect(result.stderr).not.toMatch(/package\.json|permission|EACCES/i);
        },
      );
    });
  });

  // ========================================================================
  // Duplicate Flags (T-CLI-20a, 20b)
  // ========================================================================
  describe("SPEC: Duplicate Flags", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-20a: `-n 3 -n 5 ralph` → exit 1 (duplicate -n)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "-n", "3", "-n", "5", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-20b: `-e .env1 -e .env2 ralph` → exit 1 (duplicate -e)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createEnvFile(join(project.dir, ".env1"), { A: "1" });
        await createEnvFile(join(project.dir, ".env2"), { B: "2" });
        const result = await runCLI(
          ["run", "-e", ".env1", "-e", ".env2", "ralph"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });
    });
  });

  // ========================================================================
  // Unrecognized Run Flags (T-CLI-35, 72, 86, 87, 88, 89)
  // ========================================================================
  describe("SPEC: Unrecognized Run Flags", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-35: `loopx run --unknown ralph` → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "--unknown", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-72: `loopx run -x ralph` → exit 1 (unknown short flag)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "-x", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-86: `loopx run ralph --unknown` → exit 1, marker not written", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-86.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          writeValueToFile("ran-86", marker).slice(12),
        );
        const result = await runCLI(["run", "ralph", "--unknown"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(existsSync(marker)).toBe(false);
      });

      it("T-CLI-87: `loopx run ralph -x` → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "ralph", "-x"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-88: `loopx run ralph -n 1 -n 2` → exit 1 (duplicate -n after target)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "ralph", "-n", "1", "-n", "2"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-89: `loopx run ralph -e a.env -e b.env` → exit 1 (duplicate -e after target)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createEnvFile(join(project.dir, "a.env"), { A: "1" });
        await createEnvFile(join(project.dir, "b.env"), { B: "2" });
        const result = await runCLI(
          ["run", "ralph", "-e", "a.env", "-e", "b.env"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });
    });
  });

  // ========================================================================
  // Missing Flag Operands (T-CLI-97, 98, 99, 100)
  // ========================================================================
  describe("SPEC: Missing Flag Operands", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-97: `loopx run -n` (no operand, no target) → exit 1", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-n"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-98: `loopx run -e` (no operand, no target) → exit 1", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-e"], { cwd: project.dir, runtime });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-99: `loopx run ralph -n` (missing -n operand after target) → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "ralph", "-n"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-100: `loopx run ralph -e` (missing -e operand after target) → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "ralph", "-e"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });
    });
  });

  // ========================================================================
  // CLI -e Option
  // (T-CLI-21, 22, 22a, 22c, 22b, 22d, 22e, 22f)
  // ========================================================================
  describe("SPEC: CLI -e Option", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-21: `-e .env -n 1 ralph` makes env vars visible to script", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-21.txt");
        const envPath = join(project.dir, ".env");
        await createEnvFile(envPath, { MY_VAR: "from-21" });
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          writeEnvToFile("MY_VAR", marker).slice(12),
        );

        const result = await runCLI(["run", "-e", ".env", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(marker, "utf-8")).toBe("from-21");
      });

      it("T-CLI-22: `-e nonexistent.env ralph` → exit 1, stderr names missing file", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(["run", "-e", "nonexistent.env", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/nonexistent\.env|env|missing|not found/i);
      });

      it("T-CLI-22a: `-n 0 -e nonexistent.env ralph` → exit 1 (env validated before -n 0)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        const result = await runCLI(
          ["run", "-n", "0", "-e", "nonexistent.env", "ralph"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-22c: `-n 0 -e malformed.env ralph` → exit 0 + parser warning, script never runs", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter-22c.txt");
        await createBashWorkflowScript(project, "ralph", "index", counter(counterFile).slice(12));
        const envPath = join(project.dir, "malformed.env");
        await writeEnvFileRaw(envPath, "1BAD=val\n");

        const result = await runCLI(
          ["run", "-n", "0", "-e", "malformed.env", "ralph"],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        expect(existsSync(counterFile)).toBe(false);
        expect(result.stderr).toMatch(/1BAD|invalid|warning|env|key/i);
      });

      it("T-CLI-22b: `-n 0 ralph` with collision → exit 1 (validation before -n 0)", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(project, "other", "dupe", "printf 'a'");
        await createWorkflowScript(project, "other", "dupe", ".ts", "console.log('b');\n");

        const result = await runCLI(["run", "-n", "0", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-22d: `-n 0 ralph` with invalid script name in same workflow → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(project, "ralph", "-bad", "printf 'x'");

        const result = await runCLI(["run", "-n", "0", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-22e: `-n 0 ralph` with invalid sibling workflow name → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(project, "-bad-workflow", "index", "printf 'x'");

        const result = await runCLI(["run", "-n", "0", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it.skipIf(process.getuid?.() === 0)(
        "T-CLI-22f: `-n 0 -e unreadable.env ralph` → exit 1 (env readability validated)",
        async () => {
          project = await createTempProject();
          await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
          const envPath = join(project.dir, "unreadable.env");
          await createEnvFile(envPath, { FOO: "bar" });
          await chmod(envPath, 0o000);
          extraCleanups.push(async () => {
            await chmod(envPath, 0o644).catch(() => {});
          });

          const result = await runCLI(
            ["run", "-n", "0", "-e", "unreadable.env", "ralph"],
            { cwd: project.dir, runtime },
          );

          expect(result.exitCode).toBe(1);
        },
      );
    });
  });

  // ========================================================================
  // CLI Stdout Silence (T-CLI-23, 27, 96)
  // ========================================================================
  describe("SPEC: CLI Stdout Silence + Extra Positionals", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-23: CLI stdout is empty even when script outputs result", async () => {
        project = await createTempProject();
        const marker = join(project.dir, "marker-23.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'ran-23' > "${marker}"\nprintf '{"result":"hello"}'`,
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
        expect(readFileSync(marker, "utf-8")).toBe("ran-23");
      });

      it("T-CLI-23a: CLI stdout silence on raw (non-JSON) successful output", async () => {
        // SPEC §7.1: "The CLI does not print `result` to its own stdout at any
        // point." SPEC §2.3: "If stdout is not valid JSON, is not an object,
        // or is a valid JSON object but contains none of the known fields,
        // the entire stdout content is treated as `{ result: <raw output> }`."
        // T-CLI-23 covers structured JSON success; T-LOOP-24a covers the
        // failure path. This test covers raw-stdout success — a buggy impl
        // could route raw stdout through to the CLI's own stdout while
        // correctly suppressing structured JSON ("if I parsed it as
        // structured output, suppress; otherwise pass through").
        project = await createTempProject();
        const marker = join(project.dir, "marker-23a.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf 'ran-23a' > "${marker}"\nprintf 'hello raw\\n'\nexit 0`,
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        // (a) clean exit 0 — loop reset and `-n 1` capped iterations
        expect(result.exitCode).toBe(0);
        // (b) CLI's captured stdout is byte-empty — raw script output never
        //     appears on the CLI's own stdout
        expect(result.stdout).toBe("");
        expect(result.stdout).not.toContain("hello raw");
        // (c) marker file exists, proving the script actually ran
        expect(readFileSync(marker, "utf-8")).toBe("ran-23a");
      });

      it("T-CLI-27: `loopx run ralph beta` (two positionals) → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(project, "beta", "index", "printf '{\"stop\":true}'");

        const result = await runCLI(["run", "ralph", "beta"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-96: `loopx run ralph -n 1 beta` (extra positional interleaved) → exit 1", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(project, "ralph", "index", "printf '{\"stop\":true}'");
        await createBashWorkflowScript(project, "beta", "index", "printf '{\"stop\":true}'");

        const result = await runCLI(["run", "ralph", "-n", "1", "beta"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });
    });
  });
});
