import { resolve, join, dirname } from "node:path";
import { realpathSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getLoopxBin(): string {
  try {
    return realpathSync(resolve(__dirname, "bin.js"));
  } catch {
    return resolve(__dirname, "bin.js");
  }
}

export function ensureLoopxPackageJson(loopxDir: string): void {
  const loopxPkg = join(loopxDir, "package.json");
  if (!existsSync(loopxPkg)) {
    writeFileSync(loopxPkg, '{"type":"module"}\n', "utf-8");
  }
}
