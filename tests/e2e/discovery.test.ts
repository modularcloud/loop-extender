import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, symlinkSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  createTempProject,
  createScript,
  createDirScript,
  createBashScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { writeValueToFile, emitResult } from "../helpers/fixture-scripts.js";

describe("SPEC: Script Discovery & Validation", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  // =========================================================================
  // File Script Discovery (T-DISC-01 through T-DISC-10)
  // =========================================================================
  describe("SPEC: File Script Discovery", () => {
    it("T-DISC-01: .sh file is discoverable and runs", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-01.txt");
      await createScript(project, "myscript", ".sh", writeValueToFile("disc01", marker));

      const result = await runCLI(["run", "-n", "1", "myscript"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc01");
    });

    it("T-DISC-02: .js file is discoverable and runs", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-02.txt");
      await createScript(
        project,
        "myscript",
        ".js",
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc02");\n`
      );

      const result = await runCLI(["run", "-n", "1", "myscript"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc02");
    });

    it("T-DISC-03: .jsx file is discoverable and runs", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-03.txt");
      await createScript(
        project,
        "myscript",
        ".jsx",
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc03");\n`
      );

      const result = await runCLI(["run", "-n", "1", "myscript"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc03");
    });

    it("T-DISC-04: .ts file is discoverable and runs", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-04.txt");
      await createScript(
        project,
        "myscript",
        ".ts",
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc04");\n`
      );

      const result = await runCLI(["run", "-n", "1", "myscript"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc04");
    });

    it("T-DISC-05: .tsx file is discoverable and runs", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-05.txt");
      await createScript(
        project,
        "myscript",
        ".tsx",
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc05");\n`
      );

      const result = await runCLI(["run", "-n", "1", "myscript"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc05");
    });

    it("T-DISC-06: .mjs file is NOT discoverable", async () => {
      project = await createTempProject();
      await createScript(
        project,
        "myscript",
        ".mjs",
        `import { writeFileSync } from "node:fs";\nwriteFileSync("/dev/null", "should-not-run");\n`
      );

      const result = await runCLI(["run", "-n", "1", "myscript"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/not found/i);
    });

    it("T-DISC-07: .cjs file is NOT discoverable", async () => {
      project = await createTempProject();
      await createScript(
        project,
        "myscript",
        ".cjs",
        `const fs = require("node:fs");\nfs.writeFileSync("/dev/null", "should-not-run");\n`
      );

      const result = await runCLI(["run", "-n", "1", "myscript"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-08: .txt file is NOT discoverable", async () => {
      project = await createTempProject();
      await createScript(project, "myscript", ".txt", "some text content\n");

      const result = await runCLI(["run", "-n", "1", "myscript"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-09: file with no extension is NOT discoverable", async () => {
      project = await createTempProject();
      // createScript with empty ext creates a file with no extension
      await createScript(project, "myscript", "", "#!/bin/bash\necho hello\n");

      const result = await runCLI(["run", "-n", "1", "myscript"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-10: script name is base name without extension", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-10.txt");
      await createScript(
        project,
        "my-script",
        ".ts",
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc10");\n`
      );

      // Invoke by base name (no extension)
      const result = await runCLI(["run", "-n", "1", "my-script"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc10");
    });
  });

  // =========================================================================
  // Directory Script Discovery (T-DISC-11 through T-DISC-17)
  // =========================================================================
  describe("SPEC: Directory Script Discovery", () => {
    it("T-DISC-11: directory with package.json main=index.ts is discoverable", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-11.txt");
      await createDirScript(project, "mypipe", "index.ts", {
        "index.ts": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc11");\n`,
      });

      const result = await runCLI(["run", "-n", "1", "mypipe"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc11");
    });

    it("T-DISC-11a: directory with package.json main=src/index.ts (subpath) is discoverable", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-11a.txt");
      await createDirScript(project, "mypipe", "src/index.ts", {
        "src/index.ts": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc11a");\n`,
      });

      const result = await runCLI(["run", "-n", "1", "mypipe"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc11a");
    });

    it("T-DISC-12: directory with no package.json is ignored", async () => {
      project = await createTempProject();
      const dirPath = join(project.loopxDir, "nopackage");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, "index.ts"), `console.log("hello");\n`);

      const result = await runCLI(["run", "-n", "1", "nopackage"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-13: directory with package.json but no main field is ignored", async () => {
      project = await createTempProject();
      const dirPath = join(project.loopxDir, "nomain");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, "package.json"), JSON.stringify({ name: "nomain" }));
      writeFileSync(join(dirPath, "index.ts"), `console.log("hello");\n`);

      const result = await runCLI(["run", "-n", "1", "nomain"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-14: directory with main=index.sh (bash entry point) is discoverable", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-14.txt");
      await createDirScript(project, "mypipe", "index.sh", {
        "index.sh": writeValueToFile("disc14", marker),
      });

      const result = await runCLI(["run", "-n", "1", "mypipe"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc14");
    });

    it("T-DISC-14a: directory with main=index.js is discoverable", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-14a.txt");
      await createDirScript(project, "mypipe", "index.js", {
        "index.js": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc14a");\n`,
      });

      const result = await runCLI(["run", "-n", "1", "mypipe"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc14a");
    });

    it("T-DISC-14b: directory with main=index.jsx is discoverable", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-14b.txt");
      await createDirScript(project, "mypipe", "index.jsx", {
        "index.jsx": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc14b");\n`,
      });

      const result = await runCLI(["run", "-n", "1", "mypipe"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc14b");
    });

    it("T-DISC-14c: directory with main=index.tsx is discoverable", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-14c.txt");
      await createDirScript(project, "mypipe", "index.tsx", {
        "index.tsx": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc14c");\n`,
      });

      const result = await runCLI(["run", "-n", "1", "mypipe"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc14c");
    });

    it("T-DISC-15: directory with main=index.py (unsupported ext) emits warning, ignored", async () => {
      project = await createTempProject();
      await createDirScript(project, "mypipe", "index.py", {
        "index.py": `print("hello")\n`,
      });

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.stderr).toMatch(/mypipe|\.py|unsupported|warning/i);
    });

    it("T-DISC-16: directory with main escaping directory boundary emits warning, ignored", async () => {
      project = await createTempProject();
      // Create the escape target outside the directory script
      writeFileSync(join(project.loopxDir, "escape.ts"), `console.log("escaped");\n`);
      await createDirScript(project, "mypipe", "../escape.ts", {
        // No files needed inside the dir for this test
      });

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.stderr).toMatch(/mypipe|escape|warning|boundary/i);
    });

    it("T-DISC-16a: directory with invalid JSON in package.json emits warning, ignored", async () => {
      project = await createTempProject();
      const dirPath = join(project.loopxDir, "mypipe");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, "package.json"), "{invalid}");

      const result = await runCLI(["run", "-n", "1", "mypipe"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);

      // Also check that help mode emits a warning
      const helpResult = await runCLI(["run", "-h"], { cwd: project.dir });
      expect(helpResult.stderr).toMatch(/mypipe|invalid|warning|parse|json/i);
    });

    it("T-DISC-16b: directory with unreadable package.json emits warning, ignored", async () => {
      // Skip if running as root (root can read any file)
      if (process.getuid?.() === 0) {
        return;
      }

      project = await createTempProject();
      const dirPath = join(project.loopxDir, "mypipe");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, "package.json"), JSON.stringify({ main: "index.ts" }));
      writeFileSync(join(dirPath, "index.ts"), `console.log("hello");\n`);
      // Remove read permissions
      chmodSync(join(dirPath, "package.json"), 0o000);

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.stderr).toMatch(/mypipe|unreadable|warning|permission/i);

      // Restore permissions for cleanup
      chmodSync(join(dirPath, "package.json"), 0o644);
    });

    it("T-DISC-16c: directory with non-string main field emits warning, ignored", async () => {
      project = await createTempProject();
      const dirPath = join(project.loopxDir, "mypipe");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, "package.json"), JSON.stringify({ main: 42 }));

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.stderr).toMatch(/mypipe|main|warning|string/i);
    });

    it("T-DISC-16d: directory with main pointing to nonexistent file emits warning, ignored", async () => {
      project = await createTempProject();
      const dirPath = join(project.loopxDir, "mypipe");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, "package.json"), JSON.stringify({ main: "missing.ts" }));

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.stderr).toMatch(/mypipe|missing|warning|not found|exist/i);
    });

    it("T-DISC-17: script name is directory name", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-17.txt");
      await createDirScript(project, "my-pipeline", "index.ts", {
        "index.ts": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc17");\n`,
      });

      // Invoke by directory name
      const result = await runCLI(["run", "-n", "1", "my-pipeline"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc17");
    });
  });

  // =========================================================================
  // Name Collisions (T-DISC-18 through T-DISC-21)
  // =========================================================================
  describe("SPEC: Name Collisions", () => {
    it("T-DISC-18: file.sh and file.ts with same base name cause collision error", async () => {
      project = await createTempProject();
      await createBashScript(project, "example", "echo hello");
      await createScript(project, "example", ".ts", `console.log("hello");\n`);

      const result = await runCLI(["run", "-n", "1", "example"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/example/i);
      expect(result.stderr).toMatch(/collision|conflict|duplicate|multiple/i);
    });

    it("T-DISC-19: file.ts and directory script with same name cause collision error", async () => {
      project = await createTempProject();
      await createScript(project, "example", ".ts", `console.log("hello");\n`);
      await createDirScript(project, "example", "index.ts", {
        "index.ts": `console.log("hello dir");\n`,
      });

      const result = await runCLI(["run", "-n", "1", "example"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/example/i);
      expect(result.stderr).toMatch(/collision|conflict|duplicate|multiple/i);
    });

    it("T-DISC-20: three-way collision lists all conflicting entries", async () => {
      project = await createTempProject();
      await createBashScript(project, "example", "echo hello");
      await createScript(project, "example", ".js", `console.log("hello");\n`);
      await createDirScript(project, "example", "index.ts", {
        "index.ts": `console.log("hello dir");\n`,
      });

      const result = await runCLI(["run", "-n", "1", "example"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/example/i);
      // The error should list all conflicting entries
      expect(result.stderr).toMatch(/\.sh/);
      expect(result.stderr).toMatch(/\.js/);
    });

    it("T-DISC-21: non-conflicting scripts with different names coexist", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-21.txt");
      await createScript(project, "alpha", ".sh", writeValueToFile("disc21", marker));
      await createScript(project, "beta", ".ts", `console.log("beta");\n`);

      const result = await runCLI(["run", "-n", "1", "alpha"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc21");
    });
  });

  // =========================================================================
  // Formerly Reserved Names (T-DISC-22 through T-DISC-26)
  // ADR-0002: reserved names eliminated — these are now ordinary scripts
  // =========================================================================
  describe("SPEC: Formerly Reserved Names", () => {
    it("T-DISC-22: output.sh is discoverable and runs via loopx run", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-22.txt");
      await createScript(project, "output", ".sh", writeValueToFile("disc22", marker));

      const result = await runCLI(["run", "-n", "1", "output"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc22");
    });

    it("T-DISC-23: env.ts is discoverable and runs via loopx run", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-23.txt");
      await createScript(
        project,
        "env",
        ".ts",
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc23");\n`
      );

      const result = await runCLI(["run", "-n", "1", "env"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc23");
    });

    it("T-DISC-24: install.js is discoverable and runs via loopx run", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-24.txt");
      await createScript(
        project,
        "install",
        ".js",
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc24");\n`
      );

      const result = await runCLI(["run", "-n", "1", "install"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc24");
    });

    it("T-DISC-25: version.sh is discoverable and runs via loopx run", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-25.txt");
      await createScript(project, "version", ".sh", writeValueToFile("disc25", marker));

      const result = await runCLI(["run", "-n", "1", "version"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc25");
    });

    it("T-DISC-26: run.sh is discoverable and runs via loopx run", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-26.txt");
      await createScript(project, "run", ".sh", writeValueToFile("disc26", marker));

      const result = await runCLI(["run", "-n", "1", "run"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc26");
    });

    it("T-DISC-51: loopx run -h with only formerly-reserved-named scripts lists all five, stderr empty", async () => {
      project = await createTempProject();
      await createScript(project, "version", ".sh", writeValueToFile("v", join(project.dir, "m.txt")));
      await createScript(project, "output", ".sh", writeValueToFile("o", join(project.dir, "m.txt")));
      await createScript(
        project,
        "env",
        ".ts",
        `import { writeFileSync } from "node:fs";\nwriteFileSync("/dev/null", "e");\n`
      );
      await createScript(
        project,
        "install",
        ".js",
        `import { writeFileSync } from "node:fs";\nwriteFileSync("/dev/null", "i");\n`
      );
      await createScript(project, "run", ".sh", writeValueToFile("r", join(project.dir, "m.txt")));

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/version/);
      expect(result.stdout).toMatch(/output/);
      expect(result.stdout).toMatch(/env/);
      expect(result.stdout).toMatch(/install/);
      expect(result.stdout).toMatch(/run/);
      expect(result.stderr).toBe("");
    });

    it("T-DISC-52: directory script named version is discoverable and runs via loopx run", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-52.txt");
      await createDirScript(project, "version", "index.ts", {
        "index.ts": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc52");\n`,
      });

      const result = await runCLI(["run", "-n", "1", "version"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc52");
    });

    it("T-DISC-53: loopx run -h with only version/ directory script lists it, stderr empty", async () => {
      project = await createTempProject();
      await createDirScript(project, "version", "index.ts", {
        "index.ts": `import { writeFileSync } from "node:fs";\nwriteFileSync("/dev/null", "disc53");\n`,
      });

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/version/);
      expect(result.stderr).toBe("");
    });
  });

  // =========================================================================
  // Name Restrictions (T-DISC-27 through T-DISC-32)
  // =========================================================================
  describe("SPEC: Name Restrictions", () => {
    it("T-DISC-27: name starting with dash is rejected", async () => {
      project = await createTempProject();
      await createBashScript(project, "-startswithdash", "echo hello");

      const result = await runCLI(["run", "-n", "1", "-startswithdash"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-28: hyphen in middle of name is valid", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-28.txt");
      await createScript(project, "my-script", ".sh", writeValueToFile("disc28", marker));

      const result = await runCLI(["run", "-n", "1", "my-script"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc28");
    });

    it("T-DISC-29: underscore prefix is valid", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-29.txt");
      await createScript(project, "_underscore", ".sh", writeValueToFile("disc29", marker));

      const result = await runCLI(["run", "-n", "1", "_underscore"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc29");
    });

    it("T-DISC-30: alphanumeric name is valid", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-30.txt");
      await createScript(project, "ABC123", ".sh", writeValueToFile("disc30", marker));

      const result = await runCLI(["run", "-n", "1", "ABC123"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc30");
    });

    it("T-DISC-30a: digit as first character is valid", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-30a.txt");
      await createScript(project, "1start", ".sh", writeValueToFile("disc30a", marker));

      const result = await runCLI(["run", "-n", "1", "1start"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc30a");
    });

    it("T-DISC-30b: all-digit name is valid", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-30b.txt");
      await createScript(project, "42", ".sh", writeValueToFile("disc30b", marker));

      const result = await runCLI(["run", "-n", "1", "42"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc30b");
    });

    it("T-DISC-31: name with space is rejected", async () => {
      project = await createTempProject();
      await createBashScript(project, "has space", "echo hello");

      const result = await runCLI(["run", "-n", "1", "has space"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-32: name with dot is rejected", async () => {
      project = await createTempProject();
      // The base name "has.dot" (from "has.dot.sh") contains a dot which is not allowed
      await createBashScript(project, "has.dot", "echo hello");

      const result = await runCLI(["run", "-n", "1", "has.dot"], { cwd: project.dir });

      expect(result.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // Symlinks (T-DISC-33 through T-DISC-36)
  // =========================================================================
  describe("SPEC: Symlinks", () => {
    it("T-DISC-33: symlink to a .ts file inside .loopx/ is followed and discoverable", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-33.txt");

      // Create the real file somewhere outside .loopx/
      const realFile = join(project.dir, "real-script.ts");
      writeFileSync(
        realFile,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc33");\n`
      );

      // Create a symlink in .loopx/ pointing to it
      symlinkSync(realFile, join(project.loopxDir, "linked.ts"));

      const result = await runCLI(["run", "-n", "1", "linked"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc33");
    });

    it("T-DISC-34: symlinked directory in .loopx/ with valid package.json is discoverable", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-34.txt");

      // Create a real directory outside .loopx/
      const realDir = join(project.dir, "real-pipe");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(
        join(realDir, "package.json"),
        JSON.stringify({ main: "index.ts" })
      );
      writeFileSync(
        join(realDir, "index.ts"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc34");\n`
      );

      // Create a symlink in .loopx/ pointing to it
      symlinkSync(realDir, join(project.loopxDir, "linked-pipe"));

      const result = await runCLI(["run", "-n", "1", "linked-pipe"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc34");
    });

    it("T-DISC-35: directory script whose main is a symlink to file within the directory is valid", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-35.txt");

      // Create directory script
      const dirPath = join(project.loopxDir, "mypipe");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(
        join(dirPath, "package.json"),
        JSON.stringify({ main: "entry.ts" })
      );

      // Create real file in the directory
      const realFile = join(dirPath, "real-entry.ts");
      writeFileSync(
        realFile,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "disc35");\n`
      );

      // Create symlink from entry.ts -> real-entry.ts (within the directory)
      symlinkSync(realFile, join(dirPath, "entry.ts"));

      const result = await runCLI(["run", "-n", "1", "mypipe"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc35");
    });

    it("T-DISC-36: directory script whose main is a symlink resolving outside the directory emits warning, ignored", async () => {
      project = await createTempProject();

      // Create a file outside the directory script
      const outsideFile = join(project.dir, "outside.ts");
      writeFileSync(outsideFile, `console.log("outside");\n`);

      // Create directory script
      const dirPath = join(project.loopxDir, "mypipe");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(
        join(dirPath, "package.json"),
        JSON.stringify({ main: "entry.ts" })
      );

      // Create symlink from entry.ts -> outside file (escapes directory)
      symlinkSync(outsideFile, join(dirPath, "entry.ts"));

      const result = await runCLI(["run", "-h"], { cwd: project.dir });

      expect(result.stderr).toMatch(/mypipe|warning|outside|escape|boundary/i);
    });
  });

  // =========================================================================
  // Discovery Caching (T-DISC-37 through T-DISC-38b)
  // =========================================================================
  describe("SPEC: Discovery Caching", () => {
    it("T-DISC-37: new script created mid-loop is not discoverable (cached at loop start)", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-37.txt");
      const counterFile = join(project.dir, "counter-37.txt");

      // Script A: on first call, creates a new script "newscript.sh" in .loopx/,
      // then outputs goto:"newscript"
      const newScriptPath = join(project.loopxDir, "newscript.sh");
      const scriptABody = [
        `COUNT_FILE="${counterFile}"`,
        `printf '1' >> "$COUNT_FILE"`,
        `COUNT=$(wc -c < "$COUNT_FILE" | tr -d ' ')`,
        `if [ "$COUNT" = "1" ]; then`,
        `  cat > "${newScriptPath}" << 'INNEREOF'`,
        `#!/bin/bash`,
        `printf '%s' 'newscript-ran' > "${marker}"`,
        `INNEREOF`,
        `  chmod +x "${newScriptPath}"`,
        `  printf '{"goto":"newscript"}'`,
        `else`,
        `  printf '{"result":"done"}'`,
        `fi`,
      ].join("\n");

      await createBashScript(project, "scripta", scriptABody);

      // Run with -n 3 so there are enough iterations for goto
      const result = await runCLI(["run", "-n", "3", "scripta"], { cwd: project.dir });

      // The goto to "newscript" should fail because it was not in the cached discovery
      expect(result.exitCode).toBe(1);
      // The marker should NOT exist — newscript never ran
      expect(existsSync(marker)).toBe(false);
    });

    it("T-DISC-38: content changes to discovered script take effect on next iteration", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-38.txt");
      const counterFile = join(project.dir, "counter-38.txt");
      const scriptPath = join(project.loopxDir, "mutator.sh");

      // Script "mutator": on first call, rewrites its own content to write a different value,
      // then outputs result (no goto, loop resets to starting target = mutator)
      const initialBody = [
        `#!/bin/bash`,
        `COUNT_FILE="${counterFile}"`,
        `printf '1' >> "$COUNT_FILE"`,
        `COUNT=$(wc -c < "$COUNT_FILE" | tr -d ' ')`,
        `if [ "$COUNT" = "1" ]; then`,
        `  # Rewrite own content for next iteration`,
        `  cat > "${scriptPath}" << 'REWRITE'`,
        `#!/bin/bash`,
        `printf '%s' 'mutated' > "${marker}"`,
        `printf '{"result":"done"}'`,
        `REWRITE`,
        `  chmod +x "${scriptPath}"`,
        `  printf '{"result":"first"}'`,
        `else`,
        `  printf '{"result":"unexpected"}'`,
        `fi`,
      ].join("\n");

      writeFileSync(scriptPath, initialBody + "\n");
      chmodSync(scriptPath, 0o755);

      const result = await runCLI(["run", "-n", "2", "mutator"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      // The second iteration should have used the mutated content
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("mutated");
    });

    it("T-DISC-38a: removed script fails at spawn time", async () => {
      project = await createTempProject();
      const scriptBPath = join(project.loopxDir, "scriptb.sh");

      // Script A: deletes script B's file, then outputs goto:"scriptb"
      const scriptABody = [
        `rm -f "${scriptBPath}"`,
        `printf '{"goto":"scriptb"}'`,
      ].join("\n");

      await createBashScript(project, "scripta", scriptABody);
      await createBashScript(project, "scriptb", `printf '{"result":"b-ran"}'`);

      const result = await runCLI(["run", "-n", "3", "scripta"], { cwd: project.dir });

      // When loopx tries to spawn scriptb, the file is gone
      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-38b: renamed script fails at spawn time (cached path becomes stale)", async () => {
      project = await createTempProject();
      const scriptBPath = join(project.loopxDir, "scriptb.sh");
      const renamedPath = join(project.loopxDir, "scriptb-renamed.sh");

      // Script A: renames script B, then outputs goto:"scriptb"
      const scriptABody = [
        `mv "${scriptBPath}" "${renamedPath}"`,
        `printf '{"goto":"scriptb"}'`,
      ].join("\n");

      await createBashScript(project, "scripta", scriptABody);
      await createBashScript(project, "scriptb", `printf '{"result":"b-ran"}'`);

      const result = await runCLI(["run", "-n", "3", "scripta"], { cwd: project.dir });

      // The cached path for "scriptb" no longer exists
      expect(result.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // Run-Mode Discovery Warnings (T-DISC-50)
  // =========================================================================
  describe("SPEC: Run-Mode Discovery Warnings", () => {
    it("T-DISC-50: valid script runs successfully while invalid directory emits warning on stderr", async () => {
      project = await createTempProject();
      const marker = join(project.dir, "marker-50.txt");

      // Create a valid script
      await createScript(project, "good", ".sh", writeValueToFile("disc50", marker));

      // Create an invalid directory script (malformed package.json)
      const badDir = join(project.loopxDir, "bad");
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, "package.json"), "{invalid json}");

      const result = await runCLI(["run", "-n", "1", "good"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("disc50");
      // Stderr should contain a warning about the invalid directory script
      expect(result.stderr).toMatch(/bad|warning|invalid|json/i);
    });
  });

  // =========================================================================
  // Validation Scope (T-DISC-39 through T-DISC-46b)
  // =========================================================================
  describe("SPEC: Validation Scope", () => {
    it("T-DISC-39: loopx version works when .loopx/ does not exist", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const result = await runCLI(["version"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("T-DISC-40: loopx env set works when .loopx/ does not exist, env list shows variable", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const setResult = await runCLI(["env", "set", "X", "Y"], { cwd: project.dir });
      expect(setResult.exitCode).toBe(0);
      expect(setResult.stderr).not.toMatch(/collision|conflict|reserved|warning/i);

      const listResult = await runCLI(["env", "list"], { cwd: project.dir });
      expect(listResult.exitCode).toBe(0);
      expect(listResult.stdout).toContain("X=Y");
      expect(listResult.stderr).not.toMatch(/collision|conflict|reserved|warning/i);
    });

    it("T-DISC-41: loopx output --result works when .loopx/ does not exist", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const result = await runCLI(["output", "--result", "x"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.result).toBe("x");
      expect(result.stderr).not.toMatch(/collision|conflict|reserved|warning/i);
    });

    it("T-DISC-42: `loopx` (no args) shows top-level help and exits 0, even without .loopx/", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const result = await runCLI([], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it("T-DISC-43: loopx version works when .loopx/ has collisions (no validation)", async () => {
      project = await createTempProject();
      // Create name collision
      await createBashScript(project, "example", "echo hello");
      await createScript(project, "example", ".ts", `console.log("hello");\n`);

      const result = await runCLI(["version"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(result.stderr).not.toMatch(/collision|conflict|reserved|warning/i);
    });

    it("T-DISC-44: loopx env set works when .loopx/ has collisions (no validation)", async () => {
      project = await createTempProject();
      // Create collision
      await createBashScript(project, "example", "echo hello");
      await createScript(project, "example", ".ts", `console.log("hello");\n`);

      const setResult = await runCLI(["env", "set", "X", "Y"], { cwd: project.dir });
      expect(setResult.exitCode).toBe(0);
      expect(setResult.stderr).not.toMatch(/collision|conflict|reserved|warning/i);

      const listResult = await runCLI(["env", "list"], { cwd: project.dir });
      expect(listResult.exitCode).toBe(0);
      expect(listResult.stdout).toContain("X=Y");
      expect(listResult.stderr).not.toMatch(/collision|conflict|reserved|warning/i);
    });

    it("T-DISC-45: loopx output --result works when .loopx/ has name restriction violations (no validation)", async () => {
      project = await createTempProject();
      await createScript(project, "-bad", ".sh", emitResult("x"));
      await createScript(project, ".dotfile", ".sh", emitResult("x"));

      const result = await runCLI(["output", "--result", "x"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.result).toBe("x");
      expect(result.stderr).not.toMatch(/collision|conflict|reserved|warning/i);
    });

    it("T-DISC-46: loopx install succeeds when .loopx/ has collisions (no script validation)", async () => {
      project = await createTempProject();
      // Create collision
      await createBashScript(project, "example", "echo hello");
      await createScript(project, "example", ".ts", `console.log("hello");\n`);

      // We need a valid install source. Use a local file URL for a single-file install.
      // Create a temporary script file to install from
      const installSource = join(project.dir, "remote-script.ts");
      writeFileSync(installSource, `console.log("installed");\n`);

      const result = await runCLI(["install", `file://${installSource}`], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      // Verify the installed script is present
      expect(existsSync(join(project.loopxDir, "remote-script.ts"))).toBe(true);
      expect(result.stderr).not.toMatch(/collision|conflict|reserved|warning.*existing/i);
    });

    it("T-DISC-46a: loopx env remove when .loopx/ does not exist exits 0 (silent no-op)", async () => {
      project = await createTempProject({ withLoopxDir: false });

      const result = await runCLI(["env", "remove", "X"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toMatch(/collision|conflict|reserved|warning/i);
    });

    it("T-DISC-46b: loopx env remove when .loopx/ has collisions exits 0 (no script validation)", async () => {
      project = await createTempProject();
      // Create collision
      await createBashScript(project, "example", "echo hello");
      await createScript(project, "example", ".ts", `console.log("hello");\n`);

      const result = await runCLI(["env", "remove", "X"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toMatch(/collision|conflict|reserved|warning/i);
    });
  });

  // =========================================================================
  // Discovery Scope (T-DISC-47, T-DISC-49)
  // =========================================================================
  describe("SPEC: Discovery Scope", () => {
    it("T-DISC-47: parent directory .loopx/ is not discovered", async () => {
      project = await createTempProject();
      // Create a script in the parent's .loopx/
      await createBashScript(project, "myscript", "echo hello");

      // Create a child directory without .loopx/
      const childDir = join(project.dir, "child");
      mkdirSync(childDir, { recursive: true });

      // Run loopx from the child directory
      const result = await runCLI(["run", "-n", "1", "myscript"], { cwd: childDir });

      // The parent's .loopx/ should not be found
      expect(result.exitCode).toBe(1);
    });

    it("T-DISC-49: nested .ts file in non-script subdirectory is NOT discovered", async () => {
      project = await createTempProject();
      // Create .loopx/subdir/nested.ts (subdir has no package.json)
      const subdir = join(project.loopxDir, "subdir");
      mkdirSync(subdir, { recursive: true });
      writeFileSync(
        join(subdir, "nested.ts"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync("/dev/null", "should-not-run");\n`
      );

      const result = await runCLI(["run", "-n", "1", "nested"], { cwd: project.dir });

      // "nested" should not be discoverable
      expect(result.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // Cached package.json main (T-DISC-48)
  // =========================================================================
  describe("SPEC: Cached package.json main", () => {
    it("T-DISC-48: changing package.json main between iterations does not affect cached entry point", async () => {
      project = await createTempProject();
      const marker1 = join(project.dir, "marker-48-original.txt");
      const marker2 = join(project.dir, "marker-48-changed.txt");
      const counterFile = join(project.dir, "counter-48.txt");

      // Create a directory script "mypipe" with main=original.ts
      const pipeDir = join(project.loopxDir, "mypipe");
      mkdirSync(pipeDir, { recursive: true });
      writeFileSync(
        join(pipeDir, "package.json"),
        JSON.stringify({ main: "original.ts" })
      );

      // original.ts: writes marker, rewrites package.json to point to changed.ts
      const pkgPath = join(pipeDir, "package.json");
      writeFileSync(
        join(pipeDir, "original.ts"),
        [
          `import { writeFileSync, readFileSync } from "node:fs";`,
          `import { appendFileSync } from "node:fs";`,
          `appendFileSync(${JSON.stringify(counterFile)}, "1");`,
          `const count = readFileSync(${JSON.stringify(counterFile)}, "utf-8").length;`,
          `if (count === 1) {`,
          `  writeFileSync(${JSON.stringify(marker1)}, "original-ran");`,
          `  // Rewrite package.json to point to changed.ts`,
          `  writeFileSync(${JSON.stringify(pkgPath)}, JSON.stringify({ main: "changed.ts" }));`,
          `}`,
          `if (count === 2) {`,
          `  writeFileSync(${JSON.stringify(marker1)}, "original-ran-again");`,
          `}`,
          ``,
        ].join("\n")
      );

      // changed.ts: writes a different marker
      writeFileSync(
        join(pipeDir, "changed.ts"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker2)}, "changed-ran");\n`
      );

      const result = await runCLI(["run", "-n", "2", "mypipe"], { cwd: project.dir });

      expect(result.exitCode).toBe(0);
      // The original entry point should have run both times (cached)
      expect(existsSync(marker1)).toBe(true);
      expect(readFileSync(marker1, "utf-8")).toBe("original-ran-again");
      // The changed entry point should NOT have run
      expect(existsSync(marker2)).toBe(false);
    });
  });
});
