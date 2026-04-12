import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createTempProject,
  createScript,
  createBashScript,
  createDirScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { createEnvFile, withGlobalEnv } from "../helpers/env.js";
import {
  counter,
  emitResult,
  emitStop,
  writeEnvToFile,
  writeValueToFile,
} from "../helpers/fixture-scripts.js";
import { forEachRuntime } from "../helpers/runtime.js";
import { startLocalHTTPServer, type HTTPServer } from "../helpers/servers.js";

function getExpectedVersion(): string {
  const pkgPath = resolve(process.cwd(), "node_modules/loopx/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version as string;
}

describe("SPEC: CLI Basics (T-CLI-01 through T-CLI-100)", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  // ─────────────────────────────────────────────
  // Help & Version
  // ─────────────────────────────────────────────

  describe("SPEC: Help & Version", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-01: `loopx version` prints version + newline, exits 0", async () => {
        project = await createTempProject({ withLoopxDir: false });
        const result = await runCLI(["version"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const expectedVersion = getExpectedVersion();
        expect(result.stdout).toBe(`${expectedVersion}\n`);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Top-Level Help
  // ─────────────────────────────────────────────

  describe("SPEC: Top-Level Help", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-02: `loopx -h` prints usage with subcommands, no scripts, no old syntax", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
        // Must list available subcommands
        expect(result.stdout).toContain("run");
        expect(result.stdout).toContain("version");
        expect(result.stdout).toContain("output");
        expect(result.stdout).toContain("env");
        expect(result.stdout).toContain("install");
        // Negative assertions: no pre-ADR-0002 patterns
        expect(lower).not.toMatch(/loopx\s+\[options\]\s+\[script-name\]/);
        expect(lower).not.toMatch(/loopx\s+\[script-name\]/);
        // -n and -e are NOT top-level options
        expect(lower).not.toMatch(/-n\s.*iteration/);
        expect(lower).not.toMatch(/-e\s.*env/);
        // No "default" script concept
        expect(lower).not.toMatch(/default\s+script/);
      });

      it("T-CLI-03: `--help` produces identical output as `-h` (including non-discovery guarantee)", async () => {
        project = await createTempProject();
        // Set up a fixture with scripts, a name collision, and an invalid dir script
        await createScript(project, "example", ".sh", emitResult("a"));
        await createScript(project, "example", ".ts", 'console.log("b");\n');
        const badDir = join(project.loopxDir, "broken");
        await mkdir(badDir, { recursive: true });
        await writeFile(join(badDir, "package.json"), "{invalid}", "utf-8");

        const [shortResult, longResult] = await Promise.all([
          runCLI(["-h"], { cwd: project.dir, runtime }),
          runCLI(["--help"], { cwd: project.dir, runtime }),
        ]);

        expect(shortResult.exitCode).toBe(0);
        expect(longResult.exitCode).toBe(0);
        // Byte-identical stdout
        expect(longResult.stdout).toBe(shortResult.stdout);
        // Byte-identical stderr (both empty — no discovery)
        expect(longResult.stderr).toBe(shortResult.stderr);
        expect(shortResult.stderr).toBe("");
      });

      it("T-CLI-04: `-h` with scripts does NOT list discovered script names", async () => {
        project = await createTempProject();
        await createScript(project, "alpha", ".sh", emitResult("a"));
        await createScript(
          project,
          "beta",
          ".ts",
          'import { output } from "loopx";\noutput({ result: "b" });\n',
        );

        const result = await runCLI(["-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        // Top-level help does NOT list scripts
        expect(result.stdout).not.toContain("alpha");
        expect(result.stdout).not.toContain("beta");
      });

      it("T-CLI-05: `-h` without `.loopx/` still prints help, no error, no warnings", async () => {
        project = await createTempProject({ withLoopxDir: false });
        const result = await runCLI(["-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
        expect(result.stderr).toBe("");
      });

      it("T-CLI-06: `-h` with name collisions does NOT print warnings on stderr", async () => {
        project = await createTempProject();
        await createScript(project, "dupe", ".sh", emitResult("x"));
        await createScript(project, "dupe", ".ts", 'console.log("x");\n');

        const result = await runCLI(["-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        // No warnings on stderr — top-level help performs no validation
        expect(result.stderr).toBe("");
      });

      it("T-CLI-07e: `loopx -h version` prints top-level help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h", "version"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
      });

      it("T-CLI-07f: `loopx -h env set FOO bar` prints top-level help", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h", "env", "set", "FOO", "bar"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
      });

      it("T-CLI-07g: `loopx -h --invalid-flag` prints top-level help", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h", "--invalid-flag"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
      });

      it("T-CLI-07j: `loopx -h -e nonexistent.env` prints top-level help", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h", "-e", "nonexistent.env"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
      });

      it("T-CLI-39: `loopx -h run foo` shows top-level help (not run help), exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h", "run", "foo"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
      });

      it("T-CLI-61: `loopx --help run foo` shows top-level help (not run help), exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["--help", "run", "foo"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
      });

      it("T-CLI-90: `loopx --help --invalid-flag` prints top-level help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["--help", "--invalid-flag"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
      });

      it("T-CLI-91: `loopx --help -e nonexistent.env` prints top-level help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["--help", "-e", "nonexistent.env"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
      });
    });
  });

  // ─────────────────────────────────────────────
  // Run Help
  // ─────────────────────────────────────────────

  describe("SPEC: Run Help", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-40: `loopx run -h` prints run-specific help with syntax, options, scripts", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["run", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const stdout = result.stdout;
        const lower = stdout.toLowerCase();
        // Must show required script name syntax (e.g., <script-name>, not [script-name])
        expect(stdout).toMatch(/<script[_-]?name>/i);
        // Must list -n and -e options
        expect(lower).toMatch(/-n/);
        expect(lower).toMatch(/-e/);
        // Must list discovered script names
        expect(stdout).toContain("myscript");
        // Negative: no optional script-name syntax, no "default" fallback
        expect(lower).not.toMatch(/\[script[_-]?name\]/);
        expect(lower).not.toMatch(/default\s+script/);
      });

      it("T-CLI-41: `loopx run --help` produces identical output as `loopx run -h`", async () => {
        project = await createTempProject();
        await createScript(project, "good", ".sh", emitResult("a"));
        await createScript(project, "example", ".sh", emitResult("b"));
        await createScript(project, "example", ".ts", 'console.log("c");\n');
        const badDir = join(project.loopxDir, "broken");
        await mkdir(badDir, { recursive: true });
        await writeFile(join(badDir, "package.json"), "{invalid}", "utf-8");

        const [shortResult, longResult] = await Promise.all([
          runCLI(["run", "-h"], { cwd: project.dir, runtime }),
          runCLI(["run", "--help"], { cwd: project.dir, runtime }),
        ]);

        expect(shortResult.exitCode).toBe(0);
        expect(longResult.exitCode).toBe(0);
        expect(longResult.stdout).toBe(shortResult.stdout);
        expect(longResult.stderr).toBe(shortResult.stderr);
      });

      it("T-CLI-42: `loopx run -h` without `.loopx/` prints run help with warning, no scripts section", async () => {
        project = await createTempProject({ withLoopxDir: false });

        const result = await runCLI(["run", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toMatch(/-n/);
        expect(lower).toMatch(/-e/);
        const combined = (result.stdout + result.stderr).toLowerCase();
        expect(combined).toMatch(/\.loopx|not found|directory/);
        expect(lower).not.toMatch(/available scripts|scripts:/i);
      });

      it("T-CLI-43: `loopx run -h` with name collisions prints warnings on stderr", async () => {
        project = await createTempProject();
        await createScript(project, "dupe", ".sh", emitResult("x"));
        await createScript(project, "dupe", ".ts", 'console.log("x");\n');

        const result = await runCLI(["run", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr.length).toBeGreaterThan(0);
        const stderrLower = result.stderr.toLowerCase();
        expect(stderrLower).toMatch(/collision|conflict|duplicate|dupe/);
      });

      it("T-CLI-44: `loopx run -h` with invalid script name warns on stderr", async () => {
        project = await createTempProject();
        await createScript(project, "-startswithdash", ".sh", emitResult("x"));

        const result = await runCLI(["run", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/startswithdash|invalid|name|restrict/i);
        expect(result.stdout).toMatch(/-startswithdash/);
      });

      it("T-CLI-45: `loopx run -h` lists scripts with type info", async () => {
        project = await createTempProject();
        await createScript(project, "mybash", ".sh", emitResult("a"));
        await createScript(
          project,
          "myts",
          ".ts",
          'import { output } from "loopx";\noutput({ result: "b" });\n',
        );

        const result = await runCLI(["run", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("mybash");
        expect(result.stdout).toContain("myts");
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("sh");
        expect(lower).toContain("ts");
      });

      it("T-CLI-46: `loopx run -h` with bad package.json dir script warns, not listed", async () => {
        project = await createTempProject();
        const scriptDir = join(project.loopxDir, "badpkg");
        await mkdir(scriptDir, { recursive: true });
        await writeFile(join(scriptDir, "package.json"), "{invalid json}", "utf-8");
        await writeFile(join(scriptDir, "index.ts"), 'console.log("hi");\n', "utf-8");

        const result = await runCLI(["run", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toContain("badpkg");
        expect(result.stderr).toMatch(/badpkg|invalid|json|package/i);
      });

      it("T-CLI-47: `loopx run -h` with main escaping directory warns on stderr", async () => {
        project = await createTempProject();
        const scriptDir = join(project.loopxDir, "escape");
        await mkdir(scriptDir, { recursive: true });
        await writeFile(
          join(scriptDir, "package.json"),
          JSON.stringify({ main: "../escape.ts" }),
          "utf-8",
        );
        await writeFile(
          join(project.loopxDir, "escape.ts"),
          'console.log("escaped");\n',
          "utf-8",
        );

        const result = await runCLI(["run", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/escape|traversal|path|boundary|outside/i);
      });

      it("T-CLI-55: `loopx run -h` with unreadable package.json warns (conditional)", async () => {
        if (process.getuid?.() === 0) return; // skip as root

        project = await createTempProject();
        const scriptDir = join(project.loopxDir, "unreadable");
        await mkdir(scriptDir, { recursive: true });
        await writeFile(
          join(scriptDir, "package.json"),
          JSON.stringify({ main: "index.ts" }),
          "utf-8",
        );
        await writeFile(join(scriptDir, "index.ts"), 'console.log("hi");\n', "utf-8");
        await chmod(join(scriptDir, "package.json"), 0o000);

        const result = await runCLI(["run", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/unreadable|permission|read|access|EACCES/i);

        // Restore permissions for cleanup
        await chmod(join(scriptDir, "package.json"), 0o644);
      });

      it("T-CLI-55a: `loopx run -h` with package.json missing `main` warns", async () => {
        project = await createTempProject();
        const scriptDir = join(project.loopxDir, "nomain");
        await mkdir(scriptDir, { recursive: true });
        await writeFile(
          join(scriptDir, "package.json"),
          JSON.stringify({ name: "foo" }),
          "utf-8",
        );

        const result = await runCLI(["run", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/nomain|main|missing/i);
      });

      it("T-CLI-55b: `loopx run -h` with non-string `main` warns", async () => {
        project = await createTempProject();
        const scriptDir = join(project.loopxDir, "badmain");
        await mkdir(scriptDir, { recursive: true });
        await writeFile(
          join(scriptDir, "package.json"),
          JSON.stringify({ main: 42 }),
          "utf-8",
        );

        const result = await runCLI(["run", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/badmain|main|string|type/i);
      });

      it("T-CLI-55c: `loopx run -h` with unsupported extension in `main` warns", async () => {
        project = await createTempProject();
        const scriptDir = join(project.loopxDir, "badext");
        await mkdir(scriptDir, { recursive: true });
        await writeFile(
          join(scriptDir, "package.json"),
          JSON.stringify({ main: "index.py" }),
          "utf-8",
        );
        await writeFile(join(scriptDir, "index.py"), 'print("hi")\n', "utf-8");

        const result = await runCLI(["run", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/badext|extension|unsupported|\.py/i);
      });

      it("T-CLI-55d: `loopx run -h` with nonexistent `main` file warns", async () => {
        project = await createTempProject();
        const scriptDir = join(project.loopxDir, "missing");
        await mkdir(scriptDir, { recursive: true });
        await writeFile(
          join(scriptDir, "package.json"),
          JSON.stringify({ main: "missing.ts" }),
          "utf-8",
        );

        const result = await runCLI(["run", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/missing|not found|exist|nonexistent/i);
      });

      it("T-CLI-62: `loopx run myscript --help` shows run help, exits 0", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["run", "myscript", "--help"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toMatch(/-n/);
        expect(lower).toMatch(/-e/);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Run Help Short-Circuit
  // ─────────────────────────────────────────────

  describe("SPEC: Run Help Short-Circuit", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-48: `loopx run -h foo` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "foo"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toLowerCase()).toMatch(/-n/);
      });

      it("T-CLI-49: `loopx run myscript -h` shows canonical run help, exits 0", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const [canonical, withScript] = await Promise.all([
          runCLI(["run", "-h"], { cwd: project.dir, runtime }),
          runCLI(["run", "myscript", "-h"], { cwd: project.dir, runtime }),
        ]);

        expect(withScript.exitCode).toBe(0);
        expect(withScript.stdout).toBe(canonical.stdout);
        expect(withScript.stderr).toBe(canonical.stderr);
      });

      it("T-CLI-50: `loopx run -h -e missing.env` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "-e", "missing.env"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-51: `loopx run -h -n bad` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "-n", "bad"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-52: `loopx run -h -n 5 -n 10` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "-n", "5", "-n", "10"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-53: `loopx run -h foo bar` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "foo", "bar"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-54: `loopx run -h --unknown` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "--unknown"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-63: `loopx run -h -e a.env -e b.env` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "-e", "a.env", "-e", "b.env"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-67: `loopx run myscript -h --unknown` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "myscript", "-h", "--unknown"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-68: `loopx run myscript -h -e missing.env` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "myscript", "-h", "-e", "missing.env"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-69: `loopx run --help --unknown` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "--help", "--unknown"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-70: `loopx run myscript --help -e missing.env` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "myscript", "--help", "-e", "missing.env"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-92: `loopx run -h -n` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "-n"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-93: `loopx run -h -e` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-h", "-e"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-94: `loopx run --help -n` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "--help", "-n"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-95: `loopx run --help -e` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "--help", "-e"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Late-Help Short-Circuit (invalid args before -h)
  // ─────────────────────────────────────────────

  describe("SPEC: Late-Help Short-Circuit", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-73: `loopx run --unknown -h` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "--unknown", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-74: `loopx run -e missing.env -h` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-e", "missing.env", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-75: `loopx run -n 5 -n 10 -h` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-n", "5", "-n", "10", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-76: `loopx run foo bar -h` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "foo", "bar", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-77: `loopx run -n bad -h` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-n", "bad", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-78: `loopx run --unknown --help` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "--unknown", "--help"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });

      it("T-CLI-84: `loopx run -e a.env -e b.env -h` shows run help, exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-e", "a.env", "-e", "b.env", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Bare Invocation & Top-Level Parsing Errors
  // ─────────────────────────────────────────────

  describe("SPEC: Bare Invocation & Top-Level Parsing Errors", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-28: `loopx` with no arguments shows top-level help, exits 0", async () => {
        project = await createTempProject();
        // Set up fixtures that would trigger discovery warnings
        await createScript(project, "example", ".sh", emitResult("a"));
        await createScript(project, "example", ".ts", 'console.log("b");\n');
        const badDir = join(project.loopxDir, "broken");
        await mkdir(badDir, { recursive: true });
        await writeFile(join(badDir, "package.json"), "{invalid}", "utf-8");

        const [bareResult, helpResult] = await Promise.all([
          runCLI([], { cwd: project.dir, runtime }),
          runCLI(["-h"], { cwd: project.dir, runtime }),
        ]);

        expect(bareResult.exitCode).toBe(0);
        expect(bareResult.stdout).toBe(helpResult.stdout);
        // No script names in output
        expect(bareResult.stdout).not.toContain("example");
        // No discovery/validation warnings
        expect(bareResult.stderr).toBe("");
      });

      it("T-CLI-33: `loopx myscript` is usage error (no implicit run fallback)", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "myscript", writeValueToFile("executed", markerFile));

        const result = await runCLI(["myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(existsSync(markerFile)).toBe(false);
      });

      it("T-CLI-34: `loopx --unknown` is usage error, exit 1", async () => {
        project = await createTempProject();
        const result = await runCLI(["--unknown"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-71: `loopx -x` is usage error (short flag), exit 1", async () => {
        project = await createTempProject();
        const result = await runCLI(["-x"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-36: `loopx -n 5 myscript` is usage error (top-level -n), exit 1", async () => {
        project = await createTempProject();
        const result = await runCLI(["-n", "5", "myscript"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-37: `loopx -e .env myscript` is usage error (top-level -e), exit 1", async () => {
        project = await createTempProject();
        const result = await runCLI(["-e", ".env", "myscript"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-07b: `loopx -n 5 -h` is usage error (first arg is -n, not -h), exit 1", async () => {
        project = await createTempProject();
        const result = await runCLI(["-n", "5", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-07c: `loopx myscript -h` is usage error (unrecognized subcommand), exit 1", async () => {
        project = await createTempProject();
        const result = await runCLI(["myscript", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-38: `loopx foo -h` is usage error (unrecognized subcommand), exit 1", async () => {
        project = await createTempProject();
        const result = await runCLI(["foo", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-79: `loopx foo --help` is usage error (unrecognized subcommand), exit 1", async () => {
        project = await createTempProject();
        const result = await runCLI(["foo", "--help"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Script Invocation via `run`
  // ─────────────────────────────────────────────

  describe("SPEC: Script Invocation via run", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-30: `loopx run -n 1 myscript` runs the script (marker file)", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "myscript", writeValueToFile("executed", markerFile));

        const result = await runCLI(["run", "-n", "1", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerFile)).toBe(true);
        expect(readFileSync(markerFile, "utf-8")).toBe("executed");
      });

      it("T-CLI-11: `loopx run myscript` (no options) with stop:true script", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        const scriptBody = `#!/bin/bash
printf '%s' 'executed' > "${markerFile}"
printf '{"stop":true}'
`;
        await createScript(project, "myscript", ".sh", scriptBody);

        const result = await runCLI(["run", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerFile)).toBe(true);
        expect(readFileSync(markerFile, "utf-8")).toBe("executed");
      });

      it("T-CLI-12: `loopx run nonexistent` -> exit 1", async () => {
        project = await createTempProject();

        const result = await runCLI(["run", "nonexistent"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-13: `loopx run -n 1 default` runs script named default (no special behavior)", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "default", writeValueToFile("executed", markerFile));

        const result = await runCLI(["run", "-n", "1", "default"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerFile)).toBe(true);
        expect(readFileSync(markerFile, "utf-8")).toBe("executed");
      });

      it("T-CLI-29: `loopx run` with no script name is usage error, exit 1", async () => {
        project = await createTempProject();

        const result = await runCLI(["run"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-64: `loopx run` with default.sh present still exits 1", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "default", writeValueToFile("executed", markerFile));

        const result = await runCLI(["run"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(existsSync(markerFile)).toBe(false);
      });

      it("T-CLI-65: `loopx` (bare) with default.sh present shows help, exits 0, script not run", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "default", writeValueToFile("executed", markerFile));

        const [bareResult, helpResult] = await Promise.all([
          runCLI([], { cwd: project.dir, runtime }),
          runCLI(["-h"], { cwd: project.dir, runtime }),
        ]);

        expect(bareResult.exitCode).toBe(0);
        expect(bareResult.stdout).toBe(helpResult.stdout);
        expect(existsSync(markerFile)).toBe(false);
      });

      it("T-CLI-59: `loopx run -n 5` (no script name, with options) is usage error", async () => {
        project = await createTempProject();
        await createScript(project, "example", ".sh", emitResult("a"));
        await createScript(project, "example", ".ts", 'console.log("b");\n');
        const badDir = join(project.loopxDir, "broken");
        await mkdir(badDir, { recursive: true });
        await writeFile(join(badDir, "package.json"), "{invalid}", "utf-8");

        const result = await runCLI(["run", "-n", "5"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).not.toMatch(/collision|conflict|duplicate/i);
        expect(result.stderr).not.toMatch(/warning|invalid.*json|package\.json|malformed/i);
      });

      it("T-CLI-60: `loopx run` with collision/invalid scripts still exits 1, no warnings", async () => {
        project = await createTempProject();
        await createScript(project, "example", ".sh", emitResult("a"));
        await createScript(project, "example", ".ts", 'console.log("b");\n');
        const badDir = join(project.loopxDir, "broken");
        await mkdir(badDir, { recursive: true });
        await writeFile(join(badDir, "package.json"), "{invalid}", "utf-8");

        const result = await runCLI(["run"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).not.toMatch(/collision|conflict|duplicate/i);
        expect(result.stderr).not.toMatch(/warning|invalid.*json|package\.json|malformed/i);
      });

      it("T-CLI-85: `loopx run -e missing.env` (no script name) exits 1, name takes precedence", async () => {
        project = await createTempProject();
        await createScript(project, "example", ".sh", emitResult("a"));
        await createScript(project, "example", ".ts", 'console.log("b");\n');

        const result = await runCLI(["run", "-e", "missing.env"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).not.toMatch(/collision|conflict|duplicate/i);
        expect(result.stderr).not.toMatch(/missing\.env/i);
      });

      it("T-CLI-31: `loopx run -n 1 version` runs script named version, not built-in", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "version", writeValueToFile("script-ran", markerFile));

        const result = await runCLI(["run", "-n", "1", "version"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerFile)).toBe(true);
        expect(readFileSync(markerFile, "utf-8")).toBe("script-ran");
        // stdout is empty (CLI never prints result)
        expect(result.stdout).toBe("");
        // stdout is NOT the version string
        const expectedVersion = getExpectedVersion();
        expect(result.stdout).not.toBe(`${expectedVersion}\n`);
      });

      it("T-CLI-32: `loopx run -n 1 run` runs script named run", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "run", writeValueToFile("script-ran", markerFile));

        const result = await runCLI(["run", "-n", "1", "run"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerFile)).toBe(true);
        expect(readFileSync(markerFile, "utf-8")).toBe("script-ran");
      });

      it("T-CLI-66: `loopx version` with version.sh present still prints CLI version", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "version", writeValueToFile("script-ran", markerFile));

        const result = await runCLI(["version"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const expectedVersion = getExpectedVersion();
        expect(result.stdout).toBe(`${expectedVersion}\n`);
        expect(existsSync(markerFile)).toBe(false);
      });

      it("T-CLI-80: `loopx output --result x` with output.sh present runs built-in", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "output", writeValueToFile("script-ran", markerFile));

        const result = await runCLI(["output", "--result", "x"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.result).toBe("x");
        expect(existsSync(markerFile)).toBe(false);
      });

      it("T-CLI-81: `loopx env list` with env.ts present runs built-in", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createScript(
          project,
          "env",
          ".ts",
          `import { writeFileSync } from "node:fs";\nwriteFileSync("${markerFile}", "script-ran");\n`,
        );

        const proj = project;
        await withGlobalEnv({}, async () => {
          const listResult = await runCLI(["env", "list"], {
            cwd: proj.dir,
            runtime,
          });
          expect(listResult.exitCode).toBe(0);
          expect(existsSync(markerFile)).toBe(false);

          const setResult = await runCLI(["env", "set", "FOO", "bar"], {
            cwd: proj.dir,
            runtime,
          });
          expect(setResult.exitCode).toBe(0);
          expect(existsSync(markerFile)).toBe(false);

          const listResult2 = await runCLI(["env", "list"], {
            cwd: proj.dir,
            runtime,
          });
          expect(listResult2.stdout).toContain("FOO=bar");
        });
      });

      it("T-CLI-82: `loopx install <source>` with install.js present runs built-in", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createScript(
          project,
          "install",
          ".js",
          `import { writeFileSync } from "node:fs";\nwriteFileSync("${markerFile}", "script-ran");\n`,
        );

        const tsContent = `import { output } from "loopx";\noutput({ result: "installed" });\n`;
        const server = await startLocalHTTPServer([
          { path: "/test-install.ts", body: tsContent },
        ]);

        try {
          const result = await runCLI(
            ["install", `${server.url}/test-install.ts`],
            { cwd: project.dir, runtime },
          );

          expect(result.exitCode).toBe(0);
          expect(existsSync(join(project.loopxDir, "test-install.ts"))).toBe(true);
          expect(existsSync(markerFile)).toBe(false);
        } finally {
          await server.close();
        }
      });
    });
  });

  // ─────────────────────────────────────────────
  // Option Order
  // ─────────────────────────────────────────────

  describe("SPEC: Option Order", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-57: `loopx run myscript -n 1` (script name before -n)", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");
        await createScript(project, "myscript", ".sh", counter(counterFile));

        const result = await runCLI(["run", "myscript", "-n", "1"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(counterFile)).toBe(true);
        expect(readFileSync(counterFile, "utf-8")).toBe("1");
      });

      it("T-CLI-58: `loopx run myscript -e local.env -n 1` (script before options)", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "marker.txt");
        const envFile = join(project.dir, "local.env");
        await createEnvFile(envFile, { MY_VAR: "hello" });
        await createScript(project, "myscript", ".sh", writeEnvToFile("MY_VAR", markerFile));

        const result = await runCLI(["run", "myscript", "-e", "local.env", "-n", "1"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerFile)).toBe(true);
        expect(readFileSync(markerFile, "utf-8")).toBe("hello");
      });

      it("T-CLI-83: `loopx run -e local.env myscript -n 1` (interleaved options)", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");
        const markerFile = join(project.dir, "marker.txt");
        const envFile = join(project.dir, "local.env");
        await createEnvFile(envFile, { MY_VAR: "hello" });

        const scriptBody = `#!/bin/bash
printf '1' >> "${counterFile}"
printf '%s' "\$MY_VAR" > "${markerFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')
printf '{"result":"%s"}' "$COUNT"
`;
        await createScript(project, "myscript", ".sh", scriptBody);

        const result = await runCLI(["run", "-e", "local.env", "myscript", "-n", "1"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(counterFile)).toBe(true);
        expect(readFileSync(counterFile, "utf-8")).toBe("1");
        expect(existsSync(markerFile)).toBe(true);
        expect(readFileSync(markerFile, "utf-8")).toBe("hello");
      });
    });
  });

  // ─────────────────────────────────────────────
  // CLI -n Option
  // ─────────────────────────────────────────────

  describe("SPEC: CLI -n Option", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-14: `loopx run -n 3 myscript` runs exactly 3 iterations", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");
        await createScript(project, "myscript", ".sh", counter(counterFile));

        const result = await runCLI(["run", "-n", "3", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(counterFile)).toBe(true);
        expect(readFileSync(counterFile, "utf-8")).toBe("111");
      });

      it("T-CLI-15: `loopx run -n 0 myscript` exits 0 without running script", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");
        await createScript(project, "myscript", ".sh", counter(counterFile));

        const result = await runCLI(["run", "-n", "0", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        if (existsSync(counterFile)) {
          expect(readFileSync(counterFile, "utf-8")).toBe("");
        }
      });

      it("T-CLI-16: `loopx run -n -1 myscript` -> exit 1", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["run", "-n", "-1", "myscript"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-17: `loopx run -n 1.5 myscript` -> exit 1", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["run", "-n", "1.5", "myscript"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-18: `loopx run -n abc myscript` -> exit 1", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["run", "-n", "abc", "myscript"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-19: `loopx run -n 0 nonexistent` -> exit 1 (validation before short-circuit)", async () => {
        project = await createTempProject();

        const result = await runCLI(["run", "-n", "0", "nonexistent"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stderr.toLowerCase()).toMatch(/nonexistent|not found|no such/i);
      });

      it("T-CLI-19a: `loopx run -n 0 myscript` with .loopx/ missing -> exit 1", async () => {
        project = await createTempProject({ withLoopxDir: false });

        const result = await runCLI(["run", "-n", "0", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stderr.toLowerCase()).toMatch(/\.loopx|directory/i);
      });

      it("T-CLI-20: `loopx run -n 1 myscript` runs exactly 1 iteration", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");
        await createScript(project, "myscript", ".sh", counter(counterFile));

        const result = await runCLI(["run", "-n", "1", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(counterFile)).toBe(true);
        expect(readFileSync(counterFile, "utf-8")).toBe("1");
      });

      it("T-CLI-56: `loopx run -n 0 myscript` performs discovery, exits 0, no execution", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");
        await createScript(project, "myscript", ".sh", counter(counterFile));

        const result = await runCLI(["run", "-n", "0", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        if (existsSync(counterFile)) {
          expect(readFileSync(counterFile, "utf-8")).toBe("");
        }
      });
    });
  });

  // ─────────────────────────────────────────────
  // Duplicate Flags
  // ─────────────────────────────────────────────

  describe("SPEC: Duplicate Flags", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-20a: `loopx run -n 3 -n 5 myscript` -> exit 1 (duplicate -n)", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["run", "-n", "3", "-n", "5", "myscript"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-20b: `loopx run -e .env1 -e .env2 myscript` -> exit 1 (duplicate -e)", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));
        const env1 = join(project.dir, ".env1");
        const env2 = join(project.dir, ".env2");
        await createEnvFile(env1, { FOO: "bar" });
        await createEnvFile(env2, { BAZ: "qux" });

        const result = await runCLI(
          ["run", "-e", ".env1", "-e", ".env2", "myscript"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Unrecognized Run Flags
  // ─────────────────────────────────────────────

  describe("SPEC: Unrecognized Run Flags", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-35: `loopx run --unknown myscript` -> exit 1", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["run", "--unknown", "myscript"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-72: `loopx run -x myscript` -> exit 1 (short flag)", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["run", "-x", "myscript"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-86: `loopx run myscript --unknown` -> exit 1 + marker not created", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "myscript", writeValueToFile("executed", markerFile));

        const result = await runCLI(["run", "myscript", "--unknown"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(existsSync(markerFile)).toBe(false);
      });

      it("T-CLI-87: `loopx run myscript -x` -> exit 1 + marker not created", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "myscript", writeValueToFile("executed", markerFile));

        const result = await runCLI(["run", "myscript", "-x"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(existsSync(markerFile)).toBe(false);
      });

      it("T-CLI-88: `loopx run myscript -n 1 -n 2` -> exit 1 (duplicate -n after script)", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "myscript", writeValueToFile("executed", markerFile));

        const result = await runCLI(["run", "myscript", "-n", "1", "-n", "2"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(existsSync(markerFile)).toBe(false);
      });

      it("T-CLI-89: `loopx run myscript -e a.env -e b.env` -> exit 1 (duplicate -e after script)", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "myscript", writeValueToFile("executed", markerFile));
        await createEnvFile(join(project.dir, "a.env"), { A: "1" });

        const result = await runCLI(["run", "myscript", "-e", "a.env", "-e", "b.env"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(existsSync(markerFile)).toBe(false);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Missing Flag Operands
  // ─────────────────────────────────────────────

  describe("SPEC: Missing Flag Operands", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-97: `loopx run -n` (no operand, no script) -> exit 1", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-n"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-98: `loopx run -e` (no operand, no script) -> exit 1", async () => {
        project = await createTempProject();
        const result = await runCLI(["run", "-e"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-99: `loopx run myscript -n` (missing -n operand) -> exit 1", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "myscript", writeValueToFile("executed", markerFile));

        const result = await runCLI(["run", "myscript", "-n"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(existsSync(markerFile)).toBe(false);
      });

      it("T-CLI-100: `loopx run myscript -e` (missing -e operand) -> exit 1", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "myscript", writeValueToFile("executed", markerFile));

        const result = await runCLI(["run", "myscript", "-e"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(existsSync(markerFile)).toBe(false);
      });
    });
  });

  // ─────────────────────────────────────────────
  // CLI -e Option
  // ─────────────────────────────────────────────

  describe("SPEC: CLI -e Option", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-21: `loopx run -e .env -n 1 myscript` makes env vars available", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "marker.txt");
        const envFile = join(project.dir, ".env");
        await createEnvFile(envFile, { MY_TEST_VAR: "hello123" });
        await createScript(project, "myscript", ".sh", writeEnvToFile("MY_TEST_VAR", markerFile));

        const result = await runCLI(["run", "-e", ".env", "-n", "1", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerFile)).toBe(true);
        expect(readFileSync(markerFile, "utf-8")).toBe("hello123");
      });

      it("T-CLI-22: `loopx run -e nonexistent.env myscript` -> exit 1", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["run", "-e", "nonexistent.env", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stderr.toLowerCase()).toMatch(/nonexistent\.env|not found|no such/i);
      });

      it("T-CLI-22a: `loopx run -n 0 -e nonexistent.env myscript` -> exit 1", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(
          ["run", "-n", "0", "-e", "nonexistent.env", "myscript"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-22b: `loopx run -n 0 myscript` with name collision -> exit 1", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));
        await createScript(project, "myscript", ".ts", 'console.log("x");\n');

        const result = await runCLI(["run", "-n", "0", "myscript"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-22d: `loopx run -n 0 myscript` with invalid script name in .loopx/ -> exit 1", async () => {
        project = await createTempProject();
        await createBashScript(project, "myscript", emitResult("ok"));
        await createScript(project, "-bad", ".sh", emitResult("x"));

        const result = await runCLI(["run", "-n", "0", "myscript"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });
    });
  });

  // ─────────────────────────────────────────────
  // CLI Stdout Silence
  // ─────────────────────────────────────────────

  describe("SPEC: CLI Stdout Silence", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-23: CLI stdout is empty when script outputs result", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        const scriptBody = `#!/bin/bash
printf '{"result":"hello"}'
printf 'executed' > "${markerFile}"
`;
        await createScript(project, "myscript", ".sh", scriptBody);

        const result = await runCLI(["run", "-n", "1", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
        expect(existsSync(markerFile)).toBe(true);
        expect(readFileSync(markerFile, "utf-8")).toBe("executed");
      });
    });
  });

  // ─────────────────────────────────────────────
  // Multiple Positional Arguments
  // ─────────────────────────────────────────────

  describe("SPEC: Multiple Positional Arguments", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-27: `loopx run script1 script2` (two positionals) -> exit 1", async () => {
        project = await createTempProject();
        await createBashScript(project, "s1", emitResult("x"));

        const result = await runCLI(["run", "s1", "s2"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/unexpected/i);
      });

      it("T-CLI-96: `loopx run foo -n 1 bar` (extra positional interleaved) -> exit 1", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "ran.txt");
        await createBashScript(project, "foo", writeValueToFile("executed", markerFile));

        const result = await runCLI(["run", "foo", "-n", "1", "bar"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        expect(existsSync(markerFile)).toBe(false);
      });
    });
  });
});
