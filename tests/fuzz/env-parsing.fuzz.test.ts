import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parseEnvFile } from "loopx/internal";
import {
  createTempProject,
  createBashScript,
  runCLI,
  writeEnvFileRaw,
} from "../helpers/index.js";
import { writeEnvToFile } from "../helpers/fixture-scripts.js";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Generates valid env variable keys matching [A-Za-z_][A-Za-z0-9_]*
 */
const arbitraryEnvKey: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_".split(""),
    ),
    fc.string({
      unit: fc.constantFrom(
        ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_".split(
          "",
        ),
      ),
      maxLength: 20,
    }),
  )
  .map(([first, rest]) => first + rest);

/**
 * Generates values with edge cases: quoted values, special characters,
 * equals signs, hash marks, spaces, unicode, empty.
 */
const arbitraryEnvValue: fc.Arbitrary<string> = fc.oneof(
  // Simple values (no newlines or carriage returns)
  fc.string({ maxLength: 100 }).filter((s) => !s.includes("\n") && !s.includes("\r")),
  // Empty value
  fc.constant(""),
  // Values with special characters
  fc.constant("hello world"),
  fc.constant("value=with=equals"),
  fc.constant("value#with#hash"),
  fc.constant("  leading spaces"),
  fc.constant("trailing spaces  "),
  // Double-quoted values
  fc.string({ maxLength: 50 })
    .filter((s) => !s.includes("\n") && !s.includes("\r") && !s.includes('"'))
    .map((s) => `"${s}"`),
  // Single-quoted values
  fc.string({ maxLength: 50 })
    .filter((s) => !s.includes("\n") && !s.includes("\r") && !s.includes("'"))
    .map((s) => `'${s}'`),
  // Unmatched quotes
  fc.constant('"unmatched'),
  fc.constant("'unmatched"),
  fc.constant('unmatched"'),
  fc.constant("unmatched'"),
  // Escape sequences (literal, not interpreted per spec)
  fc.constant("\\n"),
  fc.constant("\\t"),
  fc.constant("\\\\"),
  // Unicode values (no newlines)
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 30 })
    .filter((s) => !s.includes("\n") && !s.includes("\r")),
  // Values with backslash-n (literal, not newline)
  fc.constant("line\\nbreak"),
);

/**
 * Generates individual env lines: valid KEY=VALUE, comments, blank lines,
 * and malformed lines.
 */
const arbitraryEnvLine: fc.Arbitrary<string> = fc.oneof(
  // Valid KEY=VALUE
  fc.tuple(arbitraryEnvKey, arbitraryEnvValue).map(
    ([key, value]) => `${key}=${value}`,
  ),
  // Comment lines
  fc.string({ maxLength: 80 })
    .filter((s) => !s.includes("\n") && !s.includes("\r"))
    .map((s) => `# ${s}`),
  fc.constant("# This is a comment"),
  fc.constant("#"),
  fc.constant("# "),
  // Blank lines
  fc.constant(""),
  fc.constant("   "),
  fc.constant("\t"),
  // Malformed lines: no equals sign
  fc.string({ minLength: 1, maxLength: 30 }).filter(
    (s) =>
      !s.includes("=") &&
      !s.includes("\n") &&
      !s.includes("\r") &&
      !s.startsWith("#") &&
      s.trim().length > 0,
  ),
  // Malformed lines: invalid key names
  fc.constant("1BAD=val"),
  fc.constant("KEY WITH SPACES=val"),
  fc.constant("-DASH=val"),
  fc.constant("=nokey"),
  fc.constant(" LEADING_SPACE=val"),
);

/**
 * Generates multi-line .env file content by combining multiple env lines.
 */
const arbitraryEnvFile: fc.Arbitrary<string> = fc
  .array(arbitraryEnvLine, { minLength: 0, maxLength: 30 })
  .map((lines) => lines.join("\n"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Helper for E2E tests: writes .env content to file, runs loopx with -e flag,
 * uses a marker-file script to observe a specific env variable.
 */
async function runE2EEnvTest(
  envContent: string,
  varName: string,
): Promise<{ found: boolean; value: string; exitCode: number; stderr: string }> {
  const project = await createTempProject();
  try {
    // Write the raw env file
    const envPath = join(project.dir, ".env.test");
    await writeEnvFileRaw(envPath, envContent);

    // Create a script that writes the env var to a marker file
    const markerPath = join(project.dir, "marker.txt");
    await createBashScript(
      project,
      "check-env",
      writeEnvToFile(varName, markerPath),
    );

    const result = await runCLI(["-n", "1", "-e", envPath, "check-env"], {
      cwd: project.dir,
    });

    let found = false;
    let value = "";
    if (existsSync(markerPath)) {
      found = true;
      value = readFileSync(markerPath, "utf-8");
    }

    return {
      found,
      value,
      exitCode: result.exitCode,
      stderr: result.stderr,
    };
  } finally {
    await project.cleanup();
  }
}

// ---------------------------------------------------------------------------
// F-ENV-01: No crashes
// ---------------------------------------------------------------------------

describe("FUZZ: Env File Parsing", () => {
  describe("F-ENV-01: No crashes — any string as .env content, no uncaught exception", () => {
    it("unit-level: arbitrary env file content (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryEnvFile, (content) => {
          let threw = false;
          try {
            parseEnvFile(content);
          } catch {
            threw = true;
          }
          expect(threw).toBe(false);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: completely random strings (1000 inputs)", () => {
      fc.assert(
        fc.property(fc.string(), (content) => {
          let threw = false;
          try {
            parseEnvFile(content);
          } catch {
            threw = true;
          }
          expect(threw).toBe(false);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: unicode strings (1000 inputs)", () => {
      fc.assert(
        fc.property(
          fc.string({ unit: "binary", minLength: 0, maxLength: 200 }),
          (content) => {
            let threw = false;
            try {
              parseEnvFile(content);
            } catch {
              threw = true;
            }
            expect(threw).toBe(false);
          },
        ),
        { numRuns: 1000 },
      );
    });

    it("unit-level: very long content (1000 inputs)", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 500, maxLength: 5000 }),
          (content) => {
            let threw = false;
            try {
              parseEnvFile(content);
            } catch {
              threw = true;
            }
            expect(threw).toBe(false);
          },
        ),
        { numRuns: 1000 },
      );
    });

    it("unit-level: empty and whitespace-only content (no crash)", () => {
      const edgeCases = ["", " ", "\n", "\r\n", "\t", "\n\n\n", "  \n  \n  "];
      for (const content of edgeCases) {
        let threw = false;
        try {
          parseEnvFile(content);
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
      }
    });

    it("e2e: arbitrary env file content via child process (50 inputs)", async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryEnvFile, async (content) => {
          const project = await createTempProject();
          try {
            const envPath = join(project.dir, ".env.test");
            await writeEnvFileRaw(envPath, content);

            // Create a trivial script that exits successfully
            await createBashScript(project, "noop", "exit 0");

            const result = await runCLI(
              ["-n", "1", "-e", envPath, "noop"],
              { cwd: project.dir },
            );

            // Must not crash with unexpected exit code
            // Exit code 0 (success) or 1 (error) are both acceptable
            expect([0, 1]).toContain(result.exitCode);
          } finally {
            await project.cleanup();
          }
        }),
        { numRuns: 50 },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F-ENV-02: Deterministic
  // ---------------------------------------------------------------------------

  describe("F-ENV-02: Deterministic — same content, same variables", () => {
    it("unit-level: parseEnvFile called twice with same input yields equal result (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryEnvFile, (content) => {
          const result1 = parseEnvFile(content);
          const result2 = parseEnvFile(content);
          expect(result1.vars).toEqual(result2.vars);
          expect(result1.warnings).toEqual(result2.warnings);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: deterministic for random strings (1000 inputs)", () => {
      fc.assert(
        fc.property(fc.string(), (content) => {
          const result1 = parseEnvFile(content);
          const result2 = parseEnvFile(content);
          expect(result1.vars).toEqual(result2.vars);
          expect(result1.warnings).toEqual(result2.warnings);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: deterministic for unicode strings (1000 inputs)", () => {
      fc.assert(
        fc.property(
          fc.string({ unit: "binary", minLength: 0, maxLength: 200 }),
          (content) => {
            const result1 = parseEnvFile(content);
            const result2 = parseEnvFile(content);
            expect(result1.vars).toEqual(result2.vars);
            expect(result1.warnings).toEqual(result2.warnings);
          },
        ),
        { numRuns: 1000 },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F-ENV-03: Keys and values are strings
  // ---------------------------------------------------------------------------

  describe("F-ENV-03: Keys and values are strings", () => {
    it("unit-level: all parsed vars have string keys and string values (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryEnvFile, (content) => {
          const result = parseEnvFile(content);
          for (const [key, value] of Object.entries(result.vars)) {
            expect(typeof key).toBe("string");
            expect(typeof value).toBe("string");
          }
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: string types for random content (1000 inputs)", () => {
      fc.assert(
        fc.property(fc.string(), (content) => {
          const result = parseEnvFile(content);
          for (const [key, value] of Object.entries(result.vars)) {
            expect(typeof key).toBe("string");
            expect(typeof value).toBe("string");
          }
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: warnings array contains only strings (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryEnvFile, (content) => {
          const result = parseEnvFile(content);
          expect(Array.isArray(result.warnings)).toBe(true);
          for (const warning of result.warnings) {
            expect(typeof warning).toBe("string");
          }
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: key names match [A-Za-z_][A-Za-z0-9_]* (1000 inputs)", () => {
      const validKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
      fc.assert(
        fc.property(arbitraryEnvFile, (content) => {
          const result = parseEnvFile(content);
          for (const key of Object.keys(result.vars)) {
            expect(key).toMatch(validKeyPattern);
          }
        }),
        { numRuns: 1000 },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F-ENV-04: Last-wins for duplicates
  // ---------------------------------------------------------------------------

  describe("F-ENV-04: Last-wins for duplicates", () => {
    it("unit-level: duplicate keys resolved by last occurrence (1000 inputs)", () => {
      // Generate env files with guaranteed duplicate keys
      const envWithDuplicates = fc
        .tuple(
          arbitraryEnvKey,
          fc.string({ maxLength: 30 }).filter(
            (s) => !s.includes("\n") && !s.includes("\r"),
          ),
          fc.string({ maxLength: 30 }).filter(
            (s) => !s.includes("\n") && !s.includes("\r"),
          ),
          fc.array(arbitraryEnvLine, { minLength: 0, maxLength: 10 }),
        )
        .map(([key, firstValue, lastValue, otherLines]) => {
          const firstLine = `${key}=${firstValue}`;
          const lastLine = `${key}=${lastValue}`;
          // Insert other lines between duplicates
          const allLines = [firstLine, ...otherLines, lastLine];
          return { content: allLines.join("\n"), key, lastValue };
        });

      fc.assert(
        fc.property(envWithDuplicates, ({ content, key, lastValue }) => {
          const result = parseEnvFile(content);
          if (key in result.vars) {
            // The value for the duplicate key must be the last occurrence's value.
            // Note: the value may have trailing whitespace trimmed per spec.
            expect(result.vars[key]).toBe(lastValue);
          }
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: three occurrences, last wins (explicit)", () => {
      const content = "MY_KEY=first\nMY_KEY=second\nMY_KEY=third";
      const result = parseEnvFile(content);
      expect(result.vars["MY_KEY"]).toBe("third");
    });

    it("unit-level: duplicates with intervening comments (explicit)", () => {
      const content = "MY_KEY=first\n# comment\nMY_KEY=last";
      const result = parseEnvFile(content);
      expect(result.vars["MY_KEY"]).toBe("last");
    });

    it("e2e: last-wins via child process (50 inputs)", async () => {
      // Use simple alphanumeric values to avoid shell quoting issues
      const safeAlphanumeric = fc.string({
        unit: fc.constantFrom(
          ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
        ),
        minLength: 1,
        maxLength: 20,
      });

      const envWithDuplicates = fc
        .tuple(arbitraryEnvKey, safeAlphanumeric, safeAlphanumeric)
        .map(([key, firstValue, lastValue]) => ({
          content: `${key}=${firstValue}\n${key}=${lastValue}`,
          key,
          lastValue,
        }));

      await fc.assert(
        fc.asyncProperty(
          envWithDuplicates,
          async ({ content, key, lastValue }) => {
            const { found, value, exitCode } = await runE2EEnvTest(
              content,
              key,
            );
            if (exitCode === 0 && found) {
              expect(value).toBe(lastValue);
            }
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F-ENV-05: Comment lines never produce variables
  // ---------------------------------------------------------------------------

  describe("F-ENV-05: Comment lines never produce variables", () => {
    it("unit-level: files of only comment lines produce no variables (1000 inputs)", () => {
      // Generate files consisting entirely of comment lines and blank lines
      const commentLine = fc.oneof(
        fc.string({ maxLength: 80 })
          .filter((s) => !s.includes("\n") && !s.includes("\r"))
          .map((s) => `# ${s}`),
        fc.constant("#"),
        fc.constant("# comment"),
        fc.constant(""),
        fc.constant("   "),
      );

      const commentOnlyFile = fc
        .array(commentLine, { minLength: 1, maxLength: 20 })
        .map((lines) => lines.join("\n"));

      fc.assert(
        fc.property(commentOnlyFile, (content) => {
          const result = parseEnvFile(content);
          expect(Object.keys(result.vars)).toHaveLength(0);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: comment lines among valid lines do not produce extra variables (1000 inputs)", () => {
      // Generate a file with known valid lines and comment lines, and verify
      // that only the valid keys appear
      const safeAlphanumeric = fc.string({
        unit: fc.constantFrom(
          ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
        ),
        minLength: 1,
        maxLength: 20,
      });

      const validLine = fc
        .tuple(arbitraryEnvKey, safeAlphanumeric)
        .map(([key, value]) => ({ line: `${key}=${value}`, key }));

      const commentLine = fc
        .string({ maxLength: 50 })
        .filter((s) => !s.includes("\n") && !s.includes("\r"))
        .map((s) => `# ${s}`);

      const mixedFile = fc
        .tuple(
          fc.array(validLine, { minLength: 1, maxLength: 5 }),
          fc.array(commentLine, { minLength: 1, maxLength: 10 }),
        )
        .map(([validLines, comments]) => {
          // Interleave valid lines and comments
          const allLines: string[] = [];
          const validKeys = new Set<string>();
          let vi = 0;
          let ci = 0;
          while (vi < validLines.length || ci < comments.length) {
            if (vi < validLines.length) {
              allLines.push(validLines[vi].line);
              validKeys.add(validLines[vi].key);
              vi++;
            }
            if (ci < comments.length) {
              allLines.push(comments[ci]);
              ci++;
            }
          }
          return { content: allLines.join("\n"), validKeys };
        });

      fc.assert(
        fc.property(mixedFile, ({ content, validKeys }) => {
          const result = parseEnvFile(content);
          // Every key in the parsed result must be one of the valid keys we
          // generated
          for (const key of Object.keys(result.vars)) {
            expect(validKeys.has(key)).toBe(true);
          }
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: lines starting with # including edge cases (explicit)", () => {
      const edgeCases = [
        "#KEY=value",
        "# KEY=value",
        "#=value",
        "#VALID_KEY=actual_value",
        "## double hash",
        "#\ttab after hash",
      ];

      for (const line of edgeCases) {
        const result = parseEnvFile(line);
        expect(Object.keys(result.vars)).toHaveLength(0);
      }
    });

    it("e2e: comment-only env file produces no env vars in script (50 inputs)", async () => {
      const commentOnlyFile = fc
        .array(
          fc
            .string({
              unit: fc.constantFrom(
                ..."abcdefghijklmnopqrstuvwxyz0123456789 ".split(""),
              ),
              maxLength: 40,
            })
            .map((s) => `# ${s}`),
          { minLength: 1, maxLength: 10 },
        )
        .map((lines) => lines.join("\n"));

      await fc.assert(
        fc.asyncProperty(commentOnlyFile, async (content) => {
          // Use a unique variable name unlikely to exist in environment
          const uniqueVar = "LOOPX_FUZZ_COMMENT_CHECK";
          const project = await createTempProject();
          try {
            const envPath = join(project.dir, ".env.test");
            await writeEnvFileRaw(envPath, content);

            const markerPath = join(project.dir, "marker.txt");
            await createBashScript(
              project,
              "check-env",
              writeEnvToFile(uniqueVar, markerPath),
            );

            const result = await runCLI(
              ["-n", "1", "-e", envPath, "check-env"],
              { cwd: project.dir },
            );

            // The marker file should contain empty string since the
            // comment-only env file should not set any variable named
            // LOOPX_FUZZ_COMMENT_CHECK
            if (result.exitCode === 0 && existsSync(markerPath)) {
              const value = readFileSync(markerPath, "utf-8");
              expect(value).toBe("");
            }
          } finally {
            await project.cleanup();
          }
        }),
        { numRuns: 50 },
      );
    });
  });
});
