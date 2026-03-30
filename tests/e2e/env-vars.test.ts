import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  createTempProject,
  createScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import {
  createEnvFile,
  writeEnvFileRaw,
  withGlobalEnv,
  withIsolatedHome,
} from "../helpers/env.js";
import {
  writeEnvToFile,
  observeEnv,
} from "../helpers/fixture-scripts.js";
import { forEachRuntime } from "../helpers/runtime.js";

// ---------------------------------------------------------------------------
// SPEC: Global Env File
// ---------------------------------------------------------------------------

describe("SPEC: Global Env File", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-ENV-01: Variable from env set available in script (marker file)
    it("T-ENV-01: variable from global env set is available in script", async () => {
      await withIsolatedHome(async () => {
        // Set a global env variable via CLI
        const setResult = await runCLI(["env", "set", "MY_GLOBAL_VAR", "globalvalue123"], {
          runtime,
        });
        expect(setResult.exitCode).toBe(0);

        // Create a project with a script that reads the env var into a marker file
        project = await createTempProject();
        const markerPath = join(project.dir, "marker.txt");
        await createScript(
          project,
          "check-env",
          ".sh",
          writeEnvToFile("MY_GLOBAL_VAR", markerPath),
        );

        const result = await runCLI(["-n", "1", "check-env"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const content = readFileSync(markerPath, "utf-8");
        expect(content).toBe("globalvalue123");
      });
    });

    // T-ENV-02: Variable removed via env remove no longer available
    it("T-ENV-02: variable removed via env remove is no longer available in script", async () => {
      await withIsolatedHome(async () => {
        // Set then remove a global env variable
        await runCLI(["env", "set", "EPHEMERAL_VAR", "tempval"], { runtime });
        const removeResult = await runCLI(["env", "remove", "EPHEMERAL_VAR"], {
          runtime,
        });
        expect(removeResult.exitCode).toBe(0);

        // Create a project with a TS script that observes the env var
        project = await createTempProject();
        const markerPath = join(project.dir, "observe.json");
        await createScript(
          project,
          "observe",
          ".ts",
          observeEnv("EPHEMERAL_VAR", markerPath),
        );

        const result = await runCLI(["-n", "1", "observe"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const observed = JSON.parse(readFileSync(markerPath, "utf-8"));
        expect(observed.present).toBe(false);
      });
    });

    // T-ENV-03: XDG_CONFIG_HOME respected
    it("T-ENV-03: XDG_CONFIG_HOME is respected for global env file location", async () => {
      await withGlobalEnv({ XDG_TEST_VAR: "xdg-works" }, async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "xdg-marker.txt");
        await createScript(
          project,
          "check-xdg",
          ".sh",
          writeEnvToFile("XDG_TEST_VAR", markerPath),
        );

        const result = await runCLI(["-n", "1", "check-xdg"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const content = readFileSync(markerPath, "utf-8");
        expect(content).toBe("xdg-works");
      });
    });

    // T-ENV-04: Fallback to ~/.config when XDG_CONFIG_HOME unset
    it("T-ENV-04: falls back to ~/.config/loopx/env when XDG_CONFIG_HOME is unset", async () => {
      await withIsolatedHome(async () => {
        const home = process.env.HOME!;
        // Manually create the env file at ~/.config/loopx/env
        const configDir = join(home, ".config", "loopx");
        await mkdir(configDir, { recursive: true });
        await createEnvFile(join(configDir, "env"), {
          FALLBACK_VAR: "fallback-value",
        });

        project = await createTempProject();
        const markerPath = join(project.dir, "fallback-marker.txt");
        await createScript(
          project,
          "check-fallback",
          ".sh",
          writeEnvToFile("FALLBACK_VAR", markerPath),
        );

        const result = await runCLI(["-n", "1", "check-fallback"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const content = readFileSync(markerPath, "utf-8");
        expect(content).toBe("fallback-value");
      });
    });

    // T-ENV-05: Config dir created on first env set
    it("T-ENV-05: config directory is created on first env set", async () => {
      await withIsolatedHome(async () => {
        const home = process.env.HOME!;
        const configDir = join(home, ".config", "loopx");

        // Verify the config directory does not exist yet
        expect(existsSync(configDir)).toBe(false);

        const setResult = await runCLI(["env", "set", "NEW_VAR", "newval"], {
          runtime,
        });
        expect(setResult.exitCode).toBe(0);

        // Verify the config directory was created
        expect(existsSync(configDir)).toBe(true);
        // Verify the env file was created with the variable
        const envPath = join(configDir, "env");
        expect(existsSync(envPath)).toBe(true);
      });
    });

    // T-ENV-05a: Unreadable global env file -> exit 1 (conditional on non-root)
    it("T-ENV-05a: unreadable global env file causes exit 1 when running a script", async () => {
      // Skip if running as root since root can read any file
      if (process.getuid?.() === 0) {
        return;
      }

      await withGlobalEnv({ SOME_VAR: "some_val" }, async () => {
        // Make the global env file unreadable
        const xdg = process.env.XDG_CONFIG_HOME!;
        const envPath = join(xdg, "loopx", "env");
        await chmod(envPath, 0o000);

        project = await createTempProject();
        const markerPath = join(project.dir, "marker.txt");
        await createScript(
          project,
          "default",
          ".sh",
          writeEnvToFile("SOME_VAR", markerPath),
        );

        const result = await runCLI(["-n", "1"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });
    });

    // T-ENV-05b: Unreadable global env via programmatic API (run() throws)
    it("T-ENV-05b: unreadable global env via programmatic API causes run() to throw", async () => {
      if (process.getuid?.() === 0) {
        return;
      }

      await withGlobalEnv({ API_VAR: "api_val" }, async () => {
        const xdg = process.env.XDG_CONFIG_HOME!;
        const envPath = join(xdg, "loopx", "env");
        await chmod(envPath, 0o000);

        project = await createTempProject();
        await createScript(
          project,
          "default",
          ".sh",
          "#!/bin/bash\necho ok\n",
        );

        const driverCode = `
import { run } from "loopx";

try {
  await run("default", {
    maxIterations: 1,
    cwd: ${JSON.stringify(project.dir)},
  });
  process.stdout.write("NO_ERROR");
} catch (err) {
  process.stdout.write("THREW:" + (err as Error).message);
}
`;

        const result = await runAPIDriver(runtime, driverCode, {
          env: { XDG_CONFIG_HOME: xdg },
        });

        // The API should throw, so stdout should start with "THREW:"
        expect(result.stdout).toMatch(/^THREW:/);
      });
    });

    // T-ENV-05c: Unreadable global env with env list -> exit 1
    it("T-ENV-05c: unreadable global env with env list causes exit 1", async () => {
      if (process.getuid?.() === 0) {
        return;
      }

      await withGlobalEnv({ LIST_VAR: "list_val" }, async () => {
        const xdg = process.env.XDG_CONFIG_HOME!;
        const envPath = join(xdg, "loopx", "env");
        await chmod(envPath, 0o000);

        const result = await runCLI(["env", "list"], { runtime });
        expect(result.exitCode).toBe(1);
      });
    });

    // T-ENV-05d: Unreadable global env with env set -> exit 1
    it("T-ENV-05d: unreadable global env with env set causes exit 1", async () => {
      if (process.getuid?.() === 0) {
        return;
      }

      await withGlobalEnv({ SET_VAR: "set_val" }, async () => {
        const xdg = process.env.XDG_CONFIG_HOME!;
        const envPath = join(xdg, "loopx", "env");
        await chmod(envPath, 0o000);

        const result = await runCLI(["env", "set", "NEW_VAR", "new_val"], {
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });
    });

    // T-ENV-05e: Unreadable global env with env remove -> exit 1
    it("T-ENV-05e: unreadable global env with env remove causes exit 1", async () => {
      if (process.getuid?.() === 0) {
        return;
      }

      await withGlobalEnv({ REM_VAR: "rem_val" }, async () => {
        const xdg = process.env.XDG_CONFIG_HOME!;
        const envPath = join(xdg, "loopx", "env");
        await chmod(envPath, 0o000);

        const result = await runCLI(["env", "remove", "REM_VAR"], {
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: Env File Parsing
// ---------------------------------------------------------------------------

describe("SPEC: Env File Parsing", () => {
  /**
   * Helper: creates a self-contained project with a TS observe-env script,
   * writes raw content to a temp global env file, runs the script, cleans
   * up everything, and returns the parsed observation JSON.
   */
  async function parseEnvAndObserve(
    rawEnvContent: string,
    varname: string,
    runtime: "node" | "bun" = "node",
  ): Promise<{ present: boolean; value?: string }> {
    const { mkdtemp, mkdir: mkdirAsync, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");

    const tempConfigHome = await mkdtemp(join(tmpdir(), "loopx-parse-"));
    const loopxConfigDir = join(tempConfigHome, "loopx");
    await mkdirAsync(loopxConfigDir, { recursive: true });
    const envFilePath = join(loopxConfigDir, "env");
    await writeEnvFileRaw(envFilePath, rawEnvContent);

    const originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempConfigHome;

    const localProject = await createTempProject();

    try {
      const markerPath = join(localProject.dir, "observe.json");
      await createScript(
        localProject,
        "observe",
        ".ts",
        observeEnv(varname, markerPath),
      );

      const result = await runCLI(["-n", "1", "observe"], {
        cwd: localProject.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      return JSON.parse(readFileSync(markerPath, "utf-8"));
    } finally {
      await localProject.cleanup();
      if (originalXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdg;
      }
      await rm(tempConfigHome, { recursive: true, force: true });
    }
  }

  forEachRuntime((runtime) => {
    // T-ENV-06: KEY=VALUE
    it("T-ENV-06: basic KEY=VALUE is parsed correctly", async () => {
      const result = await parseEnvAndObserve("SIMPLE_KEY=simple_value\n", "SIMPLE_KEY", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("simple_value");
    });

    // T-ENV-07: Comments
    it("T-ENV-07: comment lines starting with # are ignored", async () => {
      const content = `# This is a comment\nCOMMENT_VAR=present\n# Another comment\n`;
      const result = await parseEnvAndObserve(content, "COMMENT_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("present");
    });

    // T-ENV-08: Blank lines
    it("T-ENV-08: blank lines are ignored", async () => {
      const content = `\n\nBLANK_VAR=found\n\n\n`;
      const result = await parseEnvAndObserve(content, "BLANK_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("found");
    });

    // T-ENV-09: Duplicates (last wins)
    it("T-ENV-09: duplicate keys use last-wins semantics", async () => {
      const content = `DUP_VAR=first\nDUP_VAR=second\nDUP_VAR=third\n`;
      const result = await parseEnvAndObserve(content, "DUP_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("third");
    });

    // T-ENV-10: Double-quoted value
    it("T-ENV-10: double-quoted values have quotes stripped", async () => {
      const content = `DQ_VAR="quoted value"\n`;
      const result = await parseEnvAndObserve(content, "DQ_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("quoted value");
    });

    // T-ENV-11: Single-quoted value
    it("T-ENV-11: single-quoted values have quotes stripped", async () => {
      const content = `SQ_VAR='single quoted'\n`;
      const result = await parseEnvAndObserve(content, "SQ_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("single quoted");
    });

    // T-ENV-12: No escape sequences (literal \n)
    it("T-ENV-12: backslash-n is treated as literal characters, not a newline", async () => {
      const content = `ESC_VAR="hello\\nworld"\n`;
      const result = await parseEnvAndObserve(content, "ESC_VAR", runtime);
      expect(result.present).toBe(true);
      // The value should contain a literal backslash and n, not a newline
      expect(result.value).toBe("hello\\nworld");
    });

    // T-ENV-13: Inline # is part of value
    it("T-ENV-13: inline # character is part of the value, not a comment", async () => {
      const content = `HASH_VAR=value#with#hash\n`;
      const result = await parseEnvAndObserve(content, "HASH_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("value#with#hash");
    });

    // T-ENV-14: Trailing whitespace trimmed
    it("T-ENV-14: trailing whitespace on values is trimmed", async () => {
      const content = `TRAIL_VAR=value   \n`;
      const result = await parseEnvAndObserve(content, "TRAIL_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("value");
    });

    // T-ENV-15: No whitespace around = (invalid key with space)
    it("T-ENV-15: key with whitespace around = is invalid and produces a warning", async () => {
      const content = `BAD KEY =value\nGOOD_KEY=present\n`;
      // The bad line should be ignored; GOOD_KEY should still work
      const result = await parseEnvAndObserve(content, "GOOD_KEY", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("present");
    });

    // T-ENV-15a: Empty value KEY=
    it("T-ENV-15a: KEY= with no value sets the variable to empty string", async () => {
      const content = `EMPTY_VAR=\n`;
      const result = await parseEnvAndObserve(content, "EMPTY_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("");
    });

    // T-ENV-15b: Multiple = (split on first)
    it("T-ENV-15b: value containing = is split on first = only", async () => {
      const content = `MULTI_EQ=val=ue=extra\n`;
      const result = await parseEnvAndObserve(content, "MULTI_EQ", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("val=ue=extra");
    });

    // T-ENV-15c: Invalid key 1BAD=val (ignored with warning)
    it("T-ENV-15c: key starting with digit is invalid and ignored", async () => {
      const content = `1BAD=val\nVALID_KEY=ok\n`;
      // 1BAD should be ignored; VALID_KEY should be present
      const result = await parseEnvAndObserve(content, "VALID_KEY", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("ok");

      // Also verify 1BAD is not set
      const badResult = await parseEnvAndObserve(content, "1BAD", runtime);
      expect(badResult.present).toBe(false);
    });

    // T-ENV-15d: Malformed line without = (ignored with warning)
    it("T-ENV-15d: malformed line without = is ignored", async () => {
      const content = `noequalssign\nOK_VAR=works\n`;
      const result = await parseEnvAndObserve(content, "OK_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("works");
    });

    // T-ENV-15e: Unmatched quotes (literal, not stripped)
    it("T-ENV-15e: unmatched quotes are treated as literal characters", async () => {
      const content = `UNMATCH_VAR="unmatched\n`;
      const result = await parseEnvAndObserve(content, "UNMATCH_VAR", runtime);
      expect(result.present).toBe(true);
      // Unmatched quote is preserved as a literal character
      expect(result.value).toBe('"unmatched');
    });

    // T-ENV-15f: KEY= value (leading space preserved)
    it("T-ENV-15f: leading space in value after = is preserved", async () => {
      const content = `LEAD_VAR= value\n`;
      const result = await parseEnvAndObserve(content, "LEAD_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe(" value");
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: Local Env Override
// ---------------------------------------------------------------------------

describe("SPEC: Local Env Override", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-ENV-16: -e loads vars into script env
    it("T-ENV-16: -e flag loads variables from a local env file into the script environment", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "local-env-marker.txt");
      const localEnvPath = join(project.dir, "local.env");
      await createEnvFile(localEnvPath, { LOCAL_VAR: "local-value-42" });

      await createScript(
        project,
        "check-local",
        ".sh",
        writeEnvToFile("LOCAL_VAR", markerPath),
      );

      const result = await runCLI(["-e", "local.env", "-n", "1", "check-local"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const content = readFileSync(markerPath, "utf-8");
      expect(content).toBe("local-value-42");
    });

    // T-ENV-17: -e nonexistent -> exit 1
    it("T-ENV-17: -e with nonexistent file causes exit 1", async () => {
      project = await createTempProject();
      await createScript(
        project,
        "default",
        ".sh",
        "#!/bin/bash\necho ok\n",
      );

      const result = await runCLI(["-e", "does-not-exist.env", "-n", "1"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    // T-ENV-17a: -e unreadable -> exit 1 (conditional on non-root)
    it("T-ENV-17a: -e with unreadable file causes exit 1", async () => {
      if (process.getuid?.() === 0) {
        return;
      }

      project = await createTempProject();
      const localEnvPath = join(project.dir, "unreadable.env");
      await createEnvFile(localEnvPath, { KEY: "val" });
      await chmod(localEnvPath, 0o000);

      await createScript(
        project,
        "default",
        ".sh",
        "#!/bin/bash\necho ok\n",
      );

      const result = await runCLI(["-e", "unreadable.env", "-n", "1"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
    });

    // T-ENV-18: Local overrides global on conflict
    it("T-ENV-18: local -e file overrides global env on key conflict", async () => {
      await withGlobalEnv({ CONFLICT_VAR: "global-value" }, async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "conflict-marker.txt");
        const localEnvPath = join(project.dir, "local.env");
        await createEnvFile(localEnvPath, { CONFLICT_VAR: "local-value" });

        await createScript(
          project,
          "check-conflict",
          ".sh",
          writeEnvToFile("CONFLICT_VAR", markerPath),
        );

        const result = await runCLI(
          ["-e", "local.env", "-n", "1", "check-conflict"],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const content = readFileSync(markerPath, "utf-8");
        expect(content).toBe("local-value");
      });
    });

    // T-ENV-19: Both global and local vars present
    it("T-ENV-19: both global and local env vars are present when no conflict", async () => {
      await withGlobalEnv({ GLOBAL_ONLY: "from-global" }, async () => {
        project = await createTempProject();
        const globalMarker = join(project.dir, "global-marker.txt");
        const localMarker = join(project.dir, "local-marker.txt");
        const localEnvPath = join(project.dir, "local.env");
        await createEnvFile(localEnvPath, { LOCAL_ONLY: "from-local" });

        // Script writes both env vars to separate marker files
        const scriptContent = `#!/bin/bash
printf '%s' "$GLOBAL_ONLY" > "${globalMarker}"
printf '%s' "$LOCAL_ONLY" > "${localMarker}"
`;
        await createScript(project, "check-both", ".sh", scriptContent);

        const result = await runCLI(
          ["-e", "local.env", "-n", "1", "check-both"],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        expect(existsSync(globalMarker)).toBe(true);
        expect(existsSync(localMarker)).toBe(true);
        expect(readFileSync(globalMarker, "utf-8")).toBe("from-global");
        expect(readFileSync(localMarker, "utf-8")).toBe("from-local");
      });
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: Injection Precedence
// ---------------------------------------------------------------------------

describe("SPEC: Injection Precedence", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-ENV-20: LOOPX_BIN overrides env file value
    it("T-ENV-20: LOOPX_BIN injected by runtime overrides env file value", async () => {
      await withGlobalEnv({ LOOPX_BIN: "env-file-bin-path" }, async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "bin-marker.txt");

        await createScript(
          project,
          "check-bin",
          ".sh",
          writeEnvToFile("LOOPX_BIN", markerPath),
        );

        const result = await runCLI(["-n", "1", "check-bin"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const content = readFileSync(markerPath, "utf-8");
        // LOOPX_BIN should NOT be the env file value; the runtime injects the real one
        expect(content).not.toBe("env-file-bin-path");
        expect(content.length).toBeGreaterThan(0);
      });
    });

    // T-ENV-20a: LOOPX_BIN overrides system env
    it("T-ENV-20a: LOOPX_BIN injected by runtime overrides system env", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "bin-sys-marker.txt");

      await createScript(
        project,
        "check-bin-sys",
        ".sh",
        writeEnvToFile("LOOPX_BIN", markerPath),
      );

      const result = await runCLI(["-n", "1", "check-bin-sys"], {
        cwd: project.dir,
        runtime,
        env: { LOOPX_BIN: "system-env-bin-path" },
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const content = readFileSync(markerPath, "utf-8");
      // LOOPX_BIN should NOT be the system env value; the runtime injects the real one
      expect(content).not.toBe("system-env-bin-path");
      expect(content.length).toBeGreaterThan(0);
    });

    // T-ENV-21: LOOPX_PROJECT_ROOT overrides env file value
    it("T-ENV-21: LOOPX_PROJECT_ROOT injected by runtime overrides env file value", async () => {
      await withGlobalEnv({ LOOPX_PROJECT_ROOT: "/fake/env/path" }, async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "root-marker.txt");

        await createScript(
          project,
          "check-root",
          ".sh",
          writeEnvToFile("LOOPX_PROJECT_ROOT", markerPath),
        );

        const result = await runCLI(["-n", "1", "check-root"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const content = readFileSync(markerPath, "utf-8");
        // LOOPX_PROJECT_ROOT should be the actual project dir, not the env file value
        expect(content).not.toBe("/fake/env/path");
        expect(content).toBe(project!.dir);
      });
    });

    // T-ENV-21a: LOOPX_PROJECT_ROOT overrides system env
    it("T-ENV-21a: LOOPX_PROJECT_ROOT injected by runtime overrides system env", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "root-sys-marker.txt");

      await createScript(
        project,
        "check-root-sys",
        ".sh",
        writeEnvToFile("LOOPX_PROJECT_ROOT", markerPath),
      );

      const result = await runCLI(["-n", "1", "check-root-sys"], {
        cwd: project.dir,
        runtime,
        env: { LOOPX_PROJECT_ROOT: "/fake/system/path" },
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const content = readFileSync(markerPath, "utf-8");
      // LOOPX_PROJECT_ROOT should be the actual project dir, not the system env value
      expect(content).not.toBe("/fake/system/path");
      expect(content).toBe(project!.dir);
    });

    // T-ENV-22: Global env overrides system env
    it("T-ENV-22: global env file variable overrides same-named system env variable", async () => {
      await withGlobalEnv({ OVERRIDE_ME: "from-global-env" }, async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "override-marker.txt");

        await createScript(
          project,
          "check-override",
          ".sh",
          writeEnvToFile("OVERRIDE_ME", markerPath),
        );

        const result = await runCLI(["-n", "1", "check-override"], {
          cwd: project.dir,
          runtime,
          env: { OVERRIDE_ME: "from-system-env" },
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const content = readFileSync(markerPath, "utf-8");
        expect(content).toBe("from-global-env");
      });
    });

    // T-ENV-23: System env visible when no override
    it("T-ENV-23: system env variable is visible when not overridden by env files", async () => {
      await withIsolatedHome(async () => {
        // No global env file exists in the isolated home
        project = await createTempProject();
        const markerPath = join(project.dir, "sysenv-marker.txt");

        await createScript(
          project,
          "check-sysenv",
          ".sh",
          writeEnvToFile("SYSTEM_ONLY_VAR", markerPath),
        );

        const result = await runCLI(["-n", "1", "check-sysenv"], {
          cwd: project.dir,
          runtime,
          env: { SYSTEM_ONLY_VAR: "from-system" },
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const content = readFileSync(markerPath, "utf-8");
        expect(content).toBe("from-system");
      });
    });

    // T-ENV-24: Full precedence chain
    it("T-ENV-24: full precedence chain: LOOPX_BIN/LOOPX_PROJECT_ROOT > local -e > global > system env", async () => {
      await withGlobalEnv({
        LOOPX_PROJECT_ROOT: "/fake/global/root",
        LAYER_VAR: "from-global",
        GLOBAL_ONLY_VAR: "global-only-value",
      }, async () => {
        project = await createTempProject();

        const localEnvPath = join(project.dir, "local.env");
        await createEnvFile(localEnvPath, {
          LAYER_VAR: "from-local",
          LOCAL_ONLY_VAR: "local-only-value",
        });

        const rootMarker = join(project.dir, "root.txt");
        const layerMarker = join(project.dir, "layer.txt");
        const globalOnlyMarker = join(project.dir, "global-only.txt");
        const localOnlyMarker = join(project.dir, "local-only.txt");
        const systemOnlyMarker = join(project.dir, "system-only.txt");

        const scriptContent = `#!/bin/bash
printf '%s' "$LOOPX_PROJECT_ROOT" > "${rootMarker}"
printf '%s' "$LAYER_VAR" > "${layerMarker}"
printf '%s' "$GLOBAL_ONLY_VAR" > "${globalOnlyMarker}"
printf '%s' "$LOCAL_ONLY_VAR" > "${localOnlyMarker}"
printf '%s' "$SYSTEM_ONLY_VAR" > "${systemOnlyMarker}"
`;
        await createScript(project, "precedence", ".sh", scriptContent);

        const result = await runCLI(
          ["-e", "local.env", "-n", "1", "precedence"],
          {
            cwd: project.dir,
            runtime,
            env: {
              LOOPX_PROJECT_ROOT: "/fake/system/root",
              LAYER_VAR: "from-system",
              SYSTEM_ONLY_VAR: "system-only-value",
            },
          },
        );

        expect(result.exitCode).toBe(0);

        // LOOPX_PROJECT_ROOT: runtime-injected > all others
        expect(readFileSync(rootMarker, "utf-8")).toBe(project!.dir);

        // LAYER_VAR: local -e > global > system
        expect(readFileSync(layerMarker, "utf-8")).toBe("from-local");

        // GLOBAL_ONLY_VAR: global env wins (no local or system override)
        expect(readFileSync(globalOnlyMarker, "utf-8")).toBe("global-only-value");

        // LOCAL_ONLY_VAR: local -e file
        expect(readFileSync(localOnlyMarker, "utf-8")).toBe("local-only-value");

        // SYSTEM_ONLY_VAR: system env visible (no env file override)
        expect(readFileSync(systemOnlyMarker, "utf-8")).toBe("system-only-value");
      });
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: Env Caching
// ---------------------------------------------------------------------------

describe("SPEC: Env Caching", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // T-ENV-25: Global env not re-read during loop
    it("T-ENV-25: global env is loaded once and cached; modifications during loop are not seen", async () => {
      await withGlobalEnv({ CACHED_VAR: "original" }, async () => {
        const xdg = process.env.XDG_CONFIG_HOME!;
        const envFilePath = join(xdg, "loopx", "env");

        project = await createTempProject();
        const marker1 = join(project.dir, "iter1.txt");
        const marker2 = join(project.dir, "iter2.txt");
        const counterFile = join(project.dir, "counter.txt");

        // Script that:
        // - Reads the iteration count
        // - On first iteration: writes env var to marker1, then modifies the global env file
        // - On second iteration: writes env var to marker2
        const scriptContent = `#!/bin/bash
# Increment counter
printf '1' >> "${counterFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')

if [ "$COUNT" = "1" ]; then
  printf '%s' "$CACHED_VAR" > "${marker1}"
  # Modify the global env file mid-loop
  echo "CACHED_VAR=modified" > "${envFilePath}"
elif [ "$COUNT" = "2" ]; then
  printf '%s' "$CACHED_VAR" > "${marker2}"
fi
`;
        await createScript(project, "cache-test", ".sh", scriptContent);

        const result = await runCLI(["-n", "2", "cache-test"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(marker1)).toBe(true);
        expect(existsSync(marker2)).toBe(true);

        // Both iterations should see the original value because env is cached
        expect(readFileSync(marker1, "utf-8")).toBe("original");
        expect(readFileSync(marker2, "utf-8")).toBe("original");
      });
    });

    // T-ENV-25a: Local env not re-read during loop
    it("T-ENV-25a: local -e env is loaded once and cached; modifications during loop are not seen", async () => {
      project = await createTempProject();
      const localEnvPath = join(project.dir, "local.env");
      await createEnvFile(localEnvPath, { LOCAL_CACHED: "original-local" });

      const marker1 = join(project.dir, "local-iter1.txt");
      const marker2 = join(project.dir, "local-iter2.txt");
      const counterFile = join(project.dir, "local-counter.txt");

      // Script that modifies the local env file during the loop
      const scriptContent = `#!/bin/bash
printf '1' >> "${counterFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')

if [ "$COUNT" = "1" ]; then
  printf '%s' "$LOCAL_CACHED" > "${marker1}"
  # Modify the local env file mid-loop
  echo "LOCAL_CACHED=modified-local" > "${localEnvPath}"
elif [ "$COUNT" = "2" ]; then
  printf '%s' "$LOCAL_CACHED" > "${marker2}"
fi
`;
      await createScript(project, "local-cache-test", ".sh", scriptContent);

      const result = await runCLI(
        ["-e", "local.env", "-n", "2", "local-cache-test"],
        { cwd: project.dir, runtime },
      );

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker1)).toBe(true);
      expect(existsSync(marker2)).toBe(true);

      // Both iterations should see the original value because env is cached
      expect(readFileSync(marker1, "utf-8")).toBe("original-local");
      expect(readFileSync(marker2, "utf-8")).toBe("original-local");
    });
  });
});
