import { basename, extname, resolve, join, dirname } from "node:path";
import { realpathSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getLoopxBin(): string {
  if (process.argv[1]) {
    try {
      const argvBin = realpathSync(process.argv[1]);
      if (basename(argvBin) === "bin.js" || extname(argvBin) === "") return argvBin;
    } catch {
      const argvBin = resolve(process.argv[1]);
      if (basename(argvBin) === "bin.js" || extname(argvBin) === "") return argvBin;
    }
  }
  try {
    return realpathSync(resolve(__dirname, "../bin.js"));
  } catch {
    // Source-tree fallback before postbuild has created the package-root wrapper.
  }
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
