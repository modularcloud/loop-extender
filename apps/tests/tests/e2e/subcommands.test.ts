import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createTempProject, type TempProject } from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { withIsolatedHome } from "../helpers/env.js";
import { forEachRuntime } from "../helpers/runtime.js";

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
  });
});
