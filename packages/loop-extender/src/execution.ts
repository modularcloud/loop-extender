import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import type { ScriptFile } from "./discovery.js";
import { makeAbortError } from "./abort.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOADER_REGISTER_PATH = resolve(__dirname, "loader-register.js");

// Detect Bun runtime — when running under Bun, use Bun's native TS/JSX
// support instead of tsx (SPEC §6.3).
const isBun = !!process.versions.bun;

// Bun's default JSX runtime is "automatic" (imports from "react/jsx-runtime"),
// which breaks workflow scripts that define a local `React.createElement` shim
// (SPEC §6.3 requires .tsx/.jsx to run without pulling in React). Bun only
// exposes classic transform configuration through bunfig.toml, so we write a
// private one to a temp dir on first use and pass it via `-c` along with
// the `--jsx-factory` flags.
let bunClassicJsxConfigPath: string | null = null;
function getBunClassicJsxConfig(): string {
  if (bunClassicJsxConfigPath && existsSync(bunClassicJsxConfigPath)) {
    return bunClassicJsxConfigPath;
  }
  const dir = join(tmpdir(), `loopx-bun-jsx-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "bunfig.toml");
  writeFileSync(
    path,
    `jsx = "react"\njsx-factory = "React.createElement"\njsx-fragment = "React.Fragment"\n`,
    "utf-8"
  );
  bunClassicJsxConfigPath = path;
  return path;
}

let bunLoopxResolverPreloadPath: string | null = null;
function getBunLoopxResolverPreload(): string {
  if (bunLoopxResolverPreloadPath && existsSync(bunLoopxResolverPreloadPath)) {
    return bunLoopxResolverPreloadPath;
  }
  const dir = join(tmpdir(), `loopx-bun-resolver-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "preload.mjs");
  writeFileSync(
    path,
    `import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

Bun.plugin({
  name: "loopx-resolver",
  setup(build) {
    build.onResolve({ filter: /^loopx(?:\\/internal)?$/ }, (args) => {
      try {
        const importer = args.importer
          ? pathToFileURL(args.importer).href
          : pathToFileURL(process.cwd() + "/index.js").href;
        const req = createRequire(importer);
        return { path: req.resolve(args.path) };
      } catch {
        return {
          path: args.path === "loopx/internal"
            ? process.env.LOOPX_INTERNAL_ENTRY
            : process.env.LOOPX_PACKAGE_ENTRY,
        };
      }
    });
  },
});
`,
    "utf-8"
  );
  bunLoopxResolverPreloadPath = path;
  return path;
}

// Add our node_modules/.bin to PATH so tsx is findable regardless of cwd.
// __dirname is the compiled dist/ directory. Three layouts must be supported:
//   - Global install: <pkg>/node_modules/.bin — `npm install -g loop-extender`
//     nests tsx under the package root (one level above __dirname).
//   - Workspace dev: <repo>/node_modules/.bin — npm workspaces hoist tsx to
//     the repo root (three levels above __dirname).
//   - Legacy flat: <__dirname>/node_modules/.bin — kept for backwards compat
//     with old dist-as-package layouts.
// Prepend all three; missing entries on PATH are harmless.
const LOOPX_LEGACY_BIN_DIR = resolve(__dirname, "node_modules", ".bin");
const LOOPX_FLAT_BIN_DIR = resolve(__dirname, "..", "node_modules", ".bin");
const LOOPX_WORKSPACE_BIN_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "node_modules",
  ".bin"
);
// NODE_PATH entries: loopx's own deps + parent dir (for global installs
// where the parent node_modules/ contains the loopx package itself) +
// workspace-root node_modules (for dev via npm workspaces).
const LOOPX_NODE_MODULES = resolve(__dirname, "..", "node_modules");
const LOOPX_PACKAGE_PARENT = resolve(__dirname, "..", "..");
const LOOPX_WORKSPACE_NODE_MODULES = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "node_modules"
);

// The npm package is published as "loop-extender" but scripts import from
// "loopx" (SPEC §3.1, §3.3). When the package is globally installed there is
// no `node_modules/loopx/` entry accessible to scripts, so Bun's NODE_PATH
// lookup fails. Create a per-process shim dir that symlinks `loopx` to the
// loop-extender package root (one level above __dirname, since __dirname is
// the compiled dist/ dir and package.json with `exports` lives at the parent)
// and prepend it to NODE_PATH.
let loopxShimDir: string | null = null;
function getLoopxShimDir(): string {
  if (loopxShimDir && existsSync(join(loopxShimDir, "loopx"))) {
    return loopxShimDir;
  }
  const dir = join(tmpdir(), `loopx-nodepath-shim-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "loopx");
  // __dirname is dist/ at runtime; the canonical package root with package.json
  // (and its `exports` map) lives one level up.
  const loopxPackageRoot = resolve(__dirname, "..");
  try {
    if (lstatSync(shim)) unlinkSync(shim);
  } catch {
    // didn't exist
  }
  symlinkSync(loopxPackageRoot, shim);
  loopxShimDir = dir;
  return dir;
}

const LOOPX_NODE_PATH = `${getLoopxShimDir()}:${LOOPX_NODE_MODULES}:${LOOPX_PACKAGE_PARENT}:${LOOPX_WORKSPACE_NODE_MODULES}`;

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

export interface ExecOptions {
  workflowName: string;
  workflowDir: string;
  projectRoot: string;
  loopxBin: string;
  env: Record<string, string>;
  input?: string;
  signal?: AbortSignal;
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already dead
    }
  }
}

export function executeScript(
  script: ScriptFile,
  options: ExecOptions
): Promise<ExecResult> {
  const {
    workflowName,
    workflowDir,
    projectRoot,
    loopxBin,
    env,
    input,
    signal,
  } = options;

  // SPEC §6.1: scripts always run with the project root as cwd; the workflow
  // directory is exposed separately through LOOPX_WORKFLOW_DIR.
  const cwd = projectRoot;

  const currentPath = env.PATH ?? process.env.PATH ?? "";
  const currentNodePath = env.NODE_PATH ?? "";

  const scriptEnv: Record<string, string> = {
    ...env,
    LOOPX_BIN: loopxBin,
    LOOPX_PROJECT_ROOT: projectRoot,
    LOOPX_WORKFLOW: workflowName,
    LOOPX_WORKFLOW_DIR: workflowDir,
    PATH: (() => {
      const pathEntries = currentPath.split(":");
      const prepend: string[] = [];
      for (const dir of [
        LOOPX_LEGACY_BIN_DIR,
        LOOPX_FLAT_BIN_DIR,
        LOOPX_WORKSPACE_BIN_DIR,
      ]) {
        if (!pathEntries.includes(dir)) prepend.push(dir);
      }
      return prepend.length === 0
        ? currentPath
        : `${prepend.join(":")}:${currentPath}`;
    })(),
    NODE_PATH: currentNodePath
      ? `${LOOPX_NODE_PATH}:${currentNodePath}`
      : LOOPX_NODE_PATH,
    LOOPX_PACKAGE_ENTRY: resolve(__dirname, "index.js"),
    LOOPX_INTERNAL_ENTRY: resolve(__dirname, "internal.js"),
  };

  let command: string;
  let args: string[];

  if (script.ext === ".sh") {
    command = "/bin/bash";
    args = [script.path];
  } else if (isBun) {
    command = "bun";
    // Bun interops CJS liberally, but SPEC §6.3 requires loopx scripts to be
    // ESM. Substitute `require` with `null` at parse time so any CJS-style
    // `require("fs")` call fails with a TypeError — matching the SPEC
    // requirement that CJS syntax "fail at execution time".
    const commonFlags = [
      "--preload",
      getBunLoopxResolverPreload(),
      "--define",
      "require:null",
    ];
    if (script.ext === ".tsx" || script.ext === ".jsx") {
      // Configure Bun to use the classic JSX transform against a user-supplied
      // `React.createElement` factory. This runs JSX through the same path as
      // tsx + Node (classic). Bun only honors jsx config via bunfig.toml, so
      // we write one to a tmp dir and pass it via `--config=`.
      const bunfig = getBunClassicJsxConfig();
      args = [
        ...commonFlags,
        `--config=${bunfig}`,
        "--jsx-factory=React.createElement",
        "--jsx-fragment=React.Fragment",
        script.path,
      ];
    } else {
      args = [...commonFlags, script.path];
    }
  } else {
    command = "tsx";
    args = ["--import", LOADER_REGISTER_PATH, script.path];
  }

  return new Promise<ExecResult>((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError(signal));
      return;
    }

    let bunProjectRootShim: string | null = null;
    let bunCreatedNodeModulesDir: string | null = null;
    if (
      isBun &&
      (script.ext === ".js" ||
        script.ext === ".jsx" ||
        script.ext === ".ts" ||
        script.ext === ".tsx")
    ) {
      const nodeModulesDir = join(projectRoot, "node_modules");
      const linkPath = join(nodeModulesDir, "loopx");
      try {
        if (!existsSync(linkPath)) {
          const hadNodeModulesDir = existsSync(nodeModulesDir);
          mkdirSync(nodeModulesDir, { recursive: true });
          symlinkSync(resolve(__dirname, ".."), linkPath);
          bunProjectRootShim = linkPath;
          if (!hadNodeModulesDir) {
            bunCreatedNodeModulesDir = nodeModulesDir;
          }
        }
      } catch {
        // The Bun preload resolver remains the primary fallback. If a project
        // root cannot accept a temporary shim, continue without changing the
        // user-visible execution outcome here.
      }
    }

    const cleanupBunProjectRootShim = () => {
      if (!bunProjectRootShim) return;
      try {
        rmSync(bunProjectRootShim, { recursive: true, force: true });
        if (bunCreatedNodeModulesDir) {
          rmSync(bunCreatedNodeModulesDir, { recursive: false, force: true });
        }
      } catch {
        // best effort only
      }
    };

    const child = spawn(command, args, {
      cwd,
      env: scriptEnv,
      stdio: ["pipe", "pipe", "inherit"],
      detached: true,
    });

    let stdout = "";
    let aborted = false;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stdin.on("error", () => {});
    if (input !== undefined && input !== "") {
      child.stdin.write(input);
    }
    child.stdin.end();

    const onAbort = () => {
      aborted = true;
      const forwardSignal: NodeJS.Signals =
        signal?.reason === "SIGINT" || signal?.reason === "SIGTERM"
          ? signal.reason
          : "SIGTERM";
      killProcessGroup(child, forwardSignal);
      graceTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
      }, 5000);
      graceTimer.unref();
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanupBunProjectRootShim();
      if (graceTimer) clearTimeout(graceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);

      if (aborted) {
        reject(makeAbortError(signal));
      } else {
        resolvePromise({ stdout, exitCode: code ?? 1 });
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanupBunProjectRootShim();
      if (graceTimer) clearTimeout(graceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}
