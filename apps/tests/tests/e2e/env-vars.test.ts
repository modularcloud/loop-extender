import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { mkdir, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  createBashWorkflowScript,
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

// ============================================================================
// TEST-SPEC §4.7 — Environment Variables (ADR-0003 workflow model)
// Spec refs: 8.1–8.3
//
// All env tests use the workflow model: scripts live in
// .loopx/<workflow>/<script>.<ext>, and invocation is `loopx run <workflow>`.
// All env tests use `withGlobalEnv` or `withIsolatedHome` to isolate the
// global env file from the real user config.
// ============================================================================

const IS_ROOT = process.getuid?.() === 0;

// ---------------------------------------------------------------------------
// SPEC: Global Env File  (T-ENV-01 through T-ENV-05e)
// ---------------------------------------------------------------------------

describe("SPEC: Global Env File", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    it("T-ENV-01: variable from global env set is available in script", async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(
          ["env", "set", "MY_GLOBAL_VAR", "globalvalue123"],
          { runtime },
        );
        expect(setResult.exitCode).toBe(0);

        project = await createTempProject();
        const markerPath = join(project.dir, "marker.txt");
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          writeEnvToFile("MY_GLOBAL_VAR", markerPath),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        expect(readFileSync(markerPath, "utf-8")).toBe("globalvalue123");
      });
    });

    it("T-ENV-02: variable removed via env remove is no longer available in script", async () => {
      await withIsolatedHome(async () => {
        await runCLI(["env", "set", "EPHEMERAL_VAR", "tempval"], { runtime });
        const removeResult = await runCLI(
          ["env", "remove", "EPHEMERAL_VAR"],
          { runtime },
        );
        expect(removeResult.exitCode).toBe(0);

        project = await createTempProject();
        const markerPath = join(project.dir, "observe.json");
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".ts",
          observeEnv("EPHEMERAL_VAR", markerPath),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const observed = JSON.parse(readFileSync(markerPath, "utf-8"));
        expect(observed.present).toBe(false);
      });
    });

    it("T-ENV-03: XDG_CONFIG_HOME is respected for global env file location", async () => {
      const customConfig = await mkdtemp(join(tmpdir(), "loopx-xdg-"));
      const originalXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = customConfig;

      try {
        const setResult = await runCLI(["env", "set", "X", "Y"], { runtime });
        expect(setResult.exitCode).toBe(0);

        const envFilePath = join(customConfig, "loopx", "env");
        expect(existsSync(envFilePath)).toBe(true);

        project = await createTempProject();
        const markerPath = join(project.dir, "xdg-marker.txt");
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          writeEnvToFile("X", markerPath),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        expect(readFileSync(markerPath, "utf-8")).toBe("Y");
      } finally {
        if (originalXdg === undefined) {
          delete process.env.XDG_CONFIG_HOME;
        } else {
          process.env.XDG_CONFIG_HOME = originalXdg;
        }
        await rm(customConfig, { recursive: true, force: true });
      }
    });

    it("T-ENV-04: falls back to ~/.config/loopx/env when XDG_CONFIG_HOME is unset", async () => {
      await withIsolatedHome(async () => {
        const home = process.env.HOME!;
        const configDir = join(home, ".config", "loopx");
        await mkdir(configDir, { recursive: true });
        await createEnvFile(join(configDir, "env"), {
          FALLBACK_VAR: "fallback-value",
        });

        project = await createTempProject();
        const markerPath = join(project.dir, "fallback-marker.txt");
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          writeEnvToFile("FALLBACK_VAR", markerPath),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        expect(readFileSync(markerPath, "utf-8")).toBe("fallback-value");
      });
    });

    it("T-ENV-05: config directory is created on first env set", async () => {
      await withIsolatedHome(async () => {
        const home = process.env.HOME!;
        const configDir = join(home, ".config", "loopx");
        expect(existsSync(configDir)).toBe(false);

        const setResult = await runCLI(["env", "set", "NEW_VAR", "newval"], {
          runtime,
        });
        expect(setResult.exitCode).toBe(0);

        expect(existsSync(configDir)).toBe(true);
        const envPath = join(configDir, "env");
        expect(existsSync(envPath)).toBe(true);
      });
    });

    it.skipIf(IS_ROOT)(
      "T-ENV-05a: unreadable global env file causes exit 1 when running a script",
      async () => {
        await withGlobalEnv({ SOME_VAR: "some_val" }, async () => {
          const xdg = process.env.XDG_CONFIG_HOME!;
          const envPath = join(xdg, "loopx", "env");
          await chmod(envPath, 0o000);

          project = await createTempProject();
          const markerPath = join(project.dir, "marker.txt");
          await createWorkflowScript(
            project,
            "ralph",
            "index",
            ".sh",
            writeEnvToFile("SOME_VAR", markerPath),
          );

          const result = await runCLI(["run", "-n", "1", "ralph"], {
            cwd: project.dir,
            runtime,
          });

          expect(result.exitCode).toBe(1);
          expect(result.stderr.length).toBeGreaterThan(0);
          expect(result.stderr.toLowerCase()).toMatch(
            /unreadable|permission|denied|access|cannot read/i,
          );
        });
      },
    );

    it.skipIf(IS_ROOT)(
      "T-ENV-05b: unreadable global env via programmatic API causes run() to throw",
      async () => {
        await withGlobalEnv({ API_VAR: "api_val" }, async () => {
          const xdg = process.env.XDG_CONFIG_HOME!;
          const envPath = join(xdg, "loopx", "env");
          await chmod(envPath, 0o000);

          project = await createTempProject();
          await createBashWorkflowScript(
            project,
            "ralph",
            "index",
            `echo ok`,
          );

          const driverCode = `
import { run } from "loopx";

try {
  const gen = run("ralph", {
    maxIterations: 1,
    cwd: ${JSON.stringify(project.dir)},
  });
  const result = await gen.next();
  process.stdout.write("NO_ERROR");
} catch (err) {
  process.stdout.write("THREW:" + (err as Error).message);
}
`;

          const result = await runAPIDriver(runtime, driverCode, {
            env: { XDG_CONFIG_HOME: xdg },
          });

          expect(result.stdout).toMatch(/^THREW:/);
        });
      },
    );

    it.skipIf(IS_ROOT)(
      "T-ENV-05c: unreadable global env with env list causes exit 1",
      async () => {
        await withGlobalEnv({ LIST_VAR: "list_val" }, async () => {
          const xdg = process.env.XDG_CONFIG_HOME!;
          const envPath = join(xdg, "loopx", "env");
          await chmod(envPath, 0o000);

          const result = await runCLI(["env", "list"], { runtime });
          expect(result.exitCode).toBe(1);
          expect(result.stderr.length).toBeGreaterThan(0);
          expect(result.stderr.toLowerCase()).toMatch(
            /unreadable|permission|denied|access|cannot read/i,
          );
        });
      },
    );

    it.skipIf(IS_ROOT)(
      "T-ENV-05d: unreadable global env with env set causes exit 1",
      async () => {
        await withGlobalEnv({ SET_VAR: "set_val" }, async () => {
          const xdg = process.env.XDG_CONFIG_HOME!;
          const envPath = join(xdg, "loopx", "env");
          await chmod(envPath, 0o000);

          const result = await runCLI(["env", "set", "NEW_VAR", "new_val"], {
            runtime,
          });
          expect(result.exitCode).toBe(1);
          expect(result.stderr.length).toBeGreaterThan(0);
          expect(result.stderr.toLowerCase()).toMatch(
            /unreadable|permission|denied|access|cannot read/i,
          );
        });
      },
    );

    it.skipIf(IS_ROOT)(
      "T-ENV-05e: unreadable global env with env remove causes exit 1",
      async () => {
        await withGlobalEnv({ REM_VAR: "rem_val" }, async () => {
          const xdg = process.env.XDG_CONFIG_HOME!;
          const envPath = join(xdg, "loopx", "env");
          await chmod(envPath, 0o000);

          const result = await runCLI(["env", "remove", "REM_VAR"], {
            runtime,
          });
          expect(result.exitCode).toBe(1);
          expect(result.stderr.length).toBeGreaterThan(0);
          expect(result.stderr.toLowerCase()).toMatch(
            /unreadable|permission|denied|access|cannot read/i,
          );
        });
      },
    );
  });
});

// ---------------------------------------------------------------------------
// SPEC: Env File Parsing  (T-ENV-06 through T-ENV-15f)
// ---------------------------------------------------------------------------

describe("SPEC: Env File Parsing", () => {
  /**
   * Helper: creates a self-contained workflow project with a TS observe-env
   * script in .loopx/ralph/index.ts, writes raw content to a temp global env
   * file, runs loopx against the workflow, cleans up, and returns the parsed
   * observation JSON plus captured stderr.
   */
  async function parseEnvAndObserve(
    rawEnvContent: string,
    varname: string,
    runtime: "node" | "bun" = "node",
  ): Promise<{ present: boolean; value?: string; stderr: string }> {
    const tempConfigHome = await mkdtemp(join(tmpdir(), "loopx-parse-"));
    const loopxConfigDir = join(tempConfigHome, "loopx");
    await mkdir(loopxConfigDir, { recursive: true });
    const envFilePath = join(loopxConfigDir, "env");
    await writeEnvFileRaw(envFilePath, rawEnvContent);

    const originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempConfigHome;

    const localProject = await createTempProject();

    try {
      const markerPath = join(localProject.dir, "observe.json");
      await createWorkflowScript(
        localProject,
        "ralph",
        "index",
        ".ts",
        observeEnv(varname, markerPath),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: localProject.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const observed = JSON.parse(readFileSync(markerPath, "utf-8"));
      return { ...observed, stderr: result.stderr };
    } finally {
      await localProject.cleanup().catch(() => {});
      if (originalXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdg;
      }
      await rm(tempConfigHome, { recursive: true, force: true });
    }
  }

  forEachRuntime((runtime) => {
    it("T-ENV-06: basic KEY=VALUE is parsed correctly", async () => {
      const result = await parseEnvAndObserve(
        "SIMPLE_KEY=simple_value\n",
        "SIMPLE_KEY",
        runtime,
      );
      expect(result.present).toBe(true);
      expect(result.value).toBe("simple_value");
    });

    it("T-ENV-07: comment lines starting with # are ignored", async () => {
      const content = `# This is a comment\nCOMMENT_VAR=present\n# Another comment\n`;
      const result = await parseEnvAndObserve(content, "COMMENT_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("present");
    });

    it("T-ENV-08: blank lines are ignored", async () => {
      const content = `\n\nBLANK_VAR=found\n\n\n`;
      const result = await parseEnvAndObserve(content, "BLANK_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("found");
    });

    it("T-ENV-09: duplicate keys use last-wins semantics", async () => {
      const content = `DUP_VAR=first\nDUP_VAR=second\nDUP_VAR=third\n`;
      const result = await parseEnvAndObserve(content, "DUP_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("third");
    });

    it("T-ENV-10: double-quoted values have quotes stripped", async () => {
      const content = `DQ_VAR="quoted value"\n`;
      const result = await parseEnvAndObserve(content, "DQ_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("quoted value");
    });

    it("T-ENV-11: single-quoted values have quotes stripped", async () => {
      const content = `SQ_VAR='single quoted'\n`;
      const result = await parseEnvAndObserve(content, "SQ_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("single quoted");
    });

    it("T-ENV-12: backslash-n is treated as literal characters, not a newline", async () => {
      const content = `ESC_VAR="hello\\nworld"\n`;
      const result = await parseEnvAndObserve(content, "ESC_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("hello\\nworld");
    });

    it("T-ENV-13: inline # character is part of the value, not a comment", async () => {
      const content = `HASH_VAR=value#with#hash\n`;
      const result = await parseEnvAndObserve(content, "HASH_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("value#with#hash");
    });

    it("T-ENV-14: trailing whitespace on values is trimmed", async () => {
      const content = `TRAIL_VAR=value   \n`;
      const result = await parseEnvAndObserve(content, "TRAIL_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("value");
    });

    it("T-ENV-15: KEY = value (spaces around =) treats key as 'KEY ' which is invalid", async () => {
      const content = `KEY = value\nGOOD_KEY=present\n`;
      const goodResult = await parseEnvAndObserve(content, "GOOD_KEY", runtime);
      expect(goodResult.present).toBe(true);
      expect(goodResult.value).toBe("present");
      expect(goodResult.stderr).toMatch(/warning|invalid|ignored|malformed/i);
      const keyResult = await parseEnvAndObserve(content, "KEY", runtime);
      expect(keyResult.present).toBe(false);
    });

    it("T-ENV-15a: KEY= with no value sets the variable to empty string", async () => {
      const content = `EMPTY_VAR=\n`;
      const result = await parseEnvAndObserve(content, "EMPTY_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("");
    });

    it("T-ENV-15b: value containing = is split on first = only", async () => {
      const content = `MULTI_EQ=val=ue=extra\n`;
      const result = await parseEnvAndObserve(content, "MULTI_EQ", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("val=ue=extra");
    });

    it("T-ENV-15c: key starting with digit is invalid and ignored", async () => {
      const content = `1BAD=val\nVALID_KEY=ok\n`;
      const result = await parseEnvAndObserve(content, "VALID_KEY", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("ok");
      expect(result.stderr).toMatch(/warning|invalid|ignored|malformed/i);

      const badResult = await parseEnvAndObserve(content, "1BAD", runtime);
      expect(badResult.present).toBe(false);
    });

    it("T-ENV-15d: malformed line without = is ignored", async () => {
      const content = `noequalssign\nOK_VAR=works\n`;
      const result = await parseEnvAndObserve(content, "OK_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe("works");
      expect(result.stderr).toMatch(/warning|invalid|ignored|malformed/i);
    });

    it("T-ENV-15e: unmatched quotes are treated as literal characters", async () => {
      const content = `UNMATCH_VAR="unmatched\n`;
      const result = await parseEnvAndObserve(content, "UNMATCH_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe('"unmatched');
    });

    it("T-ENV-15f: leading space in value after = is preserved", async () => {
      const content = `LEAD_VAR= value\n`;
      const result = await parseEnvAndObserve(content, "LEAD_VAR", runtime);
      expect(result.present).toBe(true);
      expect(result.value).toBe(" value");
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: Local Env Override  (T-ENV-16 through T-ENV-19)
// ---------------------------------------------------------------------------

describe("SPEC: Local Env Override", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    it("T-ENV-16: -e flag loads variables from a local env file into the script environment", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "local-env-marker.txt");
      const localEnvPath = join(project.dir, "local.env");
      await createEnvFile(localEnvPath, { LOCAL_VAR: "local-value-42" });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeEnvToFile("LOCAL_VAR", markerPath),
      );

      const result = await runCLI(
        ["run", "-e", "local.env", "-n", "1", "ralph"],
        { cwd: project.dir, runtime },
      );

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf-8")).toBe("local-value-42");
    });

    it("T-ENV-17: -e with nonexistent file causes exit 1", async () => {
      project = await createTempProject();
      await createBashWorkflowScript(project, "ralph", "index", `echo ok`);

      const result = await runCLI(
        ["run", "-e", "does-not-exist.env", "-n", "1", "ralph"],
        { cwd: project.dir, runtime },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it.skipIf(IS_ROOT)("T-ENV-17a: -e with unreadable file causes exit 1", async () => {
      project = await createTempProject();
      const localEnvPath = join(project.dir, "unreadable.env");
      await createEnvFile(localEnvPath, { KEY: "val" });
      await chmod(localEnvPath, 0o000);

      await createBashWorkflowScript(project, "ralph", "index", `echo ok`);

      const result = await runCLI(
        ["run", "-e", "unreadable.env", "-n", "1", "ralph"],
        { cwd: project.dir, runtime },
      );

      expect(result.exitCode).toBe(1);
    });

    it("T-ENV-18: local -e file overrides global env on key conflict", async () => {
      await withGlobalEnv({ CONFLICT_VAR: "global-value" }, async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "conflict-marker.txt");
        const localEnvPath = join(project.dir, "local.env");
        await createEnvFile(localEnvPath, { CONFLICT_VAR: "local-value" });

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          writeEnvToFile("CONFLICT_VAR", markerPath),
        );

        const result = await runCLI(
          ["run", "-e", "local.env", "-n", "1", "ralph"],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        expect(readFileSync(markerPath, "utf-8")).toBe("local-value");
      });
    });

    it("T-ENV-19: both global and local env vars are present when no conflict", async () => {
      await withGlobalEnv({ GLOBAL_ONLY: "from-global" }, async () => {
        project = await createTempProject();
        const globalMarker = join(project.dir, "global-marker.txt");
        const localMarker = join(project.dir, "local-marker.txt");
        const localEnvPath = join(project.dir, "local.env");
        await createEnvFile(localEnvPath, { LOCAL_ONLY: "from-local" });

        const scriptContent = `#!/bin/bash
printf '%s' "$GLOBAL_ONLY" > "${globalMarker}"
printf '%s' "$LOCAL_ONLY" > "${localMarker}"
`;
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          scriptContent,
        );

        const result = await runCLI(
          ["run", "-e", "local.env", "-n", "1", "ralph"],
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
// SPEC: Injection Precedence  (T-ENV-20 through T-ENV-24b)
// ---------------------------------------------------------------------------

describe("SPEC: Injection Precedence", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    it("T-ENV-20: LOOPX_BIN injected by runtime overrides env file value", async () => {
      await withGlobalEnv({ LOOPX_BIN: "env-file-bin-path" }, async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "bin-marker.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          writeEnvToFile("LOOPX_BIN", markerPath),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const content = readFileSync(markerPath, "utf-8");
        expect(content).not.toBe("env-file-bin-path");
        expect(content.length).toBeGreaterThan(0);
        expect(content).toMatch(/loopx|bin/i);
      });
    });

    it("T-ENV-20a: LOOPX_BIN injected by runtime overrides system env", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "bin-sys-marker.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeEnvToFile("LOOPX_BIN", markerPath),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { LOOPX_BIN: "system-env-bin-path" },
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const content = readFileSync(markerPath, "utf-8");
      expect(content).not.toBe("system-env-bin-path");
      expect(content.length).toBeGreaterThan(0);
      expect(content).toMatch(/loopx|bin/i);
    });

    it("T-ENV-20b: LOOPX_BIN injected by runtime overrides local env file (-e) value", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "bin-local-marker.txt");
      const localEnvPath = join(project.dir, "local.env");
      await createEnvFile(localEnvPath, { LOOPX_BIN: "/tmp/fake-binary" });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeEnvToFile("LOOPX_BIN", markerPath),
      );

      const result = await runCLI(
        ["run", "-e", "local.env", "-n", "1", "ralph"],
        { cwd: project.dir, runtime },
      );

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const content = readFileSync(markerPath, "utf-8");
      // Loopx-injected LOOPX_BIN must override the local -e value
      expect(content).not.toBe("/tmp/fake-binary");
      expect(content.length).toBeGreaterThan(0);
      // The injected value points to a real executable path
      expect(content).toMatch(/loopx|bin/i);
    });

    it("T-ENV-21: LOOPX_PROJECT_ROOT injected by runtime overrides env file value", async () => {
      await withGlobalEnv(
        { LOOPX_PROJECT_ROOT: "/fake/env/path" },
        async () => {
          project = await createTempProject();
          const markerPath = join(project.dir, "root-marker.txt");

          await createWorkflowScript(
            project,
            "ralph",
            "index",
            ".sh",
            writeEnvToFile("LOOPX_PROJECT_ROOT", markerPath),
          );

          const result = await runCLI(["run", "-n", "1", "ralph"], {
            cwd: project.dir,
            runtime,
          });

          expect(result.exitCode).toBe(0);
          expect(existsSync(markerPath)).toBe(true);
          const content = readFileSync(markerPath, "utf-8");
          expect(content).not.toBe("/fake/env/path");
          expect(content).toBe(project!.dir);
        },
      );
    });

    it("T-ENV-21a: LOOPX_PROJECT_ROOT injected by runtime overrides system env", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "root-sys-marker.txt");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeEnvToFile("LOOPX_PROJECT_ROOT", markerPath),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { LOOPX_PROJECT_ROOT: "/fake/system/path" },
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const content = readFileSync(markerPath, "utf-8");
      expect(content).not.toBe("/fake/system/path");
      expect(content).toBe(project!.dir);
    });

    it("T-ENV-21b: LOOPX_WORKFLOW injected by runtime overrides env file value", async () => {
      await withGlobalEnv({ LOOPX_WORKFLOW: "fake" }, async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "workflow-marker.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          writeEnvToFile("LOOPX_WORKFLOW", markerPath),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const content = readFileSync(markerPath, "utf-8");
        // Loopx-injected LOOPX_WORKFLOW must override the global env file value
        expect(content).not.toBe("fake");
        expect(content).toBe("ralph");
      });
    });

    it("T-ENV-21c: LOOPX_WORKFLOW injected by runtime overrides local env file (-e) value", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "workflow-local-marker.txt");
      const localEnvPath = join(project.dir, "local.env");
      await createEnvFile(localEnvPath, { LOOPX_WORKFLOW: "fake" });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeEnvToFile("LOOPX_WORKFLOW", markerPath),
      );

      const result = await runCLI(
        ["run", "-e", "local.env", "-n", "1", "ralph"],
        { cwd: project.dir, runtime },
      );

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const content = readFileSync(markerPath, "utf-8");
      // Loopx-injected LOOPX_WORKFLOW must override the local -e value
      expect(content).not.toBe("fake");
      expect(content).toBe("ralph");
    });

    it("T-ENV-21d: LOOPX_PROJECT_ROOT injected by runtime overrides local env file (-e) value", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "root-local-marker.txt");
      const localEnvPath = join(project.dir, "local.env");
      await createEnvFile(localEnvPath, {
        LOOPX_PROJECT_ROOT: "/tmp/fake-project-root",
      });

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        writeEnvToFile("LOOPX_PROJECT_ROOT", markerPath),
      );

      const result = await runCLI(
        ["run", "-e", "local.env", "-n", "1", "ralph"],
        { cwd: project.dir, runtime },
      );

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const content = readFileSync(markerPath, "utf-8");
      // Loopx-injected LOOPX_PROJECT_ROOT must override the local -e value
      expect(content).not.toBe("/tmp/fake-project-root");
      expect(content).toBe(project!.dir);
    });

    it("T-ENV-22: global env file variable overrides same-named system env variable", async () => {
      await withGlobalEnv({ OVERRIDE_ME: "from-global-env" }, async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "override-marker.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          writeEnvToFile("OVERRIDE_ME", markerPath),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: { OVERRIDE_ME: "from-system-env" },
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        expect(readFileSync(markerPath, "utf-8")).toBe("from-global-env");
      });
    });

    it("T-ENV-23: system env variable is visible when not overridden by env files", async () => {
      await withIsolatedHome(async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "sysenv-marker.txt");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          writeEnvToFile("SYSTEM_ONLY_VAR", markerPath),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: { SYSTEM_ONLY_VAR: "from-system" },
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        expect(readFileSync(markerPath, "utf-8")).toBe("from-system");
      });
    });

    it("T-ENV-24: full precedence chain: local wins, then global wins, then system wins", async () => {
      const tempConfigHome = await mkdtemp(join(tmpdir(), "loopx-config-"));
      const loopxConfigDir = join(tempConfigHome, "loopx");
      await mkdir(loopxConfigDir, { recursive: true });
      const globalEnvPath = join(loopxConfigDir, "env");
      await createEnvFile(globalEnvPath, { VAR: "from-global" });

      const originalXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tempConfigHome;

      try {
        project = await createTempProject();
        const localEnvPath = join(project.dir, "local.env");
        await createEnvFile(localEnvPath, { VAR: "from-local" });

        const markerPath = join(project.dir, "var-marker.txt");
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          writeEnvToFile("VAR", markerPath),
        );

        const systemEnv = { VAR: "from-system" };

        // Step 1: local + global + system → local wins
        const r1 = await runCLI(
          ["run", "-e", "local.env", "-n", "1", "ralph"],
          { cwd: project.dir, runtime, env: systemEnv },
        );
        expect(r1.exitCode).toBe(0);
        expect(readFileSync(markerPath, "utf-8")).toBe("from-local");

        // Step 2: remove local → global wins
        unlinkSync(localEnvPath);

        const r2 = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: systemEnv,
        });
        expect(r2.exitCode).toBe(0);
        expect(readFileSync(markerPath, "utf-8")).toBe("from-global");

        // Step 3: remove global → system wins
        unlinkSync(globalEnvPath);

        const r3 = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: systemEnv,
        });
        expect(r3.exitCode).toBe(0);
        expect(readFileSync(markerPath, "utf-8")).toBe("from-system");
      } finally {
        if (originalXdg === undefined) {
          delete process.env.XDG_CONFIG_HOME;
        } else {
          process.env.XDG_CONFIG_HOME = originalXdg;
        }
        await rm(tempConfigHome, { recursive: true, force: true });
      }
    });

    it("T-ENV-24a: LOOPX_DELEGATED is visible in script execution environments when inherited", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "delegated-marker.json");

      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        observeEnv("LOOPX_DELEGATED", markerPath),
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { LOOPX_DELEGATED: "1" },
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const data = JSON.parse(readFileSync(markerPath, "utf-8"));
      // Per ADR-0003 / TEST-SPEC §4.7: loopx does NOT scrub LOOPX_DELEGATED
      // from the script environment — it is inherited as-is.
      expect(data).toEqual({ present: true, value: "1" });
    });

    it("T-ENV-24b: empty string in local env file overrides global and system values", async () => {
      await withGlobalEnv({ MY_VAR: "global-value" }, async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "myvar-marker.json");
        const localEnvPath = join(project.dir, "local.env");

        await writeEnvFileRaw(localEnvPath, "MY_VAR=\n");

        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".ts",
          observeEnv("MY_VAR", markerPath),
        );

        const result = await runCLI(
          ["run", "-e", "local.env", "-n", "1", "ralph"],
          {
            cwd: project.dir,
            runtime,
            env: { MY_VAR: "system-value" },
          },
        );

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(readFileSync(markerPath, "utf-8"));
        expect(data).toEqual({ present: true, value: "" });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: Env Caching  (T-ENV-25 through T-ENV-25c)
// ---------------------------------------------------------------------------

describe("SPEC: Env Caching", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    it("T-ENV-25: global env is loaded once and cached; modifications during loop are not seen", async () => {
      await withGlobalEnv({ CACHED_VAR: "original" }, async () => {
        const xdg = process.env.XDG_CONFIG_HOME!;
        const envFilePath = join(xdg, "loopx", "env");

        project = await createTempProject();
        const marker1 = join(project.dir, "iter1.txt");
        const marker2 = join(project.dir, "iter2.txt");
        const counterFile = join(project.dir, "counter.txt");

        const scriptContent = `#!/bin/bash
printf '1' >> "${counterFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')

if [ "$COUNT" = "1" ]; then
  printf '%s' "$CACHED_VAR" > "${marker1}"
  echo "CACHED_VAR=modified" > "${envFilePath}"
elif [ "$COUNT" = "2" ]; then
  printf '%s' "$CACHED_VAR" > "${marker2}"
fi
`;
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".sh",
          scriptContent,
        );

        const result = await runCLI(["run", "-n", "2", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(marker1)).toBe(true);
        expect(existsSync(marker2)).toBe(true);

        expect(readFileSync(marker1, "utf-8")).toBe("original");
        expect(readFileSync(marker2, "utf-8")).toBe("original");
      });
    });

    it("T-ENV-25a: local -e env is loaded once and cached; modifications during loop are not seen", async () => {
      project = await createTempProject();
      const localEnvPath = join(project.dir, "local.env");
      await createEnvFile(localEnvPath, { LOCAL_CACHED: "original-local" });

      const marker1 = join(project.dir, "local-iter1.txt");
      const marker2 = join(project.dir, "local-iter2.txt");
      const counterFile = join(project.dir, "local-counter.txt");

      const scriptContent = `#!/bin/bash
printf '1' >> "${counterFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')

if [ "$COUNT" = "1" ]; then
  printf '%s' "$LOCAL_CACHED" > "${marker1}"
  echo "LOCAL_CACHED=modified-local" > "${localEnvPath}"
elif [ "$COUNT" = "2" ]; then
  printf '%s' "$LOCAL_CACHED" > "${marker2}"
fi
`;
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".sh",
        scriptContent,
      );

      const result = await runCLI(
        ["run", "-e", "local.env", "-n", "2", "ralph"],
        { cwd: project.dir, runtime },
      );

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker1)).toBe(true);
      expect(existsSync(marker2)).toBe(true);

      expect(readFileSync(marker1, "utf-8")).toBe("original-local");
      expect(readFileSync(marker2, "utf-8")).toBe("original-local");
    });

    it.skipIf(IS_ROOT)(
      "T-ENV-25b: `loopx run -n 0 ralph` with an unreadable global env file exits 1 (env loads before -n 0 short-circuit)",
      async () => {
        await withGlobalEnv({ SOME_VAR: "some_val" }, async () => {
          const xdg = process.env.XDG_CONFIG_HOME!;
          const envPath = join(xdg, "loopx", "env");
          await chmod(envPath, 0o000);

          project = await createTempProject();
          await createBashWorkflowScript(
            project,
            "ralph",
            "index",
            `echo ok`,
          );

          const result = await runCLI(["run", "-n", "0", "ralph"], {
            cwd: project.dir,
            runtime,
          });

          expect(result.exitCode).toBe(1);
          expect(result.stderr.length).toBeGreaterThan(0);
          expect(result.stderr.toLowerCase()).toMatch(
            /unreadable|permission|denied|access|cannot read/i,
          );
        });
      },
    );

    it("T-ENV-25c: `loopx run -n 0 ralph` with a malformed-but-readable global env file exits 0 with a parser warning", async () => {
      const tempConfigHome = await mkdtemp(join(tmpdir(), "loopx-parse-n0-"));
      const loopxConfigDir = join(tempConfigHome, "loopx");
      await mkdir(loopxConfigDir, { recursive: true });
      const envFilePath = join(loopxConfigDir, "env");
      // Include an invalid key that triggers a parser warning, plus a valid line.
      await writeEnvFileRaw(envFilePath, "1BAD=val\nGOOD_KEY=ok\n");

      const originalXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tempConfigHome;

      try {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `echo "should not run under -n 0"`,
        );

        const result = await runCLI(["run", "-n", "0", "ralph"], {
          cwd: project.dir,
          runtime,
        });

        // The global env file was readable and parseable enough that the
        // process exits 0 after parsing; the malformed line produced a warning.
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/warning|invalid|ignored|malformed/i);
      } finally {
        if (originalXdg === undefined) {
          delete process.env.XDG_CONFIG_HOME;
        } else {
          process.env.XDG_CONFIG_HOME = originalXdg;
        }
        await rm(tempConfigHome, { recursive: true, force: true });
      }
    });
  });
});
