import type { Output } from "../types.js";

/**
 * Parse stdout from a script execution into structured Output.
 *
 * Rules (Spec 2.3):
 * - Only a top-level JSON object with at least one known field is structured output.
 * - Known fields: result, goto, stop. Extra fields silently ignored.
 * - result: coerced via String() if not a string.
 * - goto: must be string, otherwise treated as absent.
 * - stop: must be exactly true (boolean), otherwise treated as absent.
 * - Non-object JSON, invalid JSON, or no known fields -> raw fallback { result: stdout }.
 * - Empty stdout -> { result: "" }.
 */
export function parseOutput(stdout: string): Output {
  if (stdout === "") {
    return { result: "" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not valid JSON -> raw fallback
    return { result: stdout };
  }

  // Must be a plain object (not array, not null, not primitive)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { result: stdout };
  }

  const obj = parsed as Record<string, unknown>;
  const output: Output = {};

  // Determine if any known field key is present in the object.
  // Per Spec 2.3: presence of a known key (even with invalid type) means
  // the object is structured output, not raw text.
  const hasKnownField =
    "result" in obj || "goto" in obj || "stop" in obj;

  // No known fields -> raw fallback
  if (!hasKnownField) {
    return { result: stdout };
  }

  // result: if present, coerce to string
  if ("result" in obj && obj.result !== undefined) {
    output.result =
      typeof obj.result === "string" ? obj.result : String(obj.result);
  }

  // goto: must be string, otherwise treat as absent
  if ("goto" in obj && typeof obj.goto === "string") {
    output.goto = obj.goto;
  }

  // stop: must be exactly true
  if ("stop" in obj && obj.stop === true) {
    output.stop = true;
  }

  return output;
}
