import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTempProject,
  createBashWorkflowScript,
  createWorkflowScript,
  createWorkflowPackageJson,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { writeValueToFile, observeEnv } from "../helpers/fixture-scripts.js";
import { forEachRuntime } from "../helpers/runtime.js";

// ---------------------------------------------------------------------------
// TEST-SPEC §4.1 — CLI Grammar (end-of-options + name=value + ordering)
// Spec refs: 4.1, 4.2, 4.3, 5.1, 5.2, 5.4, 7.1, 7.2, 8.3, 11.2, 12, 13
// ---------------------------------------------------------------------------

describe("SPEC: CLI Grammar (end-of-options, name=value, ordering, inherit)", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup().catch(() => {});
      project = null;
    }
  });

  // ========================================================================
  // Top-level `--` Rejection (T-CLI-TOP-DASHDASH-01)
  // ========================================================================
  describe("SPEC: Top-level `--` Rejection", () => {
    forEachRuntime((runtime) => {
      // Bun's runtime strips a leading `--` (the token immediately following
      // the script path) from process.argv before the script sees it. This
      // is Bun's own end-of-options separator, applied at the runtime layer,
      // and there is no flag to disable it. Under Bun, `bun loopx-bin.js --`
      // produces argv without the `--`, so loopx's parser cannot observe the
      // top-level `--` that SPEC 4.2 / 12 require it to reject — making the
      // test's assertion unobservable on this runtime. The contract still
      // holds for loopx's parser when actually given a `--` argv[0]; Node's
      // runtime preserves it, where the test runs and the contract is pinned.
      const skipForBun = runtime === "bun";
      it.skipIf(skipForBun)(
        "T-CLI-TOP-DASHDASH-01: `loopx --` rejected as unrecognized top-level token",
        async () => {
          // SPEC 4.2 / 4.3 / 12: `--` is not a recognized top-level flag or
          // separator; the only top-level surfaces are help (`-h` / `--help`),
          // recognized subcommands, and parser-level validation. A buggy
          // parser that silently consumed `--` would dispatch to a "no
          // subcommand" path, top-level help, or some other observable
          // behavior — this test pins down rejection.
          project = await createTempProject({ withLoopxDir: false });
          const result = await runCLI(["--"], { cwd: project.dir, runtime });

          // (a) exit code 1 (usage error per SPEC 12)
          expect(result.exitCode).toBe(1);
          // (b) stderr surfaces a usage-error category — broad wording check
          expect(result.stderr.length).toBeGreaterThan(0);
          // (c) no subcommand was dispatched — no version output, no help
          //     short-circuit, no install/run side effects
          // No version literal on stdout (version subcommand did not run)
          expect(result.stdout).not.toMatch(/^\d+\.\d+\.\d+\s*$/);
          // No top-level help block on stdout (help short-circuit did not fire)
          expect(result.stdout).not.toMatch(/usage:\s*loopx\s+<command>/i);
        },
      );
    });
  });

  // ========================================================================
  // Run `--` Rejection Matrix (T-CLI-RUN-DASHDASH-01..13)
  //
  // SPEC 11.2 / 12: `loopx run` does not accept `--` as an end-of-options
  // marker. The shell env prefix (`key=value loopx run <target>`) is the
  // sole CLI surface for per-run parameterization.
  // ========================================================================
  describe("SPEC: Run `--` Rejection Matrix", () => {
    forEachRuntime((runtime) => {
      // Helper: create a fixture with `.loopx/ralph/index.sh` whose execution
      // would write a marker file. Lets us prove the script did NOT run.
      async function setupRalphWithMarker(markerName: string): Promise<string> {
        project = await createTempProject();
        const marker = join(project.dir, markerName);
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' 'ran' > "${marker}"\nprintf '{"stop":true}'`,
        );
        return marker;
      }

      it("T-CLI-RUN-DASHDASH-01: `loopx run -- ralph` → usage error, exit 1, script did not run", async () => {
        const marker = await setupRalphWithMarker("marker-dd-01.txt");
        const result = await runCLI(["run", "--", "ralph"], {
          cwd: project!.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stderr).toContain("--");
        expect(existsSync(marker)).toBe(false);
      });

      it("T-CLI-RUN-DASHDASH-02: `loopx run -n 1 -- ralph` → usage error, exit 1, script did not run", async () => {
        const marker = await setupRalphWithMarker("marker-dd-02.txt");
        const result = await runCLI(["run", "-n", "1", "--", "ralph"], {
          cwd: project!.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stderr).toContain("--");
        expect(existsSync(marker)).toBe(false);
      });

      it("T-CLI-RUN-DASHDASH-03: `loopx run ralph -- name=value` → usage error, exit 1, script did not run", async () => {
        const marker = await setupRalphWithMarker("marker-dd-03.txt");
        const result = await runCLI(["run", "ralph", "--", "name=value"], {
          cwd: project!.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        // Either `--` or `name=value` should be cited as offending — but `--`
        // appears earliest in argv, so the SPEC-conformant rejection is on `--`.
        expect(existsSync(marker)).toBe(false);
      });

      it("T-CLI-RUN-DASHDASH-04: `loopx run -h -- ralph` → help short-circuit, exit 0", async () => {
        await setupRalphWithMarker("marker-dd-04.txt");
        const result = await runCLI(["run", "-h", "--", "ralph"], {
          cwd: project!.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        // Run-help is on stdout (mentions -n / -e options)
        expect(result.stdout.toLowerCase()).toMatch(/-n\b/);
        expect(result.stdout.toLowerCase()).toMatch(/-e\b/);
      });

      it("T-CLI-RUN-DASHDASH-05: `loopx run -h ralph adr=0003` → help short-circuit, exit 0", async () => {
        await setupRalphWithMarker("marker-dd-05.txt");
        const result = await runCLI(["run", "-h", "ralph", "adr=0003"], {
          cwd: project!.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toLowerCase()).toMatch(/-n\b/);
        expect(result.stdout.toLowerCase()).toMatch(/-e\b/);
      });

      it("T-CLI-RUN-DASHDASH-06: `loopx run --` (no target, just `--`) → usage error, exit 1", async () => {
        const marker = await setupRalphWithMarker("marker-dd-06.txt");
        const result = await runCLI(["run", "--"], {
          cwd: project!.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stderr).toContain("--");
        expect(existsSync(marker)).toBe(false);
      });

      it("T-CLI-RUN-DASHDASH-07: `loopx run ralph --` (target then trailing `--`) → usage error, exit 1, script did not run", async () => {
        const marker = await setupRalphWithMarker("marker-dd-07.txt");
        const result = await runCLI(["run", "ralph", "--"], {
          cwd: project!.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stderr).toContain("--");
        expect(existsSync(marker)).toBe(false);
      });

      it("T-CLI-RUN-DASHDASH-08: `loopx run -- -h` → run-help short-circuit, exit 0", async () => {
        const marker = await setupRalphWithMarker("marker-dd-08.txt");
        const result = await runCLI(["run", "--", "-h"], {
          cwd: project!.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        // Run-help is on stdout
        expect(result.stdout.toLowerCase()).toMatch(/-n\b/);
        expect(result.stdout.toLowerCase()).toMatch(/-e\b/);
        // Script did NOT execute
        expect(existsSync(marker)).toBe(false);
      });

      it("T-CLI-RUN-DASHDASH-09: `loopx run -- --help` → run-help short-circuit, exit 0", async () => {
        const marker = await setupRalphWithMarker("marker-dd-09.txt");
        const result = await runCLI(["run", "--", "--help"], {
          cwd: project!.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toLowerCase()).toMatch(/-n\b/);
        expect(result.stdout.toLowerCase()).toMatch(/-e\b/);
        expect(existsSync(marker)).toBe(false);
      });

      it("T-CLI-RUN-DASHDASH-10: `loopx run -e -- ralph` → usage error, exit 1, env-file `--` not loaded", async () => {
        // Pre-create a file named `--` in the project root with a malformed
        // line; if the parser consumed `--` as the `-e` operand and loaded
        // the env file before usage validation, the SPEC 8.1 invalid-key
        // warning for `1BAD` would surface on stderr.
        const marker = await setupRalphWithMarker("marker-dd-10.txt");
        const dashDashFile = join(project!.dir, "--");
        await writeFile(
          dashDashFile,
          "MARKER=should-not-be-loaded\n1BAD=warning-if-loaded\n",
          "utf-8",
        );

        const result = await runCLI(["run", "-e", "--", "ralph"], {
          cwd: project!.dir,
          runtime,
        });
        // (a) exit code 1
        expect(result.exitCode).toBe(1);
        // (b) stderr surfaces a usage error
        expect(result.stderr.length).toBeGreaterThan(0);
        // (c) script did not run
        expect(existsSync(marker)).toBe(false);
        // (d) env-file invalid-key warning for `1BAD` did NOT surface — proves
        //     the env file was NOT loaded before parser validation rejected
        //     `--`.
        expect(result.stderr).not.toMatch(/1BAD/);
      });

      it("T-CLI-RUN-DASHDASH-11: `loopx run ralph -e --` → usage error, exit 1, env-file `--` not loaded", async () => {
        const marker = await setupRalphWithMarker("marker-dd-11.txt");
        const dashDashFile = join(project!.dir, "--");
        await writeFile(
          dashDashFile,
          "MARKER=should-not-be-loaded\n1BAD=warning-if-loaded\n",
          "utf-8",
        );

        const result = await runCLI(["run", "ralph", "-e", "--"], {
          cwd: project!.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(existsSync(marker)).toBe(false);
        // Env-file invalid-key warning for `1BAD` did NOT surface
        expect(result.stderr).not.toMatch(/1BAD/);
      });

      it("T-CLI-RUN-DASHDASH-12: `loopx run -n -- ralph` → usage error, exit 1, `--` cited (not `-n` operand-value error)", async () => {
        const marker = await setupRalphWithMarker("marker-dd-12.txt");
        const result = await runCLI(["run", "-n", "--", "ralph"], {
          cwd: project!.dir,
          runtime,
        });
        // (a) exit code 1
        expect(result.exitCode).toBe(1);
        // (b) stderr identifies `--` as the offending token. SPEC 4.1: `--`
        //     is rejected "wherever it appears" — including the position
        //     where `--` could be misread as the `-n` operand. The conformant
        //     rejection treats `--` as the unsupported / unrecognized token,
        //     NOT as a successfully-consumed `-n` operand with a bad value.
        expect(result.stderr).toContain("--");
        // (c) script did not run
        expect(existsSync(marker)).toBe(false);
        // (d) stderr does NOT surface an integer / numeric / operand-value
        //     validation failure for `-n` (would indicate `--` was consumed
        //     as `-n` operand and then rejected as a bad value).
        expect(result.stderr).not.toMatch(/non-negative integer/i);
        expect(result.stderr).not.toMatch(/integer.*got\s+'--'/i);
      });

      it("T-CLI-RUN-DASHDASH-13: `loopx run ralph -n --` → usage error, exit 1, `--` cited (not `-n` operand-value error)", async () => {
        const marker = await setupRalphWithMarker("marker-dd-13.txt");
        const result = await runCLI(["run", "ralph", "-n", "--"], {
          cwd: project!.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("--");
        expect(existsSync(marker)).toBe(false);
        expect(result.stderr).not.toMatch(/non-negative integer/i);
        expect(result.stderr).not.toMatch(/integer.*got\s+'--'/i);
      });
    });
  });

  // ========================================================================
  // Inherited Shell Env Prefix (T-CLI-RUN-INHERIT-01)
  // ========================================================================
  describe("SPEC: Inherited Shell Env Prefix", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-RUN-INHERIT-01: shell env prefix (`adr=0003 loopx run ralph`) reaches script via inherited-env tier", async () => {
        // SPEC 11.2 / 12: shell env prefix is the sole CLI surface for per-run
        // parameterization. Pin down the positive observability of this path
        // — `adr=0003 loopx run ralph` reaches the spawned script via
        // inherited-env tier (SPEC 8.3 tier 5), as the negative
        // T-CLI-RUN-DASHDASH-* / T-CLI-RUN-NAMEVAL-* tests cover the
        // would-be-argv-tail axis.
        project = await createTempProject();
        const marker = join(project.dir, "marker-inherit-01.txt");
        await createWorkflowScript(
          project,
          "ralph",
          "index",
          ".ts",
          observeEnv("adr", marker) +
            'import { output } from "loopx";\noutput({ stop: true });\n',
        );

        const result = await runCLI(["run", "-n", "1", "ralph"], {
          cwd: project.dir,
          runtime,
          // Inject `adr=0003` into loopx's inherited environment — equivalent
          // to running `adr=0003 loopx run ralph` from any POSIX shell.
          env: { adr: "0003" },
        });

        // (a) exit code 0
        expect(result.exitCode).toBe(0);
        // (b) the observe-env marker confirms the inherited shell-prefix
        //     value reached the spawned script
        expect(existsSync(marker)).toBe(true);
        const data = JSON.parse(readFileSync(marker, "utf-8")) as {
          present: boolean;
          value?: string;
        };
        expect(data.present).toBe(true);
        expect(data.value).toBe("0003");
        // (c) no `name=value` token appears in the loopx argv — implicit by
        //     construction (we did not pass `adr=0003` as an argv token).
      });
    });
  });

  // ========================================================================
  // `name=value` Rejection (T-CLI-RUN-NAMEVAL-01..07)
  // ========================================================================
  describe("SPEC: `name=value` Rejection", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-RUN-NAMEVAL-01: `loopx run adr=0003` (sole positional, valid `.loopx/`) → invalid-target error, exit 1", async () => {
        // SPEC 12: `loopx run adr=0003` is parsed as a target string; `=`
        // violates the name pattern, so target-syntax validation rejects it.
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          'printf \'{"stop":true}\'',
        );

        const result = await runCLI(["run", "adr=0003"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        // Mentions the invalid target / name-restriction violation
        expect(result.stderr).toMatch(/adr=0003|invalid|name|target/i);
      });

      it("T-CLI-RUN-NAMEVAL-02: `loopx run adr=0003` (no `.loopx/`) → missing-`.loopx/` error surfaces first, exit 1", async () => {
        // SPEC 7.1: CLI discovery (step 1) runs before target validation
        // (step 3). Missing `.loopx/` is part of discovery and must surface
        // before target syntax rejection.
        project = await createTempProject({ withLoopxDir: false });
        const result = await runCLI(["run", "adr=0003"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        // Mentions the missing `.loopx/` directory
        expect(result.stderr).toMatch(/\.loopx/);
        // Does NOT cite `adr=0003` as the fatal target-validation failure —
        // discovery failed first.
        expect(result.stderr).not.toMatch(/target.*adr=0003/i);
      });

      it("T-CLI-RUN-NAMEVAL-03: `loopx run ralph adr=0003` → usage error (extra positional), exit 1", async () => {
        // T-CLI-27 covers two bare positional words; this pins down that a
        // positional of the form `name=value` is also rejected as an extra
        // positional (not silently consumed as a named-argument tail).
        project = await createTempProject();
        const marker = join(project.dir, "marker-nv-03.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' 'ran' > "${marker}"\nprintf '{"stop":true}'`,
        );

        const result = await runCLI(["run", "ralph", "adr=0003"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(existsSync(marker)).toBe(false);
      });

      it("T-CLI-RUN-NAMEVAL-04: `loopx run adr=0003 -h` → help short-circuit, exit 0, no invalid-target error", async () => {
        // Help short-circuit ignores `name=value` "in any position", per
        // SPEC 11.2 / ADR-0004 §5 — including before the help flag.
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          'printf \'{"stop":true}\'',
        );

        const result = await runCLI(["run", "adr=0003", "-h"], {
          cwd: project.dir,
          runtime,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toLowerCase()).toMatch(/-n\b/);
        expect(result.stdout.toLowerCase()).toMatch(/-e\b/);
        // The would-be invalid-target error did NOT surface
        expect(result.stderr).not.toMatch(/invalid.*target.*adr=0003/i);
      });

      it("T-CLI-RUN-NAMEVAL-05: `loopx run ralph adr=0003 --help` → help short-circuit, exit 0, no usage/target error", async () => {
        // Long-form parity of T-CLI-RUN-NAMEVAL-04. Combines two would-be
        // usage errors (extra positional + name=value) under help.
        project = await createTempProject();
        const marker = join(project.dir, "marker-nv-05.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' 'ran' > "${marker}"\nprintf '{"stop":true}'`,
        );

        const result = await runCLI(
          ["run", "ralph", "adr=0003", "--help"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toLowerCase()).toMatch(/-n\b/);
        expect(result.stdout.toLowerCase()).toMatch(/-e\b/);
        // Script did not run, no usage error surfaced
        expect(existsSync(marker)).toBe(false);
        expect(result.stderr).not.toMatch(/unexpected|extra positional/i);
      });

      it("T-CLI-RUN-NAMEVAL-06: `loopx run adr=0003 ralph` → usage error (more-than-one-positional), exit 1, script did not run", async () => {
        // Closes the leading-`name=value`-then-target ordering. Both tokens
        // must be observed as positionals before the parser rejects the
        // second; a buggy parser that processed only `adr=0003` as a sole
        // positional and missed `ralph` as the extra positional would fail
        // assertion (b)'s reject-name-restriction-only clause.
        project = await createTempProject();
        const marker = join(project.dir, "marker-nv-06.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' 'ran' > "${marker}"\nprintf '{"stop":true}'`,
        );

        const result = await runCLI(["run", "adr=0003", "ralph"], {
          cwd: project.dir,
          runtime,
        });
        // (a) exit code 1
        expect(result.exitCode).toBe(1);
        // (b) stderr identifies a multi-positional grammar violation —
        //     does NOT surface a sole-target name-restriction violation that
        //     references only `adr=0003`. Wording is broad: any
        //     "unexpected/extra/multiple/too many" phrasing identifying
        //     `ralph` as the offender works; a name-restriction-on-`adr=0003`
        //     only error indicates the parser missed `ralph`.
        expect(result.stderr.length).toBeGreaterThan(0);
        // The error must cite `ralph` (the second positional that triggers
        // the multi-positional rejection), proving both tokens were observed.
        // A reject-only-on-`adr=0003` parser would produce stderr that does
        // not mention `ralph` — that's the discriminating signal.
        expect(result.stderr).toMatch(/ralph/);
        // (c) script did NOT run
        expect(existsSync(marker)).toBe(false);
        // (d) stderr does NOT mention `ralph` as a successfully-resolved
        //     target-that-then-failed (no version-check warning, no script
        //     not-found error referencing scripts under `ralph`).
        expect(result.stderr).not.toMatch(/script.*not found.*workflow.*ralph/i);
        expect(result.stderr).not.toMatch(/version-mismatch/i);
      });

      it("T-CLI-RUN-NAMEVAL-07: `loopx run -n 1 adr=0003 ralph` → usage error (more-than-one-positional), exit 1, script did not run", async () => {
        // Counterpart to NAMEVAL-06 with `-n 1` consumed first as an option
        // operand. Both `adr=0003` and `ralph` remain as positionals and
        // the parser must observe both before rejecting.
        project = await createTempProject();
        const marker = join(project.dir, "marker-nv-07.txt");
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          `printf '%s' 'ran' > "${marker}"\nprintf '{"stop":true}'`,
        );

        const result = await runCLI(
          ["run", "-n", "1", "adr=0003", "ralph"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stderr).toMatch(/ralph/);
        expect(existsSync(marker)).toBe(false);
        // No "successfully resolved target then failed" surface
        expect(result.stderr).not.toMatch(/script.*not found.*workflow.*ralph/i);
        expect(result.stderr).not.toMatch(/version-mismatch/i);
      });
    });
  });

  // ========================================================================
  // CLI Pre-iteration Ordering (T-CLI-RUN-ORDER-01..05)
  //
  // SPEC 7.1: discovery (step 1) → env loading (step 2) → target
  // resolution (step 3) → workflow-entry version check (step 5).
  // ========================================================================
  describe("SPEC: CLI Pre-iteration Ordering", () => {
    forEachRuntime((runtime) => {
      it("T-CLI-RUN-ORDER-01: env-file error beats missing-workflow error", async () => {
        // discovery passes; env loading fails before target resolution.
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          'printf \'{"stop":true}\'',
        );

        const result = await runCLI(
          ["run", "-e", "missing.env", "nonexistent"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        // (b) stderr mentions the missing env file
        expect(result.stderr).toMatch(/missing\.env/);
        // (c) stderr does NOT mention the missing workflow as the fatal
        //     error — target resolution was never reached.
        expect(result.stderr).not.toMatch(
          /workflow\s+'nonexistent'\s+not\s+found/i,
        );
      });

      it("T-CLI-RUN-ORDER-02: env-file error beats invalid target", async () => {
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          'printf \'{"stop":true}\'',
        );

        const result = await runCLI(
          ["run", "-e", "missing.env", ":script"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/missing\.env/);
        // The invalid-target error did NOT surface as the fatal
        expect(result.stderr).not.toMatch(/invalid.*target.*:script/i);
      });

      it("T-CLI-RUN-ORDER-03: discovery / global-validation error beats env-file error", async () => {
        // sibling collision in `broken/check.sh + check.ts` — fatal across
        // all discovered workflows per SPEC 5.4.
        project = await createTempProject();
        await createBashWorkflowScript(
          project,
          "ralph",
          "index",
          'printf \'{"stop":true}\'',
        );
        await createBashWorkflowScript(
          project,
          "broken",
          "check",
          'printf \'a\'',
        );
        await createWorkflowScript(
          project,
          "broken",
          "check",
          ".ts",
          'console.log("b");\n',
        );

        const result = await runCLI(
          ["run", "-e", "missing.env", "ralph"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        // (b) stderr surfaces the sibling collision (cites broken / check)
        expect(result.stderr).toMatch(/broken/);
        expect(result.stderr).toMatch(/check\.sh/);
        expect(result.stderr).toMatch(/check\.ts/);
        // (c) stderr does NOT mention the missing env file as the fatal —
        //     env-file loading was never attempted.
        expect(result.stderr).not.toMatch(/missing\.env/);
      });

      it("T-CLI-RUN-ORDER-04: missing `.loopx/` beats env-file error", async () => {
        // Existence-branch counterpart to ORDER-03: the missing-`.loopx/`
        // check is part of discovery (step 1) and fails before env-file
        // loading (step 2).
        project = await createTempProject({ withLoopxDir: false });

        const result = await runCLI(
          ["run", "-e", "missing.env", "ralph"],
          { cwd: project.dir, runtime },
        );
        expect(result.exitCode).toBe(1);
        // (b) stderr mentions missing `.loopx/`
        expect(result.stderr).toMatch(/\.loopx/);
        // (c) stderr does NOT mention the missing env file as the fatal
        expect(result.stderr).not.toMatch(/missing\.env/);
      });

      describe("T-CLI-RUN-ORDER-05: env-file error beats workflow `package.json` / version-check warnings", () => {
        // SPEC 7.1: env loading (step 2) before workflow-entry version
        // check (step 5). Three parallel sub-cases (broken JSON, unsatisfied
        // range, non-regular `package.json`) run independently against the
        // same fixture shape.

        it("(05-bad-json): env-file error suppresses invalid-JSON warning", async () => {
          project = await createTempProject();
          const marker = join(project.dir, "marker-order-05a.txt");
          await createBashWorkflowScript(
            project,
            "ralph",
            "index",
            `printf '%s' 'ran' > "${marker}"\nprintf '{"stop":true}'`,
          );
          // Broken JSON
          await createWorkflowPackageJson(project, "ralph", "{{{INVALID");

          const result = await runCLI(
            ["run", "-e", "missing.env", "ralph"],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(1);
          // (b) env-file error is the fatal-exit reason
          expect(result.stderr).toMatch(/missing\.env/);
          // (c) no package.json parse warning for `ralph`
          expect(result.stderr).not.toMatch(
            /package\.json.*invalid|invalid.*package\.json/i,
          );
          // (d) script did not run
          expect(existsSync(marker)).toBe(false);
        });

        it("(05-bad-range): env-file error suppresses version-mismatch warning", async () => {
          project = await createTempProject();
          const marker = join(project.dir, "marker-order-05b.txt");
          await createBashWorkflowScript(
            project,
            "ralph",
            "index",
            `printf '%s' 'ran' > "${marker}"\nprintf '{"stop":true}'`,
          );
          // Valid JSON with unsatisfied loopx range
          await createWorkflowPackageJson(project, "ralph", {
            dependencies: { loopx: ">=999.0.0" },
          });

          const result = await runCLI(
            ["run", "-e", "missing.env", "ralph"],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toMatch(/missing\.env/);
          // No version-mismatch warning surface text. Existing version-check
          // wording uses "does not satisfy" / "version mismatch" — both must
          // be absent.
          expect(result.stderr).not.toMatch(/satisf/i);
          expect(result.stderr).not.toMatch(/version[- ]mismatch/i);
          expect(existsSync(marker)).toBe(false);
        });

        it("(05-non-regular): env-file error suppresses non-regular package.json warning", async () => {
          project = await createTempProject();
          const marker = join(project.dir, "marker-order-05c.txt");
          await createBashWorkflowScript(
            project,
            "ralph",
            "index",
            `printf '%s' 'ran' > "${marker}"\nprintf '{"stop":true}'`,
          );
          // package.json/ as a directory containing a placeholder file
          const { mkdir, writeFile } = await import("node:fs/promises");
          const pkgDir = join(project.loopxDir, "ralph", "package.json");
          await mkdir(pkgDir, { recursive: true });
          await writeFile(join(pkgDir, "README"), "placeholder", "utf-8");

          const result = await runCLI(
            ["run", "-e", "missing.env", "ralph"],
            { cwd: project.dir, runtime },
          );
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toMatch(/missing\.env/);
          // No non-regular package.json warning surface text
          expect(result.stderr).not.toMatch(/non-regular/i);
          expect(existsSync(marker)).toBe(false);
          // Directory at .loopx/ralph/package.json/ is preserved
          expect(existsSync(pkgDir)).toBe(true);
          expect(existsSync(join(pkgDir, "README"))).toBe(true);
        });
      });
    });
  });
});
