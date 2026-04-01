/**
 * Read input piped from the previous script via stdin.
 *
 * For use inside scripts: import { input } from "loopx";
 *
 * Rules (Spec 6.6):
 * - Returns Promise<string>.
 * - Empty string on first iteration (no prior input).
 * - Cached: multiple calls return same value.
 */
let cachedInput: string | undefined;

export function input(): Promise<string> {
  if (cachedInput !== undefined) {
    return Promise.resolve(cachedInput);
  }

  return new Promise<string>((resolve) => {
    // Check if stdin is already ended before attaching listeners
    // to avoid a race where the 'end' event fires and sets cachedInput,
    // then this block overwrites it with "".
    if (process.stdin.readableEnded) {
      cachedInput = "";
      resolve(cachedInput);
      return;
    }

    const chunks: Buffer[] = [];

    process.stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    process.stdin.on("end", () => {
      cachedInput = Buffer.concat(chunks).toString("utf-8");
      resolve(cachedInput);
    });

    // Resume stdin in case it's paused
    process.stdin.resume();
  });
}
