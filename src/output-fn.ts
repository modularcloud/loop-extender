import { writeSync } from "node:fs";
import type { Output } from "./types.js";

/**
 * Write structured JSON to stdout and terminate the process.
 *
 * For use inside scripts: import { output } from "loopx";
 *
 * Rules (Spec 6.5):
 * - Flushes stdout before calling process.exit(0).
 * - Since process.exit() is called, code after output() does not execute.
 * - Non-object values: serialize as { result: String(value) }.
 * - Objects: must have at least one known field (result, goto, stop) with a
 *   defined (non-undefined) value. The TYPE of the value is not checked here;
 *   type filtering happens in parseOutput.
 * - null/undefined: throw.
 * - Arrays with no known fields: throw.
 * - undefined properties omitted from JSON serialization.
 */
export function output(value: unknown): never {
  if (value === null || value === undefined) {
    throw new Error(
      "output() requires a non-null, non-undefined argument"
    );
  }

  let payload: Record<string, unknown>;

  if (typeof value !== "object") {
    // Non-object: serialize as { result: String(value) }
    payload = { result: String(value) };
  } else {
    // Object (including arrays): must have at least one known field
    // with a defined (non-undefined) value
    const obj = value as Record<string, unknown>;
    const knownFields = ["result", "goto", "stop"];
    const hasKnown = knownFields.some(
      (f) => f in obj && obj[f] !== undefined
    );

    if (!hasKnown) {
      throw new Error(
        "output() argument must have at least one known field (result, goto, stop) with a defined value"
      );
    }

    // Build payload with only known fields (undefined omitted by JSON.stringify)
    payload = {};
    if ("result" in obj && obj.result !== undefined) {
      payload.result =
        typeof obj.result === "string" ? obj.result : String(obj.result);
    }
    if ("goto" in obj && obj.goto !== undefined) {
      payload.goto = obj.goto;
    }
    if ("stop" in obj && obj.stop !== undefined) {
      payload.stop = obj.stop;
    }
  }

  const json = JSON.stringify(payload);
  // writeSync on a non-blocking pipe (child process stdout) can throw
  // EAGAIN when the pipe buffer is full. Retry with partial writes.
  const buf = Buffer.from(json);
  let offset = 0;
  while (offset < buf.length) {
    try {
      const written = writeSync(1, buf, offset, buf.length - offset);
      offset += written;
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EAGAIN") {
        // Pipe buffer full, retry
        continue;
      }
      throw err;
    }
  }
  process.exit(0);
}
