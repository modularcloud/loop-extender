import {
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

// Write dist/package.json for the loopx package
const pkg = {
  name: "loop-extender",
  version: "0.1.0",
  type: "module",
  bin: {
    loopx: "./bin.js",
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

console.log("postbuild: dist/package.json created");
console.log("postbuild: node_modules/loopx -> dist/");
