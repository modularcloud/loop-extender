import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTempProject,
  createScript,
  createBashScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLI } from "../helpers/cli.js";
import { runAPIDriver } from "../helpers/api-driver.js";
import { forEachRuntime } from "../helpers/runtime.js";
import { writeEnvFileRaw } from "../helpers/env.js";
import {
  stdoutWriter,
  counter,
  emitStop,
  emitGoto,
  emitResultGoto,
  writeEnvToFile,
} from "../helpers/fixture-scripts.js";

// ---------------------------------------------------------------------------
// SPEC: §7 — Edge Cases & Boundary Tests
// ---------------------------------------------------------------------------

describe("SPEC: Edge Cases & Boundary Tests (§7)", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  // =========================================================================
  // T-EDGE-01: Very long result (~1 MB) handled without truncation
  // =========================================================================

  describe("SPEC: Very long result (~1 MB)", () => {
    forEachRuntime((runtime) => {
      it("T-EDGE-01: ~1 MB result handled without truncation", async () => {
        project = await createTempProject();

        // Create a payload file containing a 1 MB JSON result
        const bigString = "x".repeat(1_000_000);
        const payloadContent = JSON.stringify({ result: bigString });
        const payloadFile = join(project.dir, "payload.json");
        await writeFile(payloadFile, payloadContent, "utf-8");

        // Create a TS script that reads and writes the payload to stdout
        await createScript(
          project,
          "bigresult",
          ".ts",
          stdoutWriter(payloadFile),
        );

        // Use runAPIDriver with runPromise to observe the yielded Output
        const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("bigresult", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify({ resultLength: outputs[0]?.result?.length }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
          timeout: 60_000,
        });

        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.resultLength).toBe(1_000_000);
      });
    });
  });

  // =========================================================================
  // T-EDGE-02: JSON-special characters in result
  // =========================================================================

  describe("SPEC: JSON-special characters in result", () => {
    forEachRuntime((runtime) => {
      it("T-EDGE-02: quotes, backslashes, newlines, tabs, unicode escapes preserved", async () => {
        project = await createTempProject();

        // A result string with JSON-special chars: quotes, backslashes, newlines, tabs, unicode
        const specialResult = 'he said "hello"\\and\nnewline\ttab\u00e9\u4e16\u754c';
        const payloadContent = JSON.stringify({ result: specialResult });
        const payloadFile = join(project.dir, "special-payload.json");
        await writeFile(payloadFile, payloadContent, "utf-8");

        // Script reads the payload file and writes it to stdout
        await createScript(
          project,
          "specialchars",
          ".ts",
          stdoutWriter(payloadFile),
        );

        const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("specialchars", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify({ result: outputs[0]?.result }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.result).toBe(specialResult);
      });
    });
  });

  // =========================================================================
  // T-EDGE-03: Partial stdout writes captured as a unit
  // =========================================================================

  describe("SPEC: Partial stdout writes captured as a unit", () => {
    forEachRuntime((runtime) => {
      it("T-EDGE-03: multiple process.stdout.write() calls captured as complete result", async () => {
        project = await createTempProject();

        // TS script that writes stdout in multiple write() calls
        const tsContent = `
process.stdout.write('{"resu');
process.stdout.write('lt":"pa');
process.stdout.write('rtial"}');
`;
        await createScript(project, "partial", ".ts", tsContent);

        const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("partial", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify({ result: outputs[0]?.result }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.result).toBe("partial");
      });
    });
  });

  // =========================================================================
  // T-EDGE-04: Stdout captured, stderr passed through, no interleaving
  // =========================================================================

  describe("SPEC: Stdout captured, stderr passed through", () => {
    forEachRuntime((runtime) => {
      it("T-EDGE-04: stdout is structured output, stderr contains expected message", async () => {
        project = await createTempProject();

        // Script writes to both stdout and stderr
        await createBashScript(
          project,
          "mixed-io",
          `echo "stderr-message-here" >&2
printf '{"result":"stdout-ok"}'`,
        );

        const result = await runCLI(["-n", "1", "mixed-io"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        // stdout should contain the structured output (the JSON result)
        expect(result.stdout).toContain("stdout-ok");
        // stderr should contain the message written by the script
        expect(result.stderr).toContain("stderr-message-here");
      });
    });
  });

  // =========================================================================
  // T-EDGE-05: Unicode in result preserved; unicode in script names rejected
  // =========================================================================

  describe("SPEC: Unicode in result preserved; unicode in script names rejected", () => {
    forEachRuntime((runtime) => {
      it("T-EDGE-05a: unicode result (emoji, CJK) preserved", async () => {
        project = await createTempProject();

        const unicodeResult = "\u{1F600}\u4E16\u754C\u{1F389}";
        const payloadContent = JSON.stringify({ result: unicodeResult });
        const payloadFile = join(project.dir, "unicode-payload.json");
        await writeFile(payloadFile, payloadContent, "utf-8");

        await createScript(
          project,
          "unicode-result",
          ".ts",
          stdoutWriter(payloadFile),
        );

        const driverCode = `
import { runPromise } from "loopx";

const outputs = await runPromise("unicode-result", { cwd: ${JSON.stringify(project.dir)}, maxIterations: 1 });
console.log(JSON.stringify({ result: outputs[0]?.result }));
`;
        const result = await runAPIDriver(runtime, driverCode, {
          cwd: project.dir,
        });

        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.result).toBe(unicodeResult);
      });

      it("T-EDGE-05b: unicode in script name is rejected", async () => {
        project = await createTempProject();

        // Create a script with a unicode name (cafe\u0301 = café)
        await createScript(
          project,
          "caf\u00e9",
          ".sh",
          `#!/bin/bash\nprintf '{"result":"ok"}'`,
        );

        // Attempting to run it should produce an error (invalid name)
        const result = await runCLI(["-n", "1", "caf\u00e9"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });

      it("T-EDGE-05c: unicode in env values is preserved", async () => {
        project = await createTempProject();
        const markerPath = join(project.dir, "unicode-env-marker.txt");
        const unicodeValue = "\u{1F600}\u4E16\u754C\u{1F389}";

        // Write env file with unicode value
        const envPath = join(project.dir, "unicode.env");
        writeEnvFileRaw(envPath, `UNICODE_VAR=${unicodeValue}\n`);

        // Script writes the env var to a marker file
        await createScript(
          project,
          "check-env",
          ".sh",
          writeEnvToFile("UNICODE_VAR", markerPath),
        );

        const result = await runCLI(["-e", envPath, "-n", "1", "check-env"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const envContent = readFileSync(markerPath, "utf-8");
        expect(envContent).toBe(unicodeValue);
      });
    });
  });

  // =========================================================================
  // T-EDGE-06: Deeply nested goto chain (A->B->...->Z) correct order and counting
  // =========================================================================

  describe("SPEC: Deeply nested goto chain (A through Z)", () => {
    forEachRuntime((runtime) => {
      it("T-EDGE-06: 26-script goto chain A->B->...->Z, all 26 run", async () => {
        project = await createTempProject();
        const counterFile = join(project.dir, "chain-counter.txt");
        const orderFile = join(project.dir, "chain-order.txt");

        const letters = "abcdefghijklmnopqrstuvwxyz".split("");

        for (let i = 0; i < letters.length; i++) {
          const letter = letters[i];
          const isLast = i === letters.length - 1;

          if (isLast) {
            // Last script: just count, no goto (end of chain)
            await createBashScript(
              project,
              letter,
              `printf '1' >> "${counterFile}"
printf '%s' "${letter}" >> "${orderFile}"
printf '{"result":"done"}'`,
            );
          } else {
            // Each script gotos the next letter
            const nextLetter = letters[i + 1];
            await createBashScript(
              project,
              letter,
              `printf '1' >> "${counterFile}"
printf '%s' "${letter}" >> "${orderFile}"
printf '{"goto":"${nextLetter}"}'`,
            );
          }
        }

        const result = await runCLI(["-n", "26", "a"], {
          cwd: project.dir,
          runtime,
          timeout: 60_000,
        });

        expect(result.exitCode).toBe(0);

        // Verify all 26 ran via counter file (26 bytes of "1")
        expect(existsSync(counterFile)).toBe(true);
        const count = readFileSync(counterFile, "utf-8");
        expect(count).toBe("1".repeat(26));

        // Verify correct execution order
        expect(existsSync(orderFile)).toBe(true);
        const order = readFileSync(orderFile, "utf-8");
        expect(order).toBe("abcdefghijklmnopqrstuvwxyz");
      });
    });
  });

  // =========================================================================
  // T-EDGE-07: Script reads stdin when no input available, no deadlock
  // =========================================================================

  describe("SPEC: Script reads stdin when no input, no deadlock", () => {
    forEachRuntime((runtime) => {
      it("T-EDGE-07: script that tries to read stdin completes without hanging", async () => {
        project = await createTempProject();

        // Bash script that tries to read stdin on first iteration
        // Since stdin is closed/empty, `read` should return immediately with EOF
        await createBashScript(
          project,
          "stdin-reader",
          `INPUT=$(cat)
printf '{"result":"read-done"}'`,
        );

        const result = await runCLI(["-n", "1", "stdin-reader"], {
          cwd: project.dir,
          runtime,
          timeout: 10_000, // Generous timeout — but should complete quickly
        });

        // Should complete without hanging or timing out
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("read-done");
      });
    });
  });

  // =========================================================================
  // T-EDGE-11: Very large -n value, no overflow
  // =========================================================================

  describe("SPEC: Very large -n value, no overflow", () => {
    forEachRuntime((runtime) => {
      it("T-EDGE-11: -n 999999 with script that stops on first iteration works normally", async () => {
        project = await createTempProject();

        // Script that stops immediately on the first iteration
        await createScript(project, "stop-first", ".sh", emitStop());

        const result = await runCLI(["-n", "999999", "stop-first"], {
          cwd: project.dir,
          runtime,
        });

        // Should exit 0 with only 1 iteration (stop on first)
        expect(result.exitCode).toBe(0);
      });
    });
  });

  // =========================================================================
  // T-EDGE-12: Empty .loopx/ dir -- no default, named not found
  // =========================================================================

  describe("SPEC: Empty .loopx/ directory", () => {
    forEachRuntime((runtime) => {
      it("T-EDGE-12a: empty .loopx/ with no args -> exit 1 (no default)", async () => {
        project = await createTempProject();
        // .loopx/ exists but is empty (no scripts at all)

        const result = await runCLI([], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
        // Stderr should mention something about the missing default script
        const stderrLower = result.stderr.toLowerCase();
        expect(stderrLower).toContain("default");
      });

      it("T-EDGE-12b: empty .loopx/ with named script -> exit 1 (not found)", async () => {
        project = await createTempProject();
        // .loopx/ exists but is empty

        const result = await runCLI(["myscript"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(1);
      });
    });
  });

  // =========================================================================
  // T-EDGE-14: Env file with no trailing newline still parsed
  // =========================================================================

  describe("SPEC: Env file with no trailing newline", () => {
    forEachRuntime((runtime) => {
      it("T-EDGE-14: env file without trailing newline still has last line parsed", async () => {
        project = await createTempProject();

        // Write an env file with no trailing newline
        const envPath = join(project.dir, ".loopx", "env");
        await writeEnvFileRaw(envPath, "MY_EDGE_KEY=edge_value");

        // Script that reads the env var and writes it to a marker file
        const markerPath = join(project.dir, "env-marker.txt");
        await createScript(
          project,
          "check-env-edge",
          ".sh",
          writeEnvToFile("MY_EDGE_KEY", markerPath),
        );

        const result = await runCLI(["-n", "1", "check-env-edge"], {
          cwd: project.dir,
          runtime,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(markerPath)).toBe(true);
        const content = readFileSync(markerPath, "utf-8");
        expect(content).toBe("edge_value");
      });
    });
  });

  // =========================================================================
  // T-EDGE-15: Empty env file (0 bytes) -- no error, no variables
  // =========================================================================

  describe("SPEC: Empty env file (0 bytes)", () => {
    forEachRuntime((runtime) => {
      it("T-EDGE-15: empty env file causes no error and loads no variables", async () => {
        project = await createTempProject();

        // Write a 0-byte env file
        const envPath = join(project.dir, ".loopx", "env");
        await writeEnvFileRaw(envPath, "");

        // Script that checks whether a specific env var is set
        // If the empty env file caused an error or loaded garbage, this would fail
        const markerPath = join(project.dir, "empty-env-marker.txt");
        await createScript(
          project,
          "check-no-env",
          ".sh",
          writeEnvToFile("NONEXISTENT_VAR", markerPath),
        );

        const result = await runCLI(["-n", "1", "check-no-env"], {
          cwd: project.dir,
          runtime,
        });

        // Should succeed without error
        expect(result.exitCode).toBe(0);
        // The marker file should exist but contain empty string (var not set)
        expect(existsSync(markerPath)).toBe(true);
        const content = readFileSync(markerPath, "utf-8");
        expect(content).toBe("");
      });
    });
  });
});
