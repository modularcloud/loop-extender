import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createTempProject,
  createScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { createEnvFile } from "../helpers/env.js";
import {
  counter,
  emitResult,
  writeEnvToFile,
} from "../helpers/fixture-scripts.js";
import { forEachRuntime } from "../helpers/runtime.js";

/**
 * Read the loopx package version from its package.json.
 * The loopx binary lives at node_modules/.bin/loopx, so the package
 * should be resolvable from the project root.
 */
function getExpectedVersion(): string {
  // The loopx package.json should be at node_modules/loopx/package.json
  const pkgPath = resolve(process.cwd(), "node_modules/loopx/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version as string;
}

describe("SPEC: CLI Basics (T-CLI-01 through T-CLI-23)", () => {
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
        // Does not require .loopx/ to exist
        project = await createTempProject({ withLoopxDir: false });
        const result = await runCLI(["version"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);

        // Read the expected version from the loopx package
        const expectedVersion = getExpectedVersion();
        // Assert exact stdout is "${version}\n" — untrimmed comparison
        expect(result.stdout).toBe(`${expectedVersion}\n`);
      });

      it("T-CLI-02: `loopx -h` prints usage containing 'loopx' and 'usage', exits 0", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
      });

      it("T-CLI-03: `--help` produces the same output as `-h`", async () => {
        project = await createTempProject();
        const [shortResult, longResult] = await Promise.all([
          runCLI(["-h"], { cwd: project.dir, runtime }),
          runCLI(["--help"], { cwd: project.dir, runtime }),
        ]);

        expect(shortResult.exitCode).toBe(0);
        expect(longResult.exitCode).toBe(0);
        expect(longResult.stdout).toBe(shortResult.stdout);
      });

      it("T-CLI-04: `-h` with scripts lists discovered script names", async () => {
        project = await createTempProject();
        await createScript(
          project,
          "alpha",
          ".sh",
          emitResult("a"),
        );
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
        expect(result.stdout).toContain("alpha");
        expect(result.stdout).toContain("beta");
      });

      it("T-CLI-05: `-h` without `.loopx/` still prints help, no error", async () => {
        project = await createTempProject({ withLoopxDir: false });
        const result = await runCLI(["-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
      });

      it("T-CLI-06: `-h` with name collisions warns on stderr", async () => {
        project = await createTempProject();
        // Create two scripts with the same base name but different extensions
        await createScript(project, "dupe", ".sh", emitResult("x"));
        await createScript(project, "dupe", ".ts", 'console.log("x");\n');

        const result = await runCLI(["-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        // Help still prints
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        // Warnings about collisions on stderr
        expect(result.stderr.length).toBeGreaterThan(0);
        const stderrLower = result.stderr.toLowerCase();
        expect(stderrLower).toMatch(/collision|conflict|duplicate|dupe/);
      });

      it("T-CLI-07: `-h` with reserved names warns on stderr", async () => {
        project = await createTempProject();
        // "output" is a reserved name
        await createScript(project, "output", ".sh", emitResult("x"));

        const result = await runCLI(["-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        // Warnings about reserved names on stderr
        expect(result.stderr.length).toBeGreaterThan(0);
        const stderrLower = result.stderr.toLowerCase();
        expect(stderrLower).toMatch(/reserved|output/);
      });

      it("T-CLI-07a: `-h` lists script names with type info", async () => {
        project = await createTempProject();
        await createScript(project, "mybash", ".sh", emitResult("a"));
        await createScript(
          project,
          "myts",
          ".ts",
          'import { output } from "loopx";\noutput({ result: "b" });\n',
        );

        const result = await runCLI(["-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        // Script names appear in output
        expect(result.stdout).toContain("mybash");
        expect(result.stdout).toContain("myts");
        // Type info appears somewhere in the help text
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("sh");
        expect(lower).toContain("ts");
      });

      it("T-CLI-07b: `-n 5 -h` prints help (precedence)", async () => {
        project = await createTempProject();
        const result = await runCLI(["-n", "5", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
      });

      it("T-CLI-07c: `myscript -h` prints help (precedence)", async () => {
        project = await createTempProject();
        const result = await runCLI(["myscript", "-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
      });

      it("T-CLI-07d: `-h` with invalid script name warns, exits 0", async () => {
        project = await createTempProject();
        // Script name starts with dash, which violates name restrictions
        await createScript(project, "-startswithdash", ".sh", emitResult("x"));

        const result = await runCLI(["-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        // The invalid script is still listed in help output (spec 5.4)
        expect(result.stdout).toContain("-startswithdash");
        // Non-fatal warning on stderr about the invalid name
        expect(result.stderr.length).toBeGreaterThan(0);
      });

      it("T-CLI-07e: `-h version` prints help (precedence)", async () => {
        project = await createTempProject();
        const result = await runCLI(["-h", "version"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        expect(lower).toContain("usage");
        // The version subcommand does not execute — stdout should not
        // contain a bare version string as first line
      });

      it("T-CLI-07f: `-h env set FOO bar` prints help", async () => {
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

      it("T-CLI-07g: `-h --invalid-flag` prints help", async () => {
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

      it("T-CLI-07h: `-h` with bad package.json dir script warns on stderr", async () => {
        project = await createTempProject();
        // Create a directory script with invalid JSON in package.json
        const scriptDir = join(project.loopxDir, "badpkg");
        await mkdir(scriptDir, { recursive: true });
        await writeFile(join(scriptDir, "package.json"), "{invalid json}", "utf-8");
        await writeFile(join(scriptDir, "index.ts"), 'console.log("hi");\n', "utf-8");

        const result = await runCLI(["-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        const lower = result.stdout.toLowerCase();
        expect(lower).toContain("loopx");
        // The invalid directory script should NOT be listed in script listing
        expect(result.stdout).not.toContain("badpkg");
        // Warning on stderr about the invalid directory script
        expect(result.stderr.length).toBeGreaterThan(0);
      });

      it("T-CLI-07i: `-h` with main escaping directory warns on stderr", async () => {
        project = await createTempProject();
        // Create a directory script whose main escapes the directory
        const scriptDir = join(project.loopxDir, "escape");
        await mkdir(scriptDir, { recursive: true });
        await writeFile(
          join(scriptDir, "package.json"),
          JSON.stringify({ main: "../escape.ts" }),
          "utf-8",
        );
        // Create the escape target file outside the script directory
        await writeFile(
          join(project.loopxDir, "escape.ts"),
          'console.log("escaped");\n',
          "utf-8",
        );

        const result = await runCLI(["-h"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        // Warning on stderr about the escaping main
        expect(result.stderr.length).toBeGreaterThan(0);
      });

      it("T-CLI-07j: `-h -e nonexistent.env` prints help", async () => {
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
    });
  });

  // ─────────────────────────────────────────────
  // Default Script Invocation
  // ─────────────────────────────────────────────

  describe("SPEC: Default Script Invocation", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-08: no script name with default.ts runs default", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");
        await createScript(
          project,
          "default",
          ".sh",
          counter(counterFile),
        );

        const result = await runCLI(["-n", "1"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        // The counter file should exist and contain exactly 1 mark
        expect(existsSync(counterFile)).toBe(true);
        const content = readFileSync(counterFile, "utf-8");
        expect(content).toBe("1");
      });

      it("T-CLI-09: no script name, no default -> exit 1", async () => {
        project = await createTempProject();
        // .loopx/ exists but has no default script

        const result = await runCLI([], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        // Stderr mentions "default" and suggests script creation
        const stderrLower = result.stderr.toLowerCase();
        expect(stderrLower).toContain("default");
      });

      it("T-CLI-10: .loopx/ missing -> exit 1", async () => {
        project = await createTempProject({ withLoopxDir: false });

        const result = await runCLI([], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        // Provides a helpful error message
        expect(result.stderr.length).toBeGreaterThan(0);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Named Script Invocation
  // ─────────────────────────────────────────────

  describe("SPEC: Named Script Invocation", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-11: named script invocation runs script", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");
        await createScript(
          project,
          "myscript",
          ".sh",
          counter(counterFile),
        );

        const result = await runCLI(["-n", "1", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(counterFile)).toBe(true);
        const content = readFileSync(counterFile, "utf-8");
        expect(content).toBe("1");
      });

      it("T-CLI-12: nonexistent script -> exit 1", async () => {
        project = await createTempProject();

        const result = await runCLI(["nonexistent"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-13: explicit `default` runs default script", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");
        await createScript(
          project,
          "default",
          ".sh",
          counter(counterFile),
        );

        const result = await runCLI(["-n", "1", "default"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(counterFile)).toBe(true);
        const content = readFileSync(counterFile, "utf-8");
        expect(content).toBe("1");
      });
    });
  });

  // ─────────────────────────────────────────────
  // CLI -n Option
  // ─────────────────────────────────────────────

  describe("SPEC: CLI -n Option", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-14: `-n 3` runs exactly 3 iterations", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");
        await createScript(
          project,
          "myscript",
          ".sh",
          counter(counterFile),
        );

        const result = await runCLI(["-n", "3", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(counterFile)).toBe(true);
        const content = readFileSync(counterFile, "utf-8");
        expect(content).toBe("111");
      });

      it("T-CLI-15: `-n 0` exits 0 without running script", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");
        await createScript(
          project,
          "myscript",
          ".sh",
          counter(counterFile),
        );

        const result = await runCLI(["-n", "0", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        // Counter file should not exist or be empty (script never ran)
        if (existsSync(counterFile)) {
          const content = readFileSync(counterFile, "utf-8");
          expect(content).toBe("");
        }
      });

      it("T-CLI-16: `-n -1` -> exit 1", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["-n", "-1", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-17: `-n 1.5` -> exit 1", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["-n", "1.5", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-18: `-n abc` -> exit 1", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["-n", "abc", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-19: `-n 0` with missing script -> exit 1 (validation before short-circuit)", async () => {
        project = await createTempProject();
        // .loopx/ exists but no default script

        const result = await runCLI(["-n", "0"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        // Stderr contains an error about the missing script
        const stderrLower = result.stderr.toLowerCase();
        expect(stderrLower).toContain("default");
      });

      it("T-CLI-19a: `-n 0` with .loopx/ missing -> exit 1", async () => {
        project = await createTempProject({ withLoopxDir: false });

        const result = await runCLI(["-n", "0"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        // Stderr contains an error about missing .loopx/ directory
        expect(result.stderr.length).toBeGreaterThan(0);
      });

      it("T-CLI-20: `-n 1` runs exactly 1 iteration", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "counter.txt");
        await createScript(
          project,
          "myscript",
          ".sh",
          counter(counterFile),
        );

        const result = await runCLI(["-n", "1", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(counterFile)).toBe(true);
        const content = readFileSync(counterFile, "utf-8");
        expect(content).toBe("1");
      });
    });
  });

  // ─────────────────────────────────────────────
  // Duplicate Flags
  // ─────────────────────────────────────────────

  describe("SPEC: Duplicate Flags", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-20a: duplicate `-n` -> exit 1", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["-n", "3", "-n", "5", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-20b: duplicate `-e` -> exit 1", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const env1 = join(project.dir, ".env1");
        const env2 = join(project.dir, ".env2");
        await createEnvFile(env1, { FOO: "bar" });
        await createEnvFile(env2, { BAZ: "qux" });

        const result = await runCLI(
          ["-e", ".env1", "-e", ".env2", "myscript"],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
      });
    });
  });

  // ─────────────────────────────────────────────
  // CLI -e Option
  // ─────────────────────────────────────────────

  describe("SPEC: CLI -e Option", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-21: `-e .env -n 1` makes env vars available", async () => {
        project = await createTempProject();
        const markerFile = join(project.dir, "marker.txt");
        const envFile = join(project.dir, ".env");
        await createEnvFile(envFile, { MY_TEST_VAR: "hello123" });

        // Script writes the env var value to a marker file
        await createScript(
          project,
          "myscript",
          ".sh",
          writeEnvToFile("MY_TEST_VAR", markerFile),
        );

        const result = await runCLI(["-e", ".env", "-n", "1", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerFile)).toBe(true);
        const content = readFileSync(markerFile, "utf-8");
        expect(content).toBe("hello123");
      });

      it("T-CLI-22: `-e nonexistent.env` -> exit 1", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(["-e", "nonexistent.env", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        // Stderr mentions the missing file
        expect(result.stderr.length).toBeGreaterThan(0);
      });

      it("T-CLI-22a: `-n 0 -e nonexistent.env` -> exit 1 (env validation before -n 0 short-circuit)", async () => {
        project = await createTempProject();
        await createScript(project, "myscript", ".sh", emitResult("x"));

        const result = await runCLI(
          ["-n", "0", "-e", "nonexistent.env", "myscript"],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-22b: `-n 0` with name collision -> exit 1 (validation before short-circuit)", async () => {
        project = await createTempProject();
        // Create a name collision: same base name, different extensions
        await createScript(project, "dupe", ".sh", emitResult("x"));
        await createScript(project, "dupe", ".ts", 'console.log("x");\n');

        const result = await runCLI(["-n", "0", "dupe"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-22c: `-n 0` with reserved name -> exit 1", async () => {
        project = await createTempProject();
        // "env" is a reserved name
        await createScript(project, "env", ".sh", emitResult("x"));

        const result = await runCLI(["-n", "0", "env"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-CLI-22d: `-n 0` with invalid script name -> exit 1", async () => {
        project = await createTempProject();
        // Script name starts with dash, violating name restrictions
        await createScript(project, "-bad", ".sh", emitResult("x"));

        const result = await runCLI(["-n", "0", "-bad"], {
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

        // Script outputs a result AND writes a marker file to prove it ran
        const scriptBody = `#!/bin/bash
printf '{"result":"hello"}'
printf 'executed' > "${markerFile}"
`;
        await createScript(project, "myscript", ".sh", scriptBody);

        const result = await runCLI(["-n", "1", "myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        // CLI stdout must be empty — the result is not printed
        expect(result.stdout).toBe("");
        // The marker file must exist — proving the script actually ran
        expect(existsSync(markerFile)).toBe(true);
        const markerContent = readFileSync(markerFile, "utf-8");
        expect(markerContent).toBe("executed");
      });
    });
  });
});
