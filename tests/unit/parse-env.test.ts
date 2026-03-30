import { describe, it, expect } from "vitest";
import { parseEnvFile } from "loopx/internal";

/**
 * TEST-SPEC §6.2 — Unit tests for parseEnvFile internal seam.
 *
 * parseEnvFile(content: string) => { vars: Record<string, string>, warnings: string[] }
 *
 * Parsing rules (Spec 8.1):
 * - One KEY=VALUE per line.
 * - No whitespace around = (key extends to first =, value is everything after).
 * - Lines starting with # are comments. Inline # is part of value.
 * - Blank lines ignored.
 * - Duplicate keys: last wins.
 * - Values optionally wrapped in matched double or single quotes (stripped).
 * - Unmatched quotes: treated literally, no stripping.
 * - No escape sequence interpretation (content inside quotes is literal).
 * - Key validation: [A-Za-z_][A-Za-z0-9_]*. Invalid keys → warning, ignored.
 * - Lines without = → warning, ignored.
 */

describe("SPEC: parseEnvFile — Standard KEY=VALUE Pairs", () => {
  it("single key-value pair", () => {
    const { vars, warnings } = parseEnvFile("FOO=bar");
    expect(vars).toEqual({ FOO: "bar" });
    expect(warnings).toHaveLength(0);
  });

  it("multiple key-value pairs", () => {
    const { vars, warnings } = parseEnvFile("FOO=bar\nBAZ=qux\nHELLO=world");
    expect(vars).toEqual({ FOO: "bar", BAZ: "qux", HELLO: "world" });
    expect(warnings).toHaveLength(0);
  });

  it("underscore in key name", () => {
    const { vars, warnings } = parseEnvFile("MY_VAR=value\n_PRIVATE=secret");
    expect(vars).toEqual({ MY_VAR: "value", _PRIVATE: "secret" });
    expect(warnings).toHaveLength(0);
  });

  it("key with digits (not leading)", () => {
    const { vars, warnings } = parseEnvFile("VAR1=one\nV2=two");
    expect(vars).toEqual({ VAR1: "one", V2: "two" });
    expect(warnings).toHaveLength(0);
  });
});

describe("SPEC: parseEnvFile — Comments and Blank Lines", () => {
  it("lines starting with # are comments", () => {
    const { vars, warnings } = parseEnvFile("# This is a comment\nFOO=bar");
    expect(vars).toEqual({ FOO: "bar" });
    expect(warnings).toHaveLength(0);
  });

  it("blank lines are ignored", () => {
    const { vars, warnings } = parseEnvFile("FOO=bar\n\n\nBAZ=qux");
    expect(vars).toEqual({ FOO: "bar", BAZ: "qux" });
    expect(warnings).toHaveLength(0);
  });

  it("comments and blank lines interspersed", () => {
    const content = "# comment\nFOO=bar\n\n# another\n\nBAZ=qux";
    const { vars, warnings } = parseEnvFile(content);
    expect(vars).toEqual({ FOO: "bar", BAZ: "qux" });
    expect(warnings).toHaveLength(0);
  });

  it("comment with leading whitespace in # → still a comment", () => {
    // Only lines starting with # are comments per spec
    // A line with leading space then # is ambiguous — but the spec says
    // "lines starting with #", so " # comment" is not a comment line.
    // However, it also has no = so it would be a malformed line.
    const { vars, warnings } = parseEnvFile(" # not a real comment");
    expect(vars).toEqual({});
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("SPEC: parseEnvFile — Quoted Values", () => {
  it("double-quoted value → quotes stripped", () => {
    const { vars } = parseEnvFile('FOO="bar baz"');
    expect(vars.FOO).toBe("bar baz");
  });

  it("single-quoted value → quotes stripped", () => {
    const { vars } = parseEnvFile("FOO='bar baz'");
    expect(vars.FOO).toBe("bar baz");
  });

  it("double-quoted empty value → empty string", () => {
    const { vars } = parseEnvFile('FOO=""');
    expect(vars.FOO).toBe("");
  });

  it("single-quoted empty value → empty string", () => {
    const { vars } = parseEnvFile("FOO=''");
    expect(vars.FOO).toBe("");
  });
});

describe("SPEC: parseEnvFile — Unmatched Quotes Treated Literally", () => {
  it("opening double quote with no closing → literal", () => {
    const { vars } = parseEnvFile('FOO="hello');
    expect(vars.FOO).toBe('"hello');
  });

  it("opening single quote with no closing → literal", () => {
    const { vars } = parseEnvFile("FOO='hello");
    expect(vars.FOO).toBe("'hello");
  });

  it("closing quote with no opening → literal", () => {
    const { vars } = parseEnvFile('FOO=hello"');
    expect(vars.FOO).toBe('hello"');
  });

  it("mismatched quote types → literal", () => {
    const { vars } = parseEnvFile(`FOO="hello'`);
    expect(vars.FOO).toBe(`"hello'`);
  });
});

describe("SPEC: parseEnvFile — Escape Sequences Are Literal", () => {
  it("\\n inside double quotes is literal backslash+n, not newline", () => {
    const { vars } = parseEnvFile('FOO="hello\\nworld"');
    expect(vars.FOO).toBe("hello\\nworld");
  });

  it("\\t inside single quotes is literal backslash+t", () => {
    const { vars } = parseEnvFile("FOO='hello\\tworld'");
    expect(vars.FOO).toBe("hello\\tworld");
  });

  it("\\\\ is literal double backslash", () => {
    const { vars } = parseEnvFile('FOO="path\\\\to\\\\file"');
    expect(vars.FOO).toBe("path\\\\to\\\\file");
  });
});

describe("SPEC: parseEnvFile — Duplicate Keys: Last Wins", () => {
  it("duplicate keys → last value wins", () => {
    const { vars } = parseEnvFile("FOO=first\nFOO=second");
    expect(vars.FOO).toBe("second");
  });

  it("three occurrences → last value wins", () => {
    const { vars } = parseEnvFile("A=1\nA=2\nA=3");
    expect(vars.A).toBe("3");
  });
});

describe("SPEC: parseEnvFile — Inline # Is Part of Value", () => {
  it("# after value is part of the value, not a comment", () => {
    const { vars } = parseEnvFile("FOO=bar # not a comment");
    expect(vars.FOO).toBe("bar # not a comment");
  });

  it("# in quoted value is part of the value", () => {
    const { vars } = parseEnvFile('FOO="bar # baz"');
    expect(vars.FOO).toBe("bar # baz");
  });

  it("value is just a #", () => {
    const { vars } = parseEnvFile("FOO=#");
    expect(vars.FOO).toBe("#");
  });
});

describe("SPEC: parseEnvFile — Trailing Whitespace Trimmed", () => {
  it("trailing spaces on value are trimmed", () => {
    const { vars } = parseEnvFile("FOO=bar   ");
    expect(vars.FOO).toBe("bar");
  });

  it("trailing tab on value is trimmed", () => {
    const { vars } = parseEnvFile("FOO=bar\t");
    expect(vars.FOO).toBe("bar");
  });

  it("trailing whitespace on quoted value is trimmed (after quote stripping)", () => {
    // The value after = is `"bar"   ` — the trailing whitespace is outside the quotes.
    // Per spec: value is everything after = to end of line, trimmed of trailing whitespace.
    // So the raw value is `"bar"`, which is a matched double-quoted value → stripped to `bar`.
    const { vars } = parseEnvFile('FOO="bar"   ');
    expect(vars.FOO).toBe("bar");
  });
});

describe("SPEC: parseEnvFile — No Whitespace Around =", () => {
  it("space before = makes the key invalid → warning, ignored", () => {
    const { vars, warnings } = parseEnvFile("FOO =bar");
    // "FOO " contains a space, which is not valid per [A-Za-z_][A-Za-z0-9_]*
    expect(vars).not.toHaveProperty("FOO");
    expect(vars).not.toHaveProperty("FOO ");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("space after = is part of the value", () => {
    // The key is FOO, the value is " bar" (leading space is part of value,
    // but trailing whitespace is trimmed). Actually spec says:
    // "value is everything after it to the end of the line (trimmed of trailing whitespace)"
    // Leading whitespace in value is preserved.
    const { vars } = parseEnvFile("FOO= bar");
    expect(vars.FOO).toBe(" bar");
  });
});

describe("SPEC: parseEnvFile — Empty Value (KEY=)", () => {
  it("KEY= with nothing after → empty string", () => {
    const { vars, warnings } = parseEnvFile("FOO=");
    expect(vars.FOO).toBe("");
    expect(warnings).toHaveLength(0);
  });

  it("KEY= with trailing whitespace → empty string after trim", () => {
    const { vars } = parseEnvFile("FOO=   ");
    expect(vars.FOO).toBe("");
  });
});

describe("SPEC: parseEnvFile — Multiple = (Split on First)", () => {
  it("value containing = is preserved", () => {
    const { vars } = parseEnvFile("FOO=bar=baz");
    expect(vars.FOO).toBe("bar=baz");
  });

  it("value is just =", () => {
    const { vars } = parseEnvFile("FOO==");
    expect(vars.FOO).toBe("=");
  });

  it("value with multiple = signs", () => {
    const { vars } = parseEnvFile("FOO=a=b=c=d");
    expect(vars.FOO).toBe("a=b=c=d");
  });

  it("base64-like value with = padding", () => {
    const { vars } = parseEnvFile("SECRET=dGVzdA==");
    expect(vars.SECRET).toBe("dGVzdA==");
  });
});

describe("SPEC: parseEnvFile — Invalid Key Names → Warning, Ignored", () => {
  it("digit-first key → warning, ignored", () => {
    const { vars, warnings } = parseEnvFile("1BAD=val");
    expect(vars).not.toHaveProperty("1BAD");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("key with spaces → warning, ignored", () => {
    const { vars, warnings } = parseEnvFile("KEY WITH SPACES=val");
    expect(vars).toEqual({});
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("key with hyphen → warning, ignored", () => {
    const { vars, warnings } = parseEnvFile("MY-VAR=val");
    expect(vars).not.toHaveProperty("MY-VAR");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("key with dot → warning, ignored", () => {
    const { vars, warnings } = parseEnvFile("MY.VAR=val");
    expect(vars).not.toHaveProperty("MY.VAR");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("empty key (=value) → warning, ignored", () => {
    const { vars, warnings } = parseEnvFile("=value");
    expect(vars).toEqual({});
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("SPEC: parseEnvFile — Malformed Lines (No =) → Warning, Ignored", () => {
  it("line with no = → warning, ignored", () => {
    const { vars, warnings } = parseEnvFile("JUSTAKEYNOVALUE");
    expect(vars).toEqual({});
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("multiple malformed lines produce multiple warnings", () => {
    const { vars, warnings } = parseEnvFile("bad1\nbad2\nbad3");
    expect(vars).toEqual({});
    expect(warnings).toHaveLength(3);
  });

  it("mix of valid and malformed lines", () => {
    const { vars, warnings } = parseEnvFile("FOO=bar\nmalformed\nBAZ=qux");
    expect(vars).toEqual({ FOO: "bar", BAZ: "qux" });
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("SPEC: parseEnvFile — Warnings Array Contains Messages", () => {
  it("warning messages are non-empty strings", () => {
    const { warnings } = parseEnvFile("1BAD=val\nno-equals-here");
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    for (const w of warnings) {
      expect(typeof w).toBe("string");
      expect(w.length).toBeGreaterThan(0);
    }
  });

  it("valid content produces no warnings", () => {
    const { warnings } = parseEnvFile("FOO=bar\n# comment\nBAZ=qux");
    expect(warnings).toHaveLength(0);
  });
});

describe("SPEC: parseEnvFile — Empty Content", () => {
  it("empty string → empty vars, no warnings", () => {
    const { vars, warnings } = parseEnvFile("");
    expect(vars).toEqual({});
    expect(warnings).toHaveLength(0);
  });

  it("only whitespace → empty vars, no warnings (blank lines ignored)", () => {
    const { vars, warnings } = parseEnvFile("\n\n\n");
    expect(vars).toEqual({});
    expect(warnings).toHaveLength(0);
  });

  it("only comments → empty vars, no warnings", () => {
    const { vars, warnings } = parseEnvFile("# comment 1\n# comment 2");
    expect(vars).toEqual({});
    expect(warnings).toHaveLength(0);
  });
});

describe("SPEC: parseEnvFile — No Trailing Newline", () => {
  it("content with no trailing newline → last line still parsed", () => {
    const { vars } = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(vars).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("single line with no trailing newline → parsed", () => {
    const { vars } = parseEnvFile("ONLY=one");
    expect(vars).toEqual({ ONLY: "one" });
  });

  it("trailing newline present → same result as without", () => {
    const withNewline = parseEnvFile("FOO=bar\n");
    const withoutNewline = parseEnvFile("FOO=bar");
    expect(withNewline.vars).toEqual(withoutNewline.vars);
  });
});
