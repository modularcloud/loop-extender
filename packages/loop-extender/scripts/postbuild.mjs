import {
  copyFileSync,
  rmSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const repoRoot = resolve(pkgRoot, "..", "..");

try {
  chmodSync(resolve(pkgRoot, "dist/bin.js"), 0o755);
} catch {
  // bin.js might not exist yet during partial builds
}

if (existsSync(resolve(pkgRoot, "README.md"))) {
  copyFileSync(
    resolve(pkgRoot, "README.md"),
    resolve(pkgRoot, "dist/README.md")
  );
}

// SPEC §3.1 / §3.3: workflow scripts written by users `import { output } from "loopx"`,
// but the published package is named "loop-extender". At runtime, src/execution.ts
// sets up a NODE_PATH shim so the import resolves. For local dev (vitest, scripts
// running outside the shim), expose the package via node_modules symlinks so
// Node's normal resolution finds it from any cwd we run from.
const symlinks = [
  {
    dir: resolve(repoRoot, "node_modules"),
    target: "../packages/loop-extender",
  },
  {
    dir: resolve(repoRoot, "apps/tests/node_modules"),
    target: "../../../packages/loop-extender",
  },
];
for (const { dir, target } of symlinks) {
  mkdirSync(dir, { recursive: true });
  const linkPath = resolve(dir, "loopx");
  try {
    lstatSync(linkPath);
    rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // doesn't exist yet
  }
  symlinkSync(target, linkPath);
  console.log(`postbuild: ${linkPath} -> ${target}`);
}

console.log("postbuild: chmod +x dist/bin.js");
console.log("postbuild: dist/README.md copied");
