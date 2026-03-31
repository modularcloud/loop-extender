import type { Output } from "./types.js";

/**
 * Write structured JSON to stdout and terminate the process.
 *
 * For use inside scripts: import { output } from "loopx";
 *
 * Rules (Spec 6.5):
 * - Flushes stdout before calling process.exit(0).
 * - Non-object values: serialize as { result: String(value) }.
 * - Objects: must have at least one known field with a defined value; else throw.
 * - null/undefined: throw.
 * - Arrays with no known fields: throw.
 * - undefined properties omitted from JSON serialization.
 */
export function output(value: unknown): void {
  if (value === null || value === undefined) {
    throw new Error(
      "output() requires a non-null, non-undefined argument"
    );
  }

  let payload: Output;

  if (typeof value !== "object") {
    // Non-object: serialize as { result: String(value) }
    payload = { result: String(value) };
  } else {
    // Object (including arrays): must have at least one known field
    const obj = value as Record<string, unknown>;
    payload = {};
    let hasKnown = false;

    if ("result" in obj && obj.result !== undefined) {
      payload.result =
        typeof obj.result === "string" ? obj.result : String(obj.result);
      hasKnown = true;
    }
    if ("goto" in obj && obj.goto !== undefined && typeof obj.goto === "string") {
      payload.goto = obj.goto;
      hasKnown = true;
    }
    if ("stop" in obj && obj.stop === true) {
      payload.stop = true;
      hasKnown = true;
    }

    if (!hasKnown) {
      throw new Error(
        "output() argument must have at least one known field (result, goto, stop) with a defined value"
      );
    }
  }

  const json = JSON.stringify(payload);
  process.stdout.write(json, () => {
    process.exit(0);
  });
}
