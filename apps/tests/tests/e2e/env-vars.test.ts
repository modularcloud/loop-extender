import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, unlinkSync, realpathSync } from "node:fs";
import { mkdir, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

// ---------------------------------------------------------------------------
// SPEC: CLI Env File LOOPX_* NUL Override
//   (T-ENV-28 / T-ENV-28a — CLI local env file `-e`,
//    T-ENV-29 / T-ENV-29a — CLI global env file)
//
// Closes the SPEC §8.3 protocol-variable override × SPEC §9.5 / §7.2 NUL-
// runtime-rejection merge-order contract on the CLI surface across both
// env-file tiers (tier 3 local `-e`, tier 4 global) and all five script-
// protocol-protected names (LOOPX_BIN, LOOPX_PROJECT_ROOT, LOOPX_WORKFLOW,
// LOOPX_WORKFLOW_DIR, LOOPX_TMPDIR).
//
// SPEC §8.1: env-file values may contain embedded NUL bytes — the parser
// splits content on '\n' and reads from after the first '=' to end of line,
// with no NUL-byte filtering. The NUL byte therefore reaches mergeEnv
// unchanged from the env-file-loaded vars. The protocol-tier overlay in
// execution.ts (lines 179-185) applies AFTER the merged env is computed in
// run.ts (lines 661-664), so for the five script-protocol-protected names
// the user-supplied NUL value is replaced before the merged env reaches
// child_process.spawn — no spawn failure surfaces.
//
// CLI counterpart of T-API-58f / T-API-58f2 (programmatic local envFile)
// and T-API-58g / T-API-58g2 (programmatic global env file). A buggy
// implementation that wired the protocol-tier-overlay-after-merge contract
// correctly on the programmatic env-file paths but routed CLI env-file
// loading through a separate, merge-order-broken code path would pass
// T-API-58f / T-API-58f2 / T-API-58g / T-API-58g2 yet fail these tests.
//
// All tests run under a test-isolated TMPDIR parent (TEST-SPEC §4.7) — the
// suite-wide isolation guidance avoids races on /tmp `loopx-*` entries
// between concurrent test workers. XDG_CONFIG_HOME is supplied via runCLI's
// `env` option (extraEnv) rather than mutating process.env, so concurrent
// tests within the same worker remain isolated.
// ---------------------------------------------------------------------------

describe("SPEC: CLI Env File LOOPX_* NUL Override", () => {
  let project: TempProject | null = null;
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.shift();
      if (cleanup) await cleanup().catch(() => {});
    }
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  async function makeIsolatedTmpdirParent(label: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `loopx-test-${label}-`));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    });
    return dir;
  }

  async function makeIsolatedXdgConfigHome(label: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `loopx-test-xdg-${label}-`));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    });
    return dir;
  }

  function assertObservedRealProtocolValue(
    name: string,
    observed: string,
    projectRoot: string,
    realTmpdirParent: string,
    tmpdirStatMarker: string,
  ): void {
    expect(observed).not.toBe("bad value");
    if (name === "LOOPX_WORKFLOW") {
      expect(observed).toBe("ralph");
    } else if (name === "LOOPX_TMPDIR") {
      // Real loopx-created tmpdir per SPEC §7.4 mkdtemp naming convention.
      expect(observed).toMatch(/\/loopx-[^/]+$/);
      expect(observed.startsWith(realTmpdirParent)).toBe(true);
      // During-run stat marker proves real loopx-created directory (not a
      // substituted string). SPEC §7.4 cleanup removes the dir AFTER the
      // script exits, so a post-run stat would observe absence even if the
      // value were a real path.
      expect(readFileSync(tmpdirStatMarker, "utf-8")).toBe("is-dir");
    } else if (name === "LOOPX_BIN") {
      // LOOPX_BIN is the resolved realpath of the loopx binary.
      expect(existsSync(observed)).toBe(true);
    } else if (name === "LOOPX_PROJECT_ROOT") {
      expect(observed).toBe(projectRoot);
    } else if (name === "LOOPX_WORKFLOW_DIR") {
      expect(observed).toBe(join(projectRoot, ".loopx", "ralph"));
    }
  }

  function tmpdirStatBlock(name: string, marker: string): string {
    if (name !== "LOOPX_TMPDIR") return "";
    return `if [ -d "$LOOPX_TMPDIR" ]; then
  printf 'is-dir' > "${marker}"
else
  printf 'not-dir' > "${marker}"
fi
`;
  }

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-ENV-28: CLI — local env file (`-e`) supplying a NUL-containing value
    //   for LOOPX_TMPDIR is silently overridden by protocol injection. The
    //   CLI run succeeds, no spawn failure surfaces, and the script observes
    //   the real protocol value (a real loopx-created tmpdir under the test-
    //   isolated parent). Tests the dynamically-computed-protocol-injection
    //   axis (LOOPX_TMPDIR per SPEC §7.4) on the CLI's local env-file tier.
    //   Companion to T-ENV-26 (NUL in non-protocol env-file value, surfaces
    //   as spawn failure) — together they pin down that the env-file tier's
    //   NUL-rejection path applies only when the entry is **not** about to be
    //   overridden by protocol injection. SPEC §7.2 / §8.1 / §8.3 / §9.5 /
    //   §13.
    // ------------------------------------------------------------------------
    it("T-ENV-28: CLI -e — NUL in LOOPX_TMPDIR silently overridden by protocol injection", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("env28");
      const realTmpdirParent = realpathSync(tmpdirParent);
      const projectRoot = realpathSync(project.dir);
      const obsMarker = join(project.dir, "loopx_tmpdir.txt");
      const tmpdirStatMarker = join(project.dir, "loopx_tmpdir_stat.txt");
      const ranMarker = join(project.dir, "child-ran.txt");
      const envFilePath = join(project.dir, "local.env");
      // SPEC §8.1: env-file parser splits on '\n' and reads value from
      // after the first '=' to end of line — NUL bytes within the value
      // are preserved verbatim and reach mergeEnv unchanged.
      await writeEnvFileRaw(envFilePath, `LOOPX_TMPDIR=bad\x00value\n`);
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_TMPDIR" > "${obsMarker}"
${tmpdirStatBlock("LOOPX_TMPDIR", tmpdirStatMarker)}printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
      );

      const result = await runCLI(
        ["run", "-e", envFilePath, "-n", "1", "ralph"],
        {
          cwd: project.dir,
          runtime,
          env: { TMPDIR: tmpdirParent },
        },
      );

      // (a) Exit code 0 (no spawn-failure rejection — protocol-tier overlay
      //     replaced the NUL value before the runtime saw it). Load-bearing —
      //     a buggy implementation that merged the env-file tier into the
      //     inherited env BEFORE applying protocol injection would surface a
      //     child launch / spawn failure on the NUL byte and fail this.
      expect(result.exitCode).toBe(0);
      // (b) Marker records a real absolute path under the test-isolated
      //     tmpdir parent (matching the per-spawn dynamically-computed tmpdir
      //     from SPEC §7.4) — not "bad\x00value".
      const observed = readFileSync(obsMarker, "utf-8");
      assertObservedRealProtocolValue(
        "LOOPX_TMPDIR",
        observed,
        projectRoot,
        realTmpdirParent,
        tmpdirStatMarker,
      );
      // (c) Stderr contains no spawn-failure error and no parser warning
      //     about NUL (per SPEC §8.1 the parser does not validate NUL).
      expect(result.stderr).not.toMatch(/exited with code/);
      expect(result.stderr).not.toMatch(/spawn/i);
      expect(result.stderr).not.toMatch(/nul|\\x00/i);
      // (d) Stderr contains no override-warning for LOOPX_TMPDIR (per SPEC
      //     §13 protocol-variable override is silent on the env-file tier
      //     as well — same contract as T-WFDIR-07 with ordinary fake values).
      expect(result.stderr).not.toMatch(
        /loopx_tmpdir.*(override|overrid|ignored|warning|notice)/i,
      );
      // (e) Workflow script ran exactly once.
      expect(existsSync(ranMarker)).toBe(true);
    });

    // ------------------------------------------------------------------------
    // T-ENV-28a (i)–(iv): CLI — local env file (`-e`) — parameterized over the
    //   remaining four script-protocol-protected names (LOOPX_BIN,
    //   LOOPX_PROJECT_ROOT, LOOPX_WORKFLOW, LOOPX_WORKFLOW_DIR). T-ENV-28
    //   covers LOOPX_TMPDIR (the dynamically-computed name); together they
    //   bring the CLI local env-file tier to all-five-name coverage matching
    //   the RunOptions.env tier (T-API-58b/58c/58d/58e/58e2/58d2) and the
    //   programmatic local-env-file tier (T-API-58f / T-API-58f2). A buggy
    //   implementation that special-cased LOOPX_TMPDIR into one merge-order-
    //   correct code path while routing the call-time-derived names through a
    //   separate, merge-order-broken path on the env-file tier would pass
    //   T-ENV-28 and fail this test. SPEC §7.2 / §8.1 / §8.3 / §9.5 / §13.
    // ------------------------------------------------------------------------
    for (const variant of [
      { name: "LOOPX_BIN", id: "i", marker: "loopx_bin" },
      { name: "LOOPX_PROJECT_ROOT", id: "ii", marker: "loopx_project_root" },
      { name: "LOOPX_WORKFLOW", id: "iii", marker: "loopx_workflow" },
      { name: "LOOPX_WORKFLOW_DIR", id: "iv", marker: "loopx_workflow_dir" },
    ]) {
      it(`T-ENV-28a (${variant.id} ${variant.name}): CLI -e — NUL in ${variant.name} silently overridden by protocol injection`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`env28a-${variant.id}`);
        const realTmpdirParent = realpathSync(tmpdirParent);
        const projectRoot = realpathSync(project.dir);
        const obsMarker = join(project.dir, `${variant.marker}.txt`);
        const tmpdirStatMarker = join(project.dir, "loopx_tmpdir_stat.txt");
        const ranMarker = join(project.dir, "child-ran.txt");
        const envFilePath = join(project.dir, "local.env");
        await writeEnvFileRaw(
          envFilePath,
          `${variant.name}=bad\x00value\n`,
        );
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' "\$${variant.name}" > "${obsMarker}"
${tmpdirStatBlock(variant.name, tmpdirStatMarker)}printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
        );

        const result = await runCLI(
          ["run", "-e", envFilePath, "-n", "1", "ralph"],
          {
            cwd: project.dir,
            runtime,
            env: { TMPDIR: tmpdirParent },
          },
        );

        // (a) Exit code 0 — no spawn failure (protocol-tier override replaced
        //     the NUL value before the runtime observed it).
        expect(result.exitCode).toBe(0);
        // (b) Marker records the real protocol value for the variant.
        const observed = readFileSync(obsMarker, "utf-8");
        assertObservedRealProtocolValue(
          variant.name,
          observed,
          projectRoot,
          realTmpdirParent,
          tmpdirStatMarker,
        );
        // (c) Stderr contains no spawn-failure error and no parser warning.
        expect(result.stderr).not.toMatch(/exited with code/);
        expect(result.stderr).not.toMatch(/spawn/i);
        expect(result.stderr).not.toMatch(/nul|\\x00/i);
        // (d) No override-warning on stderr for the variant's name.
        expect(result.stderr).not.toMatch(
          new RegExp(
            `${variant.name.toLowerCase()}.*(override|overrid|ignored|warning|notice)`,
            "i",
          ),
        );
        // (e) Workflow script ran exactly once.
        expect(existsSync(ranMarker)).toBe(true);
      });
    }

    // ------------------------------------------------------------------------
    // T-ENV-29: CLI — global env file (§8.3 tier 4) supplying a NUL-containing
    //   value for LOOPX_TMPDIR is silently overridden by protocol injection.
    //   Global-env-file counterpart to T-ENV-28 (local env-file tier 3).
    //   XDG_CONFIG_HOME is supplied via runCLI's env option (extraEnv) rather
    //   than mutating process.env, so concurrent tests remain isolated.
    //   SPEC §7.2 / §8.1 / §8.3 / §9.5 / §13.
    // ------------------------------------------------------------------------
    it("T-ENV-29: CLI global env file — NUL in LOOPX_TMPDIR silently overridden by protocol injection", async () => {
      project = await createTempProject();
      const tmpdirParent = await makeIsolatedTmpdirParent("env29");
      const realTmpdirParent = realpathSync(tmpdirParent);
      const projectRoot = realpathSync(project.dir);
      const obsMarker = join(project.dir, "loopx_tmpdir.txt");
      const tmpdirStatMarker = join(project.dir, "loopx_tmpdir_stat.txt");
      const ranMarker = join(project.dir, "child-ran.txt");
      // Provision an isolated XDG_CONFIG_HOME with <xdg>/loopx/env containing
      // the NUL-bearing protocol-name line.
      const xdgDir = await makeIsolatedXdgConfigHome("env29");
      const loopxConfigDir = join(xdgDir, "loopx");
      await mkdir(loopxConfigDir, { recursive: true });
      const globalEnvFilePath = join(loopxConfigDir, "env");
      await writeEnvFileRaw(globalEnvFilePath, `LOOPX_TMPDIR=bad\x00value\n`);
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "$LOOPX_TMPDIR" > "${obsMarker}"
${tmpdirStatBlock("LOOPX_TMPDIR", tmpdirStatMarker)}printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
      );

      const result = await runCLI(["run", "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { TMPDIR: tmpdirParent, XDG_CONFIG_HOME: xdgDir },
      });

      // (a) Exit code 0 (no spawn failure).
      expect(result.exitCode).toBe(0);
      // (b) Marker records a real absolute path under the test-isolated
      //     tmpdir parent — not "bad\x00value".
      const observed = readFileSync(obsMarker, "utf-8");
      assertObservedRealProtocolValue(
        "LOOPX_TMPDIR",
        observed,
        projectRoot,
        realTmpdirParent,
        tmpdirStatMarker,
      );
      // (c) No spawn-failure error or NUL parser warning on stderr.
      expect(result.stderr).not.toMatch(/exited with code/);
      expect(result.stderr).not.toMatch(/spawn/i);
      expect(result.stderr).not.toMatch(/nul|\\x00/i);
      // (d) No override-warning on stderr for LOOPX_TMPDIR.
      expect(result.stderr).not.toMatch(
        /loopx_tmpdir.*(override|overrid|ignored|warning|notice)/i,
      );
      // (e) Workflow script ran.
      expect(existsSync(ranMarker)).toBe(true);
    });

    // ------------------------------------------------------------------------
    // T-ENV-29a (i)–(iv): CLI — global env file — parameterized hardening over
    //   the remaining four script-protocol-protected names. T-ENV-29 covers
    //   LOOPX_TMPDIR; together they bring the CLI global env-file tier to
    //   all-five-name coverage matching the local env-file tier (T-ENV-28 /
    //   T-ENV-28a) and the RunOptions.env tier (T-API-58b/58c/58d/58e/58e2/
    //   58d2). A buggy implementation that special-cased LOOPX_TMPDIR into
    //   one merge-order-correct path while routing the call-time-derived
    //   names through a separate, merge-order-broken path on the global env-
    //   file tier would pass T-ENV-29 and fail this test. SPEC §7.2 / §8.1 /
    //   §8.3 / §9.5 / §13.
    // ------------------------------------------------------------------------
    for (const variant of [
      { name: "LOOPX_BIN", id: "i", marker: "loopx_bin" },
      { name: "LOOPX_PROJECT_ROOT", id: "ii", marker: "loopx_project_root" },
      { name: "LOOPX_WORKFLOW", id: "iii", marker: "loopx_workflow" },
      { name: "LOOPX_WORKFLOW_DIR", id: "iv", marker: "loopx_workflow_dir" },
    ]) {
      it(`T-ENV-29a (${variant.id} ${variant.name}): CLI global env file — NUL in ${variant.name} silently overridden by protocol injection`, async () => {
        project = await createTempProject();
        const tmpdirParent = await makeIsolatedTmpdirParent(`env29a-${variant.id}`);
        const realTmpdirParent = realpathSync(tmpdirParent);
        const projectRoot = realpathSync(project.dir);
        const obsMarker = join(project.dir, `${variant.marker}.txt`);
        const tmpdirStatMarker = join(project.dir, "loopx_tmpdir_stat.txt");
        const ranMarker = join(project.dir, "child-ran.txt");
        const xdgDir = await makeIsolatedXdgConfigHome(`env29a-${variant.id}`);
        const loopxConfigDir = join(xdgDir, "loopx");
        await mkdir(loopxConfigDir, { recursive: true });
        const globalEnvFilePath = join(loopxConfigDir, "env");
        await writeEnvFileRaw(
          globalEnvFilePath,
          `${variant.name}=bad\x00value\n`,
        );
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' "\$${variant.name}" > "${obsMarker}"
${tmpdirStatBlock(variant.name, tmpdirStatMarker)}printf 'spawned' > "${ranMarker}"
printf '{"stop":true}'`,
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: { TMPDIR: tmpdirParent, XDG_CONFIG_HOME: xdgDir },
        });

        // (a) Exit code 0 — no spawn failure.
        expect(result.exitCode).toBe(0);
        // (b) Marker records the real protocol value.
        const observed = readFileSync(obsMarker, "utf-8");
        assertObservedRealProtocolValue(
          variant.name,
          observed,
          projectRoot,
          realTmpdirParent,
          tmpdirStatMarker,
        );
        // (c) No spawn-failure error and no NUL parser warning.
        expect(result.stderr).not.toMatch(/exited with code/);
        expect(result.stderr).not.toMatch(/spawn/i);
        expect(result.stderr).not.toMatch(/nul|\\x00/i);
        // (d) No override-warning on stderr.
        expect(result.stderr).not.toMatch(
          new RegExp(
            `${variant.name.toLowerCase()}.*(override|overrid|ignored|warning|notice)`,
            "i",
          ),
        );
        // (e) Workflow script ran.
        expect(existsSync(ranMarker)).toBe(true);
      });
    }
  });
});

// ============================================================================
// SPEC: CLI -e file does NOT redirect global env-file lookup
//   (T-API-59f / T-API-59g — CLI-surface counterparts to T-API-59d / T-API-59e
//   for the local env-file tier). SPEC §8.1: "Global env file path resolution
//   reads XDG_CONFIG_HOME / HOME from the inherited environment on the same
//   schedule." A local env file containing XDG_CONFIG_HOME=fake or HOME=fake
//   reaches the spawned child but does not redirect WHERE loopx looks for
//   its own global env file.
// ============================================================================

describe("SPEC: CLI Env File Does Not Affect Loopx's Own Lookups", () => {
  let project: TempProject | null = null;
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.shift();
      if (cleanup) await cleanup().catch(() => {});
    }
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  async function setupRealAndFakeXdg(label: string): Promise<{
    realXdg: string;
    fakeXdg: string;
  }> {
    const realXdg = await mkdtemp(join(tmpdir(), `loopx-test-real-xdg-${label}-`));
    cleanups.push(async () => {
      await rm(realXdg, { recursive: true, force: true }).catch(() => {});
    });
    await mkdir(join(realXdg, "loopx"), { recursive: true });
    await createEnvFile(join(realXdg, "loopx", "env"), { MARKER: "real" });

    const fakeXdg = await mkdtemp(join(tmpdir(), `loopx-test-fake-xdg-${label}-`));
    cleanups.push(async () => {
      await rm(fakeXdg, { recursive: true, force: true }).catch(() => {});
    });
    await mkdir(join(fakeXdg, "loopx"), { recursive: true });
    await createEnvFile(join(fakeXdg, "loopx", "env"), { MARKER: "fake" });

    return { realXdg, fakeXdg };
  }

  async function setupRealAndFakeHome(label: string): Promise<{
    realHome: string;
    fakeHome: string;
  }> {
    const realHome = await mkdtemp(join(tmpdir(), `loopx-test-real-home-${label}-`));
    cleanups.push(async () => {
      await rm(realHome, { recursive: true, force: true }).catch(() => {});
    });
    await mkdir(join(realHome, ".config", "loopx"), { recursive: true });
    await createEnvFile(join(realHome, ".config", "loopx", "env"), {
      MARKER: "real",
    });

    const fakeHome = await mkdtemp(join(tmpdir(), `loopx-test-fake-home-${label}-`));
    cleanups.push(async () => {
      await rm(fakeHome, { recursive: true, force: true }).catch(() => {});
    });
    await mkdir(join(fakeHome, ".config", "loopx"), { recursive: true });
    await createEnvFile(join(fakeHome, ".config", "loopx", "env"), {
      MARKER: "fake",
    });

    return { realHome, fakeHome };
  }

  forEachRuntime((runtime) => {
    // ------------------------------------------------------------------------
    // T-API-59f: CLI -e file does NOT redirect global env-file lookup via
    //   XDG_CONFIG_HOME. CLI-surface parity for T-API-59d (programmatic
    //   RunOptions.envFile). The CLI argv-parsing path for -e is structurally
    //   distinct from the programmatic envFile field. SPEC §8.1, §8.2, §8.3,
    //   §4.2.
    // ------------------------------------------------------------------------
    it("T-API-59f: CLI -e file does NOT redirect global env-file lookup via XDG_CONFIG_HOME", async () => {
      project = await createTempProject();
      const xdgMarker = join(project.dir, "xdg.txt");
      const markerMarker = join(project.dir, "marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${XDG_CONFIG_HOME:-UNSET}" > "${xdgMarker}"
printf '%s' "\${MARKER:-UNSET}" > "${markerMarker}"
printf '{"stop":true}'`,
      );

      const { realXdg, fakeXdg } = await setupRealAndFakeXdg("api59f");

      const localEnvFile = join(project.dir, "local.env");
      await createEnvFile(localEnvFile, { XDG_CONFIG_HOME: fakeXdg });

      // Pass real XDG_CONFIG_HOME via runCLI's extraEnv (inherited env in the
      // spawned loopx process). The local env file supplied via -e contains
      // XDG_CONFIG_HOME=fakeXdg — that value reaches the script, but loopx
      // resolves the global env file from its OWN inherited XDG_CONFIG_HOME.
      const result = await runCLI(["run", "-e", localEnvFile, "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { XDG_CONFIG_HOME: realXdg },
      });

      // (a) Exit code 0.
      expect(result.exitCode).toBe(0);
      // (b) Child observed XDG_CONFIG_HOME from -e file (the fake path).
      expect(readFileSync(xdgMarker, "utf-8")).toBe(fakeXdg);
      // (c) loopx loaded global env file using inherited XDG_CONFIG_HOME
      //     (real path) — so MARKER=real.
      expect(readFileSync(markerMarker, "utf-8")).toBe("real");
    });

    // ------------------------------------------------------------------------
    // T-API-59g: CLI -e file does NOT redirect global env-file lookup via
    //   HOME. CLI-surface, HOME-fallback parity for T-API-59e. SPEC §8.1,
    //   §8.2, §8.3, §4.2.
    // ------------------------------------------------------------------------
    it("T-API-59g: CLI -e file does NOT redirect global env-file lookup via HOME", async () => {
      project = await createTempProject();
      const homeMarker = join(project.dir, "home.txt");
      const markerMarker = join(project.dir, "marker.txt");
      await createBashWorkflowScript(
        project,
        "ralph",
        "index",
        `printf '%s' "\${HOME:-UNSET}" > "${homeMarker}"
printf '%s' "\${MARKER:-UNSET}" > "${markerMarker}"
printf '{"stop":true}'`,
      );

      const { realHome, fakeHome } = await setupRealAndFakeHome("api59g");

      const localEnvFile = join(project.dir, "local.env");
      await createEnvFile(localEnvFile, { HOME: fakeHome });

      // Strategy: pass HOME=realHome via runCLI's extraEnv. Also explicitly
      // unset XDG_CONFIG_HOME in the spawned loopx's inherited env (otherwise
      // loopx might consult an unrelated $XDG_CONFIG_HOME inherited from the
      // test runner and the HOME fallback path wouldn't be exercised).
      // runCLI's `env` option SPREADS over process.env (line 56-59 of cli.ts).
      // Setting XDG_CONFIG_HOME to undefined in the spread does not delete
      // it. We need a value that loopx will treat as unset. Empty string
      // (per env.ts line 24: `env.XDG_CONFIG_HOME || ...`) is treated as
      // falsy and triggers the HOME fallback.
      const result = await runCLI(["run", "-e", localEnvFile, "-n", "1", "ralph"], {
        cwd: project.dir,
        runtime,
        env: { HOME: realHome, XDG_CONFIG_HOME: "" },
      });

      // (a) Exit code 0.
      expect(result.exitCode).toBe(0);
      // (b) Child observed HOME from -e file (the fake path).
      expect(readFileSync(homeMarker, "utf-8")).toBe(fakeHome);
      // (c) loopx loaded global env file using inherited HOME (real path)
      //     via the fallback — so MARKER=real.
      expect(readFileSync(markerMarker, "utf-8")).toBe("real");
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC: PWD Non-Protocol Behavior  (T-PWD-01 / 02 / 03 / 04a / 04b / 06 / 07
// / 08; T-PWD-05 is non-normative per TEST-SPEC §4.7 and is intentionally
// not implemented.)
//
// SPEC §6.1 / §8.3 / §13 explicitly declare PWD outside the
// script-protocol-protected tier. These tests pin down that loopx neither
// reserves nor synthesizes PWD and that user-supplied PWD reaches spawned
// scripts unchanged through every supply tier (inherited env, RunOptions.env,
// global env file, local -e env file).
//
// All exact-value PWD assertions use a TS fixture reading process.env.PWD
// (via observeEnv) rather than Bash $PWD, because Bash performs shell-level
// PWD rewriting at startup which is outside the loopx contract per the
// TEST-SPEC §4.7 fixture note.
// ---------------------------------------------------------------------------

describe("SPEC: PWD Non-Protocol Behavior", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  forEachRuntime((runtime) => {
    // ----------------------------------------------------------------------
    // T-PWD-01: loopx does not reserve/protect PWD; inherited PWD reaches
    // the spawned script byte-for-byte unchanged. SPEC §6.1, §8.3, §13.
    // ----------------------------------------------------------------------
    it("T-PWD-01: inherited PWD reaches the spawned script unchanged (loopx does not reserve/protect PWD)", async () => {
      await withIsolatedHome(async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "pwd-marker.json");
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".ts",
          observeEnv("PWD", markerPath),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: { PWD: "/some/inherited/value" },
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const observed = JSON.parse(readFileSync(markerPath, "utf-8"));
        expect(observed).toEqual({
          present: true,
          value: "/some/inherited/value",
        });
      });
    });

    // ----------------------------------------------------------------------
    // T-PWD-02: RunOptions.env.PWD reaches spawned scripts. SPEC §6.1, §8.3,
    // §9.5. RunOptions.env is tier 2 — it overrides inherited env, global
    // env file, and local env file, and is overridden only by protocol vars
    // (which do not include PWD).
    // ----------------------------------------------------------------------
    it("T-PWD-02: RunOptions.env.PWD reaches spawned scripts via runPromise()", async () => {
      await withIsolatedHome(async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "pwd-marker.json");
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".ts",
          observeEnv("PWD", markerPath),
        );

        const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("ralph", {
  cwd: ${JSON.stringify(project.dir)},
  env: { PWD: "/value-from-run-options" },
  maxIterations: 1,
});
console.log(JSON.stringify({ count: outputs.length }));
`;
        const result = await runAPIDriver(runtime, driverCode);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).count).toBe(1);
        expect(existsSync(markerPath)).toBe(true);
        const observed = JSON.parse(readFileSync(markerPath, "utf-8"));
        expect(observed).toEqual({
          present: true,
          value: "/value-from-run-options",
        });
      });
    });

    // ----------------------------------------------------------------------
    // T-PWD-03: Inherited PWD propagates unchanged when neither env file
    // nor RunOptions.env sets it. SPEC §6.1, §8.3.
    // ----------------------------------------------------------------------
    it("T-PWD-03: inherited PWD propagates unchanged when no env file or RunOptions.env sets PWD", async () => {
      await withIsolatedHome(async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "pwd-marker.json");
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".ts",
          observeEnv("PWD", markerPath),
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: { PWD: "/inherited" },
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const observed = JSON.parse(readFileSync(markerPath, "utf-8"));
        expect(observed).toEqual({ present: true, value: "/inherited" });
      });
    });

    // ----------------------------------------------------------------------
    // T-PWD-04a: PWD propagates from inherited env AND all five LOOPX_*
    // protocol variables are injected (SPEC §8.3 table). The TS fixture
    // enumerates process.env's keys to assert membership of all protocol
    // vars and reads the inherited PWD value to assert byte-for-byte
    // passthrough. SPEC §6.1, §8.3, §13.
    // ----------------------------------------------------------------------
    it("T-PWD-04a: when loopx is spawned with PWD in its env, the script sees PWD passed through and all five LOOPX_* protocol vars injected", async () => {
      await withIsolatedHome(async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "env-keys.json");
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".ts",
          `import { writeFileSync } from "node:fs";
const keys = Object.keys(process.env).sort();
const data = {
  keys,
  pwd: process.env.PWD === undefined ? null : process.env.PWD,
};
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(data));
`,
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: { PWD: "/inherited-pwd-value" },
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const observed = JSON.parse(readFileSync(markerPath, "utf-8"));
        // (a) all five LOOPX_* protocol vars injected per SPEC §8.3 table.
        expect(observed.keys).toContain("LOOPX_BIN");
        expect(observed.keys).toContain("LOOPX_PROJECT_ROOT");
        expect(observed.keys).toContain("LOOPX_WORKFLOW");
        expect(observed.keys).toContain("LOOPX_WORKFLOW_DIR");
        expect(observed.keys).toContain("LOOPX_TMPDIR");
        // (b) PWD reached the child unchanged from the inherited tier (loopx
        // did not synthesize, override, or rewrite it).
        expect(observed.pwd).toBe("/inherited-pwd-value");
      });
    });

    // ----------------------------------------------------------------------
    // T-PWD-04b: When loopx is spawned without PWD in its environment
    // (env -i style), the script's PWD must NOT be present — proving loopx
    // does not synthesize a PWD value when none is inherited. The five
    // LOOPX_* protocol vars must still be injected. SPEC §6.1, §8.3, §13.
    //
    // This test cannot use runCLI (which spreads process.env). Instead it
    // performs an explicit child_process.spawn with a minimal env: PATH (to
    // resolve tsx / bun) and an empty XDG_CONFIG_HOME (so loopx does not
    // attempt to load a global env file that could supply PWD via tier 4).
    // ----------------------------------------------------------------------
    it("T-PWD-04b: when loopx is spawned without PWD in its environment, the child has no PWD (loopx does not synthesize PWD)", async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "env-keys.json");
      await createWorkflowScript(
        project,
        "ralph",
        "index",
        ".ts",
        `import { writeFileSync } from "node:fs";
const keys = Object.keys(process.env).sort();
const data = {
  keys,
  pwdPresent: Object.prototype.hasOwnProperty.call(process.env, "PWD"),
  pwdValue: process.env.PWD === undefined ? null : process.env.PWD,
};
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(data));
`,
      );

      // Empty XDG_CONFIG_HOME so loopx finds no global env file (preventing
      // a stray PWD entry from tier 4).
      const emptyXdg = await mkdtemp(join(tmpdir(), "loopx-pwd04b-xdg-"));
      try {
        // Resolve loopx's actual bin path from its package.json (mirrors
        // runCLI's getLoopxBinPath helper). The bin field points at
        // dist/bin.js relative to the loopx package root, not bin.js at the
        // package root.
        const loopxPkgPath = resolve(
          process.cwd(),
          "node_modules/loopx/package.json",
        );
        const loopxPkg = JSON.parse(readFileSync(loopxPkgPath, "utf-8"));
        const binRel =
          typeof loopxPkg.bin === "string"
            ? loopxPkg.bin
            : loopxPkg.bin?.loopx;
        const loopxBinPath = resolve(
          process.cwd(),
          "node_modules/loopx",
          binRel,
        );
        const command = runtime === "bun" ? "bun" : "node";
        const args = [loopxBinPath, "run", "-n", "1", "ralph"];
        // Minimal env: PATH (for tsx / bun discovery) and XDG_CONFIG_HOME
        // (set to empty dir to suppress global env loading). No PWD.
        const minimalEnv: Record<string, string> = {
          PATH: process.env.PATH ?? "",
          XDG_CONFIG_HOME: emptyXdg,
        };
        const result = await new Promise<{
          exitCode: number;
          stdout: string;
          stderr: string;
        }>((resolvePromise, reject) => {
          const child = spawn(command, args, {
            cwd: project!.dir,
            env: minimalEnv,
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.stdin.end();
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("T-PWD-04b CLI timed out after 30s"));
          }, 30_000);
          child.on("close", (code) => {
            clearTimeout(timer);
            resolvePromise({ exitCode: code ?? 1, stdout, stderr });
          });
          child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const observed = JSON.parse(readFileSync(markerPath, "utf-8"));
        // (a) all five LOOPX_* protocol vars still injected even with a
        // minimal inherited env.
        expect(observed.keys).toContain("LOOPX_BIN");
        expect(observed.keys).toContain("LOOPX_PROJECT_ROOT");
        expect(observed.keys).toContain("LOOPX_WORKFLOW");
        expect(observed.keys).toContain("LOOPX_WORKFLOW_DIR");
        expect(observed.keys).toContain("LOOPX_TMPDIR");
        // (b) PWD is NOT present in the child env when not inherited — the
        // load-bearing assertion of T-PWD-04: loopx does not synthesize PWD.
        expect(observed.pwdPresent).toBe(false);
        expect(observed.pwdValue).toBeNull();
        // Defensive: PWD must not appear in the enumerated keys either.
        expect(observed.keys).not.toContain("PWD");
      } finally {
        await rm(emptyXdg, { recursive: true, force: true }).catch(() => {});
      }
    });

    // ----------------------------------------------------------------------
    // T-PWD-06: CLI project root derives from process.cwd() (loopx's own
    // kernel cwd at invocation), NOT from the inherited PWD env var. SPEC
    // §3.2 / §6.1 explicitly say "loopx does not consult $PWD" for
    // project-root derivation. Inherited PWD still passes through unchanged
    // to the child per T-PWD-01. SPEC §3.2, §6.1, §13.
    // ----------------------------------------------------------------------
    it("T-PWD-06: CLI project root derives from process.cwd(), not inherited PWD; PWD still passes through to the child", async () => {
      await withIsolatedHome(async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "cwd-and-pwd.json");
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".ts",
          `import { writeFileSync } from "node:fs";
const data = {
  loopxProjectRoot: process.env.LOOPX_PROJECT_ROOT ?? null,
  cwd: process.cwd(),
  pwd: process.env.PWD === undefined ? null : process.env.PWD,
};
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(data));
`,
        );

        const bogusPwd = "/bogus-value-that-does-not-exist";
        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          env: { PWD: bogusPwd },
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const observed = JSON.parse(readFileSync(markerPath, "utf-8"));

        // (a) LOOPX_PROJECT_ROOT equals the kernel cwd (real project), NOT
        // the bogus PWD value. POSIX getcwd(3) typically canonicalizes via
        // the kernel, so the canonical project path equals
        // realpathSync(project.dir). The load-bearing assertion is the
        // negative form (not bogusPwd) — the realpath equality is the
        // common-POSIX positive form.
        expect(observed.loopxProjectRoot).not.toBe(bogusPwd);
        expect(observed.loopxProjectRoot).toBe(realpathSync(project.dir));
        // (b) process.cwd() likewise reports the real project (directory
        // identity matches; the canonical spelling under getcwd(3)
        // equals realpathSync(project.dir) on the common POSIX
        // configuration).
        expect(observed.cwd).not.toBe(bogusPwd);
        expect(observed.cwd).toBe(realpathSync(project.dir));
        // (c) Inherited PWD passes through to the child unchanged (per
        // T-PWD-01) — loopx itself did not consume or rewrite it.
        expect(observed.pwd).toBe(bogusPwd);
      });
    });

    // ----------------------------------------------------------------------
    // T-PWD-07: PWD supplied via the global env file reaches spawned
    // scripts. SPEC §6.1, §8.1, §8.3, §13. PWD is not protocol-protected,
    // so the global env-file value at tier 4 reaches the child unchanged
    // (overriding the inherited PWD at tier 5).
    // ----------------------------------------------------------------------
    it("T-PWD-07: PWD supplied via global env file reaches the spawned script unchanged", async () => {
      await withGlobalEnv(
        { PWD: "/value-from-global-env-file" },
        async () => {
          project = await createTempProject();
          const markerPath = join(project.dir, "pwd-marker.json");
          await createWorkflowScript(
            project,
            "ralph",
            "index",
            ".ts",
            observeEnv("PWD", markerPath),
          );

          const result = await runCLI(["run", "-n", "1", "ralph"], {
            cwd: project.dir,
            runtime,
          });

          expect(result.exitCode).toBe(0);
          expect(existsSync(markerPath)).toBe(true);
          const observed = JSON.parse(readFileSync(markerPath, "utf-8"));
          expect(observed).toEqual({
            present: true,
            value: "/value-from-global-env-file",
          });
        },
      );
    });

    // ----------------------------------------------------------------------
    // T-PWD-08: PWD supplied via the local (-e) env file reaches spawned
    // scripts. SPEC §6.1, §8.2, §8.3, §13. Local env file (tier 3) wins
    // over global env file (tier 4) and inherited env (tier 5); only
    // RunOptions.env (tier 2) and protocol vars (tier 1) outrank it, and
    // PWD is at none of those higher tiers.
    // ----------------------------------------------------------------------
    it("T-PWD-08: PWD supplied via local (-e) env file reaches the spawned script unchanged", async () => {
      await withIsolatedHome(async () => {
        project = await createTempProject();
        const localEnvFile = join(project.dir, "local.env");
        await createEnvFile(localEnvFile, {
          PWD: "/value-from-local-env-file",
        });
        const markerPath = join(project.dir, "pwd-marker.json");
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".ts",
          observeEnv("PWD", markerPath),
        );

        const result = await runCLI(
          ["run", "-e", localEnvFile, "-n", "1", "ralph"],
          { cwd: project.dir, runtime },
        );

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const observed = JSON.parse(readFileSync(markerPath, "utf-8"));
        expect(observed).toEqual({
          present: true,
          value: "/value-from-local-env-file",
        });
      });
    });
  });
});
