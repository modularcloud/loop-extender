import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  createBashWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { withIsolatedHome, withGlobalEnvRawContent } from "../helpers/env.js";
import { forEachRuntime } from "../helpers/runtime.js";
import { writeEnvToFile } from "../helpers/fixture-scripts.js";

forEachRuntime((runtime) => {
  // ---------------------------------------------------------------------------
  // TEST-SPEC §4.2 / SPEC §4.3 — loopx output subcommand
  // ---------------------------------------------------------------------------

  describe("SPEC: loopx output subcommand (§4.3)", () => {
    let project: TempProject | null = null;

    afterEach(async () => {
      if (project) {
        await project.cleanup();
        project = null;
      }
    });

    // T-SUB-01
    it("T-SUB-01: output --result 'hello' → valid JSON with result=hello, exit 0", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--result", "hello"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.result).toBe("hello");
    });

    // T-SUB-02
    it("T-SUB-02: output --goto 'next' → valid JSON with goto=next, exit 0", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--goto", "next"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.goto).toBe("next");
    });

    // T-SUB-02a — qualified (workflow:script) target serialized as-is
    it("T-SUB-02a: output --goto 'review-adr:request-feedback' → qualified target serialized without validation", async () => {
      project = await createTempProject();
      const result = await runCLI(
        ["output", "--goto", "review-adr:request-feedback"],
        { cwd: project.dir, runtime },
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.goto).toBe("review-adr:request-feedback");
    });

    // T-SUB-02b — bare intra-workflow target serialized as-is
    it("T-SUB-02b: output --goto 'check-ready' → bare intra-workflow target serialized without validation", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--goto", "check-ready"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.goto).toBe("check-ready");
    });

    // T-SUB-02c — empty string serialized as-is
    it("T-SUB-02c: output --goto '' → empty-string target serialized without validation", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--goto", ""], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.goto).toBe("");
    });

    // T-SUB-02d — multiple-colon target serialized without validation
    it("T-SUB-02d: output --goto 'a:b:c' → multiple-colon target serialized without validation", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--goto", "a:b:c"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.goto).toBe("a:b:c");
    });

    // T-SUB-02e — leading-colon target serialized without validation
    it("T-SUB-02e: output --goto ':script' → leading-colon target serialized without validation", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--goto", ":script"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.goto).toBe(":script");
    });

    // T-SUB-02f — trailing-colon target serialized without validation
    it("T-SUB-02f: output --goto 'workflow:' → trailing-colon target serialized without validation", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--goto", "workflow:"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.goto).toBe("workflow:");
    });

    // T-SUB-02g — bare-colon target serialized without validation
    it("T-SUB-02g: output --goto ':' → bare-colon target serialized without validation", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--goto", ":"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.goto).toBe(":");
    });

    // T-SUB-02h — syntactically valid but nonexistent target; no .loopx/ exists
    it("T-SUB-02h: output --goto 'missing-workflow:missing-script' → serialized without existence check (no .loopx/)", async () => {
      project = await createTempProject({ withLoopxDir: false });
      const result = await runCLI(
        ["output", "--goto", "missing-workflow:missing-script"],
        { cwd: project.dir, runtime },
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.goto).toBe("missing-workflow:missing-script");
    });

    // T-SUB-02i — bare name-pattern violation (dot) serialized without validation
    it("T-SUB-02i: output --goto 'bad.name' → bare name-pattern violation serialized without validation", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--goto", "bad.name"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.goto).toBe("bad.name");
    });

    // T-SUB-02j — qualified target with workflow-portion name-pattern violation
    it("T-SUB-02j: output --goto 'bad.name:index' → qualified workflow-portion violation serialized without validation", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--goto", "bad.name:index"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.goto).toBe("bad.name:index");
    });

    // T-SUB-02k — qualified target with script-portion name-pattern violation
    it("T-SUB-02k: output --goto 'ralph:bad.name' → qualified script-portion violation serialized without validation", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--goto", "ralph:bad.name"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.goto).toBe("ralph:bad.name");
    });

    // T-SUB-03
    it("T-SUB-03: output --stop → valid JSON with stop=true, exit 0", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--stop"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.stop).toBe(true);
    });

    // T-SUB-04
    it("T-SUB-04: output --result 'x' --goto 'y' --stop → all three fields", async () => {
      project = await createTempProject();
      const result = await runCLI(
        ["output", "--result", "x", "--goto", "y", "--stop"],
        { cwd: project.dir, runtime },
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.result).toBe("x");
      expect(parsed.goto).toBe("y");
      expect(parsed.stop).toBe(true);
    });

    // T-SUB-05
    it("T-SUB-05: output with no flags → exit 1", async () => {
      project = await createTempProject();
      const result = await runCLI(["output"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
    });

    // T-SUB-05a — empty-string `--result ""` is a provided flag, not absent
    it('T-SUB-05a: output --result "" → exit 0, JSON has result==="" (empty value still counts as provided flag)', async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--result", ""], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.result).toBe("");
    });

    // T-SUB-06c — missing operand for --result → usage error, no JSON stdout
    it("T-SUB-06c: output --result (missing operand) → exit 1, stderr usage error, no JSON stdout", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--result"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
      // No JSON stdout — the usage error fired before the serialization path.
      expect(result.stdout).toBe("");
    });

    // T-SUB-06d — missing operand for --goto → usage error, no JSON stdout
    it("T-SUB-06d: output --goto (missing operand) → exit 1, stderr usage error, no JSON stdout", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--goto"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.stdout).toBe("");
    });

    // T-SUB-06e — unrecognized --unknown flag (bare) → usage error
    it("T-SUB-06e: output --unknown → exit 1, stderr mentions '--unknown', no JSON stdout", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--unknown"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--unknown");
      expect(result.stdout).toBe("");
    });

    // T-SUB-06f — unrecognized flag mixed with a recognized one → usage error
    it("T-SUB-06f: output --unknown --result x → exit 1, stderr mentions '--unknown', no JSON stdout", async () => {
      project = await createTempProject();
      const result = await runCLI(["output", "--unknown", "--result", "x"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--unknown");
      // The recognized --result x must NOT slip through despite the unknown flag.
      expect(result.stdout).toBe("");
    });

    // T-SUB-06
    it("T-SUB-06: output --result 'x' works without .loopx/ directory", async () => {
      project = await createTempProject({ withLoopxDir: false });
      const result = await runCLI(["output", "--result", "x"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.result).toBe("x");
    });

    // T-SUB-06a
    it('T-SUB-06a: output --result with quotes and backslashes → properly escaped JSON', async () => {
      project = await createTempProject();
      const value = 'value with "quotes" and \\backslashes';
      const result = await runCLI(["output", "--result", value], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.result).toBe(value);
    });

    // T-SUB-06b
    it("T-SUB-06b: output --result with literal newline byte → properly escaped JSON", async () => {
      project = await createTempProject();
      const value = "line1\nline2";
      const result = await runCLI(["output", "--result", value], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.result).toBe("line1\nline2");
    });
  });

  // ---------------------------------------------------------------------------
  // TEST-SPEC §4.2 / SPEC §4.3 — loopx env set subcommand
  // ---------------------------------------------------------------------------

  describe("SPEC: loopx env set subcommand (§4.3)", () => {
    // T-SUB-07
    it("T-SUB-07: env set FOO bar → env list shows FOO=bar", async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(["env", "set", "FOO", "bar"], { runtime });
        expect(setResult.exitCode).toBe(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toContain("FOO=bar");
      });
    });

    // T-SUB-08
    it("T-SUB-08: env set _UNDER score → valid underscore-prefixed name", async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(["env", "set", "_UNDER", "score"], {
          runtime,
        });
        expect(setResult.exitCode).toBe(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toContain("_UNDER=score");
      });
    });

    // T-SUB-09
    it("T-SUB-09: env set A1 val → valid alphanumeric name", async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(["env", "set", "A1", "val"], { runtime });
        expect(setResult.exitCode).toBe(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toContain("A1=val");
      });
    });

    // T-SUB-10
    it("T-SUB-10: env set 1INVALID val → exit 1 (invalid name starts with digit)", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(["env", "set", "1INVALID", "val"], {
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });
    });

    // T-SUB-11
    it("T-SUB-11: env set -DASH val → exit 1 (invalid name starts with dash)", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(["env", "set", "-DASH", "val"], { runtime });
        expect(result.exitCode).toBe(1);
      });
    });

    // T-SUB-11a — lowercase-first key accepted (regex explicitly allows lowercase)
    it("T-SUB-11a: env set mykey myval → exit 0, env list shows mykey=myval", async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(["env", "set", "mykey", "myval"], {
          runtime,
        });
        expect(setResult.exitCode).toBe(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toContain("mykey=myval");
      });
    });

    // T-SUB-11b — interior dash rejected, env file unchanged
    it("T-SUB-11b: env set FOO-BAR val → exit 1, stderr error, env file not mutated", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(["env", "set", "FOO-BAR", "val"], {
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).not.toContain("FOO-BAR");
      });
    });

    // T-SUB-11c — interior dot rejected, env file unchanged
    it("T-SUB-11c: env set FOO.BAR val → exit 1, stderr error, env file not mutated", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(["env", "set", "FOO.BAR", "val"], {
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).not.toContain("FOO.BAR");
      });
    });

    // T-SUB-11d — interior space rejected, env file unchanged
    it("T-SUB-11d: env set 'FOO BAR' val → exit 1, stderr error, env file not mutated", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(["env", "set", "FOO BAR", "val"], {
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).not.toContain("FOO BAR");
        // Sanity: no zero-content key sneaking through either.
        expect(listResult.stdout.split("\n").every((l) => !/^=/.test(l))).toBe(
          true,
        );
      });
    });

    // T-SUB-11e — empty-string name rejected; pre-existing vars remain untouched
    it('T-SUB-11e: env set "" val → exit 1, stderr error, env file not mutated and pre-existing vars untouched', async () => {
      await withIsolatedHome(async () => {
        // Pre-seed an unrelated variable to verify the failed set leaves it untouched.
        const seedResult = await runCLI(["env", "set", "EXISTING", "v"], {
          runtime,
        });
        expect(seedResult.exitCode).toBe(0);

        const result = await runCLI(["env", "set", "", "val"], { runtime });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        // Pre-existing variable preserved.
        expect(listResult.stdout).toContain("EXISTING=v");
        // No zero-length-keyed entry written (no leading `=val` line).
        expect(listResult.stdout.split("\n").every((l) => !/^=/.test(l))).toBe(
          true,
        );
      });
    });

    // T-SUB-12
    it("T-SUB-12: env set FOO bar then FOO baz → overwrite shows FOO=baz", async () => {
      await withIsolatedHome(async () => {
        await runCLI(["env", "set", "FOO", "bar"], { runtime });
        await runCLI(["env", "set", "FOO", "baz"], { runtime });

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toContain("FOO=baz");
        expect(listResult.stdout).not.toMatch(/FOO=bar/);
      });
    });

    // T-SUB-13
    it("T-SUB-13: env set without .loopx/ → works, no script-validation warnings", async () => {
      await withIsolatedHome(async () => {
        const project = await createTempProject({ withLoopxDir: false });
        try {
          const setResult = await runCLI(["env", "set", "FOO", "bar"], {
            cwd: project.dir,
            runtime,
          });
          expect(setResult.exitCode).toBe(0);
          expect(setResult.stderr).not.toMatch(/warn|validat/i);

          const listResult = await runCLI(["env", "list"], {
            cwd: project.dir,
            runtime,
          });
          expect(listResult.exitCode).toBe(0);
          expect(listResult.stdout).toContain("FOO=bar");
        } finally {
          await project.cleanup();
        }
      });
    });

    // T-SUB-14
    it("T-SUB-14: env set creates the config directory if it doesn't exist", async () => {
      await withIsolatedHome(async () => {
        // XDG_CONFIG_HOME is unset by withIsolatedHome, so config goes to ~/.config
        const home = process.env.HOME!;
        const configDir = join(home, ".config", "loopx");

        expect(existsSync(configDir)).toBe(false);

        const setResult = await runCLI(["env", "set", "FOO", "bar"], { runtime });
        expect(setResult.exitCode).toBe(0);

        expect(existsSync(configDir)).toBe(true);
      });
    });

    // T-SUB-14a
    it("T-SUB-14a: env set with 'value with spaces' → round-trips", async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(
          ["env", "set", "KEY", "value with spaces"],
          { runtime },
        );
        expect(setResult.exitCode).toBe(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toContain("KEY=value with spaces");
      });
    });

    // T-SUB-14b
    it("T-SUB-14b: env set with 'value#hash' → preserved", async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(["env", "set", "KEY", "value#hash"], {
          runtime,
        });
        expect(setResult.exitCode).toBe(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toContain("KEY=value#hash");
      });
    });

    // T-SUB-14c
    it("T-SUB-14c: env set with 'val=ue' → round-trips", async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(["env", "set", "KEY", "val=ue"], {
          runtime,
        });
        expect(setResult.exitCode).toBe(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toContain("KEY=val=ue");
      });
    });

    // T-SUB-14d
    it("T-SUB-14d: env set with value containing newline → rejected, exit 1", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(
          ["env", "set", "KEY", "value\nwith newline"],
          { runtime },
        );
        expect(result.exitCode).toBe(1);
      });
    });

    // T-SUB-14e
    it("T-SUB-14e: env set with value containing double quotes → round-trips", async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(["env", "set", "KEY", 'val"ue'], {
          runtime,
        });
        expect(setResult.exitCode).toBe(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toContain('KEY=val"ue');
      });
    });

    // T-SUB-14f
    it("T-SUB-14f: env set with trailing spaces → preserved", async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(["env", "set", "KEY", "value  "], {
          runtime,
        });
        expect(setResult.exitCode).toBe(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toContain("KEY=value  ");
      });
    });

    // T-SUB-14g
    it("T-SUB-14g: env set with value containing CR → rejected, exit 1", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(["env", "set", "KEY", "value\rwith cr"], {
          runtime,
        });
        expect(result.exitCode).toBe(1);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // TEST-SPEC §4.2 / SPEC §4.3 — loopx env set on-disk serialization
  // ---------------------------------------------------------------------------

  describe("SPEC: loopx env set on-disk serialization (§4.3)", () => {
    /**
     * Returns the path to the global env file based on the current
     * process environment (respects XDG_CONFIG_HOME / HOME fallback).
     */
    function getGlobalEnvFilePath(): string {
      const configHome =
        process.env.XDG_CONFIG_HOME ?? join(process.env.HOME!, ".config");
      return join(configHome, "loopx", "env");
    }

    // T-SUB-14h
    it('T-SUB-14h: env set FOO bar → file contains FOO="bar"\\n', async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(["env", "set", "FOO", "bar"], { runtime });
        expect(setResult.exitCode).toBe(0);

        const envFile = getGlobalEnvFilePath();
        const content = readFileSync(envFile, "utf-8");
        expect(content).toContain('FOO="bar"\n');
      });
    });

    // T-SUB-14i
    it('T-SUB-14i: env set FOO "value with spaces" → exact serialization', async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(
          ["env", "set", "FOO", "value with spaces"],
          { runtime },
        );
        expect(setResult.exitCode).toBe(0);

        const envFile = getGlobalEnvFilePath();
        const content = readFileSync(envFile, "utf-8");
        expect(content).toContain('FOO="value with spaces"\n');
      });
    });

    // T-SUB-14j
    it('T-SUB-14j: env set FOO \'val"ue\' → file contains FOO="val"ue"\\n', async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(["env", "set", "FOO", 'val"ue'], {
          runtime,
        });
        expect(setResult.exitCode).toBe(0);

        const envFile = getGlobalEnvFilePath();
        const content = readFileSync(envFile, "utf-8");
        expect(content).toContain('FOO="val"ue"\n');
      });
    });

    // T-SUB-14k
    it('T-SUB-14k: env set FOO "" → file contains FOO=""\\n', async () => {
      await withIsolatedHome(async () => {
        const setResult = await runCLI(["env", "set", "FOO", ""], { runtime });
        expect(setResult.exitCode).toBe(0);

        const envFile = getGlobalEnvFilePath();
        const content = readFileSync(envFile, "utf-8");
        expect(content).toContain('FOO=""\n');
      });
    });

    // T-SUB-14l — backslash round-trip: literal backslashes preserved on
    // serialization (SPEC §4.3 "value is written literally within double
    // quotes") and on read (SPEC §8.1 "no escape sequence interpretation").
    // The 18-byte value `val\with\backslash` contains exactly two literal
    // 0x5c bytes; both must survive (write side: bytes appear inside the
    // quoted env-file form unchanged; read side: a workflow that reads $KEY
    // sees the same byte sequence).
    it("T-SUB-14l: env set FOO 'val\\with\\backslash' → literal backslashes preserved through write+read", async () => {
      await withIsolatedHome(async () => {
        const value = "val\\with\\backslash"; // 18 bytes incl. two 0x5c
        expect(value.length).toBe(18); // sanity-check the source-level escape

        const setResult = await runCLI(["env", "set", "KEY", value], {
          runtime,
        });
        expect(setResult.exitCode).toBe(0);

        // (a) On-disk byte sequence is exactly KEY="val\with\backslash"\n
        const envFile = getGlobalEnvFilePath();
        const onDisk = readFileSync(envFile, "utf-8");
        expect(onDisk).toContain(`KEY="${value}"\n`);

        // (b) A workflow that observes $KEY records the identical 18-byte
        //     value (no escape interpretation at read time).
        const project = await createTempProject();
        try {
          const markerPath = join(project.dir, "key-value.txt");
          await createWorkflowScript(
            project,
            "ralph",
            "index",
            ".sh",
            // Write $KEY then exit non-zero so the loop terminates after
            // exactly one iteration without us needing to author a stop:true
            // emitter (and so the test doesn't depend on goto/loop semantics).
            // The marker is what we assert on.
            `${writeEnvToFile("KEY", markerPath)}exit 1\n`,
          );

          const runResult = await runCLI(["run", "ralph"], {
            cwd: project.dir,
            runtime,
          });
          // Script exits 1 by design — we only care that the marker was
          // written before exit.
          expect(runResult.exitCode).toBe(1);

          const readBack = readFileSync(markerPath, "utf-8");
          expect(readBack).toBe(value); // identical 18-byte value
        } finally {
          await project.cleanup();
        }
      });
    });
  });

  // ---------------------------------------------------------------------------
  // TEST-SPEC §4.2 / SPEC §4.3 — loopx env remove subcommand
  // ---------------------------------------------------------------------------

  describe("SPEC: loopx env remove subcommand (§4.3)", () => {
    // T-SUB-15
    it("T-SUB-15: env set FOO bar then env remove FOO → FOO is absent from list", async () => {
      await withIsolatedHome(async () => {
        await runCLI(["env", "set", "FOO", "bar"], { runtime });

        const removeResult = await runCLI(["env", "remove", "FOO"], { runtime });
        expect(removeResult.exitCode).toBe(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).not.toContain("FOO");
      });
    });

    // T-SUB-16
    it("T-SUB-16: env remove NONEXISTENT → exit 0 (silent no-op)", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(["env", "remove", "NONEXISTENT"], {
          runtime,
        });
        expect(result.exitCode).toBe(0);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // TEST-SPEC §4.2 / SPEC §4.3 — loopx env list subcommand
  // ---------------------------------------------------------------------------

  describe("SPEC: loopx env list subcommand (§4.3)", () => {
    // T-SUB-17
    it("T-SUB-17: env list with no vars → empty stdout, exit 0", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(["env", "list"], { runtime });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
      });
    });

    // T-SUB-18
    it("T-SUB-18: env list → sorted output (ALPHA, MIDDLE, ZEBRA)", async () => {
      await withIsolatedHome(async () => {
        await runCLI(["env", "set", "ZEBRA", "z"], { runtime });
        await runCLI(["env", "set", "ALPHA", "a"], { runtime });
        await runCLI(["env", "set", "MIDDLE", "m"], { runtime });

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);

        const lines = listResult.stdout.trimEnd().split("\n");
        expect(lines).toEqual(["ALPHA=a", "MIDDLE=m", "ZEBRA=z"]);
      });
    });

    // T-SUB-19
    it("T-SUB-19: env list without .loopx/ → empty stdout, no warnings", async () => {
      await withIsolatedHome(async () => {
        const project = await createTempProject({ withLoopxDir: false });
        try {
          const result = await runCLI(["env", "list"], {
            cwd: project.dir,
            runtime,
          });
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toBe("");
          expect(result.stderr).not.toMatch(/warn|validat/i);
        } finally {
          await project.cleanup();
        }
      });
    });

    // T-SUB-19a — env list parses a malformed global env file via the SAME
    // parser used for `loopx run`, emitting one parser warning to stderr per
    // invalid line and silently dropping malformed keys from the listing.
    // Closes the gap between the `run` and `env list` env-file parse paths
    // (SPEC §8.1 invalid-key warning rule + §4.3 / §5.4 env-list scope).
    it("T-SUB-19a: env list with malformed global env file → parser warning to stderr, only well-formed entries listed", async () => {
      // 1BAD starts with a digit and so violates SPEC §8.1's
      // [A-Za-z_][A-Za-z0-9_]* key pattern; GOOD is well-formed.
      await withGlobalEnvRawContent("1BAD=val\nGOOD=ok\n", async () => {
        const result = await runCLI(["env", "list"], { runtime });

        // (a) malformed line does not fail env list (warning, not error)
        expect(result.exitCode).toBe(0);

        // (b) stdout lists only the well-formed entry
        const lines = result.stdout.trimEnd().split("\n");
        expect(lines).toEqual(["GOOD=ok"]);
        // (c) stdout does not contain the malformed key
        expect(result.stdout).not.toContain("1BAD");

        // (d) stderr contains exactly one parser warning for the 1BAD=val
        //     line (same warning class as `loopx run` emits when loading the
        //     global env file via loadGlobalEnv → parseEnvFile)
        const warnLines = result.stderr
          .split("\n")
          .filter((l) => /Warning:.*1BAD/.test(l));
        expect(warnLines.length).toBe(1);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // TEST-SPEC §4.2 / SPEC §4.3 / §5.4 — Subcommands ignore .loopx/ validation
  //
  // SPEC §5.4 enumerates the commands that do NOT require .loopx/ to exist or
  // be valid: `loopx output`, `loopx env *`. These tests pin down that those
  // commands continue to exit 0 (and emit no discovery / validation warnings)
  // even when `.loopx/` is present and is "broken" — here, structurally
  // invalid in a way that would be fatal under `loopx run <target>` (a
  // workflow with a same-base-name script collision per SPEC §5.2). A buggy
  // implementation that wired discovery/validation into these subcommands
  // would emit warnings or fail; this cluster catches that.
  // ---------------------------------------------------------------------------

  describe("SPEC: Subcommands ignore .loopx/ validation (§5.4)", () => {
    let project: TempProject | null = null;

    afterEach(async () => {
      if (project) {
        await project.cleanup();
        project = null;
      }
    });

    /**
     * Builds a project with a `.loopx/` whose `ralph` workflow contains a
     * same-base-name collision (`check.sh` and `check.ts`). SPEC §5.2 makes
     * this fatal for `loopx run <target>` but not for `loopx output` or
     * `loopx env *` (per SPEC §5.4).
     */
    async function projectWithBrokenLoopx(): Promise<TempProject> {
      const p = await createTempProject();
      await createWorkflowScript(p, "ralph", "check", ".sh", "#!/bin/bash\necho stop\n");
      await createWorkflowScript(p, "ralph", "check", ".ts", "console.log('x');\n");
      return p;
    }

    // T-SUB-20 — `loopx output` works (and emits no validation warnings)
    // even when `.loopx/` contains a fatal-for-run collision.
    it("T-SUB-20: output --result with broken .loopx/ tree → exit 0, valid JSON, no validation warnings", async () => {
      project = await projectWithBrokenLoopx();
      const result = await runCLI(["output", "--result", "x"], {
        cwd: project.dir,
        runtime,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.result).toBe("x");
      // No discovery or validation warnings about ralph/check collision.
      expect(result.stderr).not.toMatch(/collision|conflict|warn|validat|ralph/i);
    });

    // T-SUB-21 — `loopx env list` does not validate `.loopx/`.
    it("T-SUB-21: env list with broken .loopx/ tree (no env vars) → exit 0, empty stdout, no validation warnings", async () => {
      project = await projectWithBrokenLoopx();
      await withIsolatedHome(async () => {
        const result = await runCLI(["env", "list"], {
          cwd: project!.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toMatch(
          /collision|conflict|warn|validat|ralph/i,
        );
      });
    });

    // T-SUB-22 — `loopx env set` does not validate `.loopx/`.
    it("T-SUB-22: env set FOO bar with broken .loopx/ tree → exit 0, no validation warnings, value reachable via env list", async () => {
      project = await projectWithBrokenLoopx();
      await withIsolatedHome(async () => {
        const setResult = await runCLI(["env", "set", "FOO", "bar"], {
          cwd: project!.dir,
          runtime,
        });
        expect(setResult.exitCode).toBe(0);
        expect(setResult.stderr).not.toMatch(
          /collision|conflict|warn|validat|ralph/i,
        );

        const listResult = await runCLI(["env", "list"], {
          cwd: project!.dir,
          runtime,
        });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toContain("FOO=bar");
      });
    });

    // T-SUB-23 — `loopx env remove` does not validate `.loopx/`.
    it("T-SUB-23: env remove FOO with broken .loopx/ tree → exit 0, no validation warnings, FOO absent from list", async () => {
      project = await projectWithBrokenLoopx();
      await withIsolatedHome(async () => {
        // Pre-seed FOO=bar so there's something to remove.
        const setResult = await runCLI(["env", "set", "FOO", "bar"], {
          cwd: project!.dir,
          runtime,
        });
        expect(setResult.exitCode).toBe(0);

        const removeResult = await runCLI(["env", "remove", "FOO"], {
          cwd: project!.dir,
          runtime,
        });
        expect(removeResult.exitCode).toBe(0);
        expect(removeResult.stderr).not.toMatch(
          /collision|conflict|warn|validat|ralph/i,
        );

        const listResult = await runCLI(["env", "list"], {
          cwd: project!.dir,
          runtime,
        });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).not.toContain("FOO");
      });
    });
  });

  // ---------------------------------------------------------------------------
  // TEST-SPEC §4.2 / SPEC §4.3 / §12 — env / output usage errors
  //
  // SPEC §4.3 enumerates the env subcommands as exactly `set`, `remove`,
  // `list` (no others, no defaults, no extra positionals); `output`'s grammar
  // is the named-flag form only. SPEC §12's usage-error contract requires
  // exit 1 + a usage-error category on stderr for parser-level surface
  // failures. The tests below pin down each violating shape across the env
  // and output subcommands.
  // ---------------------------------------------------------------------------

  describe("SPEC: env / output subcommand usage errors (§4.3, §12)", () => {
    // T-SUB-24 — bare `env` (no subcommand)
    it("T-SUB-24: env (no subcommand) → exit 1, usage error, no env mutation", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(["env"], { runtime });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);

        // Sanity: nothing was committed under the isolated HOME.
        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toBe("");
      });
    });

    // T-SUB-25 — `env set` (no name, no value)
    it("T-SUB-25: env set (no operands) → exit 1, usage error, no env mutation", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(["env", "set"], { runtime });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toBe("");
      });
    });

    // T-SUB-26 — `env set FOO` (name only, missing value)
    it("T-SUB-26: env set FOO (missing value) → exit 1, usage error, FOO not committed", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(["env", "set", "FOO"], { runtime });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        // FOO must NOT have been committed (no FOO=... line, including
        // FOO="" — a buggy impl that defaulted the missing value to "" would
        // fail this assertion).
        expect(listResult.stdout).not.toMatch(/^FOO=/m);
      });
    });

    // T-SUB-27 — `env remove` (no name)
    it("T-SUB-27: env remove (no name) → exit 1, usage error, env file not mutated", async () => {
      await withIsolatedHome(async () => {
        // Pre-seed an entry to verify the failed remove leaves it untouched
        // and to verify a buggy impl that defaulted name="" and silently
        // no-op'd (matching T-SUB-16 nonexistent-name silence) still fails.
        await runCLI(["env", "set", "EXISTING", "v"], { runtime });

        const result = await runCLI(["env", "remove"], { runtime });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toContain("EXISTING=v");
      });
    });

    // T-SUB-28 — `env unknown` (unrecognized env subcommand)
    it("T-SUB-28: env unknown → exit 1, usage error, no env mutation", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(["env", "unknown"], { runtime });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toBe("");
      });
    });

    // T-SUB-29 — `env list extra` (extra positional after `list`)
    it("T-SUB-29: env list extra → exit 1, usage error, no stdout listing", async () => {
      await withIsolatedHome(async () => {
        // Pre-seed an entry so a buggy impl that ignored the extra operand
        // and ran `list` regardless would emit visible stdout (which we
        // assert is absent).
        await runCLI(["env", "set", "FOO", "bar"], { runtime });

        const result = await runCLI(["env", "list", "extra"], { runtime });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stdout).toBe("");
      });
    });

    // T-SUB-29a — `env set FOO bar extra` (extra positional after set <name> <value>)
    it("T-SUB-29a: env set FOO bar extra → exit 1, usage error, FOO not committed", async () => {
      await withIsolatedHome(async () => {
        const result = await runCLI(
          ["env", "set", "FOO", "bar", "extra"],
          { runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        // No FOO entry was committed despite the leading well-formed
        // `set FOO bar`.
        expect(listResult.stdout).not.toMatch(/^FOO=/m);
      });
    });

    // T-SUB-29b — `env remove FOO extra` (extra positional after remove <name>)
    it("T-SUB-29b: env remove FOO extra → exit 1, usage error, env file not mutated", async () => {
      await withIsolatedHome(async () => {
        // Pre-seed FOO so a buggy impl that ignored the extra operand and
        // proceeded with the remove would wipe it (failing the assertion).
        await runCLI(["env", "set", "FOO", "bar"], { runtime });

        const result = await runCLI(
          ["env", "remove", "FOO", "extra"],
          { runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);

        const listResult = await runCLI(["env", "list"], { runtime });
        expect(listResult.exitCode).toBe(0);
        expect(listResult.stdout).toContain("FOO=bar");
      });
    });

    // T-SUB-29c — `output --result x extra` (extra positional after a value flag)
    it("T-SUB-29c: output --result x extra → exit 1, usage error, no JSON stdout", async () => {
      const project = await createTempProject();
      try {
        const result = await runCLI(
          ["output", "--result", "x", "extra"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        // No structured JSON was serialized despite the well-formed
        // `--result x` prefix.
        expect(result.stdout).toBe("");
      } finally {
        await project.cleanup();
      }
    });

    // T-SUB-29d — `output --stop extra` (extra positional after a boolean flag)
    it("T-SUB-29d: output --stop extra → exit 1, usage error, no JSON stdout", async () => {
      const project = await createTempProject();
      try {
        const result = await runCLI(
          ["output", "--stop", "extra"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stdout).toBe("");
      } finally {
        await project.cleanup();
      }
    });
  });
});
