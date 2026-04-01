import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getLoopxBin(): string {
  try {
    return realpathSync(resolve(__dirname, "bin.js"));
  } catch {
    return resolve(__dirname, "bin.js");
  }
}
