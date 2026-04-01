#!/usr/bin/env node

import { readFileSync, realpathSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { discoverScripts } from "./discovery.js";
import { runLoop } from "./loop.js";
import {
  loadGlobalEnv,
  loadLocalEnv,
  mergeEnv,
  envSet,
  envRemove,
  envList,
} from "./env.js";
import { installCommand } from "./install.js";
import { getLoopxBin, ensureLoopxPackageJson } from "./bin-path.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from dist/package.json
function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "package.json"), "utf-8")
    );
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

// --- Argument Parsing ---
interface ParsedArgs {
  help: boolean;
  maxIterations?: number;
  envFile?: string;
  subcommand?: string;
  subcommandArgs: string[];
  scriptName?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    help: false,
    subcommandArgs: [],
  };

  // Help flag takes precedence over everything
  if (argv.includes("-h") || argv.includes("--help")) {
    result.help = true;
    return result;
  }

  let i = 0;
  let sawN = false;
  let sawE = false;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "-n") {
      if (sawN) {
        process.stderr.write("Error: duplicate -n flag\n");
        process.exit(1);
      }
      sawN = true;
      i++;
      if (i >= argv.length) {
        process.stderr.write("Error: -n requires a value\n");
        process.exit(1);
      }
      const val = argv[i];
      const num = Number(val);
      if (!Number.isInteger(num) || num < 0 || val.trim() === "") {
        process.stderr.write(
          `Error: -n must be a non-negative integer, got '${val}'\n`
        );
        process.exit(1);
      }
      result.maxIterations = num;
    } else if (arg === "-e") {
      if (sawE) {
        process.stderr.write("Error: duplicate -e flag\n");
        process.exit(1);
      }
      sawE = true;
      i++;
      if (i >= argv.length) {
        process.stderr.write("Error: -e requires a value\n");
        process.exit(1);
      }
      result.envFile = argv[i];
    } else if (arg === "--") {
      // End-of-flags marker: next argument (if any) is the script name
      i++;
      if (i < argv.length) {
        if (result.scriptName) {
          process.stderr.write(`Error: unexpected argument '${argv[i]}'\n`);
          process.exit(1);
        }
        result.scriptName = argv[i];
      }
      break;
    } else if (!arg.startsWith("-")) {
      // Positional argument
      if (result.scriptName) {
        process.stderr.write(`Error: unexpected argument '${arg}'\n`);
        process.exit(1);
      }
      // Only recognize subcommands when no flags (-n, -e) precede them
      if (
        !sawN &&
        !sawE &&
        ["version", "output", "env", "install"].includes(arg)
      ) {
        result.subcommand = arg;
        result.subcommandArgs = argv.slice(i + 1);
        return result;
      }
      result.scriptName = arg;
    } else {
      process.stderr.write(`Error: unknown flag '${arg}'\n`);
      process.exit(1);
    }
    i++;
  }

  return result;
}

// --- Help ---
function printHelp(loopxDir: string): void {
  console.log(`Usage: loopx [options] [script-name]

Options:
  -n <count>    Maximum number of loop iterations
  -e <path>     Path to a local env file
  -h, --help    Print this help message

Subcommands:
  version       Print the loopx version
  output        Emit structured output (for bash scripts)
  env           Manage global environment variables
  install       Install a script into .loopx/`);

  const discovery = discoverScripts(loopxDir, "help");

  // Print warnings
  for (const w of discovery.warnings) {
    process.stderr.write(w + "\n");
  }

  if (discovery.scripts.size > 0) {
    console.log("\nAvailable scripts:");
    for (const [name, entry] of discovery.scripts) {
      const typeLabel = entry.type === "directory" ? "directory" : entry.ext;
      console.log(`  ${name} (${typeLabel})`);
    }
  }
}

// --- Output Subcommand ---
function handleOutputSubcommand(flags: string[]): void {
  if (flags.length === 0) {
    process.stderr.write(
      "Error: loopx output requires at least one flag (--result, --goto, --stop)\n"
    );
    process.exit(1);
  }

  const output: Record<string, unknown> = {};
  let i = 0;

  while (i < flags.length) {
    const flag = flags[i];
    if (flag === "--result") {
      i++;
      if (i >= flags.length) {
        process.stderr.write("Error: --result requires a value\n");
        process.exit(1);
      }
      output.result = flags[i];
    } else if (flag === "--goto") {
      i++;
      if (i >= flags.length) {
        process.stderr.write("Error: --goto requires a value\n");
        process.exit(1);
      }
      output.goto = flags[i];
    } else if (flag === "--stop") {
      output.stop = true;
    } else {
      process.stderr.write(`Error: loopx output: unknown flag '${flag}'\n`);
      process.exit(1);
    }
    i++;
  }

  console.log(JSON.stringify(output));
}

// --- Env Subcommand ---
function handleEnvSubcommand(subArgs: string[]): void {
  if (subArgs.length === 0) {
    process.stderr.write(
      "Error: loopx env requires a subcommand (set, remove, or list).\n"
    );
    process.exit(1);
  }

  const action = subArgs[0];

  if (action === "set") {
    if (subArgs.length < 3) {
      process.stderr.write("Error: loopx env set requires <name> <value>\n");
      process.exit(1);
    }
    envSet(subArgs[1], subArgs[2]);
  } else if (action === "remove") {
    if (subArgs.length < 2) {
      process.stderr.write("Error: loopx env remove requires <name>\n");
      process.exit(1);
    }
    envRemove(subArgs[1]);
  } else if (action === "list") {
    envList();
  } else {
    process.stderr.write(
      `Error: unknown env subcommand '${action}'. Use set, remove, or list.\n`
    );
    process.exit(1);
  }
}

// --- CLI Delegation ---
function findLocalBin(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, "node_modules", ".bin", "loopx");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function main(): Promise<void> {
  // Delegation: check for local node_modules/.bin/loopx before anything else
  if (process.env.LOOPX_DELEGATED === undefined) {
    const cwd = process.cwd();
    const localBin = findLocalBin(cwd);
    if (localBin) {
      // Per Spec 3.2: LOOPX_BIN is set to the resolved realpath of the local binary
      const localBinRealpath = realpathSync(localBin);
      const result = spawnSync(localBin, process.argv.slice(2), {
        cwd,
        env: {
          ...process.env,
          LOOPX_DELEGATED: "1",
          LOOPX_BIN: localBinRealpath,
        },
        stdio: "inherit",
      });
      if (result.status !== null) {
        process.exit(result.status);
      } else if (result.signal) {
        const sigNum =
          constants.signals[result.signal as keyof typeof constants.signals] ??
          15;
        process.exit(128 + sigNum);
      } else {
        process.exit(1);
      }
    }
  }

  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const loopxDir = join(cwd, ".loopx");
  const loopxBin = getLoopxBin();

  // Help
  if (args.help) {
    printHelp(loopxDir);
    process.exit(0);
  }

  // Subcommands (no .loopx/ validation needed)
  if (args.subcommand === "version") {
    console.log(getVersion());
    process.exit(0);
  }

  if (args.subcommand === "output") {
    handleOutputSubcommand(args.subcommandArgs);
    process.exit(0);
  }

  if (args.subcommand === "env") {
    handleEnvSubcommand(args.subcommandArgs);
    process.exit(0);
  }

  if (args.subcommand === "install") {
    if (args.subcommandArgs.length < 1) {
      process.stderr.write("Error: loopx install requires a <source> argument\n");
      process.exit(1);
    }
    await installCommand(args.subcommandArgs[0], cwd);
    process.exit(0);
  }

  // Run mode: requires .loopx/
  const discovery = discoverScripts(loopxDir, "run");

  ensureLoopxPackageJson(loopxDir);

  // Print warnings to stderr
  for (const w of discovery.warnings) {
    process.stderr.write(w + "\n");
  }

  // Check for fatal errors
  if (discovery.errors.length > 0) {
    for (const err of discovery.errors) {
      process.stderr.write(`Error: ${err}\n`);
    }
    process.exit(1);
  }

  // Load environment
  let globalEnv: Record<string, string> = {};
  let localEnv: Record<string, string> = {};

  try {
    const globalResult = loadGlobalEnv();
    globalEnv = globalResult.vars;
    for (const w of globalResult.warnings) {
      process.stderr.write(`Warning: ${w}\n`);
    }
  } catch (err: unknown) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }

  if (args.envFile) {
    try {
      const envFilePath = resolve(cwd, args.envFile);
      const localResult = loadLocalEnv(envFilePath);
      localEnv = localResult.vars;
      for (const w of localResult.warnings) {
        process.stderr.write(`Warning: ${w}\n`);
      }
    } catch (err: unknown) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    }
  }

  const mergedEnv = mergeEnv(globalEnv, localEnv, loopxBin, cwd);

  // Determine starting target
  const scriptName = args.scriptName || "default";
  const startingTarget = discovery.scripts.get(scriptName);

  if (!startingTarget) {
    if (!args.scriptName) {
      process.stderr.write(
        "Error: No default script found. Create .loopx/default.ts or specify a script name.\n"
      );
    } else {
      process.stderr.write(
        `Error: Script '${scriptName}' not found in .loopx/\n`
      );
    }
    process.exit(1);
  }

  // -n 0: validate then exit
  if (args.maxIterations === 0) {
    process.exit(0);
  }

  // Set up signal handling with AbortController
  const ac = new AbortController();
  let receivedSignal: NodeJS.Signals | null = null;

  function exitWithSignal(): never {
    const sigNum =
      constants.signals[receivedSignal as keyof typeof constants.signals] ?? 15;
    process.exit(128 + sigNum);
  }

  const signalHandler = (sig: NodeJS.Signals) => {
    receivedSignal = sig;
    ac.abort(sig);
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  // Run the loop
  try {
    const loop = runLoop(startingTarget, discovery.scripts, {
      maxIterations: args.maxIterations,
      env: mergedEnv,
      projectRoot: cwd,
      loopxBin,
      signal: ac.signal,
    });

    for await (const _output of loop) {
      if (receivedSignal) exitWithSignal();
    }

    if (receivedSignal) exitWithSignal();

    process.exit(0);
  } catch (err: unknown) {
    if (receivedSignal) exitWithSignal();
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
