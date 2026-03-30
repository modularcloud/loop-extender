import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseOutput } from "loopx/internal";
import {
  createTempProject,
  createScript,
  runAPIDriver,
} from "../helpers/index.js";
import { stdoutWriter } from "../helpers/fixture-scripts.js";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Generates any valid JSON value: objects, arrays, strings, numbers,
 * booleans, and null. Uses fc.letrec for recursive structure.
 */
const arbitraryJSON: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  json: fc.oneof(
    { depthSize: "small" },
    fc.string(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie("json"), { maxLength: 5 }),
    fc.dictionary(fc.string({ maxLength: 10 }), tie("json"), { maxKeys: 5 }),
  ),
})).json;

/**
 * Generates arbitrary strings including edge cases: empty, very long,
 * unicode, control characters, embedded quotes, backslashes.
 */
const arbitraryString: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.constant(""),
  fc.constant("\n"),
  fc.constant("\r\n"),
  fc.constant("\t"),
  fc.constant("\\"),
  fc.constant('"'),
  fc.constant("'"),
  fc.constant("  "),
  fc.string({ unit: "binary", minLength: 1, maxLength: 100 }),
  fc.string({ minLength: 1000, maxLength: 5000 }),
  fc.constant("{}"),
  fc.constant("{"),
  fc.constant('{"result":'),
  fc.constant("null"),
  fc.constant("undefined"),
  fc.constant("NaN"),
  fc.constant("Infinity"),
);

/**
 * Generates objects that mimic valid Output shapes, but with fields
 * of various types (correct and incorrect).
 */
const arbitraryOutputObject: fc.Arbitrary<Record<string, unknown>> = fc.record(
  {
    result: fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.dictionary(fc.string({ maxLength: 5 }), fc.string(), { maxKeys: 3 }),
      fc.array(fc.integer(), { maxLength: 3 }),
    ),
    goto: fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
    ),
    stop: fc.oneof(
      fc.constant(true as const),
      fc.constant(false as const),
      fc.string(),
      fc.integer(),
      fc.constant(null),
    ),
    extra: fc.oneof(fc.string(), fc.integer()),
  },
  { requiredKeys: [] },
);

/**
 * Generates strings that are not valid JSON: truncated objects, trailing
 * commas, unquoted keys, etc.
 */
const arbitraryMalformedJSON: fc.Arbitrary<string> = fc.oneof(
  // Truncated objects
  fc.constant('{"result": "hello"'),
  fc.constant('{"result":'),
  fc.constant("{"),
  fc.constant('{"key": "value",}'),
  // Trailing commas
  fc.constant("[1,2,3,]"),
  fc.constant('{"a":1,}'),
  // Unquoted keys
  fc.constant("{result: 42}"),
  fc.constant("{goto: next}"),
  // Single-quoted strings
  fc.constant("{'result': 'hello'}"),
  // Extra closing brackets
  fc.constant('{"result":"x"}}'),
  fc.constant("[1,2]]"),
  // Mixed nonsense
  fc.constant("}{"),
  fc.constant("]["),
  fc.constant('{"result": undefined}'),
  fc.constant('{"result": NaN}'),
  // Random garbage near JSON
  fc.string().map((s) => `{${s}}`),
  fc.string().map((s) => `[${s}]`),
  // Truncated at various points
  fc.constantFrom(
    '{"result":"x","goto":"y","stop":tru',
    '{"result":"x","goto":"y","stop":',
    '{"result":"x","goto":"y",',
    '{"result":"x","goto":',
  ),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The Output type matching the loopx spec (section 2.3).
 */
interface Output {
  result?: string;
  goto?: string;
  stop?: boolean;
}

/**
 * Helper for E2E tests: writes payload to file, creates a TS script that
 * reads the file and writes it to stdout, runs via the API driver.
 */
async function runE2EParseTest(
  payload: string,
): Promise<{ output: Output; exitCode: number; stderr: string }> {
  const project = await createTempProject();
  try {
    // Write payload to file (binary-safe via Buffer)
    const payloadPath = join(project.dir, "payload.bin");
    await writeFile(payloadPath, Buffer.from(payload, "utf-8"));

    // Create the stdoutWriter script
    await createScript(
      project,
      "writer",
      ".ts",
      stdoutWriter(payloadPath),
    );

    // Run via API driver: call runPromise, get the Output array
    const driverCode = `
import { runPromise } from "loopx";
const outputs = await runPromise("writer", { cwd: "${project.dir}", maxIterations: 1 });
console.log(JSON.stringify(outputs));
`;
    const result = await runAPIDriver("node", driverCode, { cwd: project.dir });
    let output: Output = {};
    try {
      const outputs = JSON.parse(result.stdout) as Output[];
      if (outputs.length > 0) {
        output = outputs[0];
      }
    } catch {
      // Parse failure is fine; we still check no crash
    }
    return { output, exitCode: result.exitCode, stderr: result.stderr };
  } finally {
    await project.cleanup();
  }
}

// ---------------------------------------------------------------------------
// F-PARSE-01: No crashes
// ---------------------------------------------------------------------------

describe("FUZZ: Structured Output Parsing", () => {
  describe("F-PARSE-01: No crashes — any stdout string, no uncaught exception", () => {
    it("unit-level: arbitrary strings (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryString, (input) => {
          // parseOutput must never throw for any string input
          let threw = false;
          try {
            parseOutput(input);
          } catch {
            threw = true;
          }
          expect(threw).toBe(false);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: arbitrary JSON values serialized to string (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryJSON, (jsonValue) => {
          const input = JSON.stringify(jsonValue);
          let threw = false;
          try {
            parseOutput(input);
          } catch {
            threw = true;
          }
          expect(threw).toBe(false);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: arbitrary output objects serialized to string (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryOutputObject, (obj) => {
          const input = JSON.stringify(obj);
          let threw = false;
          try {
            parseOutput(input);
          } catch {
            threw = true;
          }
          expect(threw).toBe(false);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: malformed JSON strings (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryMalformedJSON, (input) => {
          let threw = false;
          try {
            parseOutput(input);
          } catch {
            threw = true;
          }
          expect(threw).toBe(false);
        }),
        { numRuns: 1000 },
      );
    });

    it("e2e: arbitrary strings via child process (50 inputs)", async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryString, async (input) => {
          const { exitCode } = await runE2EParseTest(input);
          // Must not crash — exit code 0 (success/stop) or 1 (script error)
          // are both acceptable. No uncaught exception exit codes.
          expect([0, 1]).toContain(exitCode);
        }),
        { numRuns: 50 },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F-PARSE-02: Deterministic
  // ---------------------------------------------------------------------------

  describe("F-PARSE-02: Deterministic — same input, same behavior", () => {
    it("unit-level: parseOutput called twice with same input yields equal result (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryString, (input) => {
          const result1 = parseOutput(input);
          const result2 = parseOutput(input);
          expect(result1).toEqual(result2);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: deterministic for JSON values (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryJSON, (jsonValue) => {
          const input = JSON.stringify(jsonValue);
          const result1 = parseOutput(input);
          const result2 = parseOutput(input);
          expect(result1).toEqual(result2);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: deterministic for output objects (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryOutputObject, (obj) => {
          const input = JSON.stringify(obj);
          const result1 = parseOutput(input);
          const result2 = parseOutput(input);
          expect(result1).toEqual(result2);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: deterministic for malformed JSON (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryMalformedJSON, (input) => {
          const result1 = parseOutput(input);
          const result2 = parseOutput(input);
          expect(result1).toEqual(result2);
        }),
        { numRuns: 1000 },
      );
    });

    it("e2e: same input via child process twice yields identical outputs (50 inputs)", async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryString, async (input) => {
          const { output: output1 } = await runE2EParseTest(input);
          const { output: output2 } = await runE2EParseTest(input);
          expect(output1).toEqual(output2);
        }),
        { numRuns: 50 },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F-PARSE-03: Type safety
  // ---------------------------------------------------------------------------

  describe("F-PARSE-03: Type safety — result is string, goto is string, stop is true", () => {
    it("unit-level: all output fields have correct types (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryOutputObject, (obj) => {
          const input = JSON.stringify(obj);
          const result = parseOutput(input) as Output;

          // result, if present, must be a string
          if ("result" in result && result.result !== undefined) {
            expect(typeof result.result).toBe("string");
          }

          // goto, if present, must be a string
          if ("goto" in result && result.goto !== undefined) {
            expect(typeof result.goto).toBe("string");
          }

          // stop, if present, must be exactly true
          if ("stop" in result && result.stop !== undefined) {
            expect(result.stop).toBe(true);
          }
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: type safety for arbitrary JSON values (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryJSON, (jsonValue) => {
          const input = JSON.stringify(jsonValue);
          const result = parseOutput(input) as Output;

          if ("result" in result && result.result !== undefined) {
            expect(typeof result.result).toBe("string");
          }
          if ("goto" in result && result.goto !== undefined) {
            expect(typeof result.goto).toBe("string");
          }
          if ("stop" in result && result.stop !== undefined) {
            expect(result.stop).toBe(true);
          }
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: type safety for arbitrary strings (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryString, (input) => {
          const result = parseOutput(input) as Output;

          if ("result" in result && result.result !== undefined) {
            expect(typeof result.result).toBe("string");
          }
          if ("goto" in result && result.goto !== undefined) {
            expect(typeof result.goto).toBe("string");
          }
          if ("stop" in result && result.stop !== undefined) {
            expect(result.stop).toBe(true);
          }
        }),
        { numRuns: 1000 },
      );
    });

    it("e2e: output fields have correct types via child process (50 inputs)", async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryOutputObject, async (obj) => {
          const payload = JSON.stringify(obj);
          const { output } = await runE2EParseTest(payload);

          // result, if present, must be a string
          if ("result" in output && output.result !== undefined) {
            expect(typeof output.result).toBe("string");
          }

          // goto, if present, must be a string
          if ("goto" in output && output.goto !== undefined) {
            expect(typeof output.goto).toBe("string");
          }

          // stop, if present, must be exactly true
          if ("stop" in output && output.stop !== undefined) {
            expect(output.stop).toBe(true);
          }
        }),
        { numRuns: 50 },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F-PARSE-04: Raw fallback consistency
  // ---------------------------------------------------------------------------

  describe("F-PARSE-04: Raw fallback consistency — non-object JSON becomes result string", () => {
    it("unit-level: JSON arrays fall back to raw result equal to input (1000 inputs)", () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryJSON, { maxLength: 5 }),
          (arr) => {
            const input = JSON.stringify(arr);
            const result = parseOutput(input) as Output;
            expect(result.result).toBe(input);
          },
        ),
        { numRuns: 1000 },
      );
    });

    it("unit-level: JSON primitives fall back to raw result equal to input (1000 inputs)", () => {
      const jsonPrimitive = fc.oneof(
        fc.string().map((s) => JSON.stringify(s)),
        fc.integer().map((n) => JSON.stringify(n)),
        fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) =>
          JSON.stringify(n),
        ),
        fc.boolean().map((b) => JSON.stringify(b)),
        fc.constant("null"),
      );

      fc.assert(
        fc.property(jsonPrimitive, (input) => {
          const result = parseOutput(input) as Output;
          expect(result.result).toBe(input);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: non-JSON text falls back to raw result equal to input (1000 inputs)", () => {
      fc.assert(
        fc.property(arbitraryMalformedJSON, (input) => {
          const result = parseOutput(input) as Output;
          expect(result.result).toBe(input);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: JSON objects with no known fields fall back to raw result (1000 inputs)", () => {
      // Generate objects with keys that are NOT result/goto/stop
      const unknownFieldObj = fc.dictionary(
        fc.string({ minLength: 1, maxLength: 10 }).filter(
          (k) => k !== "result" && k !== "goto" && k !== "stop",
        ),
        fc.string(),
        { minKeys: 1, maxKeys: 5 },
      );

      fc.assert(
        fc.property(unknownFieldObj, (obj) => {
          const input = JSON.stringify(obj);
          const result = parseOutput(input) as Output;
          expect(result.result).toBe(input);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: plain strings (not JSON) fall back to raw result (1000 inputs)", () => {
      // Strings that are definitely not valid JSON: only use safe ASCII chars
      // that cannot form valid JSON on their own
      const plainString = fc
        .string({ unit: "grapheme-ascii", minLength: 1, maxLength: 100 })
        .filter((s) => {
          try {
            JSON.parse(s);
            return false;
          } catch {
            return true;
          }
        });

      fc.assert(
        fc.property(plainString, (input) => {
          const result = parseOutput(input) as Output;
          expect(result.result).toBe(input);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: empty string yields result: ''", () => {
      // This is a degenerate case but important per spec:
      // empty stdout (0 bytes) is treated as { result: "" }
      const result = parseOutput("") as Output;
      expect(result.result).toBe("");
    });

    it("e2e: non-JSON text via child process produces raw fallback (50 inputs)", async () => {
      // Use simple alphanumeric strings to avoid shell/encoding issues in E2E
      const plainText = fc
        .string({ unit: "grapheme-ascii", minLength: 1, maxLength: 50 })
        .filter((s) => {
          try {
            JSON.parse(s);
            return false;
          } catch {
            return true;
          }
        });

      await fc.assert(
        fc.asyncProperty(plainText, async (input) => {
          const { output } = await runE2EParseTest(input);
          expect(output.result).toBe(input);
        }),
        { numRuns: 50 },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F-PARSE-05: Non-ASCII safe
  // ---------------------------------------------------------------------------

  describe("F-PARSE-05: Non-ASCII safe — UTF-8, NUL, control chars, emoji, CJK", () => {
    /**
     * Generates strings containing non-ASCII characters: full Unicode range,
     * NUL bytes, control characters, emoji, CJK, supplementary plane.
     */
    const nonAsciiString: fc.Arbitrary<string> = fc.oneof(
      // Full unicode strings (any codepoint except surrogate halves)
      fc.string({ unit: "binary", minLength: 1, maxLength: 100 }),
      // Strings with embedded NUL
      fc.tuple(fc.string(), fc.string()).map(([a, b]) => `${a}\0${b}`),
      // Control characters (0x01-0x1F)
      fc.string({
        unit: fc.integer({ min: 0x01, max: 0x1f }).map((cp) =>
          String.fromCharCode(cp),
        ),
        minLength: 1,
        maxLength: 50,
      }),
      // Emoji sequences
      fc.constantFrom(
        "\u{1F600}", // grinning face
        "\u{1F4A9}", // pile of poo
        "\u{1F1FA}\u{1F1F8}", // flag US
        "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}", // family
        "\u{1F3FB}", // skin tone modifier
        "\u{2764}\u{FE0F}\u{200D}\u{1F525}", // heart on fire
      ),
      // CJK characters
      fc.string({
        unit: fc.integer({ min: 0x4e00, max: 0x9fff }).map((cp) =>
          String.fromCodePoint(cp),
        ),
        minLength: 1,
        maxLength: 50,
      }),
      // Supplementary plane codepoints (excluding surrogates)
      fc.string({
        unit: fc.integer({ min: 0x10000, max: 0x10ffff }).map((cp) =>
          String.fromCodePoint(cp),
        ),
        minLength: 1,
        maxLength: 20,
      }),
      // Mixed ASCII + non-ASCII
      fc
        .tuple(
          fc.string(),
          fc.string({ unit: "binary", minLength: 1, maxLength: 50 }),
        )
        .map(([a, b]) => a + b),
      // JSON containing non-ASCII in values
      fc
        .string({ unit: "binary", minLength: 1, maxLength: 50 })
        .map((s) => JSON.stringify({ result: s })),
    );

    it("unit-level: no crashes with non-ASCII input (1000 inputs)", () => {
      fc.assert(
        fc.property(nonAsciiString, (input) => {
          let threw = false;
          try {
            parseOutput(input);
          } catch {
            threw = true;
          }
          expect(threw).toBe(false);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: non-ASCII input is deterministic (1000 inputs)", () => {
      fc.assert(
        fc.property(nonAsciiString, (input) => {
          const result1 = parseOutput(input);
          const result2 = parseOutput(input);
          expect(result1).toEqual(result2);
        }),
        { numRuns: 1000 },
      );
    });

    it("unit-level: type safety holds for non-ASCII input (1000 inputs)", () => {
      fc.assert(
        fc.property(nonAsciiString, (input) => {
          const result = parseOutput(input) as Output;

          if ("result" in result && result.result !== undefined) {
            expect(typeof result.result).toBe("string");
          }
          if ("goto" in result && result.goto !== undefined) {
            expect(typeof result.goto).toBe("string");
          }
          if ("stop" in result && result.stop !== undefined) {
            expect(result.stop).toBe(true);
          }
        }),
        { numRuns: 1000 },
      );
    });

    it("e2e: no crashes with non-ASCII input via child process (50 inputs)", async () => {
      // For E2E, avoid NUL bytes since they can cause issues with file I/O
      // and process communication outside of the parser itself.
      const e2eNonAscii: fc.Arbitrary<string> = fc.oneof(
        fc.string({ unit: "grapheme", minLength: 1, maxLength: 50 }),
        fc.constantFrom(
          "\u{1F600}",
          "\u{4E16}\u{754C}\u{4F60}\u{597D}",
          "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
          "\u00E9\u00E8\u00EA",
          "\u00FC\u00F6\u00E4",
          "\u0410\u0411\u0412",
        ),
      );

      await fc.assert(
        fc.asyncProperty(e2eNonAscii, async (input) => {
          const { exitCode } = await runE2EParseTest(input);
          expect([0, 1]).toContain(exitCode);
        }),
        { numRuns: 50 },
      );
    });
  });
});
