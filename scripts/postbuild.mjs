import {
  copyFileSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  lstatSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Source the tsx range from the repo-level package.json so the published
// manifest can't drift from the version actually exercised in tests.
const rootPkg = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf-8")
);
const tsxRange = rootPkg.devDependencies?.tsx;
if (!tsxRange) {
  throw new Error(
    "postbuild: could not read tsx version from root package.json devDependencies"
  );
}

// Write dist/package.json for the loopx package
const pkg = {
  name: "loop-extender",
  version: "0.1.0",
  type: "module",
  bin: {
    loopx: "./bin.js",
  },
  // SPEC §3.3 / §6.3: Node runs workflow JS/TS scripts via a spawned `tsx`
  // (src/execution.ts). Must be a runtime dependency so a consumer-side
  // `npm install -g loop-extender` resolves it — without this, a fresh
  // global install fails with `spawn tsx ENOENT` on the first JS/TS script.
  dependencies: {
    tsx: tsxRange,
  },
  exports: {
    ".": {
      types: "./index.d.ts",
      default: "./index.js",
    },
    "./internal": {
      types: "./internal.d.ts",
      default: "./internal.js",
    },
  },
  repository: {
    type: "git",
    url: "https://github.com/modularcloud/loop-extender.git",
  },
};

writeFileSync(
  resolve(root, "dist/package.json"),
  JSON.stringify(pkg, null, 2) + "\n"
);

// Make bin.js executable
try {
  chmodSync(resolve(root, "dist/bin.js"), 0o755);
} catch {
  // bin.js might not exist yet during partial builds
}

// Create node_modules/loopx symlink -> ../dist
const linkPath = resolve(root, "node_modules/loopx");
try {
  lstatSync(linkPath);
  rmSync(linkPath, { recursive: true });
} catch {
  // doesn't exist yet, that's fine
}

// Ensure node_modules directory exists
mkdirSync(resolve(root, "node_modules"), { recursive: true });

symlinkSync("../dist", linkPath);

// Copy README into dist so npm includes it in the package
copyFileSync(resolve(root, "README.md"), resolve(root, "dist/README.md"));

console.log("postbuild: dist/package.json created");
console.log("postbuild: dist/README.md copied");
console.log("postbuild: node_modules/loopx -> dist/");
