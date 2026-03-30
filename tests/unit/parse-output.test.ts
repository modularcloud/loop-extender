import { describe, it, expect } from "vitest";
import { parseOutput } from "loopx/internal";

/**
 * TEST-SPEC §6.1 — Unit tests for parseOutput internal seam.
 *
 * parseOutput(stdout: string) => Output
 *
 * Parsing rules (Spec 2.3):
 * - Only a top-level JSON object can be structured output.
 * - Must contain at least one known field (result, goto, stop) to be structured.
 * - Extra fields silently ignored.
 * - result coerced via String(value) if not a string.
 * - goto must be string; otherwise treated as absent.
 * - stop must be exactly true (boolean); otherwise treated as absent.
 * - Non-object JSON, invalid JSON, or object with no known fields → raw fallback { result: <raw stdout> }.
 * - Empty stdout → { result: "" }.
 */

describe("SPEC: parseOutput — Valid JSON Objects", () => {
  it("result only → structured Output with result", () => {
    const out = parseOutput('{"result":"hello"}');
    expect(out).toEqual({ result: "hello" });
  });

  it("goto only → structured Output with goto", () => {
    const out = parseOutput('{"goto":"next-script"}');
    expect(out).toEqual({ goto: "next-script" });
  });

  it("stop only → structured Output with stop: true", () => {
    const out = parseOutput('{"stop":true}');
    expect(out).toEqual({ stop: true });
  });

  it("all three fields → structured Output with result, goto, stop", () => {
    const out = parseOutput('{"result":"done","goto":"other","stop":true}');
    expect(out).toEqual({ result: "done", goto: "other", stop: true });
  });

  it("result + goto → structured Output with both", () => {
    const out = parseOutput('{"result":"value","goto":"target"}');
    expect(out).toEqual({ result: "value", goto: "target" });
  });

  it("result + stop → structured Output with both", () => {
    const out = parseOutput('{"result":"final","stop":true}');
    expect(out).toEqual({ result: "final", stop: true });
  });

  it("goto + stop → structured Output with both", () => {
    const out = parseOutput('{"goto":"target","stop":true}');
    expect(out).toEqual({ goto: "target", stop: true });
  });
});

describe("SPEC: parseOutput — Extra Fields Silently Ignored", () => {
  it("extra fields alongside known fields are ignored", () => {
    const out = parseOutput('{"result":"ok","extra":"ignored","count":42}');
    expect(out).toEqual({ result: "ok" });
    expect(out).not.toHaveProperty("extra");
    expect(out).not.toHaveProperty("count");
  });

  it("extra fields alongside goto are ignored", () => {
    const out = parseOutput('{"goto":"next","debug":true}');
    expect(out).toEqual({ goto: "next" });
    expect(out).not.toHaveProperty("debug");
  });
});

describe("SPEC: parseOutput — Type Coercion of result", () => {
  it("result as number → coerced to string '42'", () => {
    const out = parseOutput('{"result":42}');
    expect(out.result).toBe("42");
  });

  it("result as boolean true → coerced to string 'true'", () => {
    const out = parseOutput('{"result":true}');
    expect(out.result).toBe("true");
  });

  it("result as boolean false → coerced to string 'false'", () => {
    const out = parseOutput('{"result":false}');
    expect(out.result).toBe("false");
  });

  it("result as object → coerced to string '[object Object]'", () => {
    const out = parseOutput('{"result":{"nested":"value"}}');
    expect(out.result).toBe("[object Object]");
  });

  it("result as null → coerced to string 'null'", () => {
    const out = parseOutput('{"result":null}');
    expect(out.result).toBe("null");
  });

  it("result as array → coerced via String()", () => {
    const out = parseOutput('{"result":[1,2,3]}');
    expect(out.result).toBe("1,2,3");
  });
});

describe("SPEC: parseOutput — goto Must Be String", () => {
  it("goto as number → treated as absent", () => {
    const out = parseOutput('{"goto":123}');
    expect(out).not.toHaveProperty("goto");
    // With no valid known fields, this falls back to raw
    expect(out.result).toBe('{"goto":123}');
  });

  it("goto as boolean → treated as absent", () => {
    const out = parseOutput('{"goto":true}');
    expect(out).not.toHaveProperty("goto");
    expect(out.result).toBe('{"goto":true}');
  });

  it("goto as null → treated as absent", () => {
    const out = parseOutput('{"goto":null}');
    expect(out).not.toHaveProperty("goto");
    expect(out.result).toBe('{"goto":null}');
  });

  it("goto as object → treated as absent", () => {
    const out = parseOutput('{"goto":{"a":"b"}}');
    expect(out).not.toHaveProperty("goto");
    expect(out.result).toBe('{"goto":{"a":"b"}}');
  });

  it("goto as non-string alongside valid result → goto absent, result preserved", () => {
    const out = parseOutput('{"result":"hello","goto":42}');
    expect(out.result).toBe("hello");
    expect(out).not.toHaveProperty("goto");
  });
});

describe("SPEC: parseOutput — stop Must Be Exactly true", () => {
  it('stop as string "true" → treated as absent', () => {
    const out = parseOutput('{"stop":"true"}');
    expect(out).not.toHaveProperty("stop");
    // No other known fields → raw fallback
    expect(out.result).toBe('{"stop":"true"}');
  });

  it("stop as number 1 → treated as absent", () => {
    const out = parseOutput('{"stop":1}');
    expect(out).not.toHaveProperty("stop");
    expect(out.result).toBe('{"stop":1}');
  });

  it("stop as false → treated as absent", () => {
    const out = parseOutput('{"stop":false}');
    expect(out).not.toHaveProperty("stop");
    expect(out.result).toBe('{"stop":false}');
  });

  it('stop as string "false" → treated as absent', () => {
    const out = parseOutput('{"stop":"false"}');
    expect(out).not.toHaveProperty("stop");
    expect(out.result).toBe('{"stop":"false"}');
  });

  it("stop as non-boolean alongside valid result → stop absent, result preserved", () => {
    const out = parseOutput('{"result":"data","stop":"true"}');
    expect(out.result).toBe("data");
    expect(out).not.toHaveProperty("stop");
  });

  it("stop as exactly true → preserved", () => {
    const out = parseOutput('{"result":"data","stop":true}');
    expect(out.result).toBe("data");
    expect(out.stop).toBe(true);
  });
});

describe("SPEC: parseOutput — Edge Cases", () => {
  it("empty string → { result: '' }", () => {
    const out = parseOutput("");
    expect(out).toEqual({ result: "" });
  });

  it("whitespace-only string → { result: '  ' } (raw fallback)", () => {
    const out = parseOutput("  ");
    expect(out.result).toBe("  ");
  });

  it("very large string (~1MB) → raw fallback with full content", () => {
    const large = "x".repeat(1_000_000);
    const out = parseOutput(large);
    expect(out.result).toBe(large);
    expect(out.result!.length).toBe(1_000_000);
  });

  it("very large JSON result (~1MB) → structured output preserved", () => {
    const largeValue = "y".repeat(1_000_000);
    const out = parseOutput(JSON.stringify({ result: largeValue }));
    expect(out.result).toBe(largeValue);
    expect(out.result!.length).toBe(1_000_000);
  });
});

describe("SPEC: parseOutput — Non-Object JSON → Raw Fallback", () => {
  it("JSON array → raw fallback", () => {
    const input = '[1,2,3]';
    const out = parseOutput(input);
    expect(out).toEqual({ result: input });
  });

  it("JSON string → raw fallback", () => {
    const input = '"hello"';
    const out = parseOutput(input);
    expect(out).toEqual({ result: input });
  });

  it("JSON number → raw fallback", () => {
    const input = "42";
    const out = parseOutput(input);
    expect(out).toEqual({ result: input });
  });

  it("JSON boolean true → raw fallback", () => {
    const input = "true";
    const out = parseOutput(input);
    expect(out).toEqual({ result: input });
  });

  it("JSON boolean false → raw fallback", () => {
    const input = "false";
    const out = parseOutput(input);
    expect(out).toEqual({ result: input });
  });

  it("JSON null → raw fallback", () => {
    const input = "null";
    const out = parseOutput(input);
    expect(out).toEqual({ result: input });
  });
});

describe("SPEC: parseOutput — Malformed JSON → Raw Fallback", () => {
  it("truncated JSON → raw fallback", () => {
    const input = '{"result":"hel';
    const out = parseOutput(input);
    expect(out).toEqual({ result: input });
  });

  it("plain text → raw fallback", () => {
    const input = "hello world";
    const out = parseOutput(input);
    expect(out).toEqual({ result: input });
  });

  it("multiple JSON objects (not valid JSON) → raw fallback", () => {
    const input = '{"a":1}{"b":2}';
    const out = parseOutput(input);
    expect(out).toEqual({ result: input });
  });

  it("XML-like content → raw fallback", () => {
    const input = "<result>hello</result>";
    const out = parseOutput(input);
    expect(out).toEqual({ result: input });
  });
});

describe("SPEC: parseOutput — Whitespace Handling", () => {
  it("trailing newline on valid JSON → still parsed as structured", () => {
    const out = parseOutput('{"result":"hello"}\n');
    expect(out).toEqual({ result: "hello" });
  });

  it("trailing multiple newlines → still parsed as structured", () => {
    const out = parseOutput('{"result":"hello"}\n\n');
    expect(out).toEqual({ result: "hello" });
  });

  it("leading whitespace → parsed correctly", () => {
    const out = parseOutput('  {"result":"hello"}');
    expect(out).toEqual({ result: "hello" });
  });

  it("leading and trailing whitespace → parsed correctly", () => {
    const out = parseOutput('  {"result":"hello"}  \n');
    expect(out).toEqual({ result: "hello" });
  });

  it("pretty-printed JSON → parsed correctly", () => {
    const pretty = JSON.stringify({ result: "hello", goto: "next" }, null, 2);
    const out = parseOutput(pretty);
    expect(out).toEqual({ result: "hello", goto: "next" });
  });

  it("pretty-printed JSON with tabs → parsed correctly", () => {
    const input = '{\n\t"result": "hello",\n\t"stop": true\n}';
    const out = parseOutput(input);
    expect(out).toEqual({ result: "hello", stop: true });
  });
});

describe("SPEC: parseOutput — JSON Object With No Known Fields → Raw Fallback", () => {
  it("object with only unknown fields → raw fallback", () => {
    const input = '{"foo":"bar","baz":42}';
    const out = parseOutput(input);
    expect(out).toEqual({ result: input });
  });

  it("empty object {} → raw fallback (no known fields)", () => {
    const input = "{}";
    const out = parseOutput(input);
    expect(out).toEqual({ result: input });
  });
});
